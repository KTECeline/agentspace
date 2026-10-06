import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentSpaceEvent, StoredEvent } from "@agentspace/spec-types";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { computeBaseline } from "../src/detect/baseline.js";
import { DEFAULT_CONFIG, failureLoop, handoffLoop, repeatedToolCall, toolCallOutlier, usageOutlier } from "../src/detect/detectors.js";
import { loadDetectorConfig } from "../src/detect/engine.js";
import type { Baseline, Detector, Finding, RunContext } from "../src/detect/types.js";
import { SqliteStore } from "../src/store/index.js";
import { validateEvent } from "../src/validate.js";
import { ev } from "./helpers.js";

function feed<C>(d: Detector<C>, cfg: C, events: AgentSpaceEvent[], baseline: Baseline | null = null): Finding[][] {
  const ctx: RunContext = { workspace: "default", runId: "run-1", baseline };
  const check = d.create(ctx, cfg);
  return events.map((e) => check(e));
}
const call = (agent: string, tool: string, hash?: string) =>
  ev({ type: "tool.call", agent_id: agent, data: { tool_name: tool, call_id: Math.random().toString(36).slice(2), ...(hash ? { arguments_hash: hash } : {}) } });
const result = (agent: string, tool: string, ok: boolean) => ev({ type: "tool.result", agent_id: agent, data: { tool_name: tool, call_id: "c", ok, ...(ok ? {} : { error: "exit 1" }) } });
const handoff = (from: string, to: string) => ev({ type: "handoff", agent_id: from, data: { from_agent_id: from, to_agent_id: to } });
const llm = (agent: string, tokens: number, cost: number) => ev({ type: "llm.call", agent_id: agent, tokens_in: tokens, tokens_out: 0, cost_usd: cost, data: {} });
const fired = (out: Finding[][]) => out.map((f, i) => (f.length ? i : -1)).filter((i) => i >= 0);

