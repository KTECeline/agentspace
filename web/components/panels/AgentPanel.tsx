"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, ScrollText, X } from "lucide-react";
import type { StoredEvent } from "@agentspace/spec-types";
import { currentStep, findingsFor, toolCalls } from "@/lib/agentDetail";
import { clock, costInfo, describe, evidenceRows, formatDuration, formatTokens, teamLabel, timeAgo } from "@/lib/format";
import { Cost } from "../Cost";
import { useOffice } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { useThrottled } from "@/lib/useThrottled";
import { FindingBadge } from "../FindingBadge";
import { StatusBadge } from "../StatusBadge";
import { ApprovalCard } from "../operator/Approvals";

const EMPTY: StoredEvent[] = [];

/** Details for the selected agent: status, current step, tool calls, and its own live log. */
export function AgentPanel({ agentId, onShowInLog }: { agentId: string; onShowInLog: (agentId: string) => void }) {
  const agent = useOffice((s) => s.agents[agentId]);
  const events = useThrottled(useOffice((s) => s.agentEvents[agentId] ?? EMPTY), 250);
  const select = useOffice((s) => s.select);
  const now = useNow();
  const heading = useRef<HTMLHeadingElement>(null);
  const [hideStatus, setHideStatus] = useState(true);
  const approvalMap = useOffice((s) => s.approvals);
  const approvals = useMemo(
    () => Object.values(approvalMap).filter((a) => a.agent_id === agentId && a.status === "pending"),
    [approvalMap, agentId],
  );

  // Move focus into the panel when it opens (important when it was opened from the 3D canvas).
  useEffect(() => {
    heading.current?.focus();
  }, [agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const step = useMemo(() => currentStep(events, agentId), [events, agentId]);
  const tools = useMemo(() => toolCalls(events, agentId), [events, agentId]);
  const runId = agent?.current_run_id ?? null;
  const findings = useMemo(() => findingsFor(events, agentId, runId), [events, agentId, runId]);
  const log = useMemo(() => {
    const out: StoredEvent[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < 60; i--) {
      const e = events[i]!;
      if (hideStatus && (e.type === "agent.status" || e.type.startsWith("step."))) continue;
      out.push(e);
    }
    return out;
  }, [events, hideStatus]);

  const priceAsOf = useMemo(() => latestPriceAsOf(events), [events]);

  if (!agent) return null;
  const { note } = costInfo(agent);
  const costNote = note && priceAsOf && agent.cost_estimated_usd > 0 ? `${note} Prices as of ${priceAsOf}.` : note;

  return (
    <section aria-labelledby="agent-panel-title" className="flex max-h-[70vh] min-h-0 flex-col rounded-xl border border-border bg-surface lg:max-h-none">
      <header className="flex items-start gap-3 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <h2 id="agent-panel-title" ref={heading} tabIndex={-1} className="truncate font-display text-lg font-semibold outline-none">
            {agent.name}
          </h2>
          <p className="truncate text-sm text-muted">
            {teamLabel(agent.team_id ?? "")}
            {agent.role ? ` · ${agent.role}` : ""}
            {agent.framework ? ` · ${agent.framework}` : ""}
          </p>
        </div>
        <FindingBadge count={agent.findings} className="mt-1" />
        <StatusBadge status={agent.status} />
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close agent details"
          className="-mr-2 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border p-4 text-sm sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          <Stat label="Tokens" value={`${formatTokens(agent.tokens_in)}→${formatTokens(agent.tokens_out)}`} />
          <div className="min-w-0">
            <dt className="text-xs text-muted">Cost</dt>
            <dd className="truncate font-mono tabular-nums">
              <Cost totals={agent} />
            </dd>
          </div>
          <Stat label="Model" value={agent.model ?? "—"} />
          <Stat label="Active" value={timeAgo(agent.last_event_at, now)} />
        </dl>
        {costNote && <p className="border-b border-border px-4 py-2 text-xs text-muted">{costNote}</p>}

        {approvals.length > 0 && (
          <div className="flex flex-col gap-2 border-b border-border p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Waiting for you</h3>
            {approvals.map((a) => (
              <ApprovalCard key={a.approval_id} approval={a} showAgent={false} />
            ))}
          </div>
        )}

        {findings.length > 0 && (
          <div className="flex flex-col gap-2 border-b border-border p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Findings in this run</h3>
            {findings.map((f) => (
              <article key={f.id} data-status={f.severity === "critical" ? "error" : "using_tool"} className="rounded-lg border border-[var(--st-dot)] bg-[var(--st-bg)] p-3">
                <p className="text-sm font-medium text-[var(--st-fg)]">
                  {f.message}
                  {f.severity === "critical" && <span className="ml-1.5 text-xs font-semibold uppercase">critical</span>}
                </p>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {evidenceRows(f.evidence)
                    .filter(([label]) => label !== "Tool")
                    .map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-muted">{label}</dt>
                        <dd className="min-w-0 break-words font-mono tabular-nums">{value}</dd>
                      </div>
                    ))}
                </dl>
                <p className="mt-1.5 text-xs text-muted">
                  {f.detector.replace(/_/g, " ")} · {clock(f.ts).slice(0, 8)}
                </p>
              </article>
            ))}
          </div>
        )}

        <div className="border-b border-border p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Now</h3>
          {step ? (
            <p className="text-sm">
              <span className="font-medium">{step.name}</span>
              <span className="text-muted"> · {formatDuration(Math.max(0, now - Date.parse(step.startedAt)))}</span>
              {agent.status_detail && <span className="block text-muted">{agent.status_detail}</span>}
            </p>
          ) : (
            <p className="text-sm text-muted">{agent.last_summary ? `Last: ${agent.last_summary}` : "Not working on anything right now."}</p>
          )}
        </div>

        <div className="border-b border-border p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Tool calls</h3>
          {tools.length === 0 ? (
            <p className="text-sm text-muted">No tool calls yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {tools.map((t) => (
                <li key={t.callId} className="flex items-center gap-2 text-sm">
                  <ToolState state={t.state} />
                  <span className="truncate font-mono">{t.tool}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted">
                    {t.state === "running" ? "running" : t.durationMs != null ? formatDuration(t.durationMs) : ""}
                  </span>
                  {t.error && <span className="sr-only">Error: {t.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="mr-auto text-xs font-semibold uppercase tracking-wide text-muted">Activity</h3>
            <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-surface-2">
              <input type="checkbox" checked={hideStatus} onChange={(e) => setHideStatus(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              Hide status
            </label>
            <button
              type="button"
              onClick={() => onShowInLog(agentId)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ScrollText aria-hidden className="size-4" />
              Full log
            </button>
          </div>
          {log.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ol className="flex flex-col font-mono text-xs">
              {log.map((e) => (
                <li key={e.seq} className="grid grid-cols-[auto_1fr] gap-x-3 border-b border-border/60 py-1.5 last:border-0">
                  <time dateTime={e.ts} className="tabular-nums text-muted">
                    {clock(e.ts).slice(0, 8)}
                  </time>
                  <span className="break-words font-sans text-sm">{describe(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-mono tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ToolState({ state }: { state: "running" | "ok" | "failed" }) {
  const tone = state === "running" ? "using_tool" : state === "ok" ? "done" : "error";
  return (
    <span data-status={tone} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--st-bg)] text-[var(--st-fg)]">
      {state === "running" ? (
        <Loader2 aria-label="Running" className="size-3 motion-safe:animate-spin" />
      ) : state === "ok" ? (
        <Check aria-label="Succeeded" className="size-3" />
      ) : (
        <X aria-label="Failed" className="size-3" />
      )}
    </span>
  );
}

/** The price-table date on the newest estimated call (the collector stamps it, D-038). */
function latestPriceAsOf(events: StoredEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const asOf = events[i]!.attributes?.["agentspace.price_as_of"];
    if (typeof asOf === "string") return asOf;
  }
  return null;
}
