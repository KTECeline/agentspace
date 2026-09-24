"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Box, LayoutGrid, RefreshCw } from "lucide-react";
import type { RunState } from "@agentspace/spec-types";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { latestRun } from "@/lib/state";
import { useOffice, type Connection } from "@/lib/store";
import { useSource, type SourceConfig } from "@/lib/useSource";
import { useThrottled } from "@/lib/useThrottled";
import { useViewMode, type ViewMode } from "@/lib/useViewMode";
import { Grid2D } from "./office2d/Grid2D";
import { ScenarioPicker } from "./ScenarioPicker";
import { AgentPanel } from "./panels/AgentPanel";
import { EventLog } from "./panels/EventLog";

const OfficeScene = dynamic(() => import("./office/OfficeScene"), {
  ssr: false,
  loading: () => <div aria-busy="true" aria-label="Loading 3D office" className="h-full min-h-[420px] animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />,
});

interface Props {
  source: SourceConfig;
  showFps?: boolean;
  /** Demo only: the current recording, to show the scenario picker. */
  scenario?: string;
}

export function OfficeApp({ source, showFps = false, scenario }: Props) {
  const view = useViewMode();
  const { retry, error } = useSource(source);
  const ready = useOffice((s) => s.ready);
  const connection = useOffice((s) => s.connection);
  const agentCount = useOffice((s) => Object.keys(s.agents).length);
  // The log is DOM-heavy; 4 updates/s is plenty for reading and keeps 100 events/s cheap.
  const events = useThrottled(useOffice((s) => s.events), 250);
  // Throttled like the events: agent rows change on almost every event under load.
  const agentsById = useThrottled(useOffice((s) => s.agents), 250);
  const agents = useMemo(() => Object.values(agentsById), [agentsById]);
  const run = useThrottled(useOffice((s) => latestRun(s.runs)), 250);
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const selectedAgent = useOffice((s) => s.selectedAgent);
  const select = useOffice((s) => s.select);

  const workspace = source.kind === "live" ? source.workspace : source.kind === "stress" ? "stress" : "demo";
  const collectorUrl = source.kind === "live" ? source.collectorUrl : null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 lg:h-dvh lg:flex-none lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-display text-xl font-semibold tracking-tight">AgentSpace</h1>
        <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">workspace: {workspace}</span>
        <ConnectionPill connection={connection} onRetry={retry} />
        {scenario && <ScenarioPicker current={scenario} />}
        {run && <RunSummary run={run} />}
        <ViewToggle mode={view.mode} onChange={view.setMode} webgl={view.webgl} />
      </header>

      {error ? (
        <Problem title="Something went wrong" onRetry={() => location.reload()}>
          {error}
        </Problem>
      ) : connection === "offline" && !ready && collectorUrl ? (
        <Problem title="Can’t reach the collector" onRetry={retry}>
          Nothing is answering at <code className="font-mono text-foreground">{collectorUrl}</code>. Start it with{" "}
          <code className="font-mono text-foreground">docker compose up</code> or <code className="font-mono text-foreground">make dev</code>. This page
          keeps retrying.
        </Problem>
      ) : !ready ? (
        <LoadingSkeleton />
      ) : (
        <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:grid-rows-[minmax(0,1fr)]">
          <div className={view.mode === "3d" ? "flex h-[60vh] min-h-[420px] flex-col lg:h-auto lg:min-h-0" : "min-h-0 overflow-y-auto pr-1"}>
            {agentCount === 0 && collectorUrl ? (
              <EmptyOffice collectorUrl={collectorUrl} workspace={workspace} />
            ) : !view.ready ? null : view.mode === "3d" ? (
              <OfficeScene showFps={showFps} />
            ) : (
              <Grid2D />
            )}
          </div>
          {selectedAgent ? (
            <AgentPanel
              agentId={selectedAgent}
              onShowInLog={(id) => {
                setLogFilter(id);
                select(null);
              }}
            />
          ) : (
            <EventLog events={events} agents={agents} agentFilter={logFilter} onAgentFilter={setLogFilter} />
          )}
        </main>
      )}
    </div>
  );
}

function ViewToggle({ mode, onChange, webgl }: { mode: ViewMode; onChange: (m: ViewMode) => void; webgl: boolean }) {
  const options: { value: ViewMode; label: string; Icon: typeof Box }[] = [
    { value: "3d", label: "3D", Icon: Box },
    { value: "2d", label: "2D", Icon: LayoutGrid },
  ];
  return (
    <div role="radiogroup" aria-label="Office view" className="flex rounded-lg border border-border bg-surface p-0.5">
      {options.map(({ value, label, Icon }) => {
        const disabled = value === "3d" && !webgl;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={disabled}
            title={disabled ? "3D needs WebGL, which this browser doesn't provide" : undefined}
            onClick={() => onChange(value)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
              mode === value ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ConnectionPill({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  const tone = { live: "done", connecting: "waiting", reconnecting: "using_tool", offline: "error", recording: "thinking" }[connection];
  const label = {
    live: "Live",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    offline: "Collector offline",
    recording: "Recorded demo",
  }[connection];
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
        <code>{`pip install agentspace-sdk

import agentspace
agentspace.init(url="${collectorUrl}"${wsArg})
# LangGraph apps are picked up automatically.`}</code>
      </pre>
      <a
        href="/demo"
        className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Watch a recorded demo
      </a>
    </div>
  );
}

function Problem({ title, children, onRetry }: { title: string; children: React.ReactNode; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted">{children}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <RefreshCw aria-hidden className="size-4" />
        Retry now
      </button>
    </div>
  );
}
