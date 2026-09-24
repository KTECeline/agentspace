# UI load benchmark

**Question:** does the 3D office stay smooth with **50 agents at 100 events/s**? The target is about 60 fps.

**Method.** `/demo?stress=50&rate=100` drives the office with a synthetic team, with no collector. It runs through the same message path as a live collector (frame-batched store, Projector). Adding `&bench=20` waits 5 s for things to settle, then records the interval between every rendered frame for 20 s. The result is shown on the page, printed to the console as `[agentspace-bench] {...}`, and stored in `window.__agentspaceBench`.

## Reproduce

Use a **production build**. Dev mode is about 25% slower.

```bash
cd web && pnpm build && pnpm exec next start -p 4812
```

Then open http://localhost:4812/demo?stress=50&rate=100&bench=20 in a normal browser window. Keep it **focused and visible** for 25 s: browsers throttle animation frames in background or occluded windows, which makes the number meaningless. Read the line at the bottom left of the office.

## Results

| Machine | Browser | Window | fps | frame p50 | p95 | p99 | slow frames (>25 ms) |
|---|---|---|---|---|---|---|---|
| Apple M4, 16 GB, macOS 26.6.2 | _pending: run by hand in a focused window_ | | | | | | |

Earlier measurement (Phase 2, same build setup, FPS meter only): **58–60 fps** on the dev MacBook Air (see DECISIONS D-022 and PROGRESS).

**Why this isn't automated.** Browser automation drives an unfocused window, where Chrome delivers animation frames only every few seconds. Run that way, the benchmark reports about 1 fps, which measures the throttling, not the office. So the published number comes from a person running it in a focused window.
