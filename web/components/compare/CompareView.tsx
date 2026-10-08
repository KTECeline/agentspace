"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, History, KeyRound, RefreshCw } from "lucide-react";
import type { AgentSpaceEvent, RunState } from "@agentspace/spec-types";
import { ApiError } from "@/lib/collector";
import { compareSource, type CompareSourceSpec } from "@/lib/compareSource";
import { compareRuns, pickBaseline, type Comparison, type MetricChange, type RunProfile, type Unit } from "@/lib/compare";
import { describe, formatCost, formatDuration, formatTokens } from "@/lib/format";
import { buildTimeline } from "@/lib/replay";
import { useOffice } from "@/lib/store";
import { Cost } from "../Cost";
import { TokenButton } from "../operator/TokenDialog";

interface Props {
  /** A collector, or the bundled recordings (/demo/compare). */
  source: CompareSourceSpec;
  /** The run being looked at. */
  runId: string | null;
  /** What to compare it with; the latest good run of the same workflow when null. */
  baseId: string | null;
  officeHref: string;
}

type Runs = { status: "loading" } | { status: "ok"; runs: RunState[] } | { status: "error"; error: unknown };
type Pair = { key: string; a: AgentSpaceEvent[]; b: AgentSpaceEvent[]; truncated: boolean } | { key: string; error: unknown };

const RUN_STATUS = { running: "thinking", ok: "done", cancelled: "waiting", error: "error" } as const;

/** Two stored runs side by side: what changed, and where they first stopped doing the same thing (D-043). */
export function CompareView({ source: spec, runId: initialRun, baseId: initialBase, officeHref }: Props) {
  const specKey = JSON.stringify(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => compareSource(spec), [specKey]);
  const collector = source.collector;
  const token = useOffice((s) => s.token);
  const openTokenDialog = useOffice((s) => s.openTokenDialog);
  const [runId, setRunId] = useState(initialRun);
  const [baseChoice, setBaseChoice] = useState(initialBase);
  const [runs, setRuns] = useState<Runs>({ status: "loading" });
  const [pair, setPair] = useState<Pair | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    useOffice.getState().setCollector(collector);
  }, [collector]);

  useEffect(() => {
    let stale = false;
    source
      .runs(token)
      .then((list) => !stale && setRuns({ status: "ok", runs: list }))
      .catch((error: unknown) => !stale && setRuns({ status: "error", error }));
    return () => {
      stale = true;
    };
  }, [source, token, refresh]);

  const list = runs.status === "ok" ? runs.runs : [];
  // With no run given, look at the latest one that didn't finish ok (that's usually the question).
  const target = list.find((r) => r.run_id === runId) ?? (runId ? undefined : (list.find((r) => r.status === "error") ?? list[0]));
  const baseline = baseChoice ? list.find((r) => r.run_id === baseChoice) : target ? (pickBaseline(list, target) ?? undefined) : undefined;
  const key = target && baseline ? `${baseline.run_id}\u0000${target.run_id}\u0000${refresh}` : null;

  useEffect(() => {
    if (!key || !target || !baseline) return;
    let stale = false;
    Promise.all([source.events(baseline.run_id, token), source.events(target.run_id, token)])
      .then(([a, b]) => {
        if (stale) return;
        setPair({ key, a: buildTimeline(a.events).events, b: buildTimeline(b.events).events, truncated: a.truncated || b.truncated });
      })
      .catch((error: unknown) => !stale && setPair({ key, error }));
    return () => {
      stale = true;
    };
    // The ids are in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source, token]);

  const choose = (which: "run" | "base", id: string) => {
    if (which === "run") setRunId(id);
    else setBaseChoice(id);
    const q = new URLSearchParams(location.search);
    q.set(which, id);
    history.replaceState(null, "", `?${q}`);
  };

  const replayHref = (run: string, eventId?: string) => source.replayHref(run, eventId);
  const current = pair && pair.key === key ? pair : null;
  const comparison = useMemo(() => (current && "a" in current ? compareRuns(current.a, current.b) : null), [current]);

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
        <h1 className="font-display text-xl font-semibold tracking-tight">Compare runs</h1>
        <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">{source.label}</span>
        {collector && (
          <div className="ml-auto">
            <TokenButton onSaved={() => setRefresh((n) => n + 1)} />
          </div>
        )}
      </header>

      {runs.status === "error" ? (
        <LoadError error={runs.error} collectorUrl={collector?.url ?? null} onRetry={() => setRefresh((n) => n + 1)} onToken={() => openTokenDialog(true)} />
      ) : runs.status === "loading" ? (
        <Skeleton />
      ) : list.length < 2 ? (
        <Message title="Nothing to compare yet">{collector ? "This workspace needs at least two stored runs. Run your app twice, or an example with a different input." : "There are fewer than two recorded runs."}</Message>
      ) : (
        <>
          <section aria-label="Runs" className="grid gap-3 md:grid-cols-2">
            <RunCard
              title="Baseline"
              id="base"
              runs={list}
              run={baseline}
              exclude={target?.run_id}
              onChoose={(id) => choose("base", id)}
              replayHref={replayHref}
              empty={target ? `No earlier successful run of “${target.name ?? "this workflow"}”. Pick one to compare with.` : "Pick a run."}
            />
            <RunCard title="This run" id="run" runs={list} run={target} exclude={baseline?.run_id} onChoose={(id) => choose("run", id)} replayHref={replayHref} empty="Pick a run." />
          </section>

          {!key ? null : current === null ? (
            <Skeleton />
          ) : "error" in current ? (
            <LoadError error={current.error} collectorUrl={collector?.url ?? null} onRetry={() => setRefresh((n) => n + 1)} onToken={() => openTokenDialog(true)} />
          ) : comparison && baseline && target ? (
            <Body c={comparison} a={current.a} b={current.b} baseRun={baseline.run_id} targetRun={target.run_id} replayHref={replayHref} truncated={current.truncated} />
          ) : null}
        </>
      )}
    </div>
  );
}

