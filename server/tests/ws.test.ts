import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { WsServerMessage } from "@agentspace/spec-types";
import { ev, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

function connect(url: string) {
  const ws = new WebSocket(url);
  const messages: WsServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as WsServerMessage);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (m: WsServerMessage) => boolean, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error("timed out waiting for message");
  };
  return { ws, messages, next };
}

describe("GET /v1/ws", () => {
  it("sends a snapshot, then live events for its workspace only", async () => {
    ({ app } = await makeApp());
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [ev({ type: "agent.status", agent_id: "a1", data: { status: "idle" } })] } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };

    const client = connect(`ws://127.0.0.1:${port}/v1/ws?workspace=default`);
    const snap = await client.next((m) => m.type === "snapshot");
    expect(snap.type === "snapshot" && snap.agents.map((a) => a.agent_id)).toEqual(["a1"]);

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        events: [
          ev({ type: "agent.status", agent_id: "a1", data: { status: "thinking" } }),
          ev({ type: "agent.status", workspace: "other", agent_id: "zz", data: { status: "idle" } }),
        ],
      },
    });
    const live = await client.next((m) => m.type === "events");
    expect(live.type === "events" && live.events.map((e) => e.agent_id)).toEqual(["a1"]);
    const agents = await client.next((m) => m.type === "agents");
    expect(agents.type === "agents" && agents.agents[0]!.status).toBe("thinking");
    expect(client.messages.some((m) => m.type === "events" && m.events.some((e) => e.workspace === "other"))).toBe(false);
    client.ws.close();
  });
});
