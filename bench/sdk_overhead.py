"""AgentSpace Python SDK overhead benchmark (stdlib only).

Measures what instrumentation costs the *calling* thread, which is what your app feels:

- per-call latency of ``emit()``, a ``step()`` scope and an ``agent()`` scope (p50/p99/max),
  with the collector up, down (connection refused) and stalled (accepts, never answers),
  plus the SDK disabled as a baseline;
- event-loop blocking: the worst lateness of a 1 ms asyncio ticker while a coroutine emits;
- memory: growth after 200,000 events with the collector down (the queue is bounded).

Reproduce:
    cd packages/sdk-python && VIRTUAL_ENV= uv run python ../../bench/sdk_overhead.py
Writes bench/results/sdk-python.json and prints a Markdown table.
"""

from __future__ import annotations

import asyncio
import gc
import json
import multiprocessing
import platform
import socket
import statistics
import subprocess
import sys
import time
import tracemalloc
from collections.abc import Callable
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import agentspace

N = 50_000
WARMUP = 2_000
RESULTS = Path(__file__).parent / "results" / "sdk-python.json"
COMMAND = "cd packages/sdk-python && VIRTUAL_ENV= uv run python ../../bench/sdk_overhead.py"


# ---------------------------------------------------------------- stub collectors


class _Up(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        out = json.dumps(
            {"accepted": len(body.get("events", [])), "duplicates": 0, "rejected": 0, "errors": []}
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self) -> None:
        out = b"{}"
        self.send_response(200)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args: Any) -> None:
        pass


def _serve_up_forever(port_out: Any) -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Up)
    port_out.put(srv.server_address[1])
    srv.serve_forever()