describe("detectors", () => {
  it("repeated_tool_call: fires once when the same call (by hash) reaches the threshold", () => {
    const h = "aaaaaaaaaaaaaaaa";
    const out = feed(repeatedToolCall, DEFAULT_CONFIG.repeated_tool_call, [
      call("rev", "run_tests", h),
      call("rev", "run_tests", "bbbbbbbbbbbbbbbb"), // other arguments
      call("other", "run_tests", h), // other agent
      call("rev", "run_tests"), // no hash: never counted
      call("rev", "run_tests", h),
      call("rev", "run_tests", h),
      call("rev", "run_tests", h),
    ]);
    expect(fired(out)).toEqual([5]);
    const f = out[5]![0]!;
    expect([f.severity, f.message, f.evidence.count, f.subjectIds.length]).toEqual(["warning", "run_tests called 3 times with the same arguments", 3, 3]);
  });

  it("failure_loop: needs N failures in a row, and a later streak is a new finding", () => {
    const out = feed(failureLoop, DEFAULT_CONFIG.failure_loop, [
      result("rev", "run_tests", false),
      result("rev", "run_tests", false),
      result("rev", "run_tests", true), // resets
      result("rev", "deploy", false), // another tool: its own streak
      result("rev", "run_tests", false),
      result("rev", "run_tests", false),
      result("rev", "run_tests", false), // 3 in a row
      result("rev", "run_tests", false),
      result("rev", "run_tests", true),
      result("rev", "run_tests", false),
      result("rev", "run_tests", false),
      result("rev", "run_tests", false), // second streak
    ]);
    expect(fired(out)).toEqual([6, 11]);
    expect(out[6]![0]!.key).not.toBe(out[11]![0]!.key);
    expect(out[6]![0]!.evidence).toMatchObject({ tool: "run_tests", count: 3, last_error: "exit 1" });
  });

  it("handoff_loop: counts back-and-forth round trips between the same two agents", () => {
    const out = feed(handoffLoop, DEFAULT_CONFIG.handoff_loop, [
      handoff("planner", "coder"),
      handoff("coder", "reviewer"), // breaks: a different pair
      handoff("reviewer", "coder"),
      handoff("coder", "reviewer"),
      handoff("reviewer", "coder"),
      handoff("coder", "reviewer"),
      handoff("reviewer", "coder"), // 6 handoffs between coder and reviewer = 3 round trips
      handoff("coder", "reviewer"),
    ]);
    expect(fired(out)).toEqual([6]);
    expect(out[6]![0]!.evidence).toEqual({ round_trips: 3, handoffs: 6 });
  });

  const baseline: Baseline = { runs: 6, toolCalls: { rev: { p50: 2, p95: 3 } }, tokens: { p50: 1000, p95: 1200 }, cost: { p50: 0, p95: 0 } };

  it("tool_call_outlier: over 2x the median and at least 5 more, once per agent, only with enough runs", () => {
    const calls = Array.from({ length: 12 }, () => call("rev", "t"));
    const out = feed(toolCallOutlier, DEFAULT_CONFIG.tool_call_outlier, [...calls, call("stranger", "t")], baseline);
    expect(fired(out)).toEqual([6]); // the 7th call: > 4 and >= 2 + 5
    expect(out[6]![0]!).toMatchObject({ severity: "warning", evidence: { count: 7, baseline_p50: 2, baseline_runs: 6 } });
    expect(fired(feed(toolCallOutlier, DEFAULT_CONFIG.tool_call_outlier, calls, { ...baseline, runs: 4 }))).toEqual([]); // too few runs
    expect(fired(feed(toolCallOutlier, DEFAULT_CONFIG.tool_call_outlier, calls, null))).toEqual([]);
  });

  it("usage_outlier: tokens and cost against the median run; no finding for a zero median", () => {
    const out = feed(usageOutlier, DEFAULT_CONFIG.usage_outlier, [llm("rev", 1500, 0.01), llm("rev", 600, 0.01), llm("rev", 5000, 0.01)], baseline);
    expect(fired(out)).toEqual([1]);
    expect(out[1]![0]!).toMatchObject({ key: "tokens", severity: "warning", evidence: { metric: "tokens", value: 2100, baseline_p50: 1000 } });
    // 7,100 tokens is 7x the median, but tokens already fired; cost has a zero median.
    expect(out[2]).toEqual([]);
  });

  it("computes baselines with zeros for runs an agent wasn't in", () => {
    const b = computeBaseline({
      runs: [
        { run_id: "a", tokens: 100, cost_usd: 0.1 },
        { run_id: "b", tokens: 300, cost_usd: 0.3 },
        { run_id: "c", tokens: 200, cost_usd: 0.2 },
      ],
      agents: [
        { run_id: "a", agent_id: "rev", tool_calls: 4 },
        { run_id: "b", agent_id: "rev", tool_calls: 6 },
        { run_id: "c", agent_id: "helper", tool_calls: 9 },
      ],
    });
    expect(b.runs).toBe(3);
    expect(b.toolCalls.rev).toEqual({ p50: 4, p95: 6 }); // [0, 4, 6]
    expect(b.toolCalls.helper).toEqual({ p50: 0, p95: 9 });
    expect(b.tokens).toEqual({ p50: 200, p95: 300 });
  });
});

describe("detector config", () => {
  it("is on by default, can be turned off, and takes per-detector overrides from a file", () => {
    expect(loadDetectorConfig({})).toEqual(DEFAULT_CONFIG);
    expect(loadDetectorConfig({ AGENTSPACE_DETECTORS: "off" })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "det-"));
    const file = join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ failure_loop: { min_count: 5 }, usage_outlier: false }));
    const cfg = loadDetectorConfig({ AGENTSPACE_DETECTORS_FILE: file })!;
    expect(cfg.failure_loop).toEqual({ enabled: true, min_count: 5 });
    expect(cfg.usage_outlier.enabled).toBe(false);
    expect(DEFAULT_CONFIG.failure_loop.min_count).toBe(3); // defaults untouched
    writeFileSync(file, JSON.stringify({ nope: false }));
    expect(() => loadDetectorConfig({ AGENTSPACE_DETECTORS_FILE: file })).toThrow(/unknown detector/);
    writeFileSync(file, JSON.stringify({ failure_loop: { min_count: "5" } }));
    expect(() => loadDetectorConfig({ AGENTSPACE_DETECTORS_FILE: file })).toThrow(/bad setting/);
  });
});

