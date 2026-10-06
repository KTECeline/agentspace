import type { AgentSpaceEvent } from "@agentspace/spec-types";
import type { Detector, DetectorConfig, Finding, Severity } from "./types.js";

/**
 * The built-in detectors (D-044). Each fires once per thing it finds (the key), with the numbers
 * behind it as evidence. None of them reads content: only names, counts, outcomes and the
 * arguments hash.
 */

const MAX_SUBJECTS = 20;

const push = (ids: string[], id: string) => {
  ids.push(id);
  if (ids.length > MAX_SUBJECTS) ids.shift();
};

/** The same agent calls the same tool with the same arguments (by `arguments_hash`) N+ times. */
export const repeatedToolCall: Detector<DetectorConfig["repeated_tool_call"]> = {
  id: "repeated_tool_call",
  create(_ctx, cfg) {
    const seen = new Map<string, { count: number; ids: string[] }>();
    return (e) => {
      if (e.type !== "tool.call" || !e.data.arguments_hash) return [];
      const key = `${e.agent_id ?? "-"}|${e.data.tool_name}|${e.data.arguments_hash}`;
      const s = seen.get(key) ?? { count: 0, ids: [] };
      seen.set(key, s);
      s.count += 1;
      push(s.ids, e.id);
      if (s.count !== cfg.min_count) return [];
      return [
        finding("repeated_tool_call", key, "warning", `${e.data.tool_name} called ${s.count} times with the same arguments`, e, s.ids, {
          tool: e.data.tool_name,
          count: s.count,
        }),
      ];
    };
  },
};

/** One agent's tool fails N+ times in a row (arrival order) with no success in between. */
export const failureLoop: Detector<DetectorConfig["failure_loop"]> = {
  id: "failure_loop",
  create(_ctx, cfg) {
    const streaks = new Map<string, { count: number; ids: string[]; n: number }>();
    return (e) => {
      if (e.type !== "tool.result") return [];
      const key = `${e.agent_id ?? "-"}|${e.data.tool_name}`;
      const s = streaks.get(key) ?? { count: 0, ids: [], n: 0 };
      streaks.set(key, s);
      if (e.data.ok) {
        if (s.count >= cfg.min_count) s.n += 1; // the next streak is a new finding
        s.count = 0;
        s.ids = [];
        return [];
      }
      s.count += 1;
      push(s.ids, e.id);
      if (s.count !== cfg.min_count) return [];
      return [
        finding("failure_loop", `${key}|${s.n}`, "warning", `${e.data.tool_name} failed ${s.count} times in a row`, e, s.ids, {
          tool: e.data.tool_name,
          count: s.count,
          ...(e.data.error ? { last_error: e.data.error.slice(0, 200) } : {}),
        }),
      ];
    };
  },
};

/** Two agents hand work back and forth: N+ round trips (A→B→A counts one) in a row. */
export const handoffLoop: Detector<DetectorConfig["handoff_loop"]> = {
  id: "handoff_loop",
  create(_ctx, cfg) {
    let cur: { pair: string; lastTo: string; handoffs: number; first: string; ids: string[] } | null = null;
    return (e) => {
      if (e.type !== "handoff") return [];
      const { from_agent_id: from, to_agent_id: to } = e.data;
      const pair = [from, to].sort().join("|");
      if (cur && cur.pair === pair && cur.lastTo === from) {
        cur.handoffs += 1;
        cur.lastTo = to;
        push(cur.ids, e.id);
      } else {
        cur = { pair, lastTo: to, handoffs: 1, first: e.id, ids: [e.id] };
      }
      const roundTrips = Math.floor(cur.handoffs / 2);
      if (cur.handoffs % 2 !== 0 || roundTrips !== cfg.min_round_trips) return [];
      return [
        finding("handoff_loop", `${pair}|${cur.first}`, "warning", `${from} and ${to} handed work back and forth ${roundTrips} times`, e, cur.ids, {
          round_trips: roundTrips,
          handoffs: cur.handoffs,
        }),
      ];
    };
  },
};

