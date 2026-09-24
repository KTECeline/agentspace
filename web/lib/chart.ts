/** Small, pure helpers for the dashboard charts (tested in tests/chart.test.ts). */

/** Evenly spaced round ticks from 0 that cover `max` (for example 0, 0.05, 0.1, 0.15). */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0];
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough * (1 - 1e-9)) ?? 10 * pow);
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/**
 * Axis labels for dollar ticks, all with the same decimals: $0, $0.05, $0.10 or $0, $250, $1.2K.
 * `ticks` are the output of niceTicks (evenly spaced from 0).
 */
export function formatUsdTicks(ticks: number[]): string[] {
  const step = ticks[1] ?? 0;
  const top = ticks[ticks.length - 1] ?? 0;
  if (top >= 1000) return ticks.map((t) => (t === 0 ? "$0" : `$${Number((t / 1000).toPrecision(3))}K`));
  const decimals = step >= 1 && Number.isInteger(step) ? 0 : Math.max(2, -Math.floor(Math.log10(step || 1) + 1e-9));
  return ticks.map((t) => (t === 0 ? "$0" : `$${t.toFixed(decimals)}`));
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatPercent(ratio: number | null): string {
  if (ratio === null) return "—";
  const pct = ratio * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Every UTC day from the first to the last in `days` (YYYY-MM-DD), so gaps show as empty. */
export function fillDays<T extends { day: string }>(days: T[], empty: (day: string) => T): T[] {
  if (days.length < 2) return days;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: T[] = [];
  const end = Date.parse(`${days[days.length - 1]!.day}T00:00:00Z`);
  for (let t = Date.parse(`${days[0]!.day}T00:00:00Z`); t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? empty(day));
  }
  return out;
}
