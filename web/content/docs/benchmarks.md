# Benchmarks

The target: under **1 ms per event at p99**, and never blocking your app.

Measured on an Apple M4 (10 cores, 16 GB, macOS 26.6.2) with Python 3.12.13 and Node 22.17.0. Every number, and the command that reproduces it, is in [`bench/README.md`](https://github.com/KTECeline/agentspace/blob/main/bench/README.md).

## Cost per call, with a collector running

| SDK | `emit` p99 | `step` p99 | `agent` p99 |
|---|---|---|---|
| Python | 116 µs | 147 µs | 242 µs |
| TypeScript | 4 µs | 8 µs | 11 µs |

With the collector **down** or **stalled** (accepting connections and never answering), calls get *cheaper*: under 45 µs at p99 in Python and under 21 µs in TypeScript. Sending happens on a background thread (Python) or asynchronously (Node), and the caller only appends to a bounded queue.

## Event loop

At a steady 1,000 events per second, a 1 ms ticker's lateness with AgentSpace is the same as without it. Emitting 20,000 events as fast as possible, the loop can wait a few milliseconds at p99: that's the sender's CPU time (the Python GIL, or Node's single thread), never blocking I/O.

## Memory

With the collector down, 200,000 events leave 6 MB (Python) or 4 MB (Node): the newest 10,000 are buffered and the oldest dropped, with one warning.

## The office

50 agents at 100 events per second: see [`bench/ui_load.md`](https://github.com/KTECeline/agentspace/blob/main/bench/ui_load.md), and try it yourself at `/demo?stress=50&rate=100&bench=20`.
