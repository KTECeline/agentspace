import { createGunzip } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { AgentSpaceEvent, IngestResponse, WsServerMessage } from "@agentspace/spec-types";
import type { Config } from "./config.js";
import { Hub } from "./hub.js";
import { Store } from "./store.js";
import { validateEvent } from "./validate.js";
import { OtlpAssembler } from "./otlp/assembler.js";
import { protobufToJson, spansFromJson } from "./otlp/decode.js";

const MAX_BATCH = 1000;
const MAX_ERRORS_REPORTED = 5;

export interface AppDeps {
  config: Config;
  store?: Store;
  logger?: boolean;
}

export async function buildApp({ config, store, logger = true }: AppDeps): Promise<FastifyInstance> {
  const db = store ?? new Store(config.dbPath);
  const hub = new Hub();
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    bodyLimit: config.bodyLimit,
  });

  await app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const otlp = new OtlpAssembler({ holdMs: config.otlpHoldMs, captureContent: config.otlpCaptureContent });
  // Spans held for a parent that never arrived get released by this timer.
  const otlpTimer = setInterval(() => store_(otlp.flush()), 1000);
  otlpTimer.unref();

  app.addHook("onClose", () => {
    clearInterval(otlpTimer);
    if (!store) db.close();
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

  /** Validate, store, and broadcast events from any ingest path. */
  function store_(events: AgentSpaceEvent[]): { accepted: number; duplicates: number; rejected: number } {
    if (!events.length) return { accepted: 0, duplicates: 0, rejected: 0 };
    const valid: AgentSpaceEvent[] = [];
    for (const ev of events) {
      const res = validateEvent(ev);
      if (res.ok) valid.push(res.event);
      else app.log.warn({ id: ev.id, message: res.message }, "dropped invalid converted event");
    }
    const { inserted, duplicates, agents, runs } = db.insert(valid);
    fanOut(hub, inserted, agents, runs);
    return { accepted: inserted.length, duplicates, rejected: events.length - valid.length };
  }

  app.get("/healthz", () => ({ ok: true, subscribers: hub.count() }));

  // ---- ingest ----

  app.post("/v1/events", async (req, reply) => {
    const body = req.body as { events?: unknown } | null;
    if (!body || !Array.isArray(body.events)) {
      return reply.code(400).send({ error: 'body must be {"events": [...]}' });
    }
    if (body.events.length > MAX_BATCH) {
      return reply.code(413).send({ error: `at most ${MAX_BATCH} events per batch` });
    }

    const valid: AgentSpaceEvent[] = [];
    const errors: IngestResponse["errors"] = [];
    body.events.forEach((raw, index) => {
      const res = validateEvent(raw);
      if (res.ok) valid.push(res.event);
      else if (errors.length < MAX_ERRORS_REPORTED) {
        const id = (raw as { id?: unknown })?.id;
        errors.push({ index, id: typeof id === "string" ? id : undefined, message: res.message });
      }
    });
    const rejected = body.events.length - valid.length;
    if (rejected) req.log.warn({ rejected, first: errors[0] }, "rejected invalid events");

    const { inserted, duplicates, agents, runs } = db.insert(valid);
    fanOut(hub, inserted, agents, runs);

    const res: IngestResponse = { accepted: inserted.length, duplicates, rejected, errors };
    return res;
  });

  // ---- OTLP/HTTP traces (JSON or protobuf) ----

  app.post("/v1/traces", async (req, reply) => {
    const isProto = String(req.headers["content-type"] ?? "").includes("protobuf");
    let spans;
    try {
      const body = isProto ? protobufToJson(req.body as Buffer) : req.body;
      spans = spansFromJson(body);
    } catch (err) {
      return reply.code(400).send({ error: `invalid OTLP payload: ${(err as Error).message}` });
    }
    const workspace = req.headers["x-agentspace-workspace"];
    const events = otlp.ingest(spans, typeof workspace === "string" && workspace ? workspace : undefined);
    const res = store_(events);
    req.log.debug({ spans: spans.length, ...res, pending: otlp.pendingCount }, "otlp traces");
    // OTLP success response: an empty ExportTraceServiceResponse.
    if (isProto) return reply.header("content-type", "application/x-protobuf").send(Buffer.alloc(0));
    return {};
  });

  // ---- read API ----

  app.get("/v1/workspaces", () => db.workspaces());

  app.get<{ Params: { ws: string } }>("/v1/workspaces/:ws/agents", (req) => db.agents(req.params.ws));

  app.get<{ Params: { ws: string }; Querystring: { limit?: string } }>("/v1/workspaces/:ws/runs", (req) =>
    db.runs(req.params.ws, clamp(req.query.limit, 50, 500)),
  );

  app.get<{ Params: { ws: string; runId: string } }>("/v1/workspaces/:ws/runs/:runId", (req, reply) => {
    const run = db.run(req.params.ws, req.params.runId);
    return run ?? reply.code(404).send({ error: "run not found" });
  });

  app.get<{ Params: { ws: string; runId: string }; Querystring: { after?: string; limit?: string } }>(
    "/v1/workspaces/:ws/runs/:runId/events",
    (req) =>
      db.runEvents(req.params.ws, req.params.runId, clamp(req.query.after, 0, Number.MAX_SAFE_INTEGER), clamp(req.query.limit, 1000, 5000)),
  );

  app.get<{ Params: { ws: string }; Querystring: { limit?: string } }>("/v1/workspaces/:ws/events", (req) =>
    db.recentEvents(req.params.ws, clamp(req.query.limit, 200, 2000)),
  );

  // ---- live stream ----

  app.get<{ Querystring: { workspace?: string } }>("/v1/ws", { websocket: true }, (socket, req) => {
    const workspace = req.query.workspace || "default";
    hub.add(workspace, socket);
    const snapshot: WsServerMessage = {
      type: "snapshot",
      workspace,
      agents: db.agents(workspace),
      runs: db.runs(workspace, 50),
      events: db.recentEvents(workspace, 200),
    };
    socket.send(JSON.stringify(snapshot));
  });

  return app;
}

function fanOut(
  hub: Hub,
  inserted: ReturnType<Store["insert"]>["inserted"],
  agents: ReturnType<Store["insert"]>["agents"],
  runs: ReturnType<Store["insert"]>["runs"],
): void {
  const byWs = new Map<string, WsServerMessage[]>();
  const push = (ws: string, msg: WsServerMessage) => {
    const list = byWs.get(ws) ?? [];
    list.push(msg);
    byWs.set(ws, list);
  };
  groupBy(inserted, (e) => e.workspace).forEach((events, ws) => push(ws, { type: "events", events }));
  groupBy(agents, (a) => a.workspace).forEach((list, ws) => push(ws, { type: "agents", agents: list }));
  groupBy(runs, (r) => r.workspace).forEach((list, ws) => push(ws, { type: "runs", runs: list }));
  for (const [ws, msgs] of byWs) for (const msg of msgs) hub.broadcast(ws, msg);
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
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}
