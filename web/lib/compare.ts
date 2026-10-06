import type { AgentSpaceEvent, RunState } from "@agentspace/spec-types";
import { usageOf, type Usage } from "./projector";

/**
 * Run comparison (pure, tested in tests/compare.test.ts): a profile of each run, what changed
 * between two of them, and the first point where they stopped doing the same thing.
 * Inputs should be sorted by time (`buildTimeline(...).events`).
 */

export interface ToolProfile {
  calls: number;
  failed: number;
}

export interface RunProfile {
  name: string | null;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs: number | null;
  events: number;
  /** Agent ids in the order they took a step, with repeats in a row collapsed. */
  path: string[];
  names: Record<string, string>;
  models: Record<string, number>;
  tools: Record<string, ToolProfile>;
  usage: Usage;
  llmCalls: number;
  toolCalls: number;
  /** `error` events. Failed tool calls are counted apart: one failure often shows up as both. */
  errors: number;
  failedTools: number;
  handoffs: number;
  approvals: number;
  llmP50: number | null;
  llmP95: number | null;
  /** One entry per meaningful event (see `signature`), with its index in the input. */
  signature: { sig: string; index: number }[];
}

export function profileRun(events: AgentSpaceEvent[]): RunProfile {
  const p: RunProfile = {
    name: null,
    status: "running",
    durationMs: null,
    events: events.length,
    path: [],
    names: {},
    models: {},
    tools: {},
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, cost_estimated_usd: 0, unpriced_calls: 0 },
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
    failedTools: 0,
    handoffs: 0,
    approvals: 0,
    llmP50: null,
    llmP95: null,
    signature: [],
  };
  const latencies: number[] = [];
  events.forEach((e, index) => {
    const sig = signature(e);
    if (sig) p.signature.push({ sig, index });
    const u = usageOf(e);
    p.usage = {
      tokens_in: p.usage.tokens_in + u.tokens_in,
      tokens_out: p.usage.tokens_out + u.tokens_out,
      cost_usd: p.usage.cost_usd + u.cost_usd,
      cost_estimated_usd: p.usage.cost_estimated_usd + u.cost_estimated_usd,
      unpriced_calls: p.usage.unpriced_calls + u.unpriced_calls,
    };
    switch (e.type) {
      case "run.started":
        p.name = e.data.name ?? null;
        return;
      case "run.finished":
        p.status = e.data.status;
        p.durationMs = e.data.duration_ms ?? Date.parse(e.ts) - Date.parse(events[0]!.ts);
        return;
      case "agent.registered":
        if (e.agent_id) p.names[e.agent_id] = e.data.name;
        return;
      case "step.started":
        if (e.agent_id && p.path.at(-1) !== e.agent_id) p.path.push(e.agent_id);
        return;
      case "llm.call":
        p.llmCalls += 1;
        if (e.model) p.models[e.model] = (p.models[e.model] ?? 0) + 1;
        if (e.data.duration_ms !== undefined) latencies.push(e.data.duration_ms);
        return;
      case "tool.call":
        p.toolCalls += 1;
        (p.tools[e.data.tool_name] ??= { calls: 0, failed: 0 }).calls += 1;
        return;
      case "tool.result":
        if (!e.data.ok) {
          p.failedTools += 1;
          (p.tools[e.data.tool_name] ??= { calls: 0, failed: 0 }).failed += 1;
        }
        return;
      case "error":
        p.errors += 1;
        return;
      case "handoff":
        p.handoffs += 1;
        return;
      case "approval.requested":
        p.approvals += 1;
        return;
      default:
        return;
    }
  });
  latencies.sort((a, b) => a - b);
  p.llmP50 = nearestRank(latencies, 0.5);
  p.llmP95 = nearestRank(latencies, 0.95);
  return p;
}

/**
 * What a run *did* at an event, without ids, times or content: the agent, the kind of event and
 * what it acted on. Two runs that do the same thing have the same signatures, in the same order.
 */
export function signature(e: AgentSpaceEvent): string | null {
  const who = e.agent_id ?? "-";
  switch (e.type) {
    case "step.started":
      return `${who} step ${e.data.name}`;
    case "tool.call":
      return `${who} tool ${e.data.tool_name}`;
    case "tool.result":
      return e.data.ok ? null : `${who} tool-failed ${e.data.tool_name}`;
    case "llm.call":
      return `${who} llm ${e.model ?? "?"}`;
    case "handoff":
      return `${who} handoff ${e.data.to_agent_id}`;
    case "approval.requested":
      return `${who} approval`;
    case "approval.resolved":
      return `${who} approval-${e.data.decision}`;
    case "error":
      return `${who} error ${e.data.kind ?? ""}`.trimEnd();
    case "run.control":
      return `${who} control ${e.data.action}`;
    default:
      return null;
  }
}

