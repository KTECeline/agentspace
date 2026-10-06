# Benchmarks

What AgentSpace costs your app, and how the office holds up under load. Raw results are in [`results/`](results).

**Machine for every number below:** Apple M4 (10 cores), 16 GB RAM, macOS 26.6.2 (Darwin 25.6.0), a normal desktop session with other apps open. Python 3.12.13 (CPython), Node v22.17.0, uv 0.11.26, pnpm 10.13.1. Run on 2026-09-24/25.

**The target** (from the brief): under 1 ms per event at p99, and never blocking the host.

## SDK overhead

**Method.** Each call runs 50,000 times after 2,000 warm-up calls, timed one by one on the calling thread (Python: `perf_counter_ns`, with the garbage collector paused while timing; Node: `process.hrtime.bigint`). Four collector setups:

- **disabled**: `init(enabled=False)`, the baseline;
- **up**: a stub collector that answers every request, run in its own process like a real one;
- **down**: nothing listening (connection refused);
- **stalled**: a stub that accepts connections and never replies.

`step` records two events (start and finish); `agent` registers the agent, sets its status and checks for pause/cancel.

### Python

```bash
cd packages/sdk-python && VIRTUAL_ENV= uv run python ../../bench/sdk_overhead.py
```

| Collector | Call | p50 | p99 | max |
|---|---|---|---|---|
| disabled | `emit` | 0.17 µs | 0.21 µs | 3.9 µs |
| disabled | `step` | 2.9 µs | 3.7 µs | 56 µs |
| disabled | `agent` | 6.2 µs | 8.0 µs | 96 µs |
| **up** | `emit` | 4.0 µs | **116 µs** | 0.5 ms |
| **up** | `step` | 13 µs | **147 µs** | 12.8 ms |
| **up** | `agent` | 37 µs | **242 µs** | 9.6 ms |
| down | `emit` | 3.6 µs | 4.6 µs | 80 µs |
| down | `step` | 10 µs | 16 µs | 0.26 ms |
| down | `agent` | 26 µs | 34 µs | 0.31 ms |
| stalled | `emit` | 3.6 µs | 4.6 µs | 81 µs |
| stalled | `step` | 10 µs | 16 µs | 0.27 ms |
| stalled | `agent` | 26 µs | 41 µs | 2.5 ms |

**Every p99 is under 1 ms; the worst is 242 µs.** p99 is higher with the collector *up* because the background sender thread is busy serializing batches and competes for the GIL. When the collector is down or stalled, the sender mostly waits on sockets, which releases the GIL.

**Event loop.** A 1 ms asyncio ticker runs while another coroutine emits, and we record how late the ticker wakes up:

| While emitting | p50 late | p99 late | max late |
|---|---|---|---|
| disabled, 1,000 events/s for 3 s | 0.18 ms | 1.15 ms | 12.4 ms |
| **up**, 1,000 events/s for 3 s | 0.18 ms | **0.72 ms** | 16.8 ms |
| stalled, 1,000 events/s for 3 s | 0.21 ms | 1.61 ms | 89 ms |
| disabled, 20,000 events flat out | 0.06 ms | 0.07 ms | 0.13 ms |
| **up**, 20,000 events flat out | 1.55 ms | **6.64 ms** | 8.2 ms |
| stalled, 20,000 events flat out | 0.91 ms | 1.48 ms | 3.0 ms |

At a steady 1,000 events/s the SDK is indistinguishable from the baseline. Emitting 20,000 events as fast as possible, the loop can wait a few milliseconds. The SDK never does blocking I/O on the loop; the wait is CPU time the sender thread holds under the GIL, bounded by the interpreter's switch interval (5 ms by default, `sys.setswitchinterval`).

**Max values are mostly noise from a laptop's scheduler.** The *disabled* baseline alone ranged from 3 to 13 ms max lateness across runs, and the stalled case measured 21 ms and 89 ms in two identical runs. Read p50 and p99.

**Memory with the collector down.** After 200,000 events, 6.0 MB is retained: the queue holds the newest 10,000 events (`max_queue`) and drops the 190,000 oldest, with one warning.

### TypeScript

```bash
pnpm --filter agentspace-sdk build && node --expose-gc bench/sdk_overhead.mjs
```

| Collector | Call | p50 | p99 | max |
|---|---|---|---|---|
| disabled | `emit` | 0.04 µs | 0.08 µs | 0.36 ms |
| disabled | `step` | 0.33 µs | 2.2 µs | 0.51 ms |
| disabled | `agent` | 0.88 µs | 2.8 µs | 0.43 ms |
| **up** | `emit` | 1.1 µs | **4.0 µs** | 2.8 ms |
| **up** | `step` | 3.0 µs | **8.0 µs** | 2.4 ms |
| **up** | `agent` | 7.1 µs | **11 µs** | 1.4 ms |
| down | `emit` | 1.1 µs | 2.5 µs | 1.7 ms |
| down | `step` | 3.1 µs | 8.8 µs | 4.2 ms |
| down | `agent` | 7.4 µs | 20 µs | 2.3 ms |
| stalled | `emit` | 1.1 µs | 1.8 µs | 1.1 ms |
| stalled | `step` | 3.0 µs | 4.5 µs | 1.2 ms |
| stalled | `agent` | 7.4 µs | 13 µs | 1.9 ms |

**Every p99 is under 21 µs.** Max values are V8 garbage-collection pauses; the disabled baseline shows them too.

**Event-loop delay** (`perf_hooks.monitorEventLoopDelay`, 1 ms resolution, so about 1 ms is the floor):

| While emitting | p50 | p99 | max |
|---|---|---|---|
| disabled, 1,000 events/s for 3 s | 1.17 ms | 1.99 ms | 6.1 ms |
| **up**, 1,000 events/s for 3 s | 1.17 ms | **2.22 ms** | 4.3 ms |
| stalled, 1,000 events/s for 3 s | 1.19 ms | 1.82 ms | 11.2 ms |
| disabled, 20,000 events flat out | 0.99 ms | 1.03 ms | 1.0 ms |
| **up**, 20,000 events flat out | 0.99 ms | **4.85 ms** | 8.0 ms |
| stalled, 20,000 events flat out | 1.0 ms | 2.2 ms | 2.2 ms |

Node has one thread, so batches are serialized and sent on it: flat out, that shows up as a few milliseconds at p99. At a steady rate it matches the baseline.

**Heap with the collector down:** +4.1 MB after 200,000 events (10,000 buffered, 190,000 oldest dropped).

### Argument hashing

Adapters add a keyed hash of each tool call's arguments (`arguments_hash`, D-044). It runs once per tool call, inside the framework's callback, so its cost matters for big arguments. Long strings are reduced to a digest of their first 256K characters and nested structures are read up to 500 values, so the cost has a ceiling. Same machine, 2026-10-06, `bench/hash_arguments.py`:

| Arguments | p50 | p99 |
|---|---|---|
| small dict (2 keys) | 3.5 µs | 4.8 µs |
| 1 KB dict | 2.8 µs | 5.8 µs |
| JSON string (OpenAI style) | 4.1 µs | 7.8 µs |
| 1 MB file body | 90 µs | 114 µs |
| 5 MB string | 96 µs | 160 µs |
| 40,000-row list | 397 µs | 465 µs |
| 40,000-key dict | 487 µs | 581 µs |

Every case is under the 1 ms target at p99. `init(hash_arguments=False)` turns it off.

```bash
cd packages/sdk-python && VIRTUAL_ENV= uv run python ../../bench/hash_arguments.py
```

## UI load

See [ui_load.md](ui_load.md).