def _serve_stalled_forever(port_out: Any) -> None:
    """Accepts connections and never replies (a hung collector)."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(1024)
    port_out.put(sock.getsockname()[1])
    held = []
    while True:
        held.append(sock.accept()[0])


def _spawn(target: Callable[[Any], None]) -> tuple[str, Callable[[], None]]:
    """Run a stub collector in its own process, like a real one: it must not share our GIL."""
    q: Any = multiprocessing.Queue()
    proc = multiprocessing.Process(target=target, args=(q,), daemon=True)
    proc.start()
    return f"http://127.0.0.1:{q.get(timeout=10)}", proc.terminate


def serve_up() -> tuple[str, Callable[[], None]]:
    return _spawn(_serve_up_forever)


def serve_stalled() -> tuple[str, Callable[[], None]]:
    return _spawn(_serve_stalled_forever)


def refused_url() -> str:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens here now
    return f"http://127.0.0.1:{port}"


# ---------------------------------------------------------------- measurement


def pct(sorted_ns: list[int], p: float) -> float:
    i = min(len(sorted_ns) - 1, max(0, round(p / 100 * len(sorted_ns)) - 1))
    return sorted_ns[i] / 1000  # µs


def timed(fn: Callable[[], Any], n: int = N) -> dict[str, float]:
    for _ in range(WARMUP):
        fn()
    gc.collect()
    gc.disable()  # measure the SDK, not the collector of this process
    try:
        samples = []
        clock = time.perf_counter_ns
        for _ in range(n):
            t0 = clock()
            fn()
            samples.append(clock() - t0)
    finally:
        gc.enable()
    samples.sort()
    return {
        "p50_us": round(pct(samples, 50), 2),
        "p99_us": round(pct(samples, 99), 2),
        "max_us": round(samples[-1] / 1000, 1),
        "mean_us": round(statistics.fmean(samples) / 1000, 2),
    }


def ops() -> dict[str, Callable[[], Any]]:
    def emit() -> None:
        agentspace.emit("agent.status", {"status": "thinking"})

    def step() -> None:
        with agentspace.step("bench step"):
            pass

    def agent() -> None:
        with agentspace.agent("bench-agent"):
            pass

    return {"emit": emit, "step (2 events)": step, "agent scope": agent}


def run_scenario(name: str, url: str | None) -> dict[str, Any]:
    if url is None:
        agentspace.init(enabled=False, auto_instrument=False)
    else:
        agentspace.init(url=url, workspace="bench", auto_instrument=False)
    out: dict[str, Any] = {}
    with agentspace.run("bench"), agentspace.agent("bench"):
        for op, fn in ops().items():
            out[op] = timed(fn)
    out["transport"] = agentspace.stats()
    agentspace.shutdown(timeout=0.5)
    return out


async def loop_lag(
    url: str | None, events: int = 20_000, rate: int | None = None
) -> dict[str, float]:
    """Lateness of a 1 ms ticker while another coroutine emits in bursts of 100. The bursts
    themselves take time (100 emits), so compare against the disabled baseline."""
    if url is None:
        agentspace.init(enabled=False, auto_instrument=False)
    else:
        agentspace.init(url=url, workspace="bench", auto_instrument=False)
    lags: list[float] = []
    done = asyncio.Event()

    async def ticker() -> None:
        loop = asyncio.get_running_loop()
        while not done.is_set():
            t0 = loop.time()
            await asyncio.sleep(0.001)
            lags.append((loop.time() - t0 - 0.001) * 1000)

    async def producer() -> None:
        async with agentspace.run("bench-async"), agentspace.agent("bench"):
            for i in range(events):
                agentspace.emit("agent.status", {"status": "thinking"})
                if rate is not None:
                    await asyncio.sleep(1 / rate)  # a steady app: one event per tick
                elif i % 100 == 99:
                    await asyncio.sleep(0)  # flat out: 100 events between yields
        done.set()

    await asyncio.gather(ticker(), producer())
    agentspace.shutdown(timeout=0.5)
    lags.sort()
    return {
        "ticks": len(lags),
        "p50_ms": round(lags[len(lags) // 2], 2),
        "p99_ms": round(lags[max(0, int(len(lags) * 0.99) - 1)], 2),
        "max_ms": round(lags[-1], 2),
        "switch_interval_ms": sys.getswitchinterval() * 1000,
    }


def memory_when_down(events: int = 200_000) -> dict[str, Any]:
    agentspace.init(url=refused_url(), workspace="bench", auto_instrument=False)
    gc.collect()
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    with agentspace.run("bench-mem"), agentspace.agent("bench"):
        for _ in range(events):
            agentspace.emit("agent.status", {"status": "thinking"})
    gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    stats = agentspace.stats()
    agentspace.shutdown(timeout=0.2)
    return {
        "events": events,
        "retained_mb": round((current - base) / 1e6, 1),
        "peak_mb": round((peak - base) / 1e6, 1),
        "dropped": stats["dropped"],
        "pending": stats["pending"],
    }


def machine() -> dict[str, str]:
    def sysctl(key: str) -> str:
        try:
            return subprocess.run(
                ["sysctl", "-n", key], capture_output=True, text=True, timeout=2
            ).stdout.strip()
        except Exception:
            return ""

    mem = sysctl("hw.memsize")
    return {
        "cpu": sysctl("machdep.cpu.brand_string") or platform.processor() or platform.machine(),
        "cores": sysctl("hw.ncpu") or str(__import__("os").cpu_count()),
        "memory_gb": str(round(int(mem) / 2**30)) if mem.isdigit() else "",
        "os": platform.platform(terse=True),
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
    }


def main() -> int:
    up_url, stop_up = serve_up()
    stalled_url, stop_stalled = serve_stalled()
    scenarios = {
        "disabled (baseline)": None,
        "collector up": up_url,
        "collector down": refused_url(),
        "collector stalled": stalled_url,
    }
    results: dict[str, Any] = {
        "when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": COMMAND,
        "sdk_version": getattr(agentspace, "__version__", "?"),
        "machine": machine(),
        "calls_per_op": N,
        "latency": {},
        "event_loop": {},
    }
    for name, url in scenarios.items():
        print(f"latency: {name} ...", file=sys.stderr)
        results["latency"][name] = run_scenario(name, url)
    for name in ("disabled (baseline)", "collector up", "collector stalled"):
        print(f"event loop: {name} ...", file=sys.stderr)
        results["event_loop"][f"{name}, 20k events flat out"] = asyncio.run(
            loop_lag(scenarios[name])
        )
        results["event_loop"][f"{name}, 1,000 events/s for 3 s"] = asyncio.run(
            loop_lag(scenarios[name], 3_000, rate=1_000)
        )
    print("memory with the collector down ...", file=sys.stderr)
    results["memory_down"] = memory_when_down()
    stop_up()
    stop_stalled()

    RESULTS.parent.mkdir(exist_ok=True)
    RESULTS.write_text(json.dumps(results, indent=1) + "\n")

    m = results["machine"]
    where = f"{m['cpu']}, {m['cores']} cores, {m['memory_gb']} GB, {m['os']}"
    print(f"\nPython SDK overhead: {where}, Python {m['python']}\n")
    print("| Collector | Call | p50 | p99 | max |")
    print("|---|---|---|---|---|")
    for name, ops_ in results["latency"].items():
        for op, r in ops_.items():
            if op != "transport":
                print(
                    f"| {name} | `{op}` | {r['p50_us']} µs | {r['p99_us']} µs | {r['max_us']} µs |"
                )
    print("\n| Event loop (1 ms ticker) while emitting | ticks | p50 late | p99 late | max late |")
    print("|---|---|---|---|---|")
    for name, r in results["event_loop"].items():
        print(f"| {name} | {r['ticks']} | {r['p50_ms']} ms | {r['p99_ms']} ms | {r['max_ms']} ms |")
    md = results["memory_down"]
    print(
        f"\nMemory, collector down, {md['events']:,} events: {md['retained_mb']} MB retained, "
        f"{md['dropped']:,} oldest dropped, {md['pending']:,} buffered."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
