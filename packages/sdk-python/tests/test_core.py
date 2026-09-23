"""Core SDK behaviour: event shape, context propagation, privacy."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from conftest import FakeCollector, assert_valid_events, init_fast
from jsonschema import Draft202012Validator

import agentspace


def test_calls_before_init_are_noops() -> None:
    assert agentspace.get_client() is None
    assert agentspace.emit("message", {"text": "hi"}) is None
    agentspace.set_status("thinking")
    agentspace.handoff("x")
    with agentspace.run("r"), agentspace.agent("A"), agentspace.step("s"):
        pass

    @agentspace.agent
    def f() -> int:
        return 1

    assert f() == 1
    assert agentspace.flush() is True


def test_manual_api_emits_valid_linked_events(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url, workspace="ws1", auto_instrument=False)

    @agentspace.agent(team="Engineering", role="fixes bugs")
    def engineer(bug: str) -> str:
        with agentspace.step("reproduce"):
            agentspace.emit("tool.call", {"tool_name": "pytest", "call_id": "c1"})
        return f"fixed {bug}"

    @agentspace.agent(name="Manager", team="Engineering")
    def manager() -> str:
        agentspace.set_status("thinking", "planning")
        return engineer("#12")

    with agentspace.run("fix-bug") as r:
        assert manager() == "fixed #12"
    assert agentspace.flush()

    events = collector.events
    assert_valid_events(validator, events)
    assert {e["workspace"] for e in events} == {"ws1"}
    assert {e["run_id"] for e in events} == {r.run_id}

    types = [e["type"] for e in events]
    assert types[0] == "run.started" and types[-1] == "run.finished"

    registered = {e["agent_id"]: e for e in collector.of_type("agent.registered")}
    assert set(registered) == {"manager", "engineer"}
    assert registered["engineer"]["team_id"] == "engineering"
    assert registered["engineer"]["data"]["role"] == "fixes bugs"

    (handoff,) = collector.of_type("handoff")
    assert handoff["data"] == {"from_agent_id": "manager", "to_agent_id": "engineer"}

    # parent links: tool.call -> "reproduce" step -> engineer agent step -> manager agent step
    steps = {e["data"]["name"]: e for e in collector.of_type("step.started")}
    (tool_call,) = collector.of_type("tool.call")
    assert tool_call["agent_id"] == "engineer"
    assert tool_call["parent_id"] == steps["reproduce"]["data"]["step_id"]
    assert steps["reproduce"]["parent_id"] == steps["engineer"]["data"]["step_id"]
    assert steps["engineer"]["parent_id"] == steps["Manager"]["data"]["step_id"]

    statuses = [(e["agent_id"], e["data"]["status"]) for e in collector.of_type("agent.status")]
    assert statuses[-2:] == [("engineer", "done"), ("manager", "done")]


def test_user_exceptions_propagate_and_are_recorded(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url, auto_instrument=False)

    @agentspace.agent(team="qa")
    def flaky() -> None:
        raise KeyError("boom")

    with pytest.raises(KeyError, match="boom"), agentspace.run("r"):
        flaky()
    agentspace.flush()

    assert_valid_events(validator, collector.events)
    errors = collector.of_type("error")
    assert errors and errors[0]["data"]["kind"] == "KeyError"
    finished = collector.of_type("run.finished")[0]
    assert finished["data"]["status"] == "error"
    step_done = collector.of_type("step.finished")[0]
    assert step_done["data"]["ok"] is False


def test_async_agents_keep_separate_context(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url, auto_instrument=False)

    async def worker(name: str) -> str:
        for _ in range(3):
            agentspace.emit("message", {"text": name}, summary=name)
            await asyncio.sleep(0)
        return name

    async def main() -> None:
        async with agentspace.run("parallel"):
            await asyncio.gather(
                agentspace.agent("alpha", team="r")(worker)("alpha"),
                agentspace.agent("beta", team="r")(worker)("beta"),
            )

    asyncio.run(main())
    agentspace.flush()

    assert_valid_events(validator, collector.events)
    for msg in collector.of_type("message"):
        assert msg["agent_id"] == msg["summary"]  # never crossed wires between tasks


def test_async_decorated_function(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)

    @agentspace.agent(team="t")
    async def solo() -> int:
        return 7

    assert asyncio.run(solo()) == 7
    agentspace.flush()
    assert collector.of_type("step.finished")


def test_content_not_sent_by_default(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    with agentspace.run("r", input={"secret": "prompt"}):
        pass
    agentspace.flush()
    started = collector.of_type("run.started")[0]
    assert "input" not in started["data"]


def test_capture_content_with_redaction(collector: FakeCollector) -> None:
    seen: list[str] = []

    def redact(field: str, value: Any) -> Any:
        seen.append(field)
        return {k: ("***" if k == "api_key" else v) for k, v in value.items()}

    init_fast(collector.url, auto_instrument=False, capture_content=True, redact=redact)
    with agentspace.run("r", input={"q": "hello", "api_key": "sk-123"}):
        pass
    agentspace.flush()
    assert seen == ["run.input"]
    assert collector.of_type("run.started")[0]["data"]["input"] == {"q": "hello", "api_key": "***"}


def test_broken_redact_hook_drops_content_but_keeps_event(collector: FakeCollector) -> None:
    def bad(field: str, value: Any) -> Any:
        raise RuntimeError("bug in user hook")

    init_fast(collector.url, auto_instrument=False, capture_content=True, redact=bad)
    with agentspace.run("r", input="hi"):
        pass
    agentspace.flush()
    started = collector.of_type("run.started")[0]
    assert "input" not in started["data"]


def test_long_summary_is_truncated(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url, auto_instrument=False)
    agentspace.emit("message", {}, summary="x" * 5000, model="m" * 1000)
    agentspace.flush()
    assert_valid_events(validator, collector.events)


def test_disabled_via_env(monkeypatch: pytest.MonkeyPatch, collector: FakeCollector) -> None:
    monkeypatch.setenv("AGENTSPACE_DISABLED", "1")
    client = agentspace.init(url=collector.url, auto_instrument=False)
    assert client is not None and client.transport is None
    agentspace.emit("message", {})
    assert collector.events == []
