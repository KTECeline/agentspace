import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AgentSpaceEvent, ApprovalState, IngestResponse, ServerInfo, StoredEvent } from "@agentspace/spec-types";
import { ev, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

const KEYS = { AGENTSPACE_API_KEYS: "default:sdk-key,other:other-key", AGENTSPACE_OPERATOR_TOKEN: "op-token" };
const H = (t: string) => ({ authorization: `Bearer ${t}` });

function approvalEvent(id: string, timeout_s?: number): AgentSpaceEvent {
  return ev({ type: "approval.requested", agent_id: "eng", team_id: "t", data: { approval_id: id, reason: "Deploy to prod?", payload: { version: "1.2.3" }, ...(timeout_s ? { timeout_s } : {}) } } as never);
}

async function post(events: unknown[], headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events }, headers });
  return { status: res.statusCode, body: res.json() as IngestResponse };
}

describe("auth", () => {
  it("is fully open when nothing is configured", async () => {
    ({ app } = await makeApp());
    expect((await app.inject("/v1/info")).json()).toMatchObject<Partial<ServerInfo>>({ auth_required: false, operator_enabled: true, public_readonly: false });
    expect((await post([ev({ type: "message", data: {} })])).status).toBe(200);
    expect((await app.inject("/v1/workspaces/default/agents")).statusCode).toBe(200);
  });

  it("with keys: ingest needs the workspace key, reads need a key or the operator token", async () => {
    ({ app } = await makeApp(KEYS));
    expect((await app.inject("/v1/info")).json()).toMatchObject({ auth_required: true });
    expect((await post([ev({ type: "message", data: {} })])).status).toBe(401);
    expect((await post([ev({ type: "message", data: {} })], H("other-key"))).status).toBe(401); // wrong workspace
    const ok = await post([ev({ type: "message", data: {} })], H("sdk-key"));
    expect(ok.status).toBe(200);
    expect(ok.body.accepted).toBe(1);
    // mixed batch: only the allowed workspace is stored
    const mixed = await post([ev({ type: "message", data: {} }), ev({ type: "message", workspace: "other", data: {} })], H("sdk-key"));
    expect(mixed.body).toMatchObject({ accepted: 1, rejected: 1 });

    expect((await app.inject("/v1/workspaces/default/agents")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/workspaces/default/agents", headers: H("sdk-key") })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/workspaces/default/agents", headers: H("op-token") })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/workspaces/default/agents", headers: H("other-key") })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/workspaces", headers: H("sdk-key") })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/workspaces", headers: H("op-token") })).statusCode).toBe(200);
  });

  it("websocket: first message must carry a valid token", async () => {
    ({ app } = await makeApp(KEYS));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const connect = (token?: string) =>
      new Promise<{ code?: number; first?: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?workspace=default`);
        ws.on("open", () => token !== undefined && ws.send(JSON.stringify({ type: "auth", token })));
        ws.on("message", (m) => {
          resolve({ first: JSON.parse(String(m)).type });
          ws.close();
        });
        ws.on("close", (code) => resolve({ code }));
      });
    expect(await connect("op-token")).toEqual({ first: "snapshot" });
    expect(await connect("wrong")).toEqual({ code: 4401 });
  });

  it("public read-only mode: anyone reads, payloads are hidden, no operator actions", async () => {
    ({ app } = await makeApp({ ...KEYS, AGENTSPACE_PUBLIC_READONLY: "true" }));
    expect((await app.inject("/v1/info")).json()).toMatchObject({ auth_required: false, operator_enabled: false, public_readonly: true });
    await post([ev({ type: "run.started", data: {} }), approvalEvent("ap1")], H("sdk-key"));
    const approvals = (await app.inject("/v1/workspaces/default/approvals")).json() as ApprovalState[];
    expect(approvals[0]).toMatchObject({ reason: "Deploy to prod?", payload: null });
    const events = (await app.inject("/v1/workspaces/default/events")).json() as StoredEvent[];
    const req = events.find((e) => e.type === "approval.requested")!;
    expect(req.data).not.toHaveProperty("payload");
    expect(req.data).toMatchObject({ reason: "Deploy to prod?" });
    const resolve = await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/ap1/resolve", payload: { decision: "approved" }, headers: H("op-token") });
    expect(resolve.statusCode).toBe(403);
    const pause = await app.inject({ method: "POST", url: "/v1/workspaces/default/runs/run-1/control", payload: { action: "pause" }, headers: H("op-token") });
    expect(pause.statusCode).toBe(403);
  });
});

describe("approvals", () => {
  it("long-poll returns the moment an operator decides; a second resolve is 409 with no new event", async () => {
    ({ app } = await makeApp(KEYS));
    await post([approvalEvent("ap1")], H("sdk-key"));
    const waiting = app.inject({ url: "/v1/workspaces/default/approvals/ap1?wait=10", headers: H("sdk-key") });
    await new Promise((r) => setTimeout(r, 100));
    const unauth = await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/ap1/resolve", payload: { decision: "approved" } });
    expect(unauth.statusCode).toBe(401);
    const t0 = Date.now();
    const res = await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/ap1/resolve", payload: { decision: "rejected", comment: "not today" }, headers: H("op-token") });
    expect(res.statusCode).toBe(200);
    const polled = (await waiting).json() as ApprovalState;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(polled).toMatchObject({ status: "rejected", comment: "not today", resolved_by: "operator" });

    const again = await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/ap1/resolve", payload: { decision: "approved" }, headers: H("op-token") });
    expect(again.statusCode).toBe(409);
    const events = (await app.inject({ url: "/v1/workspaces/default/events", headers: H("op-token") })).json() as StoredEvent[];
    expect(events.filter((e) => e.type === "approval.resolved")).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/nope/resolve", payload: { decision: "approved" }, headers: H("op-token") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/workspaces/default/approvals/ap1/resolve", payload: { decision: "maybe" }, headers: H("op-token") })).statusCode).toBe(400);
  });

  it("expires pending approvals in the background", async () => {
    ({ app } = await makeApp());
    await post([approvalEvent("ap2", 1)]);
    const polled = (await app.inject("/v1/workspaces/default/approvals/ap2?wait=5")).json() as ApprovalState;
    expect(polled).toMatchObject({ status: "timeout", resolved_by: "system" });
  }, 10_000);
});

describe("run controls", () => {
  it("pause/resume/cancel via REST, reported back in ingest responses and the controls long-poll", async () => {
    ({ app } = await makeApp(KEYS));
    await post([ev({ type: "run.started", data: {} })], H("sdk-key"));
    const control = (action: string, token = "op-token") =>
      app.inject({ method: "POST", url: "/v1/workspaces/default/runs/run-1/control", payload: { action }, headers: H(token) });

    expect((await control("pause", "wrong")).statusCode).toBe(401);
    expect((await control("dance")).statusCode).toBe(400);
    expect((await control("pause")).json()).toMatchObject({ control: "paused" });
    expect((await control("pause")).statusCode).toBe(409);

    const ingest = await post([ev({ type: "message", data: {} })], H("sdk-key"));
    expect(ingest.body.controls).toEqual({ "run-1": "paused" });

    const waiting = app.inject({ url: "/v1/workspaces/default/controls?runs=run-1&wait=10", headers: H("sdk-key") });
    await new Promise((r) => setTimeout(r, 100));
    await control("cancel");
    expect((await waiting).json()).toEqual({ "run-1": "cancelled" });
    expect((await control("resume")).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/workspaces/default/runs/missing/control", payload: { action: "pause" }, headers: H("op-token") })).statusCode).toBe(404);
  });
});
