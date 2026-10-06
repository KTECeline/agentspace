"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, RefreshCw } from "lucide-react";
import type { PriceTable, StatsResponse } from "@agentspace/spec-types";
import { ApiError, fetchPricing, fetchStats } from "@/lib/collector";
import { formatMs, formatPercent } from "@/lib/chart";
import { costInfo, formatTokens } from "@/lib/format";
import { useOffice } from "@/lib/store";
import { Cost } from "../Cost";
import { TokenButton } from "../operator/TokenDialog";
import { BarTable } from "./BarTable";
import { DayChart } from "./DayChart";
import { RunsTable } from "./RunsTable";
import { ToolsTable } from "./ToolsTable";

const RANGES = [
  { id: "24h", label: "24 hours", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { id: "all", label: "All", ms: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

type Load = { status: "loading" } | { status: "ok"; stats: StatsResponse } | { status: "error"; error: unknown };

const POLL_MS = 15_000;

/** Cost, latency and error dashboard for one workspace (reads GET …/stats). */
export function Dashboard({ collectorUrl, workspace, officeHref }: { collectorUrl: string; workspace: string; officeHref: string }) {
  const [range, setRange] = useState<RangeId>("7d");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [pricing, setPricing] = useState<PriceTable | null>(null);
  const [refresh, setRefresh] = useState(0);
  const token = useOffice((s) => s.token);
  const openTokenDialog = useOffice((s) => s.openTokenDialog);

  // The token dialog and the stored token are keyed by the collector.
  useEffect(() => {
    useOffice.getState().setCollector({ url: collectorUrl, workspace });
  }, [collectorUrl, workspace]);

  useEffect(() => {
    let stale = false;
    const ms = RANGES.find((r) => r.id === range)?.ms ?? null;
    const get = () => {
      const since = ms === null ? null : new Date(Date.now() - ms).toISOString();
      fetchStats(collectorUrl, workspace, since, token)
        .then((stats) => !stale && setLoad({ status: "ok", stats }))
        .catch((error: unknown) => !stale && setLoad({ status: "error", error }));
    };
    get();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") get();
    }, POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [collectorUrl, workspace, range, token, refresh]);

  useEffect(() => {
    let stale = false;
    fetchPricing(collectorUrl)
      .then((t) => !stale && setPricing(t))
      .catch(() => undefined); // the footer just stays generic
    return () => {
      stale = true;
    };
  }, [collectorUrl]);

  const pickRange = (id: RangeId) => {
    if (id === range) return;
    setLoad({ status: "loading" });
    setRange(id);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 lg:p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={officeHref}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Office
        </Link>
        <h1 className="font-display text-xl font-semibold tracking-tight">Costs and performance</h1>
        <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">workspace: {workspace}</span>
        <div className="ml-auto flex items-center gap-2">
          <RangePicker value={range} onChange={pickRange} />
          <button
            type="button"
            onClick={() => setRefresh((n) => n + 1)}
            aria-label="Refresh"
            title="Refresh (also refreshes every 15 s)"
            className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw aria-hidden className="size-4" />
          </button>
          <TokenButton onSaved={() => setRefresh((n) => n + 1)} />
        </div>
      </header>

      {load.status === "loading" ? (
        <Skeleton />
      ) : load.status === "error" ? (
        <LoadError error={load.error} collectorUrl={collectorUrl} onRetry={() => setRefresh((n) => n + 1)} onToken={() => openTokenDialog(true)} />
      ) : load.stats.totals.calls === 0 && load.stats.totals.runs === 0 ? (
        <section className="rounded-xl border border-border bg-surface p-8 text-center">
          <h2 className="font-display text-lg font-semibold">No runs in this period</h2>
          <p className="mx-auto mt-1 max-w-prose text-sm text-muted">
            Costs appear here once agents make model calls. Try a longer period, or run an example (
            <code className="font-mono text-foreground">cd examples/langgraph-dev-team &amp;&amp; uv run main.py --fake</code>).
          </p>
        </section>
      ) : (
        <Body
          stats={load.stats}
          pricing={pricing}
          replayHref={(runId) => `/replay?${new URLSearchParams({ collector: collectorUrl, workspace, run: runId })}`}
          compareHref={(runId) => `/compare?${new URLSearchParams({ collector: collectorUrl, workspace, run: runId })}`}
        />
      )}
    </div>
  );
}

function Body({
  stats,
  pricing,
  replayHref,
  compareHref,
}: {
  stats: StatsResponse;
  pricing: PriceTable | null;
  replayHref: (runId: string) => string;
  compareHref: (runId: string) => string;
}) {
  const t = stats.totals;
  const { note } = costInfo(t);
  return (
    <main className="flex flex-col gap-5">
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Total cost" wide>
          <Cost totals={t} className="text-4xl font-semibold" />
          {note && <p className="mt-1 text-xs text-muted">{note}</p>}
        </Tile>
        <Tile label="Runs">
          <span className="text-2xl font-semibold">{t.runs.toLocaleString()}</span>
          <p className="mt-1 text-xs text-muted">
            {t.runs_ok} ok · {t.runs_failed} failed · {t.runs_cancelled} cancelled
          </p>
        </Tile>
        <Tile label="Error rate">
          <span className="text-2xl font-semibold">{formatPercent(t.error_rate)}</span>
          <p className="mt-1 text-xs text-muted">of finished runs · {t.errors.toLocaleString()} error events</p>
        </Tile>
        <Tile label="Model latency">
          <span className="text-2xl font-semibold">{formatMs(t.p50_ms)}</span>
          <p className="mt-1 text-xs text-muted">median · p95 {formatMs(t.p95_ms)}</p>
        </Tile>
        <Tile label="Model calls">
          <span className="text-2xl font-semibold">{t.calls.toLocaleString()}</span>
          <p className="mt-1 text-xs text-muted">
            {formatTokens(t.tokens_in)} in · {formatTokens(t.tokens_out)} out
          </p>
        </Tile>
      </section>

      <Card title="Cost per day" subtitle="UTC days. Hover or focus a bar for details.">
        <DayChart days={stats.by_day} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Cost by agent">
          <BarTable
            label="Agent"
            rows={stats.by_agent.map((a) => ({
              key: a.agent_id,
              name: a.name,
              detail: `${a.calls} calls · p50 ${formatMs(a.p50_ms)}${a.errors ? ` · ${a.errors} errors` : ""}`,
              totals: a,
            }))}
          />
        </Card>
        <Card title="Cost by model">
          <BarTable
            label="Model"
            mono
            rows={stats.by_model.map((m) => ({
              key: m.model,
              name: m.model,
              detail: `${m.calls} calls · p50 ${formatMs(m.p50_ms)} · p95 ${formatMs(m.p95_ms)}`,
              totals: m,
            }))}
          />
        </Card>
      </div>

      <Card title="Runs" subtitle={stats.by_run.length >= 200 ? "The 200 most recent runs." : undefined}>
        <RunsTable runs={stats.by_run} replayHref={replayHref} compareHref={compareHref} />
      </Card>

      <Card title="Slowest tools" subtitle="By 95th percentile duration.">
        <ToolsTable tools={stats.slowest_tools} />
      </Card>

      <PricingNote pricing={pricing} />
    </main>
  );
}

function RangePicker({ value, onChange }: { value: RangeId; onChange: (id: RangeId) => void }) {
  return (
    <div role="group" aria-label="Time range" className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={value === r.id}
          onClick={() => onChange(r.id)}
          className={`h-8 rounded px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value === r.id ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-4 ${wide ? "col-span-2 md:col-span-3 xl:col-span-2" : ""}`}>
      <h2 className="text-sm text-muted">{label}</h2>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface p-4" aria-label={title}>
      <h2 className="font-display text-base font-semibold">{title}</h2>
      {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

/** Where estimates come from: the table version and each provider's page and check date. */
function PricingNote({ pricing }: { pricing: PriceTable | null }) {
  const sources = new Map<string, { provider: string; asOf: string }>();
  for (const m of pricing?.models ?? []) {
    const prev = sources.get(m.source);
    if (!prev || m.as_of < prev.asOf) sources.set(m.source, { provider: PROVIDER_NAMES[m.provider ?? ""] ?? m.provider ?? m.source, asOf: m.as_of });
  }
  return (
    <footer className="text-xs text-muted">
      <p>
        <span className="font-medium text-foreground">est.</span> marks costs the collector estimated from list prices (standard tier, no batch or
        regional discounts). Costs reported by a framework are shown as reported.
        {pricing && ` Price table ${pricing.version}.`}
      </p>
      {sources.size > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {[...sources].map(([url, s]) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:text-foreground">
                {s.provider}
              </a>{" "}
              prices as of {s.asOf}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

function LoadError({ error, collectorUrl, onRetry, onToken }: { error: unknown; collectorUrl: string; onRetry: () => void; onToken: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const needsToken = status === 401;
  return (
    <section role="alert" className="rounded-xl border border-border bg-surface p-8 text-center">
      <h2 className="font-display text-lg font-semibold">{needsToken ? "This office is private" : "Can’t load the dashboard"}</h2>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted">
        {needsToken ? (
          <>
            The collector at <code className="font-mono text-foreground">{collectorUrl}</code> needs a token. Use the operator token or an API key for
            this workspace.
          </>
        ) : status === 0 ? (
          <>
            Nothing is answering at <code className="font-mono text-foreground">{collectorUrl}</code>. Start it with{" "}
            <code className="font-mono text-foreground">make dev</code> or <code className="font-mono text-foreground">docker compose up</code>.
          </>
        ) : (
          (error as Error).message
        )}
      </p>
      <button
        type="button"
        onClick={needsToken ? onToken : onRetry}
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {needsToken ? <KeyRound aria-hidden className="size-4" /> : <RefreshCw aria-hidden className="size-4" />}
        {needsToken ? "Add token" : "Try again"}
      </button>
    </section>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard" className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`h-24 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none ${i === 0 ? "col-span-2" : ""}`} />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="h-48 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
        <div className="h-48 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
      </div>
    </div>
  );
}
