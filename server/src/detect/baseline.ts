import { percentile } from "../store/stats.js";
import type { Baseline, Stat } from "./types.js";

/** Rows a store returns for a baseline (see `Store.baselineRows`). */
export interface BaselineRows {
  runs: { run_id: string; tokens: number; cost_usd: number }[];
  /** Agents that took part in those runs, with their tool calls (0 included). */
  agents: { run_id: string; agent_id: string; tool_calls: number }[];
}

/** Pure, so every store gives the same baseline. Runs an agent wasn't in count as 0 for it. */
export function computeBaseline(rows: BaselineRows): Baseline {
  const runIds = rows.runs.map((r) => r.run_id);
  const perAgent = new Map<string, Map<string, number>>();
  for (const a of rows.agents) {
    if (!perAgent.has(a.agent_id)) perAgent.set(a.agent_id, new Map());
    perAgent.get(a.agent_id)!.set(a.run_id, a.tool_calls);
  }
  const toolCalls: Record<string, Stat> = {};
  for (const [agent, byRun] of perAgent) {
    const stat = statOf(runIds.map((id) => byRun.get(id) ?? 0));
    if (stat) toolCalls[agent] = stat;
  }
  return {
    runs: runIds.length,
    toolCalls,
    tokens: statOf(rows.runs.map((r) => r.tokens)),
    cost: statOf(rows.runs.map((r) => r.cost_usd)),
  };
}

function statOf(values: number[]): Stat | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50)!, p95: percentile(sorted, 95)! };
}
