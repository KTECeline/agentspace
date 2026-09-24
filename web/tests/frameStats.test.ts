import { describe, expect, it } from "vitest";
import { frameStats } from "../lib/frameStats";

describe("frameStats", () => {
  it("summarizes frame intervals", () => {
    const steady = Array.from({ length: 600 }, () => 1000 / 60);
    expect(frameStats(steady)).toMatchObject({ frames: 600, seconds: 10, fps: 60, p50_ms: 16.7, p99_ms: 16.7, slow_frames: 0 });
    const hitchy = [...steady.slice(0, 588), ...Array.from({ length: 11 }, () => 40), 100]; // 2% slow
    expect(frameStats(hitchy)).toMatchObject({ p95_ms: 16.7, p99_ms: 40, max_ms: 100, slow_frames: 12 });
    expect(frameStats([])).toMatchObject({ frames: 0, fps: 0, max_ms: 0 });
  });
});
