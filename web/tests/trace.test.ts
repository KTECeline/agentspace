import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { buildTimeline } from "../lib/replay";
import { buildTrace, nodeAt, pathTo, type TraceNode } from "../lib/trace";

const dir = fileURLToPath(new URL("../public/recordings/", import.meta.url));
const load = (name: string) => buildTimeline((JSON.parse(readFileSync(dir + name, "utf8")) as { events: AgentSpaceEvent[] }).events).events;

let n = 0;
function ev(type: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}): AgentSpaceEvent {
  n += 1;
  return {
    spec_version: "0.1",
    id: `e${n}`,
    type,
    ts: new Date(Date.UTC(2026, 9, 6, 10, 0, 0, n * 100)).toISOString(),
    workspace: "default",
    run_id: "r1",
    agent_id: null,
    team_id: null,
    parent_id: null,
    data,
    ...extra,
  } as AgentSpaceEvent;
}

const shape = (x: TraceNode): unknown => [x.kind, x.label, ...(x.children.length ? [x.children.map(shape)] : [])];

describe("buildTrace", () => {
  it("nests the dev-team recording by step, pairs tools and places the parentless approval", () => {
    const events = load("dev-team.json");
    const t = buildTrace(events);
    expect(t.root.label).toBe("dev-team");
    expect(t.root.status).toBe("ok");
    expect(t.root.children.filter((c) => c.kind === "step").map((c) => `${c.agentId}:${c.label}`)).toEqual([
      "manager:Manager",
      "triage:Triage",
      "manager:Manager",
      "engineer:Engineer",
      "manager:Manager",
    ]);
    const engineer = t.root.children.find((c) => c.agentId === "engineer" && c.kind === "step")!;
    expect(engineer.children.map((c) => `${c.kind}:${c.label}`)).toEqual(["llm:" + engineer.children[0]!.label, "tool:write_file", "llm:" + engineer.children[2]!.label, "tool:run_tests", "llm:" + engineer.children[4]!.label]);
    const write = engineer.children[1]!;
    expect(write.status).toBe("ok");
    // approval.requested has no parent_id in this recording: it lands in the open tool call.
    expect(write.children.map((c) => [c.kind, c.inferred, c.status])).toEqual([["approval", true, "ok"]]);
    // Every model call is counted exactly once.
    expect(t.root.llmCalls).toBe(events.filter((e) => e.type === "llm.call").length);
    expect(t.root.toolCalls).toBe(4);
    expect(t.firstError).toBeNull();
  });

  it("builds a tree for every bundled recording with no node lost or duplicated", () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const events = load(file);
      const t = buildTrace(events);
      const expected = events.filter((e) => !["agent.status", "agent.registered", "run.started", "run.finished", "step.finished", "tool.result", "approval.resolved"].includes(e.type)).length;
      expect(t.flat.length - 1, file).toBe(expected);
      expect(new Set(t.flat.map((x) => x.id)).size, file).toBe(t.flat.length);
      for (const x of t.flat) {
        expect(x.start, file).toBeLessThanOrEqual(x.end);
        for (const c of x.children) expect(c.depth, file).toBe(x.depth + 1);
      }
      expect(t.root.usage.tokens_in, file).toBe(events.reduce((s, e) => s + (e.type === "llm.call" ? (e.tokens_in ?? 0) : 0), 0));
    }
  });

  it("marks failures, keeps unfinished work open and finds the first thing that went wrong", () => {
    n = 0;
    const events = [
      ev("run.started", {}, { name: "deploy" }),
      ev("step.started", { agent_id: "rev" }, { step_id: "s1", name: "review" }),
      ev("tool.call", { agent_id: "rev", parent_id: "s1" }, { tool_name: "run_tests", call_id: "c1" }),
      ev("tool.result", { agent_id: "rev", parent_id: "s1" }, { tool_name: "run_tests", call_id: "c1", ok: false, error: "exit 1" }),
      ev("error", { agent_id: "rev" }, { message: "boom" }),
      ev("step.finished", { agent_id: "rev" }, { step_id: "s1", name: "review", ok: false, error: "tests failed" }),
      ev("step.started", { agent_id: "dep" }, { step_id: "s2", name: "deploy" }),
      ev("tool.call", { agent_id: "dep", parent_id: "s2" }, { tool_name: "ship", call_id: "c2" }),
      ev("run.finished", {}, { status: "error" }),
    ];
    const t = buildTrace(events);
    expect(shape(t.root)).toEqual(["run", "deploy", [["step", "review", [["tool", "run_tests"], ["error", "boom"]]], ["step", "deploy", [["tool", "ship"]]]]]);
    const review = t.root.children[0]!;
    expect([review.status, review.error, review.hasError]).toEqual(["error", "tests failed", true]);
    expect(review.children[1]!.inferred).toBe(true);
    const ship = t.byId.get("tool:c2")!;
    expect([ship.status, ship.end, ship.durationMs]).toEqual(["open", events.length - 1, null]);
    expect(t.root.status).toBe("error");
    expect(t.firstError?.id).toBe("tool:c1");
    expect(pathTo(t, "tool:c1")).toEqual(["run", "step:s1", "tool:c1"]);
  });

  it("keeps a step whose start is missing and leaves a step with no parent at the top", () => {
    n = 0;
    const t = buildTrace([
      ev("step.started", { agent_id: "a" }, { step_id: "outer", name: "outer" }),
      ev("step.started", { agent_id: "a" }, { step_id: "inner", name: "inner" }), // no parent_id: top level
      ev("step.finished", { agent_id: "b" }, { step_id: "lost", name: "lost", ok: true, duration_ms: 42 }),
    ]);
    expect(t.root.children.map((c) => c.id)).toEqual(["step:outer", "step:inner", "step:lost"]);
    expect(t.byId.get("step:lost")!.durationMs).toBe(42);
    expect(t.root.status).toBe("open");
  });
});

describe("nodeAt", () => {
  it("returns the most recently started node covering an event, and null outside any", () => {
    n = 0;
    const t = buildTrace([
      ev("run.started", {}, { name: "r" }),
      ev("step.started", { agent_id: "a" }, { step_id: "s", name: "s" }),
      ev("llm.call", { agent_id: "a", parent_id: "s" }),
      ev("agent.status", { agent_id: "a" }, { status: "thinking" }),
      ev("step.finished", { agent_id: "a" }, { step_id: "s", name: "s", ok: true }),
      ev("run.finished", {}, { status: "ok" }),
    ]);
    expect(nodeAt(t, 0)).toBeNull();
    expect(nodeAt(t, 1)?.id).toBe("step:s");
    expect(nodeAt(t, 2)?.kind).toBe("llm");
    expect(nodeAt(t, 3)?.id).toBe("step:s");
    expect(nodeAt(t, 5)).toBeNull();
  });
});
