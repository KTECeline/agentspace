"""The SDK must never crash, block, or grow without bound, whatever the collector does."""

from __future__ import annotations

import asyncio
import socket
import statistics
import threading
import time

import pytest
from conftest import FakeCollector, free_port, init_fast

import agentspace


def _emit_many(n: int) -> list[float]:
    lat = []
    for i in range(n):
        t0 = time.perf_counter()
        agentspace.emit("message", {"text": str(i)}, summary="load")
        lat.append(time.perf_counter() - t0)
    return lat


def test_collector_down_never_raises_and_stays_fast() -> None:
    url = f"http://127.0.0.1:{free_port()}"  # nothing listening
    init_fast(url, auto_instrument=False)

    @agentspace.agent(team="t")
    def work() -> str:
        agentspace.set_status("using_tool", "x")
        return "ok"

    with agentspace.run("offline"):
        assert work() == "ok"
    lat = _emit_many(2000)
    p99 = sorted(lat)[int(len(lat) * 0.99)]
    assert p99 < 0.002, f"emit p99 {p99 * 1000:.3f} ms while collector is down"

    t0 = time.monotonic()
    assert agentspace.flush(timeout=5) is False
    assert time.monotonic() - t0 < 1.0, "flush must not wait for a dead collector"
    t0 = time.monotonic()
    agentspace.shutdown(timeout=5)
    assert time.monotonic() - t0 < 1.0, "shutdown must not wait for a dead collector"


def test_queue_is_bounded_and_drops_oldest() -> None:
    url = f"http://127.0.0.1:{free_port()}"
    init_fast(url, auto_instrument=False, max_queue=100)
    _emit_many(1000)
    s = agentspace.stats()
    assert s["pending"] <= 100
    assert s["dropped"] >= 800


def test_buffered_events_delivered_when_collector_comes_back() -> None:
    port = free_port()
    init_fast(f"http://127.0.0.1:{port}", auto_instrument=False)
    _emit_many(50)
    time.sleep(0.2)  # at least one failed attempt
    collector = FakeCollector(port=port)
    try:
        ok = collector.wait_for(lambda evs: len(evs) >= 50, timeout=8)
        assert ok, f"only {len(collector.events)} events arrived after recovery"
    finally:
        collector.stop()


def test_hung_collector_does_not_block_event_loop() -> None:
    """A collector that accepts connections but never answers must not stall asyncio code."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(64)
    port = srv.getsockname()[1]
    try:
        init_fast(f"http://127.0.0.1:{port}", auto_instrument=False, timeout=5)

        async def main() -> float:
            ticks: list[float] = []

            async def ticker() -> None:
                for _ in range(20):
                    t0 = time.perf_counter()
                    await asyncio.sleep(0.005)
                    ticks.append(time.perf_counter() - t0)

            async def producer() -> None:
                for _ in range(20):
                    _emit_many(200)
                    await asyncio.sleep(0)

            await asyncio.gather(ticker(), producer())
            return statistics.median(ticks)

        median_tick = asyncio.run(main())
        assert median_tick < 0.05, f"event loop stalled: median tick {median_tick * 1000:.1f} ms"
    finally:
        srv.close()


def test_4xx_batches_are_dropped_not_retried(collector: FakeCollector) -> None:
    collector.status = 400
    init_fast(collector.url, auto_instrument=False)
    _emit_many(10)
    deadline = time.monotonic() + 3
    while agentspace.stats()["rejected"] < 10 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert agentspace.stats()["rejected"] >= 10
    assert agentspace.stats()["pending"] == 0


def test_internal_failure_is_swallowed(
    collector: FakeCollector, monkeypatch: pytest.MonkeyPatch
) -> None:
    init_fast(collector.url, auto_instrument=False)
    client = agentspace.get_client()
    assert client is not None and client.transport is not None

    def explode(event: object) -> None:
        raise RuntimeError("simulated SDK bug")

    monkeypatch.setattr(client.transport, "put", explode)
    assert agentspace.emit("message", {}) is None
    agentspace.set_status("thinking")

    @agentspace.agent(team="t")
    def still_works() -> int:
        with agentspace.step("s"):
            return 42

    with agentspace.run("r"):
        assert still_works() == 42


def test_non_json_values_do_not_break_sending(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    agentspace.emit("message", {"text": object()}, attributes={"k": "v"})
    assert agentspace.flush()
    assert collector.of_type("message")


def test_emit_is_thread_safe(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False)
    threads = [threading.Thread(target=_emit_many, args=(250,)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert collector.wait_for(lambda evs: len(evs) >= 2000 + 1)  # +1 for run.started
