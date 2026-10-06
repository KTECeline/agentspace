import type { RunStats } from "@agentspace/spec-types";
import { formatDuration, formatTokens } from "@/lib/format";
import { Cost } from "../Cost";

/** Same colors as the run summary in the office header. */
const RUN_STATUS = { running: "thinking", ok: "done", cancelled: "waiting", error: "error" } as const;

export function RunsTable({ runs, replayHref, compareHref }: { runs: RunStats[]; replayHref?: (runId: string) => string; compareHref?: (runId: string) => string }) {
  if (!runs.length) return <p className="text-sm text-muted">No runs in this period.</p>;
  return (
    <div className="max-h-[28rem] overflow-auto pr-3 [scrollbar-gutter:stable]">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
          <tr>
            <th className="py-1.5 pr-4 font-medium">Run</th>
            <th className="py-1.5 pr-4 font-medium">Started</th>
            <th className="py-1.5 pr-4 text-right font-medium">Duration</th>
            <th className="py-1.5 pr-4 text-right font-medium">Calls</th>
            <th className="py-1.5 pr-4 text-right font-medium">Tokens</th>
            <th className="py-1.5 pr-4 text-right font-medium">Errors</th>
            <th className="py-1.5 text-right font-medium">Cost</th>
            {replayHref && (
              <th className="py-1.5 pl-4 font-medium">
                <span className="sr-only">Replay</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {runs.map((r) => (
            <tr key={r.run_id} className="border-t border-border">
              <td className="max-w-64 py-1.5 pr-4">
                <span data-status={RUN_STATUS[r.status]} className="inline-flex max-w-full items-center gap-1.5">
                  <span aria-hidden className="status-dot size-2 shrink-0 rounded-full bg-[var(--st-dot)]" />
                  <span className="truncate font-medium" title={r.run_id}>
                    {r.name ?? r.run_id.slice(0, 8)}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{r.status}</span>
                </span>
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-muted">{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</td>
              <td className="py-1.5 pr-4 text-right">{r.duration_ms != null ? formatDuration(r.duration_ms) : "—"}</td>
              <td className="py-1.5 pr-4 text-right">{r.calls.toLocaleString()}</td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-right">
                {formatTokens(r.tokens_in)}→{formatTokens(r.tokens_out)}
              </td>
              <td className="py-1.5 pr-4 text-right">{r.errors || "—"}</td>
              <td className="whitespace-nowrap py-1.5 text-right font-mono">
                <Cost totals={r} />
              </td>
              {replayHref && (
                <td className="whitespace-nowrap py-1.5 pl-4">
                  <a
                    href={replayHref(r.run_id)}
                    className="rounded text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Replay<span className="sr-only"> {r.name ?? r.run_id}</span>
                  </a>
                  {compareHref && (
                    <a
                      href={compareHref(r.run_id)}
                      title="Compare with the latest successful run of the same workflow"
                      className="ml-3 rounded text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Compare<span className="sr-only"> {r.name ?? r.run_id}</span>
                    </a>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
