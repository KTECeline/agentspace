"""Approvals (fail closed) and pause / resume / cancel."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest
from conftest import (
    FakeCollector,
    approve_when_requested,
    assert_valid_events,
    free_port,
    init_fast,
)
from jsonschema import Draft202012Validator

import agentspace

# ---------------- approvals ----------------


def test_approved(collector: FakeCollector, validator: Draft202012Validator) -> None:
    init_fast(collector.url, auto_instrument=False)
    approve_when_requested(collector, "approved", "ship it")
    with agentspace.run("deploy"), agentspace.agent("Deployer", team="ops"):
        result = agentspace.request_approval_sync(
            "Deploy v1.2 to prod?", {"version": "1.2"}, timeout=10
        )
    assert result.approved and result.comment == "ship it" and result.error is None
    agentspace.flush()
    assert_valid_events(validator, collector.events)
    (req,) = collector.of_type("approval.requested")
    assert req["data"]["payload"] == {"version": "1.2"}  # sent even without capture_content
    assert req["agent_id"] == "deployer"
    statuses = [e["data"]["status"] for e in collector.of_type("agent.status")]
    assert (
        "waiting_human" in statuses and statuses[statuses.index("waiting_human") + 1] == "thinking"
    )


def test_rejected_and_redacted(collector: FakeCollector) -> None:
    def redact(field: str, value: Any) -> Any:
        return {k: "***" for k in value} if field == "approval.payload" else value

    init_fast(collector.url, auto_instrument=False, redact=redact)
    approve_when_requested(collector, "rejected", "not now")
    result = agentspace.request_approval_sync("Wire money?", {"iban": "DE00"}, timeout=10)
    assert result.decision == "rejected" and not result.approved and result.comment == "not now"
    assert collector.of_type("approval.requested")[0]["data"]["payload"] == {"iban": "***"}


def test_times_out(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    t0 = time.monotonic()
    result = agentspace.request_approval_sync("Anyone?", timeout=1.0)
    assert result.decision == "timeout" and not result.approved
    assert time.monotonic() - t0 < 4


def test_fails_closed_when_not_initialized() -> None:
    result = agentspace.request_approval_sync("Delete prod?", timeout=5)
    assert result.decision == "rejected" and result.error == "agentspace is not initialized"


def test_fails_closed_when_collector_is_down() -> None:
    init_fast(f"http://127.0.0.1:{free_port()}", auto_instrument=False)
    t0 = time.monotonic()
    result = agentspace.request_approval_sync("Delete prod?", timeout=60)
    assert result.decision == "rejected" and result.error == "collector unreachable"
    assert time.monotonic() - t0 < 6


def test_fails_closed_when_collector_dies_while_waiting(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)

    def kill() -> None:
        collector.wait_for(lambda evs: any(e["type"] == "approval.requested" for e in evs))
        collector.stop()

    threading.Thread(target=kill, daemon=True).start()
    t0 = time.monotonic()
    result = agentspace.request_approval_sync("Deploy?", timeout=120)
    assert result.decision == "rejected" and result.error in ("collector unreachable",)
    assert time.monotonic() - t0 < 30


def test_unauthorized_fails_closed(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    collector.approval_status_override = 401
    result = agentspace.request_approval_sync("Deploy?", timeout=10)
    assert result.decision == "rejected" and "401" in (result.error or "")


def test_async_version_does_not_block_the_loop(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    approve_when_requested(collector, delay=0.5)

    async def main() -> tuple[bool, int]:
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            for _ in range(50):
                ticks += 1
                await asyncio.sleep(0.01)

        result, _ = await asyncio.gather(agentspace.request_approval("ok?", timeout=10), ticker())
        return result.approved, ticks

    approved, ticks = asyncio.run(main())
    assert approved and ticks == 50


# ---------------- pause / resume / cancel ----------------


def test_cancel_raises_base_exception_that_except_exception_cannot_swallow(
    collector: FakeCollector,
) -> None:
    init_fast(collector.url, auto_instrument=False)
    swallowed = False
    with pytest.raises(agentspace.Cancelled), agentspace.run("long job") as r:
        collector.controls[r.run_id] = "cancelled"
        agentspace.emit("message", {})
        assert agentspace.flush()  # the ingest response carries the control
        try:
            with agentspace.agent("Worker", team="t"):  # safe point -> raises
                pass
        except Exception:
            swallowed = True
    assert not swallowed
    assert issubclass(agentspace.Cancelled, BaseException) and not issubclass(
        agentspace.Cancelled, Exception
    )
    agentspace.flush()
    finished = collector.of_type("run.finished")
    assert finished and finished[-1]["data"]["status"] == "cancelled"
    assert not collector.of_type("error")  # a cancel is not an error


def test_cancel_flag_mode(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, cancel_mode="flag")
    with agentspace.run("job") as r:
        collector.controls[r.run_id] = "cancelled"
        agentspace.emit("message", {})
        agentspace.flush()
        with agentspace.agent("Worker"):  # no raise in flag mode
            assert agentspace.is_cancelled()
            assert agentspace.checkpoint() is False


def test_pause_blocks_until_resumed(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    with agentspace.run("job") as r:
        collector.controls[r.run_id] = "paused"
        agentspace.emit("message", {})
        agentspace.flush()

        def resume() -> None:
            time.sleep(0.6)
            collector.controls.pop(r.run_id)

        threading.Thread(target=resume, daemon=True).start()
        t0 = time.monotonic()
        with agentspace.agent("Worker"):
            waited = time.monotonic() - t0
    assert 0.5 < waited < 5
    agentspace.flush()
    details = [
        (e["data"]["status"], e["data"].get("detail")) for e in collector.of_type("agent.status")
    ]
    assert ("blocked", "run paused (resume it in the office)") in details


def test_pause_then_cancel(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    with pytest.raises(agentspace.Cancelled), agentspace.run("job") as r:
        collector.controls[r.run_id] = "paused"
        agentspace.emit("message", {})
        agentspace.flush()
        threading.Timer(0.3, lambda: collector.controls.__setitem__(r.run_id, "cancelled")).start()
        agentspace.checkpoint()


def test_idle_runs_learn_controls_by_polling(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    with agentspace.run("job") as r:
        agentspace.flush()
        collector.controls[r.run_id] = "cancelled"  # no further events from this run
        deadline = time.monotonic() + 5
        while not agentspace.is_cancelled() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert agentspace.is_cancelled()


def test_async_pause_does_not_block_the_loop(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)

    async def main() -> int:
        ticks = 0
        async with agentspace.run("job") as r:
            collector.controls[r.run_id] = "paused"
            agentspace.emit("message", {})
            await asyncio.to_thread(agentspace.flush)
            asyncio.get_running_loop().call_later(0.4, lambda: collector.controls.pop(r.run_id))

            async def ticker() -> None:
                nonlocal ticks
                for _ in range(20):
                    ticks += 1
                    await asyncio.sleep(0.01)

            await asyncio.gather(agentspace.acheckpoint(), ticker())
        return ticks

    assert asyncio.run(main()) == 20
