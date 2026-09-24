import { afterEach, describe, expect, it } from "vitest";
import * as agentspace from "../src/index.js";
import { FakeCollector, assertValid, freePort, sleep } from "./helpers.js";

let collector: FakeCollector | null = null;
afterEach(async () => {
  await agentspace.shutdown(500);
  await collector?.stop();
  collector = null;
});

async function setup(opts: agentspace.InitOptions = {}) {
  collector = await new FakeCollector().start();
  agentspace.init({ url: collector.url, flushIntervalMs: 10, ...opts });
  return collector;
}

/** Make the SDK learn a control: any flushed event's ingest response carries it. */
async function deliver(c: FakeCollector, runId: string, state: string) {
  c.controls.set(runId, state);
  agentspace.emit("message", {}, { runId });
  expect(await agentspace.flush()).toBe(true);
}

describe("approvals", () => {
  it("resolves approved with the comment, and shows waiting_human meanwhile", async () => {
    const c = await setup();
    void c.resolveWhenRequested("approved", "ship it");
    const result = await agentspace.run("deploy", () =>
      agentspace.agent({ name: "Deployer", team: "ops" }, () => agentspace.requestApproval("Deploy v1.2?", { version: "1.2" }, { timeoutMs: 10_000 })),
    );
    expect(result).toMatchObject({ decision: "approved", approved: true, comment: "ship it" });
    expect(result.error).toBeUndefined();
    expect(await agentspace.flush()).toBe(true);
    assertValid(c.events);
    const [req] = c.ofType("approval.requested");
    expect(req!.data.payload).toEqual({ version: "1.2" }); // sent even without captureContent
    expect(req!.agent_id).toBe("deployer");
    const statuses = c.ofType("agent.status").map((e) => e.data.status);
    expect(statuses[statuses.indexOf("waiting_human") + 1]).toBe("thinking");
  });

  it("rejects, and the payload goes through the redact hook", async () => {
    const c = await setup({ redact: (field, v) => (field === "approval.payload" ? "***" : v) });
    void c.resolveWhenRequested("rejected", "not now");
    const result = await agentspace.requestApproval("Wire money?", { iban: "DE00" }, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ decision: "rejected", approved: false, comment: "not now" });
    expect(c.ofType("approval.requested")[0]!.data.payload).toBe("***");
  });

  it("times out", async () => {
    await setup();
    const t0 = Date.now();
    const result = await agentspace.requestApproval("Anyone?", undefined, { timeoutMs: 1200 });
    expect(result.decision).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("fails closed before init", async () => {
    const result = await agentspace.requestApproval("x");
    expect(result).toMatchObject({ decision: "rejected", approved: false, error: "agentspace is not initialized" });
  });

  it("fails closed when the collector is down", async () => {
    agentspace.init({ url: `http://127.0.0.1:${await freePort()}`, flushIntervalMs: 10 });
    const result = await agentspace.requestApproval("x", undefined, { timeoutMs: 5000 });
    expect(result).toMatchObject({ decision: "rejected", error: "collector unreachable" });
  });

  it("fails closed when not authorized to read approvals", async () => {
    const c = await setup();
    c.approvalStatusOverride = 403;
    const result = await agentspace.requestApproval("x", undefined, { timeoutMs: 5000 });
    expect(result.decision).toBe("rejected");
    expect(result.error).toMatch(/403/);
  });
});

const R1 = { runId: "r1" };

describe("pause / resume / cancel", () => {
  it("cancel throws Cancelled at the next scope and the run finishes as cancelled", async () => {
    const c = await setup();
    let reachedWorker = false;
    await expect(
      agentspace.run("long job", async () => {
        await agentspace.flush();
        await deliver(c, "r1", "cancelled");
        await agentspace.agent("Worker", async () => {
          reachedWorker = true;
        });
      }, R1),
    ).rejects.toBeInstanceOf(agentspace.Cancelled);
    expect(reachedWorker).toBe(false);
    await agentspace.flush();
    assertValid(c.events);
    expect(c.ofType("run.finished").map((e) => e.data.status)).toEqual(["cancelled"]);
    expect(c.ofType("error")).toEqual([]); // a cancel is not an error
  });

  it("checkpoint() throws inside an agent and marks it done, not error", async () => {
    const c = await setup();
    await expect(
      agentspace.run("job", () =>
        agentspace.agent("Worker", async () => {
          await deliver(c, "r1", "cancelled");
          await agentspace.checkpoint();
        }),
        R1,
      ),
    ).rejects.toSatisfy(agentspace.isCancelled);
    await agentspace.flush();
    const last = c.ofType("agent.status").at(-1)!.data;
    expect(last.status).toBe("done");
    expect(String(last.detail)).toContain("cancelled");
  });

  it("flag mode never throws", async () => {
    const c = await setup({ cancelMode: "flag" });
    await agentspace.run("job", () =>
      agentspace.agent("Worker", async () => {
        await deliver(c, "r1", "cancelled");
        expect(agentspace.runCancelled()).toBe(true);
        expect(await agentspace.checkpoint()).toBe(false);
        agentspace.step("still allowed", () => 1);
      }),
      R1,
    );
  });

  it("checkpoint() waits while paused and continues after resume", async () => {
    const c = await setup();
    await agentspace.run("job", () =>
      agentspace.agent("Worker", async () => {
        const runId = "r1";
        await deliver(c, runId, "paused");
        setTimeout(() => c.controls.delete(runId), 300);
        const t0 = Date.now();
        expect(await agentspace.checkpoint()).toBe(true);
        expect(Date.now() - t0).toBeGreaterThan(250);
      }),
      R1,
    );
    await agentspace.flush();
    const details = c.ofType("agent.status").map((e) => [e.data.status, e.data.detail]);
    expect(details).toContainEqual(["blocked", "paused by an operator"]);
    expect(details).toContainEqual(["thinking", "resumed"]);
    expect(c.ofType("run.finished").map((e) => e.data.status)).toEqual(["ok"]);
  });

  it("idle runs learn about a cancel by polling", async () => {
    const c = await setup();
    await expect(
      agentspace.run("job", async () => {
        await agentspace.flush();
        c.controls.set("r1", "cancelled"); // no further events sent
        const t0 = Date.now();
        while (!agentspace.runCancelled() && Date.now() - t0 < 5000) await sleep(50);
        await agentspace.checkpoint();
      }, R1),
    ).rejects.toBeInstanceOf(agentspace.Cancelled);
  });
});
