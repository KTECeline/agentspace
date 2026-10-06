import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { compareRuns, profileRun } from "../lib/compare";
import { buildTimeline } from "../lib/replay";

const recording = buildTimeline(
  (JSON.parse(readFileSync(fileURLToPath(new URL("../public/recordings/dev-team.json", import.meta.url)), "utf8")) as { events: AgentSpaceEvent[] }).events,
).events;

let n = 0;
function ev(type: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}): AgentSpaceEvent {
  n += 1;
  return {
    spec_version: "0.1",
    id: `e${n}`,
    type,
    ts: new Date(Date.UTC(2026, 9, 6, 10, 0, 0, n * 100)).toISOString(),
    workspace: "default",
    run_id: "r",
    agent_id: null,
    team_id: null,
    parent_id: null,
    data,
    ...extra,
  } as AgentSpaceEvent;
}

/** A small reviewer run: one step, `tests` tool calls, then ok or error. */
function run(opts: { model: string; tests: number; fail?: boolean; cost: number }): AgentSpaceEvent[] {
  const out = [ev("run.started", {}, { name: "ship" }), ev("agent.registered", { agent_id: "rev" }, { name: "Reviewer" })];
  out.push(ev("step.started", { agent_id: "rev" }, { step_id: `s${n}`, name: "review" }));
  out.push(ev("llm.call", { agent_id: "rev", model: opts.model, tokens_in: 100, tokens_out: 10, cost_usd: opts.cost }, { duration_ms: 400 }));
  for (let i = 0; i < opts.tests; i++) {
    const call_id = `c${n}`;
    out.push(ev("tool.call", { agent_id: "rev" }, { tool_name: "run_tests", call_id }));
    out.push(ev("tool.result", { agent_id: "rev" }, { tool_name: "run_tests", call_id, ok: !(opts.fail && i === opts.tests - 1) }));
  }
  out.push(ev("run.finished", {}, { status: opts.fail ? "error" : "ok", duration_ms: 1000 * opts.tests }));
  return out;
}

describe("profileRun", () => {
  it("profiles the dev-team recording", () => {
    const p = profileRun(recording);
    expect(p.name).toBe("dev-team");
    expect(p.status).toBe("ok");
    expect(p.path.map((id) => p.names[id])).toEqual(["Manager", "Triage", "Manager", "Engineer", "Manager"]);
    expect(p.toolCalls).toBe(4);
    expect(p.tools.run_tests).toEqual({ calls: 2, failed: 0 });
    expect(p.handoffs).toBe(4);
    expect(p.approvals).toBe(1);
    expect(p.llmCalls).toBe(9);
    expect(p.errors).toBe(0);
  });
});

describe("compareRuns", () => {
  it("finds nothing to report between a run and itself", () => {
    const c = compareRuns(recording, recording);
    expect(c.changed).toEqual([]);
    expect(c.divergence).toBeNull();
    expect(c.pathChanged || c.statusChanged).toBe(false);
  });

  it("reports what changed and where the runs first differ", () => {
    n = 0;
    const good = run({ model: "claude-haiku-4-5", tests: 1, cost: 0.01 });
    const bad = run({ model: "claude-sonnet-4-5", tests: 3, fail: true, cost: 0.04 });
    const c = compareRuns(good, bad);
    expect(c.statusChanged).toBe(true);
    expect(c.changed.map((m) => m.key)).toEqual(["duration", "cost", "tool_calls", "failed_tools"]);
    expect(c.metrics.find((m) => m.key === "cost")!.ratio).toBeCloseTo(4);
    expect(c.metrics.find((m) => m.key === "failed_tools")!.ratio).toBeNull(); // 0 → 1: no ratio
    expect(c.models).toEqual([
      { model: "claude-haiku-4-5", a: 1, b: 0 },
      { model: "claude-sonnet-4-5", a: 0, b: 1 },
    ]);
    expect(c.tools).toEqual([{ tool: "run_tests", a: { calls: 1, failed: 0 }, b: { calls: 3, failed: 1 } }]);
    // Same step, then a different model: that's the first divergence.
    expect(c.divergence?.common).toBe(1);
    expect(c.divergence?.a?.sig).toBe("rev llm claude-haiku-4-5");
    expect(bad[c.divergence!.b!.index]!.type).toBe("llm.call");
  });

  it("treats a run that stops early as diverging where it ended", () => {
    n = 0;
    const a = run({ model: "m", tests: 1, cost: 0 });
    const b = run({ model: "m", tests: 2, cost: 0 });
    const d = compareRuns(a, b).divergence!;
    expect(d.a).toBeNull();
    expect(d.b?.sig).toBe("rev tool run_tests");
  });
});
