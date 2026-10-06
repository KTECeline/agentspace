import { describe, expect, it } from "vitest";
import type { AgentSpaceEvent, StoredEvent } from "@agentspace/spec-types";
import { findingsFor } from "../lib/agentDetail";
import { compareRuns } from "../lib/compare";
import { evidenceRows } from "../lib/format";
import { buildTimeline } from "../lib/replay";
import { buildTrace } from "../lib/trace";

let n = 0;
function ev(type: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}): AgentSpaceEvent {
  n += 1;
  return {
    spec_version: "0.1",
    id: `e${n}`,
    type,
    ts: new Date(Date.UTC(2026, 9, 6, 10, 0, n)).toISOString(),
    workspace: "default",
    run_id: "r1",
    agent_id: null,
    team_id: null,
    parent_id: null,
    data,
    ...extra,
  } as AgentSpaceEvent;
}
const finding = (agent: string, run = "r1", parent: string | null = null) =>
  ev("anomaly.detected", { agent_id: agent, run_id: run, parent_id: parent }, { detector: "failure_loop", severity: "warning", message: "run_tests failed 3 times in a row", evidence: { count: 3, tool: "run_tests" } });

describe("findings in the web app (D-044)", () => {
  it("formats evidence with readable labels, known keys first, money for cost", () => {
    expect(evidenceRows({ baseline_runs: 12, count: 31, baseline_p50: 8, odd_key: "x" })).toEqual([
      ["This run", "31"],
      ["Usually (median)", "8"],
      ["Runs compared", "12"],
      ["odd key", "x"],
    ]);
    expect(evidenceRows({ metric: "cost", value: 2.84, baseline_p50: 0.32 })).toEqual([
      ["Measure", "cost"],
      ["This run", "$2.84"],
      ["Usually (median)", "$0.32"],
    ]);
    expect(evidenceRows(undefined)).toEqual([]);
  });

  it("lists an agent's findings in one run, newest first", () => {
    const events = [finding("rev"), finding("other"), finding("rev", "r2"), finding("rev")].map((e, i) => ({ ...e, seq: i + 1 }) as StoredEvent);
    expect(findingsFor(events, "rev", "r1").map((f) => f.id)).toEqual([events[3]!.id, events[0]!.id]);
  });

  it("shows findings as trace rows, not failures, and as replay markers", () => {
    const events = [
      ev("step.started", { agent_id: "rev" }, { step_id: "s1", name: "review" }),
      finding("rev", "r1", "s1"),
      ev("step.finished", { agent_id: "rev" }, { step_id: "s1", name: "review", ok: true }),
    ];
    const trace = buildTrace(events);
    const step = trace.root.children[0]!;
    expect(step.children.map((c) => [c.kind, c.status])).toEqual([["finding", "none"]]);
    expect([step.findings, step.hasError, trace.firstError]).toEqual([1, false, null]);
    expect(buildTimeline(events).markers.map((m) => m.kind)).toEqual(["finding"]);
  });

  it("counts findings when comparing runs", () => {
    const c = compareRuns([ev("run.started", {}, { name: "x" })], [ev("run.started", {}, { name: "x" }), finding("rev")]);
    expect(c.changed.find((m) => m.key === "findings")).toMatchObject({ a: 0, b: 1 });
  });
});
