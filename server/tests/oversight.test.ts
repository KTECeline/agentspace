import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentSpaceEvent, ApprovalState, IngestResponse, PolicyResponse, RunState, StoredEvent } from "@agentspace/spec-types";
import { loadPolicy } from "../src/config.js";
import { ev, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

function policyFile(policy: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "policy-")), "policy.json");
  writeFileSync(file, JSON.stringify(policy));
  return file;
}
const post = async (events: AgentSpaceEvent[]) => (await app.inject({ method: "POST", url: "/v1/events", payload: { events } })).json() as IngestResponse;
const get = async <T>(url: string) => (await app.inject(url)).json() as T;

/** Three failed run_tests in a row: the failure_loop detector fires. */
function failingRun(run: string): AgentSpaceEvent[] {
  return [
    ev({ type: "run.started", run_id: run, data: { name: "ship" } }),
    ...[1, 2, 3].flatMap((i) => [
      ev({ type: "tool.call", run_id: run, agent_id: "rev", parent_id: "s1", data: { tool_name: "run_tests", call_id: `${run}${i}` } }),
      ev({ type: "tool.result", run_id: run, agent_id: "rev", parent_id: "s1", data: { tool_name: "run_tests", call_id: `${run}${i}`, ok: false, error: "exit 1" } }),
    ]),
  ];
}

describe("the collector's policy (D-045)", () => {
  it("loads a valid policy file and refuses a bad one with the path of the problem", () => {
    expect(loadPolicy(undefined)).toBeNull();
    expect(loadPolicy(policyFile({ tools: [{ match: "deploy", action: "review" }] }))).toEqual({ tools: [{ match: "deploy", action: "review" }] });
    expect(() => loadPolicy(policyFile({ tools: [{ match: "deploy", action: "deny" }] }))).toThrow(/tools\[0\]\.action/);
    expect(() => loadPolicy("/nonexistent/policy.json")).toThrow(/can’t read/);
  });

  it("serves the policy and tells SDKs which runs are escalated by findings", async () => {
    const policy = { tools: [{ match: "write_file", action: "allow", on_findings: "review" }] };
    ({ app } = await makeApp({ AGENTSPACE_POLICY_FILE: policyFile(policy) }));
    const quiet = await post([ev({ type: "run.started", run_id: "quiet", data: { name: "ship" } })]);
    expect(quiet.escalated).toBeUndefined();
    const res = await post(failingRun("bad"));
    expect(res.escalated).toEqual(["bad"]);
    expect(await get<PolicyResponse>("/v1/workspaces/default/policy?runs=bad,quiet,unknown")).toEqual({ policy, escalated: ["bad"] });
    // No policy file: null, but escalation still reported (a code policy may use it).
    await app.close();
    ({ app } = await makeApp());
    await post(failingRun("bad"));
    expect(await get<PolicyResponse>("/v1/workspaces/default/policy?runs=bad")).toEqual({ policy: null, escalated: ["bad"] });
  });

  it("pauses a run when a finding matches on_findings.pause, saying why, once", async () => {
    ({ app } = await makeApp({ AGENTSPACE_POLICY_FILE: policyFile({ on_findings: { pause: ["failure_loop"] } }) }));
    const res = await post(failingRun("bad"));
    expect(res.controls).toEqual({ bad: "paused" });
    const run = await get<RunState>("/v1/workspaces/default/runs/bad");
    expect(run).toMatchObject({ control: "paused", control_by: "detector:failure_loop", control_reason: "run_tests failed 3 times in a row" });
    const events = await get<StoredEvent[]>("/v1/workspaces/default/runs/bad/events");
    const finding = events.find((e) => e.type === "anomaly.detected")!;
    const controls = events.filter((e) => e.type === "run.control");
    expect(controls).toHaveLength(1);
    expect(controls[0]!.type === "run.control" && controls[0]!.data).toMatchObject({ action: "pause", finding_id: finding.id });
    // Another failure streak while paused doesn't pause again.
    await post(failingRun("bad").slice(1).map((e) => ({ ...e, id: `again-${e.id}` })));
    expect((await get<StoredEvent[]>("/v1/workspaces/default/runs/bad/events")).filter((e) => e.type === "run.control")).toHaveLength(1);
  });

  it("doesn't pause for findings the policy doesn't list, or without a policy", async () => {
    ({ app } = await makeApp({ AGENTSPACE_POLICY_FILE: policyFile({ on_findings: { pause: ["handoff_loop"] } }) }));
    expect((await post(failingRun("bad"))).controls).toBeUndefined();
    await app.close();
    ({ app } = await makeApp());
    expect((await post(failingRun("bad"))).controls).toBeUndefined();
  });

  it("attaches evidence to policy reviews: findings and this run against the usual", async () => {
    ({ app } = await makeApp());
    for (let r = 0; r < 5; r++) {
      await post([
        ev({ type: "run.started", run_id: `ok${r}`, data: { name: "ship" } }),
        ev({ type: "tool.call", run_id: `ok${r}`, agent_id: "rev", data: { tool_name: "run_tests", call_id: `ok${r}` } }),
        ev({ type: "llm.call", run_id: `ok${r}`, agent_id: "rev", tokens_in: 10, cost_usd: 0.01, data: {} }),
        ev({ type: "run.finished", run_id: `ok${r}`, data: { status: "ok" } }),
      ]);
    }
    await post(failingRun("bad"));
    const policy = { tool: "deploy", action: "review" as const, rule: "deploy", source: "collector" as const };
    await post([
      ev({ type: "tool.call", run_id: "bad", agent_id: "rev", data: { tool_name: "deploy", call_id: "d1" } }),
      ev({ type: "approval.requested", run_id: "bad", agent_id: "rev", data: { approval_id: "ap1", reason: "Deploy?", policy } }),
      ev({ type: "approval.requested", run_id: "bad", agent_id: "rev", data: { approval_id: "ap2", reason: "Plain request" } }),
    ]);
    const ap1 = await get<ApprovalState>("/v1/workspaces/default/approvals/ap1");
    expect(ap1.policy).toEqual(policy);
    expect(ap1.context).toEqual({
      findings: [{ detector: "failure_loop", severity: "warning", message: "run_tests failed 3 times in a row" }],
      agent_tool_calls: 4,
      baseline_tool_calls_p50: 1,
      tool_calls: 1,
      run_cost_usd: 0,
      baseline_cost_p50: 0.01,
      baseline_runs: 5,
    });
    expect((await get<ApprovalState>("/v1/workspaces/default/approvals/ap2")).context).toBeNull();
    // A replay of the run reads its approvals (with the evidence) with ?run=.
    const ofRun = await get<ApprovalState[]>("/v1/workspaces/default/approvals?run=bad");
    expect(ofRun.map((a) => a.approval_id).sort()).toEqual(["ap1", "ap2"]);
    expect(await get<ApprovalState[]>("/v1/workspaces/default/approvals?run=ok0")).toEqual([]);
    expect(await get<ApprovalState[]>("/v1/workspaces/default/approvals?run=bad&status=approved")).toEqual([]);
  });
});
