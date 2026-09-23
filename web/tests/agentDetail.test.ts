import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agentspace/spec-types";
import { currentStep, toolCalls } from "../lib/agentDetail";

let seq = 0;
const ev = (type: string, data: object, agent = "eng"): StoredEvent =>
  ({ seq: ++seq, spec_version: "0.1", id: `e${seq}`, type, ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, workspace: "w", run_id: "r", agent_id: agent, team_id: null, parent_id: null, data }) as StoredEvent;

describe("currentStep", () => {
  it("returns the innermost unfinished step", () => {
    const events = [
      ev("step.started", { step_id: "a", name: "Engineer", kind: "agent" }),
      ev("step.started", { step_id: "b", name: "reproduce" }),
      ev("step.finished", { step_id: "b", name: "reproduce", ok: true }),
      ev("step.started", { step_id: "c", name: "patch" }),
      ev("step.started", { step_id: "z", name: "other agent" }, "qa"),
    ];
    expect(currentStep(events, "eng")?.name).toBe("patch");
    expect(currentStep([...events, ev("step.finished", { step_id: "c", name: "patch", ok: true })], "eng")?.name).toBe("Engineer");
    expect(currentStep([], "eng")).toBeNull();
  });
});

describe("toolCalls", () => {
  it("pairs calls with results, newest first", () => {
    const events = [
      ev("tool.call", { tool_name: "read_file", call_id: "1" }),
      ev("tool.result", { tool_name: "read_file", call_id: "1", ok: true, duration_ms: 12 }),
      ev("tool.call", { tool_name: "run_tests", call_id: "2" }),
      ev("tool.result", { tool_name: "run_tests", call_id: "2", ok: false, error: "boom" }),
      ev("tool.call", { tool_name: "write_file", call_id: "3" }),
    ];
    expect(toolCalls(events, "eng").map((c) => [c.tool, c.state])).toEqual([
      ["write_file", "running"],
      ["run_tests", "failed"],
      ["read_file", "ok"],
    ]);
    expect(toolCalls(events, "eng")[1]!.error).toBe("boom");
    expect(toolCalls(events, "eng", 1)).toHaveLength(1);
  });
});
