"use client";

import { useEffect, useRef, useState } from "react";
import type { StatsResponse } from "@agentspace/spec-types";
import { fillDays, formatUsdTicks, niceTicks } from "@/lib/chart";
import { formatCost } from "@/lib/format";

type Day = StatsResponse["by_day"][number];

const H = 200; // plot height, px
const AXIS_W = 56;
const BAR_MAX = 24;
const GAP = 2;

/** Cost per UTC day: one column per day, with a per-bar tooltip and a table view. */
export function DayChart({ days }: { days: Day[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setBoxWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);
  const data = fillDays(days, (day) => ({ day, calls: 0, cost_usd: 0, cost_estimated_usd: 0 }));

  if (!data.length) return <p className="text-sm text-muted">No model calls in this period.</p>;

  const ticks = niceTicks(Math.max(...data.map((d) => d.cost_usd)));
  const tickLabels = formatUsdTicks(ticks);
  const top = ticks[ticks.length - 1]! || 1;
  // Fill the card; scroll sideways only when days get narrower than 8px.
  const slot = Math.max(8, (boxWidth - AXIS_W) / data.length);
  const bar = Math.min(BAR_MAX, Math.max(4, slot - 2 * GAP - 4));
  const width = AXIS_W + slot * data.length;
  const labelEvery = Math.ceil((data.length * 44) / Math.max(1, width - AXIS_W));
  const current = active !== null ? data[active] : undefined;

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="h-8 rounded-md border border-border px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      {asTable ? (
        <DayTable data={data} />
      ) : (
        <div ref={box} className="relative overflow-x-auto">
          <svg width={width} height={H + 28} role="group" aria-label="Cost per day" className="block text-muted" onMouseLeave={() => setActive(null)}>
            {ticks.map((t, ti) => {
              const y = H - (t / top) * H + 4;
              return (
                <g key={t}>
                  <line x1={AXIS_W} x2={width} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={1} />
                  <text x={AXIS_W - 8} y={y} dy="0.32em" textAnchor="end" className="fill-current text-[11px] tabular-nums">
                    {tickLabels[ti]}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const h = d.cost_usd > 0 ? Math.max(2, (d.cost_usd / top) * H) : 0;
              const x = AXIS_W + i * slot + (slot - bar) / 2;
              const y = H - h + 4;
              const r = Math.min(4, h / 2, bar / 2);
              return (
                <g key={d.day}>
                  {h > 0 && (
                    // 4px rounded data-end, square at the baseline.
                    <path
                      d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bar - r} Q${x + bar},${y} ${x + bar},${y + r} V${y + h} Z`}
                      fill="var(--chart-bar)"
                      opacity={active === null || active === i ? 1 : 0.55}
                    />
                  )}
                  {/* Hit target: the whole column, bigger than the mark. */}
                  <rect
                    x={AXIS_W + i * slot}
                    y={0}
                    width={slot}
                    height={H + 4}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={`${d.day}: ${formatCost(d.cost_usd)}${d.cost_estimated_usd > 0 ? " (includes estimates)" : ""}, ${d.calls} calls`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className="outline-none focus-visible:stroke-[var(--ring)] focus-visible:stroke-2"
                  />
                  {i % labelEvery === 0 && (
                    <text x={AXIS_W + i * slot + slot / 2} y={H + 22} textAnchor="middle" className="fill-current text-[11px] tabular-nums">
                      {d.day.slice(5)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {current && active !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 z-10 w-max max-w-56 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-sm"
              style={{ left: Math.min(AXIS_W + active * slot + slot / 2 + 8, width - 180) }}
            >
              <p className="font-medium text-foreground">{current.day}</p>
              <p className="tabular-nums text-foreground">{formatCost(current.cost_usd)}</p>
              {current.cost_estimated_usd > 0 && <p className="text-muted">{formatCost(current.cost_estimated_usd)} estimated</p>}
              <p className="text-muted">{current.calls.toLocaleString()} model calls</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DayTable({ data }: { data: Day[] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 pr-4 font-medium">Day (UTC)</th>
            <th className="py-1 pr-4 text-right font-medium">Cost</th>
            <th className="py-1 pr-4 text-right font-medium">Estimated</th>
            <th className="py-1 text-right font-medium">Calls</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {data.map((d) => (
            <tr key={d.day} className="border-t border-border">
              <td className="py-1 pr-4">{d.day}</td>
              <td className="py-1 pr-4 text-right">{formatCost(d.cost_usd)}</td>
              <td className="py-1 pr-4 text-right">{formatCost(d.cost_estimated_usd)}</td>
              <td className="py-1 text-right">{d.calls.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