function RunCard(props: {
  title: string;
  id: string;
  runs: RunState[];
  run: RunState | undefined;
  exclude: string | undefined;
  onChoose: (id: string) => void;
  replayHref: (run: string) => string;
  empty: string;
}) {
  const { title, id, runs, run, exclude, onChoose, replayHref, empty } = props;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <label htmlFor={`pick-${id}`} className="text-sm font-semibold">
          {title}
        </label>
        {run && (
          <a
            href={replayHref(run.run_id)}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <History aria-hidden className="size-4" />
            Replay
          </a>
        )}
      </div>
      <select
        id={`pick-${id}`}
        value={run?.run_id ?? ""}
        onChange={(e) => e.target.value && onChoose(e.target.value)}
        className="h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!run && <option value="">Choose a run…</option>}
        {runs
          .filter((r) => r.run_id !== exclude)
          .map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.name ?? r.run_id.slice(0, 8)} · {r.status} · {r.started_at ? new Date(r.started_at).toLocaleString() : "—"}
            </option>
          ))}
      </select>
      {run ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <div className="flex items-center gap-1.5" data-status={RUN_STATUS[run.status]}>
            <dt className="sr-only">Status</dt>
            <span aria-hidden className="status-dot size-2 rounded-full bg-[var(--st-dot)]" />
            <dd className="font-medium">{run.status}</dd>
          </div>
          <Stat label="Duration">{run.duration_ms != null ? formatDuration(run.duration_ms) : "—"}</Stat>
          <Stat label="Tokens">
            {formatTokens(run.tokens_in)}→{formatTokens(run.tokens_out)}
          </Stat>
          <Stat label="Cost">
            <Cost totals={run} />
          </Stat>
        </dl>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </div>
  );
}

