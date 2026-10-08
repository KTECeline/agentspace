import type { ApprovalState, RunState } from "@agentspace/spec-types";
import { formatCost } from "./format";

/** A line of review evidence. `unusual` lines are worth a look (about twice the usual or more). */
export interface EvidenceLine {
  label: string;
  value: string;
  unusual: boolean;
}

export interface ApprovalWhy {
  /** "Policy rule write_* (in code)", or null when no policy asked. */
  rule: string | null;
  reason: string | null;
  /** Asked only because the run has detector findings. */
  escalated: boolean;
  lines: EvidenceLine[];
  findings: { detector: string; severity: "info" | "warning" | "critical"; message: string }[];
  /** True until the collector has attached its evidence. */
  loading: boolean;
}

const UNUSUAL_RATIO = 2;
const SOURCE: Record<string, string> = { code: "in code", collector: "collector" };

const usually = (n: number | null, fmt: (v: number) => string) => (n == null ? "" : ` · usually ${fmt(n)}`);
const unusual = (value: number, baseline: number | null) => baseline != null && value >= UNUSUAL_RATIO * Math.max(baseline, 1);

/** Why a person is asked to review this call, and what the run looks like so far (D-045). */
export function approvalWhy(a: Pick<ApprovalState, "policy" | "context">): ApprovalWhy | null {
  const p = a.policy;
  if (!p) return null;
  const rule = p.rule ? `Policy rule ${p.rule}${p.source ? ` (${SOURCE[p.source] ?? p.source})` : ""}` : p.source ? `Policy default (${SOURCE[p.source] ?? p.source})` : "Policy";
  const c = a.context;
  const lines: EvidenceLine[] = [];
  if (c) {
    const count = (n: number) => n.toLocaleString("en-US");
    const base = c.baseline_runs > 0;
    lines.push({
      label: "Tool calls by this agent",
      value: `${count(c.agent_tool_calls)}${base ? usually(c.baseline_tool_calls_p50, count) : ""}`,
      unusual: base && unusual(c.agent_tool_calls, c.baseline_tool_calls_p50),
    });
    lines.push({ label: `${p.tool} calls so far`, value: count(c.tool_calls), unusual: false });
    lines.push({
      label: "Run cost so far",
      value: `${formatCost(c.run_cost_usd)}${base ? usually(c.baseline_cost_p50, formatCost) : ""}`,
      unusual: base && c.baseline_cost_p50 != null && c.baseline_cost_p50 > 0 && c.run_cost_usd >= UNUSUAL_RATIO * c.baseline_cost_p50,
    });
    lines.push({
      label: "Compared with",
      value: base ? `${count(c.baseline_runs)} earlier successful run${c.baseline_runs === 1 ? "" : "s"}` : "no earlier successful runs yet",
      unusual: false,
    });
  }
  return { rule, reason: p.reason ?? null, escalated: !!p.escalated, lines, findings: c?.findings ?? [], loading: !c };
}

/** "Paused by the failure_loop detector: …" when the collector paused the run itself, else null. */
export function pausedBy(run: Pick<RunState, "control" | "control_by" | "control_reason">): string | null {
  if (run.control !== "paused" || !run.control_by?.startsWith("detector:")) return null;
  const detector = run.control_by.slice("detector:".length);
  return `Paused by the ${detector} detector${run.control_reason ? `: ${run.control_reason}` : ""}`;
}
