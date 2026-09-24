import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StatsResponse } from "@agentspace/spec-types";
import { percentile } from "../src/store/stats.js";
import { ev, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});

describe("GET /v1/workspaces/:ws/stats", () => {
  const seed = [
    ev({ type: "run.started", data: { name: "r" } }),
    ev({ type: "llm.call", agent_id: "a", model: "claude-haiku-4-5", tokens_in: 1_000_000, tokens_out: 0, data: {} }),
    ev({ type: "approval.requested", agent_id: "a", data: { approval_id: "ap1", reason: "Ship it?", payload: { secret: "TOP-SECRET-DIFF" } } }),
  ];

  it("returns aggregates, priced at ingest", async () => {
    ({ app } = await makeApp());
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: seed } });
    const res = await app.inject({ url: "/v1/workspaces/default/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totals).toMatchObject({ calls: 1, cost_usd: 1, cost_estimated_usd: 1, runs: 1 });
    expect(body.by_model[0]).toMatchObject({ model: "claude-haiku-4-5", cost_usd: 1 });
  });

  it("rejects bad timestamps and normalizes good ones", async () => {
    ({ app } = await makeApp());
    expect((await app.inject({ url: "/v1/workspaces/default/stats?since=yesterday" })).statusCode).toBe(400);
    const res = await app.inject({ url: "/v1/workspaces/default/stats?since=2026-09-01T00:00:00Z" });
    expect(res.json()).toMatchObject({ since: "2026-09-01T00:00:00.000Z", until: null });
  });

  it("needs a token when reads are protected", async () => {
    ({ app } = await makeApp({ AGENTSPACE_OPERATOR_TOKEN: "op" }));
    expect((await app.inject({ url: "/v1/workspaces/default/stats" })).statusCode).toBe(401);
    const ok = await app.inject({ url: "/v1/workspaces/default/stats", headers: { authorization: "Bearer op" } });
    expect(ok.statusCode).toBe(200);
  });

  it("is readable in public mode and never includes payloads", async () => {
    ({ app } = await makeApp({ AGENTSPACE_PUBLIC_READONLY: "true" }));
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: seed } });
    const res = await app.inject({ url: "/v1/workspaces/default/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("TOP-SECRET-DIFF");
  });
});
