import type { CostTotals } from "@/lib/format";
import { Cost } from "../Cost";

export interface BarRow {
  key: string;
  name: string;
  detail: string;
  totals: CostTotals;
}

/** A ranked table with an inline magnitude bar: the table is the chart (and its own table view). */
export function BarTable({ label, rows, mono }: { label: string; rows: BarRow[]; mono?: boolean }) {
  if (!rows.length) return <p className="text-sm text-muted">No model calls in this period.</p>;
  const max = Math.max(...rows.map((r) => r.totals.cost_usd)) || 1;
  const shown = rows.slice(0, 12);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>{label}</th>
            <th>Share</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className="border-t border-border first:border-t-0">
              <td className="max-w-0 py-2 pr-3 sm:w-2/5">
                <p className={`truncate ${mono ? "font-mono text-[13px]" : "font-medium"}`} title={r.name}>
                  {r.name}
                </p>
                <p className="truncate text-xs text-muted">{r.detail}</p>
              </td>
              <td className="hidden w-2/5 py-2 pr-3 sm:table-cell" aria-hidden>
                <div className="h-3 rounded-r bg-transparent">
                  {r.totals.cost_usd > 0 && (
                    <div className="h-3 rounded-r-[4px] bg-chart-bar" style={{ width: `${Math.max(1, (r.totals.cost_usd / max) * 100)}%` }} />
                  )}
                </div>
              </td>
              <td className="whitespace-nowrap py-2 text-right font-mono tabular-nums">
                <Cost totals={r.totals} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p className="mt-2 text-xs text-muted">and {rows.length - shown.length} more</p>}
    </div>
  );
}
