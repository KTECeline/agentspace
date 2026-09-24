import type { ToolStats } from "@agentspace/spec-types";
import { formatMs } from "@/lib/chart";

export function ToolsTable({ tools }: { tools: ToolStats[] }) {
  if (!tools.length) return <p className="text-sm text-muted">No timed tool calls in this period.</p>;
  const max = Math.max(...tools.map((t) => t.p95_ms ?? 0)) || 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1.5 pr-4 font-medium">Tool</th>
            <th className="w-1/3 py-1.5 pr-4 font-medium">
              <span className="sr-only">p95 bar</span>
            </th>
            <th className="py-1.5 pr-4 text-right font-medium">p50</th>
            <th className="py-1.5 pr-4 text-right font-medium">p95</th>
            <th className="py-1.5 pr-4 text-right font-medium">Max</th>
            <th className="py-1.5 pr-4 text-right font-medium">Calls</th>
            <th className="py-1.5 text-right font-medium">Errors</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {tools.map((t) => (
            <tr key={t.tool_name} className="border-t border-border">
              <td className="max-w-56 truncate py-1.5 pr-4 font-mono text-[13px]" title={t.tool_name}>
                {t.tool_name}
              </td>
              <td className="py-1.5 pr-4" aria-hidden>
                <div className="h-3 rounded-r-[4px] bg-chart-bar" style={{ width: `${Math.max(1, ((t.p95_ms ?? 0) / max) * 100)}%` }} />
              </td>
              <td className="py-1.5 pr-4 text-right">{formatMs(t.p50_ms)}</td>
              <td className="py-1.5 pr-4 text-right">{formatMs(t.p95_ms)}</td>
              <td className="py-1.5 pr-4 text-right">{formatMs(t.max_ms)}</td>
              <td className="py-1.5 pr-4 text-right">{t.calls.toLocaleString()}</td>
              <td className="py-1.5 text-right">{t.errors ? `${t.errors} (${Math.round((t.errors / t.calls) * 100)}%)` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
