import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentState, IngestResponse, RunState, StoredEvent } from "@agentspace/spec-types";
import { ev, fixture, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

async function post(events: unknown[]) {
  const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events } });
  return { status: res.statusCode, body: res.json() as IngestResponse };
}

describe("POST /v1/events", () => {
  it("accepts every valid spec example and rejects every invalid one", async () => {
    ({ app } = await makeApp());
    const valid = fixture("valid.jsonl");
    const invalid = fixture("invalid.jsonl");
    const { status, body } = await post([...valid, ...invalid]);
    expect(status).toBe(200);
    expect(body.accepted).toBe(valid.length);
    expect(body.rejected).toBe(invalid.length);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]!.id).toBe("x1");
  });

  it("de-duplicates by event id (SDK retries are safe)", async () => {
    ({ app } = await makeApp());
    const batch = fixture("valid.jsonl");
    await post(batch);
    const { body } = await post(batch);
    expect(body).toMatchObject({ accepted: 0, duplicates: batch.length });
  });

  it("rejects malformed bodies and oversized batches", async () => {
    ({ app } = await makeApp());
    const bad = await app.inject({ method: "POST", url: "/v1/events", payload: { nope: 1 } });
    expect(bad.statusCode).toBe(400);
    const big = await post(Array.from({ length: 1001 }, () => ({})));
    expect(big.status).toBe(413);
  });
});

describe("projections", () => {
  it("tracks agent status, registration, and llm.call totals", async () => {
    ({ app } = await makeApp());
    await post([
      ev({ type: "run.started", data: { name: "demo" } }),
      ev({ type: "agent.registered", agent_id: "qa", team_id: "eng", data: { name: "QA", role: "tests" } }),
      ev({ type: "agent.status", agent_id: "qa", team_id: "eng", data: { status: "using_tool", detail: "pytest" } }),
      ev({ type: "llm.call", agent_id: "qa", team_id: "eng", tokens_in: 100, tokens_out: 10, cost_usd: 0.01, model: "m1", data: {} }),
      ev({ type: "llm.call", agent_id: "qa", team_id: "eng", tokens_in: 50, tokens_out: 5, cost_usd: 0.02, data: {} }),
      // tokens on non-llm events are not added to totals
      ev({ type: "step.finished", agent_id: "qa", team_id: "eng", tokens_in: 999, data: { step_id: "s", name: "s", ok: true } }),
    ]);
    const agents = (await app.inject("/v1/workspaces/default/agents")).json() as AgentState[];
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agent_id: "qa",
      name: "QA",
      team_id: "eng",
      role: "tests",
      status: "using_tool",
      status_detail: "pytest",
      tokens_in: 150,
      tokens_out: 15,
      model: "m1",
    });
    expect(agents[0]!.cost_usd).toBeCloseTo(0.03);

    await post([ev({ type: "run.finished", data: { status: "ok", duration_ms: 1234 } })]);
    const runs = (await app.inject("/v1/workspaces/default/runs")).json() as RunState[];
    expect(runs[0]).toMatchObject({ run_id: "run-1", name: "demo", status: "ok", duration_ms: 1234, event_count: 7, tokens_in: 150 });
  });

  it("creates a placeholder agent if events arrive before registration", async () => {
    ({ app } = await makeApp());
    await post([ev({ type: "agent.status", agent_id: "early", team_id: "t", data: { status: "thinking" } })]);
    const agents = (await app.inject("/v1/workspaces/default/agents")).json() as AgentState[];
    expect(agents[0]).toMatchObject({ agent_id: "early", name: "early", status: "thinking" });
  });

  it("keeps workspaces isolated", async () => {
    ({ app } = await makeApp());
    await post([
      ev({ type: "agent.status", workspace: "a", agent_id: "x", data: { status: "idle" } }),
      ev({ type: "agent.status", workspace: "b", agent_id: "y", data: { status: "idle" } }),
    ]);
    const a = (await app.inject("/v1/workspaces/a/agents")).json() as AgentState[];
    expect(a.map((x) => x.agent_id)).toEqual(["x"]);
  });

  it("serves run events in order with pagination", async () => {
    ({ app } = await makeApp());
    await post(Array.from({ length: 5 }, (_, i) => ev({ type: "message", summary: `m${i}`, data: {} })));
    const page1 = (await app.inject("/v1/workspaces/default/runs/run-1/events?limit=3")).json() as StoredEvent[];
    expect(page1.map((e) => e.summary)).toEqual(["m0", "m1", "m2"]);
    const page2 = (await app.inject(`/v1/workspaces/default/runs/run-1/events?after=${page1[2]!.seq}`)).json() as StoredEvent[];
    expect(page2.map((e) => e.summary)).toEqual(["m3", "m4"]);
  });
});

describe("retention", () => {
  it("prunes old events", async () => {
    const { app: a, store } = await makeApp();
    app = a;
    await post([ev({ type: "message", data: {} })]);
    store.db.prepare("UPDATE events SET received_at = 0").run();
    expect(store.prune(7)).toBe(1);
    expect(store.recentEvents("default")).toHaveLength(0);
  });
});