/** An agent makes far more tool calls than in the workflow's recent successful runs. */
export const toolCallOutlier: Detector<DetectorConfig["tool_call_outlier"]> = {
  id: "tool_call_outlier",
  create(ctx, cfg) {
    const counts = new Map<string, number>();
    const fired = new Set<string>();
    return (e) => {
      if (e.type !== "tool.call" || !e.agent_id) return [];
      const n = (counts.get(e.agent_id) ?? 0) + 1;
      counts.set(e.agent_id, n);
      const b = ctx.baseline;
      const stat = b?.toolCalls[e.agent_id];
      if (!b || !stat || b.runs < cfg.min_runs || fired.has(e.agent_id)) return [];
      if (n <= cfg.factor * stat.p50 || n < stat.p50 + cfg.min_extra) return [];
      fired.add(e.agent_id);
      return [
        finding("tool_call_outlier", e.agent_id, severityFor(n, stat.p50), `${n} tool calls so far; usually ${stat.p50} (median of ${b.runs} runs)`, e, [e.id], {
          count: n,
          baseline_p50: stat.p50,
          baseline_p95: stat.p95,
          baseline_runs: b.runs,
        }),
      ];
    };
  },
};

/** The run uses far more tokens, or costs far more, than the workflow's recent successful runs. */
export const usageOutlier: Detector<DetectorConfig["usage_outlier"]> = {
  id: "usage_outlier",
  create(ctx, cfg) {
    let tokens = 0;
    let cost = 0;
    const fired = new Set<string>();
    return (e) => {
      if (e.type !== "llm.call") return [];
      tokens += (e.tokens_in ?? 0) + (e.tokens_out ?? 0);
      cost += e.cost_usd ?? 0;
      const b = ctx.baseline;
      if (!b || b.runs < cfg.min_runs) return [];
      const out: Finding[] = [];
      const check = (what: "tokens" | "cost", value: number, stat: { p50: number; p95: number } | null, show: (v: number) => string) => {
        if (!stat || stat.p50 <= 0 || fired.has(what) || value <= cfg.factor * stat.p50) return;
        fired.add(what);
        out.push(
          finding("usage_outlier", what, severityFor(value, stat.p50), `${what === "tokens" ? "Tokens" : "Cost"} so far ${show(value)}; usually ${show(stat.p50)} per run (median of ${b.runs})`, e, [e.id], {
            metric: what,
            value: round(value),
            baseline_p50: round(stat.p50),
            baseline_p95: round(stat.p95),
            baseline_runs: b.runs,
          }),
        );
      };
      check("tokens", tokens, b.tokens, (v) => Math.round(v).toLocaleString("en-US"));
      check("cost", cost, b.cost, (v) => `$${v.toFixed(v < 1 ? 4 : 2)}`);
      return out;
    };
  },
};

export const DETECTORS = [repeatedToolCall, failureLoop, handoffLoop, toolCallOutlier, usageOutlier] as const;

export const DEFAULT_CONFIG: DetectorConfig = {
  repeated_tool_call: { enabled: true, min_count: 3 },
  failure_loop: { enabled: true, min_count: 3 },
  handoff_loop: { enabled: true, min_round_trips: 3 },
  tool_call_outlier: { enabled: true, min_runs: 5, factor: 2, min_extra: 5 },
  usage_outlier: { enabled: true, min_runs: 5, factor: 2 },
};

/** Five times the usual is critical; anything flagged below that is a warning. */
function severityFor(value: number, p50: number): Severity {
  return p50 > 0 && value >= 5 * p50 ? "critical" : "warning";
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function finding(
  detector: string,
  key: string,
  severity: Severity,
  message: string,
  trigger: AgentSpaceEvent,
  ids: string[],
  evidence: Finding["evidence"],
): Finding {
  return { detector, key, severity, message: message.slice(0, 500), evidence, trigger, subjectIds: [...ids] };
}
