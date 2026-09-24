/** Frame-time statistics for the UI load benchmark (`/demo?stress=50&bench=20`). Pure; tested. */
export interface FrameStats {
  frames: number;
  seconds: number;
  fps: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  /** Frames that took longer than 1.5x a 60 Hz frame (a visible hitch). */
  slow_frames: number;
}

export function frameStats(intervalsMs: number[]): FrameStats {
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const total = intervalsMs.reduce((a, b) => a + b, 0);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    frames: sorted.length,
    seconds: r(total / 1000),
    fps: total ? r((sorted.length * 1000) / total) : 0,
    p50_ms: r(at(50)),
    p95_ms: r(at(95)),
    p99_ms: r(at(99)),
    max_ms: r(sorted.at(-1) ?? 0),
    slow_frames: sorted.filter((ms) => ms > 25).length,
  };
}
