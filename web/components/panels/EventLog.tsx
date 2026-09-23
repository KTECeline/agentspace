"use client";

import { useMemo, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import type { AgentState, StoredEvent } from "@agentspace/spec-types";
import { clock, describe } from "@/lib/format";

interface Props {
  events: StoredEvent[];
  agents: AgentState[];
  agentFilter: string | null;
  onAgentFilter: (agentId: string | null) => void;
}

const TYPE_TONE: Partial<Record<StoredEvent["type"], string>> = {
  error: "error",
  handoff: "thinking",
  "approval.requested": "waiting_human",
  "tool.call": "using_tool",
  "tool.result": "using_tool",
  "run.finished": "done",
};

export function EventLog({ events, agents, agentFilter, onAgentFilter }: Props) {
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [hideStatus, setHideStatus] = useState(false);

  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.agent_id, a.name])), [agents]);

  const visible = useMemo(() => {
    const out: StoredEvent[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < 300; i--) {
      const e = events[i]!;
      if (pausedAt !== null && e.seq > pausedAt) continue;
      if (agentFilter && e.agent_id !== agentFilter) continue;
      if (hideStatus && (e.type === "agent.status" || e.type.startsWith("step."))) continue;
      out.push(e);
    }
    return out;
  }, [events, pausedAt, agentFilter, hideStatus]);

  const newSincePause = pausedAt === null ? 0 : events.filter((e) => e.seq > pausedAt).length;
  const lastSeq = events.at(-1)?.seq ?? 0;

  return (
    <section aria-labelledby="log-title" className="flex min-h-0 flex-col rounded-xl border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <h2 id="log-title" className="mr-auto font-semibold">
          Event log
        </h2>
        <label className="sr-only" htmlFor="agent-filter">
          Filter by agent
        </label>
        <select
          id="agent-filter"
          value={agentFilter ?? ""}
          onChange={(e) => onAgentFilter(e.target.value || null)}
          className="h-9 rounded-md border border-border bg-surface-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-surface-2">
          <input
            type="checkbox"
            checked={hideStatus}
            onChange={(e) => setHideStatus(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Hide status
        </label>
        <button
          type="button"
          onClick={() => setPausedAt(pausedAt === null ? lastSeq : null)}
          aria-pressed={pausedAt !== null}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {pausedAt === null ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
          {pausedAt === null ? "Pause" : newSincePause ? `Resume (${newSincePause} new)` : "Resume"}
        </button>
      </header>

      {agentFilter && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <span className="text-muted">Showing</span>
          <span className="font-medium">{names[agentFilter] ?? agentFilter}</span>
          <button
            type="button"
            onClick={() => onAgentFilter(null)}
            className="ml-auto inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Clear agent filter"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">
          {agentFilter ? "No events from this agent yet." : "No events yet. They appear here the moment your agents start."}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto font-mono text-xs" aria-live={pausedAt === null ? "polite" : "off"} aria-relevant="additions">
          {visible.map((e, i) => (
            <li
              key={e.seq}
              data-status={TYPE_TONE[e.type]}
              className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-border/60 px-3 py-2 ${i === 0 && pausedAt === null ? "log-row-new" : ""} ${
                e.type === "error" ? "bg-[var(--st-bg)]" : ""
              }`}
            >
              <time dateTime={e.ts} className="text-muted tabular-nums">
                {clock(e.ts)}
              </time>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={`shrink-0 ${TYPE_TONE[e.type] ? "text-[var(--st-fg)]" : "text-muted"}`}>{e.type}</span>
                {e.agent_id && (
                  <button
                    type="button"
                    onClick={() => onAgentFilter(e.agent_id)}
                    className="shrink-0 rounded font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {names[e.agent_id] ?? e.agent_id}
                  </button>
                )}
              </span>
              <span aria-hidden />
              <span className="break-words font-sans text-sm">{describe(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
