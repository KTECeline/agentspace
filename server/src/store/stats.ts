/**
 * Dashboard aggregates (GET …/stats). Backends fetch the raw rows for a time window; this pure
 * function does the grouping and percentiles, so every backend returns identical numbers.
 */
import type {
  AgentState,
  AgentStats,
  CostTotals,
  Latency,
  ModelStats,
  RunState,
  RunStats,
  StatsResponse,
  ToolStats,
} from "@agentspace/spec-types";

export interface StatsWindow {
  since: string | null;
  until: string | null;
}

export interface LlmRow {
  run_id: string;
  agent_id: string | null;
  model: string | null;
  ts: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  duration_ms: number | null;
}

export interface ToolRow {
  tool_name: string;
  ok: boolean;
  duration_ms: number | null;
}

export interface ErrorRow {
  run_id: string;
  agent_id: string | null;
}

export interface StatsRows {
  llm: LlmRow[];
  tools: ToolRow[];
  errors: ErrorRow[];
  /** Runs that started inside the window. */
  runs: RunState[];
  agents: AgentState[];
}

const MAX_RUNS = 200;
const MAX_TOOLS = 10;

const zero = (): CostTotals => ({ calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, cost_estimated_usd: 0, unpriced_calls: 0 });

/** Same rules as the projections (usageOf): estimated share, and calls nobody priced. */
function addCall(t: CostTotals, r: LlmRow): void {
  const tin = r.tokens_in ?? 0;
  const tout = r.tokens_out ?? 0;
  t.calls += 1;
  t.tokens_in += tin;
  t.tokens_out += tout;
  t.cost_usd += r.cost_usd ?? 0;
  if (r.cost_source === "estimated") t.cost_estimated_usd += r.cost_usd ?? 0;
  if (tin + tout > 0 && r.cost_usd === null && r.cost_source === null) t.unpriced_calls += 1;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function latency(durations: number[]): Latency {
  const sorted = [...durations].sort((a, b) => a - b);
  return { p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95) };
}

function group<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function totalsOf(rows: LlmRow[]): CostTotals {
  const t = zero();
  for (const r of rows) addCall(t, r);
  return t;
}

const durationsOf = (rows: { duration_ms: number | null }[]) => rows.flatMap((r) => (r.duration_ms !== null && r.duration_ms >= 0 ? [r.duration_ms] : []));
const byCost = (a: CostTotals, b: CostTotals) => b.cost_usd - a.cost_usd || b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out);

export function computeStats(workspace: string, window: StatsWindow, rows: StatsRows): StatsResponse {
  const errorsByRun = group(rows.errors, (e) => e.run_id);
  const errorsByAgent = group(
    rows.errors.filter((e) => e.agent_id),
    (e) => e.agent_id!,
  );

  // --- runs: those that started in the window, plus any with calls in it ---
  const llmByRun = group(rows.llm, (r) => r.run_id);
  const runMeta = new Map(rows.runs.map((r) => [r.run_id, r]));
  const runIds = new Set([...runMeta.keys(), ...llmByRun.keys()]);
  const byRun: RunStats[] = [...runIds]
    .map((run_id) => {
      const meta = runMeta.get(run_id);
      return {
        run_id,
        name: meta?.name ?? null,
        status: meta?.status ?? "running",
        started_at: meta?.started_at ?? llmByRun.get(run_id)?.[0]?.ts ?? null,
        duration_ms: meta?.duration_ms ?? null,
        errors: errorsByRun.get(run_id)?.length ?? 0,
        ...totalsOf(llmByRun.get(run_id) ?? []),
      };
    })
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    .slice(0, MAX_RUNS);

  // --- agents ---
  const agentMeta = new Map(rows.agents.map((a) => [a.agent_id, a]));
  const byAgent: AgentStats[] = [...group(rows.llm.filter((r) => r.agent_id), (r) => r.agent_id!)]
    .map(([agent_id, calls]) => ({
      agent_id,
      name: agentMeta.get(agent_id)?.name ?? agent_id,
      team_id: agentMeta.get(agent_id)?.team_id ?? null,
      errors: errorsByAgent.get(agent_id)?.length ?? 0,
      ...totalsOf(calls),
      ...latency(durationsOf(calls)),
    }))
    .sort(byCost);

  // --- models ---
  const byModel: ModelStats[] = [...group(rows.llm, (r) => r.model ?? "unknown")]
    .map(([model, calls]) => ({ model, ...totalsOf(calls), ...latency(durationsOf(calls)) }))
    .sort(byCost);

  // --- days (UTC) ---
  const byDay = [...group(rows.llm, (r) => r.ts.slice(0, 10))]
    .map(([day, calls]) => {
      const t = totalsOf(calls);
      return { day, calls: t.calls, cost_usd: t.cost_usd, cost_estimated_usd: t.cost_estimated_usd };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  // --- tools ---
  const tools: ToolStats[] = [...group(rows.tools, (t) => t.tool_name)]
    .map(([tool_name, calls]) => {
      const d = durationsOf(calls);
      return { tool_name, calls: calls.length, errors: calls.filter((c) => !c.ok).length, ...latency(d), max_ms: d.length ? Math.max(...d) : null };
    })
    .filter((t) => t.p95_ms !== null)
    .sort((a, b) => b.p95_ms! - a.p95_ms! || b.calls - a.calls)
    .slice(0, MAX_TOOLS);

  // --- totals ---
  const count = (status: RunState["status"]) => rows.runs.filter((r) => r.status === status).length;
  const runsOk = count("ok");
  const runsFailed = count("error");
  return {
    workspace,
    since: window.since,
    until: window.until,
    totals: {
      ...totalsOf(rows.llm),
      ...latency(durationsOf(rows.llm)),
      runs: rows.runs.length,
      runs_ok: runsOk,
      runs_failed: runsFailed,
      runs_cancelled: count("cancelled"),
      error_rate: runsOk + runsFailed ? runsFailed / (runsOk + runsFailed) : null,
      errors: rows.errors.length,
      tool_calls: rows.tools.length,
      tool_errors: rows.tools.filter((t) => !t.ok).length,
    },
    by_run: byRun,
    by_agent: byAgent,
    by_model: byModel,
    by_day: byDay,
    slowest_tools: tools,
  };
}