export type Unit = "ms" | "tokens" | "usd" | "count";

export interface MetricChange {
  key: string;
  label: string;
  unit: Unit;
  a: number | null;
  b: number | null;
  /** b / a when both are positive. */
  ratio: number | null;
}

export interface Divergence {
  /** Matching steps before the runs differ. */
  common: number;
  /** Index in each run's events of the first differing event (null: that run had ended). */
  a: { index: number; sig: string } | null;
  b: { index: number; sig: string } | null;
}

export interface Comparison {
  a: RunProfile;
  b: RunProfile;
  metrics: MetricChange[];
  /** Only the metrics that differ. */
  changed: MetricChange[];
  models: { model: string; a: number; b: number }[];
  tools: { tool: string; a: ToolProfile; b: ToolProfile }[];
  pathChanged: boolean;
  statusChanged: boolean;
  /** Null when the runs did the same things in the same order. */
  divergence: Divergence | null;
}

export function compareRuns(eventsA: AgentSpaceEvent[], eventsB: AgentSpaceEvent[]): Comparison {
  const a = profileRun(eventsA);
  const b = profileRun(eventsB);
  const metric = (key: string, label: string, unit: Unit, get: (p: RunProfile) => number | null): MetricChange => {
    const va = get(a);
    const vb = get(b);
    return { key, label, unit, a: va, b: vb, ratio: va !== null && vb !== null && va > 0 && vb > 0 ? vb / va : null };
  };
  const metrics = [
    metric("duration", "Duration", "ms", (p) => p.durationMs),
    metric("cost", "Cost", "usd", (p) => p.usage.cost_usd),
    metric("tokens_in", "Tokens in", "tokens", (p) => p.usage.tokens_in),
    metric("tokens_out", "Tokens out", "tokens", (p) => p.usage.tokens_out),
    metric("llm_calls", "Model calls", "count", (p) => p.llmCalls),
    metric("tool_calls", "Tool calls", "count", (p) => p.toolCalls),
    metric("failed_tools", "Failed tool calls", "count", (p) => p.failedTools),
    metric("errors", "Errors", "count", (p) => p.errors),
    metric("handoffs", "Handoffs", "count", (p) => p.handoffs),
    metric("approvals", "Approvals asked", "count", (p) => p.approvals),
    metric("llm_p50", "Model latency p50", "ms", (p) => p.llmP50),
    metric("llm_p95", "Model latency p95", "ms", (p) => p.llmP95),
  ];
  const models = [...new Set([...Object.keys(a.models), ...Object.keys(b.models)])]
    .sort()
    .map((model) => ({ model, a: a.models[model] ?? 0, b: b.models[model] ?? 0 }));
  const none: ToolProfile = { calls: 0, failed: 0 };
  const tools = [...new Set([...Object.keys(a.tools), ...Object.keys(b.tools)])]
    .map((tool) => ({ tool, a: a.tools[tool] ?? none, b: b.tools[tool] ?? none }))
    .sort((x, y) => Math.abs(y.b.calls - y.a.calls) - Math.abs(x.b.calls - x.a.calls) || x.tool.localeCompare(y.tool));
  return {
    a,
    b,
    metrics,
    changed: metrics.filter((m) => m.a !== m.b),
    models,
    tools,
    pathChanged: a.path.join("\u0000") !== b.path.join("\u0000"),
    statusChanged: a.status !== b.status,
    divergence: diverge(a.signature, b.signature),
  };
}

function diverge(a: RunProfile["signature"], b: RunProfile["signature"]): Divergence | null {
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.sig === b[i]!.sig) i++;
  if (i === a.length && i === b.length) return null;
  return { common: i, a: a[i] ?? null, b: b[i] ?? null };
}

function nearestRank(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/**
 * The run to compare `target` with when none is given: the latest successful run of the same
 * workflow (same name) that started before it, else the latest successful one of that name.
 * Runs of a different workflow aren't comparable, so there may be none.
 */
export function pickBaseline(runs: RunState[], target: RunState): RunState | null {
  const ok = runs
    .filter((r) => r.run_id !== target.run_id && r.status === "ok" && r.name === target.name)
    .sort((x, y) => (y.started_at ?? "").localeCompare(x.started_at ?? ""));
  const before = (r: RunState) => !target.started_at || !r.started_at || r.started_at <= target.started_at;
  return ok.find(before) ?? ok[0] ?? null;
}
