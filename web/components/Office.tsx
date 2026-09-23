"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { RunState } from "@agentspace/spec-types";
import { formatCost, formatDuration, formatTokens, teamLabel } from "@/lib/format";
import { groupByTeam, latestRun } from "@/lib/state";
import { useNow, useWorkspaceStream, type Connection } from "@/lib/useWorkspaceStream";
import { AgentCard } from "./AgentCard";
import { EventLog } from "./panels/EventLog";

interface Props {
  collectorUrl: string;
  workspace: string;
}

export function Office({ collectorUrl, workspace }: Props) {
  const { state, connection, retry } = useWorkspaceStream(collectorUrl, workspace);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const now = useNow();

  const agents = useMemo(() => Object.values(state.agents), [state.agents]);
  const teams = useMemo(() => groupByTeam(agents), [agents]);
  const run = latestRun(state.runs);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 lg:h-dvh lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">AgentSpace</h1>
        <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">workspace: {workspace}</span>
        <ConnectionPill connection={connection} onRetry={retry} />
        {run && <RunSummary run={run} />}
      </header>

      {connection === "offline" && !state.ready ? (
        <Offline collectorUrl={collectorUrl} onRetry={retry} />
      ) : !state.ready ? (
        <LoadingSkeleton />
      ) : (
        <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <div className="min-h-0 overflow-y-auto pr-1">
            {teams.length === 0 ? (
              <EmptyOffice collectorUrl={collectorUrl} workspace={workspace} />
            ) : (
              <div className="flex flex-col gap-6">
                {teams.map((team) => (
                  <section key={team.id || "_none"} aria-labelledby={`team-${team.id}`}>
                    <h2 id={`team-${team.id}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
                      {teamLabel(team.id)}
                      <span className="font-normal text-muted">
                        {team.agents.length} agent{team.agents.length === 1 ? "" : "s"}
                      </span>
                    </h2>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                      {team.agents.map((a) => (
                        <AgentCard
                          key={a.agent_id}
                          agent={a}
                          now={now}
                          selected={agentFilter === a.agent_id}
                          onSelect={(id) => setAgentFilter((cur) => (cur === id ? null : id))}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
          <EventLog events={state.events} agents={agents} agentFilter={agentFilter} onAgentFilter={setAgentFilter} />
        </main>
      )}
    </div>
  );
}

function ConnectionPill({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  const tone = { live: "done", connecting: "waiting", reconnecting: "using_tool", offline: "error" }[connection];
  const label = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…", offline: "Collector offline" }[connection];
  return (
    <span className="flex items-center gap-1" role="status">
      <span data-status={tone} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--st-bg)] px-2.5 py-1 text-xs font-medium text-[var(--st-fg)]">
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--st-dot)]" />
        {label}
      </span>
      {connection === "offline" && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry connection"
          className="inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw aria-hidden className="size-4" />
        </button>
      )}
    </span>
  );
}

function RunSummary({ run }: { run: RunState }) {
  const status = run.status === "running" ? "thinking" : run.status === "ok" ? "done" : "error";
  return (
    <dl className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-label="Latest run">
      <div className="flex items-center gap-2">
        <dt className="sr-only">Run</dt>
        <dd data-status={status} className="inline-flex items-center gap-1.5 font-medium">
          <span aria-hidden className="status-dot size-2 rounded-full bg-[var(--st-dot)]" />
          {run.name ?? run.run_id.slice(0, 8)}
          <span className="text-muted">· {run.status}</span>
        </dd>
      </div>
      <Stat label="Duration" value={run.duration_ms != null ? formatDuration(run.duration_ms) : "—"} />
      <Stat label="Tokens" value={`${formatTokens(run.tokens_in)}→${formatTokens(run.tokens_out)}`} />
      <Stat label="Cost" value={formatCost(run.cost_usd)} />
      <Stat label="Events" value={String(run.event_count)} />
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading office" className="grid gap-4 lg:grid-cols-[1fr_400px]">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-44 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
    </div>
  );
}

function EmptyOffice({ collectorUrl, workspace }: { collectorUrl: string; workspace: string }) {
  const wsArg = workspace === "default" ? "" : `, workspace="${workspace}"`;
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border bg-surface p-8">
      <div>
        <h2 className="text-lg font-semibold">The office is empty</h2>
        <p className="text-muted">Agents appear here as soon as your app sends its first event.</p>
      </div>
      <pre className="w-full overflow-x-auto rounded-lg bg-surface-2 p-4 font-mono text-sm">
        <code>{`pip install agentspace

import agentspace
agentspace.init(url="${collectorUrl}"${wsArg})
# LangGraph apps are picked up automatically.`}</code>
      </pre>
      <p className="text-sm text-muted">
        Or run the example: <code className="font-mono">make demo</code>
      </p>
    </div>
  );
}

function Offline({ collectorUrl, onRetry }: { collectorUrl: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-8">
      <h2 className="text-lg font-semibold">Can’t reach the collector</h2>
      <p className="text-muted">
        Nothing is answering at <code className="font-mono text-foreground">{collectorUrl}</code>. Start it with{" "}
        <code className="font-mono text-foreground">docker compose up</code> or <code className="font-mono text-foreground">make dev</code>.
        This page keeps retrying.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <RefreshCw aria-hidden className="size-4" />
        Retry now
      </button>
    </div>
  );
}
