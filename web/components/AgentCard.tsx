import type { AgentState } from "@agentspace/spec-types";
import { formatCost, formatTokens, timeAgo } from "@/lib/format";
import { StatusBadge } from "./StatusBadge";

interface Props {
  agent: AgentState;
  now: number;
  selected: boolean;
  onSelect: (agentId: string) => void;
}

export function AgentCard({ agent, now, selected, onSelect }: Props) {
  const initials = agent.name
    .split(/[\s_-]+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      type="button"
      data-status={agent.status}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${agent.status.replace("_", " ")}. ${selected ? "Close details." : "Show details."}`}
      onClick={() => onSelect(agent.agent_id)}
      className={`agent-card group flex w-full flex-col gap-3 rounded-xl border bg-surface p-4 text-left transition-[border-color,box-shadow] duration-150 hover:border-[var(--st-dot)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        selected ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--st-bg)] font-mono text-sm font-semibold text-[var(--st-fg)]"
        >
          {initials || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold">{agent.name}</h3>
            <StatusBadge status={agent.status} />
          </div>
          <p className="truncate text-sm text-muted">{agent.role ?? agent.framework ?? agent.agent_id}</p>
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm">
        {agent.status_detail ?? agent.last_summary ?? <span className="text-muted">No activity yet</span>}
      </p>

      <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 font-mono text-xs">
        <div>
          <dt className="text-muted">Tokens</dt>
          <dd className="tabular-nums">
            {formatTokens(agent.tokens_in)}→{formatTokens(agent.tokens_out)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Cost</dt>
          <dd className="tabular-nums">{formatCost(agent.cost_usd)}</dd>
        </div>
        <div>
          <dt className="text-muted">Active</dt>
          <dd className="tabular-nums">{timeAgo(agent.last_event_at, now)}</dd>
        </div>
      </dl>
      {agent.model && <p className="-mt-1 truncate font-mono text-xs text-muted">{agent.model}</p>}
    </button>
  );
}