interface BodyProps {
  c: Comparison;
  a: AgentSpaceEvent[];
  b: AgentSpaceEvent[];
  baseRun: string;
  targetRun: string;
  replayHref: (run: string, eventId?: string) => string;
  truncated: boolean;
}

function Body({ c, a, b, baseRun, targetRun, replayHref, truncated }: BodyProps) {
  const names = { ...c.a.names, ...c.b.names };
  const models = c.models.filter((m) => m.a !== m.b);
  const tools = c.tools.filter((t) => t.a.calls !== t.b.calls || t.a.failed !== t.b.failed);
  const nothing = !c.statusChanged && !c.pathChanged && !c.changed.length && !models.length && !tools.length && !c.divergence;
  return (
    <main className="flex flex-col gap-5">
      {truncated && <p className="text-sm text-muted">One of these runs is very long; only its first 50,000 events are compared.</p>}

      <Card title="What changed">
        {nothing ? (
          <p className="text-sm text-muted">Nothing: these runs did the same things in the same order, with the same totals.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {c.statusChanged && (
              <Change label="Outcome">
                <RunStatus p={c.a} /> <ArrowRight aria-label="became" className="inline size-3.5 text-muted" /> <RunStatus p={c.b} />
              </Change>
            )}
            {c.pathChanged && (
              <Change label="Agent path">
                <span className="flex flex-col gap-1">
                  <Path p={c.a} names={names} />
                  <Path p={c.b} names={names} />
                </span>
              </Change>
            )}
            {c.changed.map((m) => (
              <Change key={m.key} label={m.label}>
                <Values m={m} />
              </Change>
            ))}
            {models.map((m) => (
              <Change key={`model:${m.model}`} label={`Model ${m.model}`}>
                {m.a} <ArrowRight aria-label="became" className="inline size-3.5 text-muted" /> {m.b} {m.b === 1 ? "call" : "calls"}
              </Change>
            ))}
            {tools.map((t) => (
              <Change key={`tool:${t.tool}`} label={`Tool ${t.tool}`}>
                {toolText(t.a)} <ArrowRight aria-label="became" className="inline size-3.5 text-muted" /> {toolText(t.b)}
              </Change>
            ))}
          </ul>
        )}
      </Card>

      {c.divergence && (
        <Card title="First difference">
          <p className="text-sm text-muted">
            {c.divergence.common === 0
              ? "The runs differ from their first step."
              : `Both runs did the same ${c.divergence.common} ${c.divergence.common === 1 ? "thing" : "things"}, then:`}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <DivergedAt title="Baseline" at={c.divergence.a} events={a} run={baseRun} names={names} replayHref={replayHref} />
            <DivergedAt title="This run" at={c.divergence.b} events={b} run={targetRun} names={names} replayHref={replayHref} />
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="All metrics">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1.5 pr-4 font-medium">Metric</th>
                <th className="py-1.5 pr-4 text-right font-medium">Baseline</th>
                <th className="py-1.5 pr-4 text-right font-medium">This run</th>
                <th className="py-1.5 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {c.metrics.map((m) => (
                <tr key={m.key} className="border-t border-border">
                  <td className="py-1.5 pr-4">{m.label}</td>
                  <td className="py-1.5 pr-4 text-right font-mono">{fmt(m.a, m.unit)}</td>
                  <td className="py-1.5 pr-4 text-right font-mono">{fmt(m.b, m.unit)}</td>
                  <td className="py-1.5 text-right font-mono text-muted">{delta(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            Cost: <Cost totals={c.a.usage} /> → <Cost totals={c.b.usage} /> (model calls only).
          </p>
        </Card>
        <Card title="Tools">
          {c.tools.length === 0 ? (
            <p className="text-sm text-muted">Neither run called a tool.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">Tool</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Baseline</th>
                  <th className="py-1.5 text-right font-medium">This run</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {c.tools.map((t) => (
                  <tr key={t.tool} className="border-t border-border">
                    <td className="py-1.5 pr-4 font-mono text-xs">{t.tool}</td>
                    <td className="py-1.5 pr-4 text-right">{toolText(t.a)}</td>
                    <td className="py-1.5 text-right">{toolText(t.b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </main>
  );
}

function DivergedAt(props: {
  title: string;
  at: { index: number; sig: string } | null;
  events: AgentSpaceEvent[];
  run: string;
  names: Record<string, string>;
  replayHref: (run: string, eventId?: string) => string;
}) {
  const { title, at, events, run, names, replayHref } = props;
  const e = at ? events[at.index] : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {e ? (
        <>
          <p className="text-sm">
            {e.agent_id && <span className="font-semibold">{names[e.agent_id] ?? e.agent_id}: </span>}
            {describe({ ...e, seq: 0 })}
          </p>
          <a
            href={replayHref(run, e.id)}
            className="inline-flex h-9 items-center gap-1.5 self-start rounded-md border border-border px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <History aria-hidden className="size-4" />
            Open in replay
          </a>
        </>
      ) : (
        <p className="text-sm text-muted">Ended here.</p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Change({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function RunStatus({ p }: { p: RunProfile }) {
  return (
    <span data-status={RUN_STATUS[p.status]} className="inline-flex items-center gap-1.5 font-medium">
      <span aria-hidden className="status-dot size-2 rounded-full bg-[var(--st-dot)]" />
      {p.status}
    </span>
  );
}

function Path({ p, names }: { p: RunProfile; names: Record<string, string> }) {
  return <span className="font-mono text-xs">{p.path.map((id) => names[id] ?? id).join(" → ") || "—"}</span>;
}

function Values({ m }: { m: MetricChange }) {
  return (
    <span className="font-mono tabular-nums">
      {fmt(m.a, m.unit)} <ArrowRight aria-label="became" className="inline size-3.5 text-muted" /> {fmt(m.b, m.unit)}
      {delta(m) && <span className="ml-2 font-sans text-xs text-muted">({delta(m)})</span>}
    </span>
  );
}

function fmt(v: number | null, unit: Unit): string {
  if (v === null) return "—";
  if (unit === "ms") return formatDuration(v);
  if (unit === "tokens") return formatTokens(v);
  if (unit === "usd") return formatCost(v);
  return v.toLocaleString();
}

/** "+41%", "−20%", or "4.0×" for big jumps; empty when there's no meaningful ratio. */
function delta(m: MetricChange): string {
  if (m.a === m.b) return "";
  if (m.ratio === null) return m.a === 0 || m.a === null ? "new" : "";
  if (m.ratio >= 2) return `${m.ratio.toFixed(1)}×`;
  const pct = Math.round((m.ratio - 1) * 100);
  return pct === 0 ? "" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

function toolText(t: { calls: number; failed: number }): string {
  return `${t.calls} ${t.calls === 1 ? "call" : "calls"}${t.failed ? `, ${t.failed} failed` : ""}`;
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-8 text-center">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted">{children}</p>
    </section>
  );
}

function LoadError({ error, collectorUrl, onRetry, onToken }: { error: unknown; collectorUrl: string | null; onRetry: () => void; onToken: () => void }) {
  // Recordings aren't a collector: show their own message.
  const status = error instanceof ApiError ? error.status : collectorUrl ? 0 : -1;
  const needsToken = status === 401;
  return (
    <section role="alert" className="rounded-xl border border-border bg-surface p-8 text-center">
      <h2 className="font-display text-lg font-semibold">{needsToken ? "This office is private" : "Can’t load these runs"}</h2>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted">
        {needsToken ? (
          <>
            The collector at <code className="font-mono text-foreground">{collectorUrl}</code> needs a token. Use the operator token or an API key for this
            workspace.
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
    <div aria-busy="true" aria-label="Loading runs" className="flex flex-col gap-5">
      <div className="h-32 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-48 animate-pulse rounded-xl border border-border bg-surface motion-reduce:animate-none" />
    </div>
  );
}
