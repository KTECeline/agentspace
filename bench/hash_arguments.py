"""Cost of the tool-arguments hash (D-044), per call, on typical and worst-case arguments.

cd packages/sdk-python && uv run python ../../bench/hash_arguments.py
"""

from __future__ import annotations

import gc
import platform
import statistics
import time

from agentspace import hash_arguments

CASES = {
    "small dict (2 keys)": {"path": "cart.py", "line": 12},
    "1 KB dict": {"query": "x" * 1000},
    "JSON string (OpenAI style)": '{"invoice_id": "42", "reason": "duplicate charge"}',
    "1 MB file body": {"path": "app.py", "content": "x" * 1_000_000},
    "5 MB string": "z" * 5_000_000,
    "40,000-row list": {"rows": [{"id": i, "v": "abcdefgh"} for i in range(40_000)]},
    "40,000-key dict": {f"k{i}": i for i in range(40_000)},
}


def main() -> None:
    print(f"Python {platform.python_version()} on {platform.machine()}")
    print(f"{'arguments':30s} {'p50':>10s} {'p99':>10s}")
    for name, value in CASES.items():
        n = 2000 if len(str(value)) < 10_000 else 200
        for _ in range(50):
            hash_arguments(value)
        samples = []
        gc.disable()
        for _ in range(n):
            t = time.perf_counter_ns()
            hash_arguments(value)
            samples.append(time.perf_counter_ns() - t)
        gc.enable()
        samples.sort()
        p50 = statistics.median(samples) / 1000
        p99 = samples[int(len(samples) * 0.99) - 1] / 1000
        print(f"{name:30s} {p50:8.1f} us {p99:8.1f} us")


if __name__ == "__main__":
    main()