describe("detection in the collector", () => {
  let apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps = [];
  });
  async function app(store: SqliteStore, env: Record<string, string> = {}) {
    const a = await buildApp({ config: loadConfig(env), store, logger: false });
    apps.push(a);
    return a;
  }
  const post = (a: FastifyInstance, events: AgentSpaceEvent[]) => a.inject({ method: "POST", url: "/v1/events", payload: { events } });
  const findings = async (a: FastifyInstance, run = "run-1") =>
    ((await a.inject(`/v1/workspaces/default/runs/${run}/events`)).json() as StoredEvent[]).filter((e) => e.type === "anomaly.detected");

  function failing(run: string): AgentSpaceEvent[] {
    return [
      ev({ type: "run.started", run_id: run, data: { name: "ship" } }),
      ...[1, 2, 3].flatMap((i) => [
        { ...call("rev", "run_tests", "cccccccccccccccc"), run_id: run, parent_id: "s1", id: `${run}-call-${i}` },
        { ...result("rev", "run_tests", false), run_id: run, parent_id: "s1", id: `${run}-res-${i}` },
      ]),
    ];
  }

  it("stores valid findings at the trigger's agent and step, once, even across a restart", async () => {
    const store = new SqliteStore(":memory:");
    const a = await app(store);
    const events = failing("run-1");
    await post(a, events.slice(0, 4)); // the run arrives in two batches
    await post(a, events.slice(4));
    let found = await findings(a);
    expect(found.map((f) => f.type === "anomaly.detected" && f.data.detector).sort()).toEqual(["failure_loop", "repeated_tool_call"]);
    for (const f of found) {
      expect(validateEvent(f).ok).toBe(true);
      expect([f.agent_id, f.parent_id]).toEqual(["rev", "s1"]);
    }
    // A retry of the same batch changes nothing.
    await post(a, events.slice(4));
    expect(await findings(a)).toHaveLength(2);
    // A new collector on the same store rebuilds the run from storage: same ids, no duplicates.
    const b = await app(store);
    await post(b, [{ ...call("rev", "run_tests", "cccccccccccccccc"), id: "late-call" }]);
    found = await findings(b);
    expect(found).toHaveLength(2);
  });

  it("flags an agent far above the workflow's baseline", async () => {
    const store = new SqliteStore(":memory:");
    const a = await app(store);
    for (let r = 0; r < 5; r++) {
      const run = `ok-${r}`;
      await post(a, [
        ev({ type: "run.started", run_id: run, data: { name: "ship" } }),
        { ...call("rev", "run_tests"), run_id: run },
        ev({ type: "run.finished", run_id: run, data: { status: "ok" } }),
      ]);
    }
    await post(a, [ev({ type: "run.started", run_id: "big", data: { name: "ship" } }), ...Array.from({ length: 8 }, () => ({ ...call("rev", "run_tests"), run_id: "big" }))]);
    const found = await findings(a, "big");
    expect(found).toHaveLength(1);
    expect(found[0]!.type === "anomaly.detected" && found[0]!.data).toMatchObject({
      detector: "tool_call_outlier",
      evidence: { count: 6, baseline_p50: 1, baseline_runs: 5 },
    });
  });

  it("does nothing when turned off", async () => {
    const a = await app(new SqliteStore(":memory:"), { AGENTSPACE_DETECTORS: "off" });
    await post(a, failing("run-1"));
    expect(await findings(a)).toEqual([]);
  });
});
