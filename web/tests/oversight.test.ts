import { describe, expect, it } from "vitest";
import type { ApprovalContext, ApprovalPolicy } from "@agentspace/spec-types";
import { approvalWhy, pausedBy } from "@/lib/oversight";

const policy: ApprovalPolicy = { tool: "run_tests", action: "review", rule: "run_*", source: "collector", reason: "Tests touch the staging DB." };
const context: ApprovalContext = {
  findings: [{ detector: "failure_loop", severity: "critical", message: "run_tests failed 3 times in a row" }],
  agent_tool_calls: 31,
  baseline_tool_calls_p50: 8,
  tool_calls: 4,
  run_cost_usd: 0.05,
  baseline_cost_p50: 0.04,
  baseline_runs: 6,
};

describe("approvalWhy", () => {
  it("is null when no policy asked", () => {
    expect(approvalWhy({ policy: null, context: null })).toBeNull();
  });

  it("names the rule and waits for the collector's evidence", () => {
    const why = approvalWhy({ policy, context: null })!;
    expect(why).toMatchObject({ rule: "Policy rule run_* (collector)", reason: "Tests touch the staging DB.", loading: true, lines: [] });
  });

  it("compares the run with the usual and flags what's unusual", () => {
    const why = approvalWhy({ policy: { ...policy, escalated: true }, context })!;
    expect(why.escalated).toBe(true);
    expect(why.lines).toEqual([
      { label: "Tool calls by this agent", value: "31 · usually 8", unusual: true },
      { label: "run_tests calls so far", value: "4", unusual: false },
      { label: "Run cost so far", value: "$0.05 · usually $0.04", unusual: false },
      { label: "Compared with", value: "6 earlier successful runs", unusual: false },
    ]);
    expect(why.findings).toHaveLength(1);
  });

  it("says when there's nothing to compare with", () => {
    const why = approvalWhy({ policy: { tool: "x", action: "review", source: "code" }, context: { ...context, findings: [], baseline_runs: 0, baseline_tool_calls_p50: null, baseline_cost_p50: null } })!;
    expect(why.rule).toBe("Policy default (in code)");
    expect(why.lines[0]).toEqual({ label: "Tool calls by this agent", value: "31", unusual: false });
    expect(why.lines.at(-1)!.value).toBe("no earlier successful runs yet");
  });
});

describe("pausedBy", () => {
  it("explains a pause the collector made, not an operator's", () => {
    expect(pausedBy({ control: "paused", control_by: "detector:failure_loop", control_reason: "run_tests failed 3 times" })).toBe(
      "Paused by the failure_loop detector: run_tests failed 3 times",
    );
    expect(pausedBy({ control: "paused", control_by: "operator", control_reason: null })).toBeNull();
    expect(pausedBy({ control: "running", control_by: "detector:x", control_reason: null })).toBeNull();
  });
});
