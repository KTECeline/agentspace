"use client";

import { useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Box, ChartColumn, Eye, History, KeyRound, LayoutGrid, Radio, RefreshCw } from "lucide-react";
import type { RunState } from "@agentspace/spec-types";
import { formatDuration, formatTokens } from "@/lib/format";
import { latestRun } from "@/lib/state";
import { useOffice, type Connection } from "@/lib/store";
import { useSource, type SourceConfig } from "@/lib/useSource";
import { useThrottled } from "@/lib/useThrottled";
import { useViewMode, type ViewMode } from "@/lib/useViewMode";
import { Cost } from "./Cost";
import { Grid2D } from "./office2d/Grid2D";
import { ApprovalsPanel, usePendingCount } from "./operator/Approvals";
import { RunControls } from "./operator/RunControls";
import { TokenButton } from "./operator/TokenDialog";
import { ReplayBar } from "./replay/ReplayBar";
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
  /** UI load benchmark: measure frame times for this many seconds (bench/ui_load.md). */
  benchSeconds?: number;
}

export function OfficeApp({ source, showFps = false, scenario, benchSeconds }: Props) {
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
  const [tab, setTab] = useState<"activity" | "approvals">("activity");
  const pendingApprovals = usePendingCount();
  const publicMode = useOffice((s) => !!s.info?.public_readonly);
  const openTokenDialog = useOffice((s) => s.openTokenDialog);
  const selectedAgent = useOffice((s) => s.selectedAgent);
  const select = useOffice((s) => s.select);

  const workspace = source.kind === "live" || source.kind === "replay" ? source.workspace : source.kind === "stress" ? "stress" : "demo";
  const collectorUrl = source.kind === "live" ? source.collectorUrl : null;
  const player = useOffice((s) => s.player);
  const officeQuery = source.kind === "live" || source.kind === "replay" ? new URLSearchParams({ collector: source.collectorUrl, workspace }).toString() : "";

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 lg:h-dvh lg:flex-none lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-display text-xl font-semibold tracking-tight">AgentSpace</h1>
        <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">workspace: {workspace}</span>
        <ConnectionPill connection={connection} onRetry={retry} />
        {publicMode && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-xs text-muted">
            <Eye aria-hidden className="size-3.5" />
            Read-only
          </span>
        )}
        {pendingApprovals > 0 && (
          <button
            type="button"
            onClick={() => {
              select(null);
              setTab("approvals");
            }}
            data-status="waiting_human"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--st-bg)] px-3 text-sm font-medium text-[var(--st-fg)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className="status-dot size-2 rounded-full bg-[var(--st-dot)]" />
            {pendingApprovals === 1 ? "1 approval waiting" : `${pendingApprovals} approvals waiting`}
          </button>
        )}
        {scenario && <ScenarioPicker current={scenario} />}
        {source.kind === "replay" && (
          <a
            href={`/?${officeQuery}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Radio aria-hidden className="size-4" />
            Back to live
          </a>
        )}
        {run && <RunSummary run={run} replayHref={collectorUrl ? `/replay?${officeQuery}&run=${encodeURIComponent(run.run_id)}` : undefined} />}
        <ViewToggle mode={view.mode} onChange={view.setMode} webgl={view.webgl} />
        {(source.kind === "live" || source.kind === "replay") && (
          <a
            href={`/dashboard?${officeQuery}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChartColumn aria-hidden className="size-4" />
            Costs
          </a>
        )}
        {collectorUrl && !publicMode && <TokenButton onSaved={retry} />}
      </header>

      {player && !error && <ReplayBar player={player} showClock={source.kind === "replay"} />}

      {error ? (
        <Problem title="Something went wrong" onRetry={() => location.reload()}>
          {error}
        </Problem>
      ) : connection === "unauthorized" && collectorUrl ? (
        <Problem
          title="This office is private"
          onRetry={() => openTokenDialog(true)}
          action={
            <>
              <KeyRound aria-hidden className="size-4" />
              Add token
            </>
          }
        >
          The collector at <code className="font-mono text-foreground">{collectorUrl}</code> needs a token to watch it. Use the operator token or an API
          key for this workspace.
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
              <OfficeScene showFps={showFps} benchSeconds={benchSeconds} />
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
            <div className="flex min-h-0 flex-col gap-2">
              <RightTabs tab={tab} onChange={setTab} pending={pendingApprovals} />
              <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
                {tab === "approvals" ? (
                  <ApprovalsPanel />
                ) : (
                  <EventLog events={events} agents={agents} agentFilter={logFilter} onAgentFilter={setLogFilter} />
                )}
              </div>
            </div>
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
  const tone = { live: "done", connecting: "waiting", reconnecting: "using_tool", offline: "error", recording: "thinking", replay: "thinking", unauthorized: "waiting_human" }[connection];
  const label = {
    live: "Live",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    offline: "Collector offline",
    recording: "Recorded demo",
    replay: "Replay",
    unauthorized: "Needs a token",
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

function RightTabs({ tab, onChange, pending }: { tab: "activity" | "approvals"; onChange: (t: "activity" | "approvals") => void; pending: number }) {
  const tabs = [
    { id: "activity" as const, label: "Activity" },
    { id: "approvals" as const, label: pending ? `Approvals (${pending})` : "Approvals" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Side panel"
      className="flex self-start rounded-lg border border-border bg-surface p-0.5"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const next = tab === "activity" ? "approvals" : "activity";
          onChange(next);
          document.getElementById(`tab-${next}`)?.focus();
        }
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={`inline-flex h-9 items-center rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            tab === t.id ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RunSummary({ run, replayHref }: { run: RunState; replayHref?: string }) {
  const paused = run.status === "running" && run.control === "paused";
  const status = paused ? "blocked" : run.status === "running" ? "thinking" : run.status === "ok" ? "done" : run.status === "cancelled" ? "waiting" : "error";
  const label = paused ? "paused" : run.status;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-label="Latest run">
      <div className="flex items-center gap-2">
        <dt className="sr-only">Run</dt>
        <dd data-status={status} className="inline-flex items-center gap-1.5 font-medium">
          <span aria-hidden className="status-dot size-2 rounded-full bg-[var(--st-dot)]" />
          {run.name ?? run.run_id.slice(0, 8)}
          <span className="text-muted">· {label}</span>
        </dd>
      </div>
      <Stat label="Duration" value={run.duration_ms != null ? formatDuration(run.duration_ms) : "—"} />
      <Stat label="Tokens" value={`${formatTokens(run.tokens_in)}→${formatTokens(run.tokens_out)}`} />
      <Stat label="Cost" value={<Cost totals={run} />} />
      <Stat label="Events" value={String(run.event_count)} />
    </dl>
    <RunControls run={run} />
    {replayHref && (
      <a
        href={replayHref}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <History aria-hidden className="size-4" />
        Replay
      </a>
    )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
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

function Problem({ title, children, onRetry, action }: { title: string; children: React.ReactNode; onRetry: () => void; action?: React.ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted">{children}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {action ?? (
          <>
            <RefreshCw aria-hidden className="size-4" />
            Retry now
          </>
        )}
      </button>
    </div>
  );
}
