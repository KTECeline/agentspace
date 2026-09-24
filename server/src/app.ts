import { EventEmitter } from "node:events";
import { createGunzip } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type {
  AgentSpaceEvent,
  ApprovalState,
  ApprovalStatus,
  IngestResponse,
  PriceTable,
  RunControl,
  ServerInfo,
  StoredEvent,
  WsServerMessage,
} from "@agentspace/spec-types";
import { Auth, bearer } from "./auth.js";
import type { Config } from "./config.js";
import { Hub } from "./hub.js";
import { OtlpAssembler } from "./otlp/assembler.js";
import { protobufToJson, spansFromJson } from "./otlp/decode.js";
import { createStore, type Store } from "./store/index.js";
import type { ControlAction, InsertResult } from "./store/types.js";
import { loadPricer } from "./pricing/index.js";
import { validateEvent } from "./validate.js";

export const VERSION = "0.1.0";
const MAX_BATCH = 1000;
const MAX_ERRORS_REPORTED = 5;
const MAX_WAIT_S = 30;
const WS_AUTH_TIMEOUT_MS = 5000;

export interface AppDeps {
  config: Config;
  store?: Store;
  logger?: boolean;
}

export async function buildApp({ config, store, logger = true }: AppDeps): Promise<FastifyInstance> {
  const db = store ?? (await createStore(config));
  const auth = new Auth(config);
  const pricer = loadPricer(config.pricesFile);
  const hub = new Hub();
  const waiters = new EventEmitter();
  waiters.setMaxListeners(0);
  const app = Fastify({ logger: logger ? { level: config.logLevel } : false, bodyLimit: config.bodyLimit });

  await app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // ---------------- plumbing ----------------

  /** Public mode never shows approval payloads (reason only). */
  const redactEvent = (e: StoredEvent): StoredEvent =>
    auth.publicReadonly && e.type === "approval.requested" ? ({ ...e, data: { ...e.data, payload: undefined } } as StoredEvent) : e;
  const redactApproval = (a: ApprovalState): ApprovalState => (auth.publicReadonly ? { ...a, payload: null } : a);

  function publish(changes: InsertResult): void {
    const byWs = new Map<string, WsServerMessage[]>();
    const push = (ws: string, msg: WsServerMessage) => byWs.set(ws, [...(byWs.get(ws) ?? []), msg]);
    groupBy(changes.inserted, (e) => e.workspace).forEach((events, ws) => push(ws, { type: "events", events: events.map(redactEvent) }));
    groupBy(changes.agents, (a) => a.workspace).forEach((agents, ws) => push(ws, { type: "agents", agents }));
    groupBy(changes.runs, (r) => r.workspace).forEach((runs, ws) => push(ws, { type: "runs", runs }));
    groupBy(changes.approvals, (a) => a.workspace).forEach((approvals, ws) => push(ws, { type: "approvals", approvals: approvals.map(redactApproval) }));
    for (const [ws, msgs] of byWs) for (const msg of msgs) hub.broadcast(ws, msg);
    for (const a of changes.approvals) if (a.status !== "pending") waiters.emit(`approval:${a.workspace}:${a.approval_id}`);
    for (const r of changes.runs) waiters.emit(`control:${r.workspace}:${r.run_id}`);
  }

  /** Validate, store and broadcast events from any ingest path. */
  async function storeEvents(events: AgentSpaceEvent[]): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    if (!events.length) return { accepted: 0, duplicates: 0, rejected: 0 };
    const valid: AgentSpaceEvent[] = [];
    for (const ev of events) {
      const res = validateEvent(ev);
      if (res.ok) valid.push(pricer.apply(res.event));
      else app.log.warn({ id: ev.id, message: res.message }, "dropped invalid converted event");
    }
    const changes = await db.insert(valid);
    publish(changes);
    return { accepted: changes.inserted.length, duplicates: changes.duplicates, rejected: events.length - valid.length };
  }

  function waitFor(key: string, seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.off(key, done);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      waiters.once(key, done);
    });
  }

  const token = (req: FastifyRequest) => bearer(req.headers.authorization);
  const deny = (reply: FastifyReply, code: 401 | 403, what: string) =>
    reply.code(code).send({ error: code === 401 ? `${what} needs a valid token (Authorization: Bearer ...)` : `${what} is not allowed on this server` });

  // Approval deadlines and OTLP orphans are handled by one timer.
  const otlp = new OtlpAssembler({ holdMs: config.otlpHoldMs, captureContent: config.otlpCaptureContent });
  const tick = setInterval(() => {
    void (async () => {
      await storeEvents(otlp.flush());
      for (const a of await db.expiredApprovals()) {
        const out = await db.resolveApproval(a.workspace, a.approval_id, "timeout", { by: "system" });
        if (out.result === "resolved") publish(out.changes);
      }
    })().catch((err: unknown) => app.log.error({ err }, "background tick failed"));
  }, 1000);
  tick.unref();

  app.addHook("onClose", async () => {
    clearInterval(tick);
    if (!store) await db.close();
  });

  // gzip request bodies (OTLP exporters often compress).
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers["content-encoding"] === "gzip") {
      delete req.headers["content-encoding"];
      const unzipped = payload.pipe(createGunzip()) as typeof payload & { receivedEncodedLength?: number };
      // Fastify checks Content-Length against `receivedEncodedLength`: count the *compressed* bytes.
      unzipped.receivedEncodedLength = 0;
      payload.on("data", (chunk: Buffer) => {
        unzipped.receivedEncodedLength! += chunk.length;
      });
      return unzipped;
    }
    return payload;
  });
  app.addContentTypeParser("application/x-protobuf", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  // ---------------- info ----------------

  app.get("/healthz", () => ({ ok: true, subscribers: hub.count() }));

  app.get("/v1/info", (): ServerInfo => ({
    version: VERSION,
    auth_required: auth.readRequiresAuth,
    operator_enabled: auth.operatorEnabled,
    public_readonly: auth.publicReadonly,
  }));

  // Prices are server config, not workspace data: readable without a token.
  app.get("/v1/pricing", (): PriceTable => pricer.table);

  // ---------------- ingest ----------------

  app.post("/v1/events", async (req, reply) => {
    const body = req.body as { events?: unknown } | null;
    if (!body || !Array.isArray(body.events)) return reply.code(400).send({ error: 'body must be {"events": [...]}' });
    if (body.events.length > MAX_BATCH) return reply.code(413).send({ error: `at most ${MAX_BATCH} events per batch` });

    const tok = token(req);
    const valid: AgentSpaceEvent[] = [];
    const errors: IngestResponse["errors"] = [];
    let unauthorized = 0;
    body.events.forEach((raw, index) => {
      const res = validateEvent(raw);
      const id = (raw as { id?: unknown })?.id;
      let message: string | null = null;
      if (!res.ok) message = res.message;
      else if (!auth.canIngest(tok, res.event.workspace)) {
        unauthorized += 1;
        message = `not allowed to write to workspace "${res.event.workspace}"`;
      } else valid.push(pricer.apply(res.event));
      if (message && errors.length < MAX_ERRORS_REPORTED) errors.push({ index, id: typeof id === "string" ? id : undefined, message });
    });
    if (unauthorized && unauthorized === body.events.length) return deny(reply, 401, "Writing events");
    const rejected = body.events.length - valid.length;
    if (rejected) req.log.warn({ rejected, first: errors[0] }, "rejected events");

    const changes = await db.insert(valid);
    publish(changes);

    // Tell the SDK about runs in this batch that an operator paused or cancelled.
    const controls: Record<string, RunControl> = {};
    for (const [ws, events] of groupBy(valid, (e) => e.workspace)) {
      Object.assign(controls, await db.controls(ws, [...new Set(events.map((e) => e.run_id))]));
    }
    const res: IngestResponse = { accepted: changes.inserted.length, duplicates: changes.duplicates, rejected, errors };
    if (Object.keys(controls).length) res.controls = controls;
    return res;
  });

  app.post("/v1/traces", async (req, reply) => {
    const isProto = String(req.headers["content-type"] ?? "").includes("protobuf");
    let spans;
    try {
      spans = spansFromJson(isProto ? protobufToJson(req.body as Buffer) : req.body);
    } catch (err) {
      return reply.code(400).send({ error: `invalid OTLP payload: ${(err as Error).message}` });
    }
    const header = req.headers["x-agentspace-workspace"];
    const workspace = typeof header === "string" && header ? header : undefined;
    const tok = token(req);
    if (!auth.canIngest(tok, workspace ?? "default") && !spans.some((s) => auth.canIngest(tok, String(s.resource["agentspace.workspace"] ?? "")))) {
      return deny(reply, 401, "Writing traces");
    }
    const events = otlp.ingest(spans, workspace).filter((e) => auth.canIngest(tok, e.workspace));
    const res = await storeEvents(events);
    req.log.debug({ spans: spans.length, ...res, pending: otlp.pendingCount }, "otlp traces");
    if (isProto) return reply.header("content-type", "application/x-protobuf").send(Buffer.alloc(0));
    return {};
  });

  // ---------------- read API ----------------

  type WsParams = { Params: { ws: string } };
  const readable = (req: FastifyRequest<WsParams>, reply: FastifyReply): boolean => {
    if (auth.canRead(token(req), req.params.ws)) return true;
    void deny(reply, 401, "Reading this workspace");
    return false;
  };

  app.get("/v1/workspaces", async (req, reply) => {
    if (!auth.canReadAll(token(req))) return deny(reply, 401, "Listing workspaces");
    return db.workspaces();
  });

  app.get<WsParams>("/v1/workspaces/:ws/agents", async (req, reply) => (readable(req, reply) ? db.agents(req.params.ws) : reply));

  app.get<WsParams & { Querystring: { limit?: string } }>("/v1/workspaces/:ws/runs", async (req, reply) =>
    readable(req, reply) ? db.runs(req.params.ws, clamp(req.query.limit, 50, 500)) : reply,
  );

  app.get<{ Params: { ws: string; runId: string } }>("/v1/workspaces/:ws/runs/:runId", async (req, reply) => {
    if (!readable(req, reply)) return reply;
    return (await db.run(req.params.ws, req.params.runId)) ?? reply.code(404).send({ error: "run not found" });
  });

  app.get<{ Params: { ws: string; runId: string }; Querystring: { after?: string; limit?: string } }>(
    "/v1/workspaces/:ws/runs/:runId/events",
    async (req, reply) => {
      if (!readable(req, reply)) return reply;
      const events = await db.runEvents(req.params.ws, req.params.runId, clamp(req.query.after, 0, Number.MAX_SAFE_INTEGER), clamp(req.query.limit, 1000, 5000));
      return events.map(redactEvent);
    },
  );

  app.get<WsParams & { Querystring: { limit?: string } }>("/v1/workspaces/:ws/events", async (req, reply) =>
    readable(req, reply) ? (await db.recentEvents(req.params.ws, clamp(req.query.limit, 200, 2000))).map(redactEvent) : reply,
  );

  // ---------------- approvals ----------------

  app.get<WsParams & { Querystring: { status?: string; limit?: string } }>("/v1/workspaces/:ws/approvals", async (req, reply) => {
    if (!readable(req, reply)) return reply;
    const status = (["pending", "approved", "rejected", "timeout"] as const).find((s) => s === req.query.status) as ApprovalStatus | undefined;
    return (await db.approvals(req.params.ws, status, clamp(req.query.limit, 100, 500))).map(redactApproval);
  });

  /** Long-poll: ?wait=N (max 30 s) returns as soon as the approval is decided. */
  app.get<{ Params: { ws: string; id: string }; Querystring: { wait?: string } }>("/v1/workspaces/:ws/approvals/:id", async (req, reply) => {
    const { ws, id } = req.params;
    const tok = token(req);
    if (!auth.canRead(tok, ws) && !auth.canIngest(tok, ws)) return deny(reply, 401, "Reading this approval");
    let approval = await db.approval(ws, id);
    const wait = Math.min(clamp(req.query.wait, 0, MAX_WAIT_S), MAX_WAIT_S);
    if (approval?.status === "pending" && wait > 0) {
      await waitFor(`approval:${ws}:${id}`, wait);
      approval = await db.approval(ws, id);
    }
    return approval ? redactApproval(approval) : reply.code(404).send({ error: "approval not found" });
  });

  app.post<{ Params: { ws: string; id: string }; Body: { decision?: string; comment?: string; by?: string } }>(
    "/v1/workspaces/:ws/approvals/:id/resolve",
    async (req, reply) => {
      const { ws, id } = req.params;
      if (!auth.canOperate(token(req), ws)) return deny(reply, auth.publicReadonly ? 403 : 401, "Resolving approvals");
      const decision = req.body?.decision;
      if (decision !== "approved" && decision !== "rejected") return reply.code(400).send({ error: 'decision must be "approved" or "rejected"' });
      const out = await db.resolveApproval(ws, id, decision, { comment: req.body.comment?.slice(0, 2000), by: req.body.by?.slice(0, 256) || "operator" });
      if (out.result === "not_found") return reply.code(404).send({ error: "approval not found" });
      if (out.result === "conflict") {
        publish({ inserted: [], duplicates: 0, agents: [], runs: [], approvals: [out.approval] });
        return reply.code(409).send({ error: `approval already ${out.approval.status}`, approval: redactApproval(out.approval) });
      }
      publish(out.changes);
      return redactApproval(out.approval);
    },
  );

  // ---------------- run controls ----------------

  app.post<{ Params: { ws: string; runId: string }; Body: { action?: string; by?: string } }>(
    "/v1/workspaces/:ws/runs/:runId/control",
    async (req, reply) => {
      const { ws, runId } = req.params;
      if (!auth.canOperate(token(req), ws)) return deny(reply, auth.publicReadonly ? 403 : 401, "Controlling runs");
      const action = req.body?.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") return reply.code(400).send({ error: 'action must be "pause", "resume" or "cancel"' });
      const out = await db.setControl(ws, runId, action as ControlAction, { by: req.body.by?.slice(0, 256) || "operator" });
      if (out.result === "not_found") return reply.code(404).send({ error: "run not found" });
      if (out.result === "conflict") return reply.code(409).send({ error: `run is ${out.run.control}`, run: out.run });
      publish(out.changes);
      return out.run;
    },
  );

  /** SDKs poll this while paused. ?runs=a,b&wait=N returns when any of them changes. */
  app.get<WsParams & { Querystring: { runs?: string; wait?: string } }>("/v1/workspaces/:ws/controls", async (req, reply) => {
    const { ws } = req.params;
    const tok = token(req);
    if (!auth.canRead(tok, ws) && !auth.canIngest(tok, ws)) return deny(reply, 401, "Reading controls");
    const runs = (req.query.runs ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const before = await db.controls(ws, runs);
    const wait = Math.min(clamp(req.query.wait, 0, MAX_WAIT_S), MAX_WAIT_S);
    if (wait > 0 && runs.length) {
      await Promise.race(runs.map((r) => waitFor(`control:${ws}:${r}`, wait)));
      return db.controls(ws, runs);
    }
    return before;
  });

  // ---------------- live stream ----------------

  app.get<{ Querystring: { workspace?: string } }>("/v1/ws", { websocket: true }, (socket, req) => {
    const workspace = req.query.workspace || "default";
    const start = async () => {
      hub.add(workspace, socket);
      const snapshot: WsServerMessage = {
        type: "snapshot",
        workspace,
        agents: await db.agents(workspace),
        runs: await db.runs(workspace, 50),
        events: (await db.recentEvents(workspace, 200)).map(redactEvent),
        approvals: (await db.approvals(workspace, undefined, 50)).map(redactApproval),
      };
      socket.send(JSON.stringify(snapshot));
    };
    if (auth.canRead(undefined, workspace)) {
      void start();
      return;
    }
    // Browsers can't set headers on WebSockets; the first message carries the token instead.
    const timer = setTimeout(() => socket.close(4401, "auth required"), WS_AUTH_TIMEOUT_MS);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      let tok: string | undefined;
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; token?: string };
        if (msg.type === "auth") tok = msg.token;
      } catch {
        // fall through
      }
      if (auth.canRead(tok, workspace)) void start();
      else socket.close(4401, "invalid token");
    });
  });

  return app;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
