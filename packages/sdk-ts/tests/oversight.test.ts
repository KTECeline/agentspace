import { afterEach, describe, expect, it } from "vitest";
import * as agentspace from "../src/index.js";
import { FakeCollector, assertValid } from "./helpers.js";

let collector: FakeCollector | null = null;
afterEach(async () => {
  await agentspace.shutdown(500);
  await collector?.stop();
  collector = null;
});

async function setup(opts: agentspace.InitOptions = {}, collectorPolicy: unknown = null) {
  collector = await new FakeCollector().start();
  collector.policy = collectorPolicy;
  agentspace.init({ url: collector.url, flushIntervalMs: 10, ...opts });
  return collector;
}

const POLICY: agentspace.Policy = {
  tools: [
    { match: "deploy", action: "block", reason: "No deploys on Fridays." },
    { match: "write_*", action: "review" },
    { match: "search", action: "allow", on_findings: "review" },
  ],
};

const inAgent = <T>(fn: () => Promise<T>) => agentspace.run("ship", () => agentspace.agent({ name: "Engineer", team: "eng" }, fn));

describe("guardTool", () => {
  it("allows calls no rule covers, without asking anyone", async () => {
    const c = await setup({ policy: POLICY });
    const decision = await inAgent(() => agentspace.guardTool("read_file", { path: "a.ts" }));
    expect(decision.action).toBe("allow");
    await agentspace.flush();
    expect(c.ofType("approval.requested")).toHaveLength(0);
  });

  it("blocks with a message for the model, and records the denial", async () => {
    const c = await setup({ policy: POLICY });
    const err = await inAgent(() => agentspace.guardTool("deploy", { env: "prod" })).catch((e: unknown) => e);
    expect(agentspace.isPolicyDenied(err)).toBe(true);
    const denied = err as agentspace.PolicyDenied;
    expect(denied.outcome).toBe("blocked");
    expect(denied.message).toBe("deploy is blocked by policy (rule deploy): No deploys on Fridays. Don't retry it; choose another way or report back.");
    expect(await agentspace.flush()).toBe(true);
    const [e] = c.ofType("error");
    expect(e!.data).toMatchObject({ kind: "PolicyDenied" });
    expect([e!.agent_id, e!.team_id]).toEqual(["engineer", "eng"]);
    assertValid(c.events);
  });

  it("asks for a review with the rule and arguments, and follows the decision", async () => {
    const c = await setup({ policy: POLICY });
    void c.resolveWhenRequested("approved");
    const ok = await inAgent(() => agentspace.guardTool("write_file", { path: "a.ts" }, { timeoutMs: 10_000 }));
    expect(ok).toMatchObject({ action: "review", rule: "write_*", source: "code" });
    const [req] = c.ofType("approval.requested");
    expect(req!.data.payload).toEqual({ tool: "write_file", arguments: { path: "a.ts" } });
    expect(req!.data.policy).toMatchObject({ tool: "write_file", action: "review", rule: "write_*", source: "code" });
    expect(req!.data.policy).toHaveProperty("arguments_hash");
    expect(req!.agent_id).toBe("engineer");

    void c.resolveWhenRequested("rejected", "not that file");
    const err = await inAgent(() => agentspace.guardTool("write_file", { path: "b.ts" }, { timeoutMs: 10_000 })).catch((e: unknown) => e);
    expect((err as agentspace.PolicyDenied).message).toContain("write_file was rejected by an operator: not that file");
    await agentspace.flush();
    assertValid(c.events);
  });

  it("uses the collector's policy too: the stricter wins", async () => {
    await setup({ policy: { tools: [{ match: "deploy", action: "allow" }] } }, { tools: [{ match: "deploy", action: "block" }] });
    const err = await inAgent(() => agentspace.guardTool("deploy")).catch((e: unknown) => e);
    expect(err).toMatchObject({ outcome: "blocked", decision: { source: "collector" } });
  });

  it("escalates rules with on_findings for runs the collector flags", async () => {
    const c = await setup({ policy: POLICY });
    expect((await agentspace.run("r", () => agentspace.guardTool("search"))).action).toBe("allow");
    c.escalated.add("flagged");
    agentspace.emit("message", {}, { runId: "flagged" });
    await agentspace.flush(); // the ingest response says "flagged" has findings
    void c.resolveWhenRequested("approved");
    const d = await agentspace.guardTool("search", undefined, { runId: "flagged", timeoutMs: 10_000 });
    expect(d).toMatchObject({ action: "review", escalated: true });
    expect(c.ofType("approval.requested")[0]!.data.policy).toMatchObject({ escalated: true });
  });

  it("fails closed on an invalid policy", async () => {
    const c = await setup({ policy: { tools: [{ match: "x", action: "maybe" }] } as unknown as agentspace.Policy });
    void c.resolveWhenRequested("rejected");
    const err = await agentspace.guardTool("anything", undefined, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ outcome: "rejected" });
  });

  it("allows everything before init and without a policy", async () => {
    expect((await agentspace.guardTool("deploy")).action).toBe("allow");
    const c = await setup();
    expect((await agentspace.guardTool("deploy")).action).toBe("allow");
    expect(c.policyReads).toBe(1); // fetched once, not per call
    await agentspace.guardTool("deploy");
    expect(c.policyReads).toBe(1);
  });
});
