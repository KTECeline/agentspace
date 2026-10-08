import { createServer, type Server } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import schema from "@agentspace/spec-types/schema.json" with { type: "json" };

const fx = addFormatsModule as unknown as FormatsPlugin & { default?: FormatsPlugin };
const ajv = new Ajv2020({ strict: false });
(fx.default ?? fx)(ajv);
const validate = ajv.compile(schema);

export type Ev = Record<string, unknown> & { type: string; data: Record<string, unknown>; agent_id: string | null; parent_id: string | null; run_id: string };

export function assertValid(events: Ev[]): void {
  for (const e of events) {
    const ok = validate(e as unknown);
    if (!ok) throw new Error(`${e.type}: ${JSON.stringify(validate.errors?.[0])}`);
  }
}

export class FakeCollector {
  events: Ev[] = [];
  status = 200;
  hang = false;
  url = "";
  /** approval_id -> state (emulates GET /approvals/:id, long-polling when ?wait is set). */
  approvals = new Map<string, { status: string; comment?: string; resolved_by?: string }>();
  /** run_id -> "paused" | "cancelled" (returned on ingest and by GET /controls). */
  controls = new Map<string, string>();
  approvalStatusOverride: number | null = null;
  /** Served by GET /policy (D-045); runs listed in `escalated` come back on ingest too. */
  policy: unknown = null;
  escalated = new Set<string>();
  policyReads = 0;
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (this.hang) return; // never answer
        const url = new URL(req.url ?? "/", "http://x");
        const json = (code: number, out: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        };
        if (req.method === "GET") return void this.get(url, json);
        if (this.status !== 200) return json(this.status, { error: "nope" });
        const events = (JSON.parse(body) as { events: Ev[] }).events;
        this.events.push(...events);
        const controls: Record<string, string> = {};
        for (const e of events) {
          if (e.type === "approval.requested") this.approvals.set(String(e.data.approval_id), { status: "pending" });
          const c = this.controls.get(e.run_id);
          if (c) controls[e.run_id] = c;
        }
        const escalated = [...new Set(events.map((e) => e.run_id))].filter((r) => this.escalated.has(r));
        json(200, { accepted: events.length, rejected: 0, controls, ...(escalated.length ? { escalated } : {}) });
      });
    });
  }

  private async get(url: URL, json: (code: number, out: unknown) => void): Promise<void> {
    const wait = Number(url.searchParams.get("wait") ?? 0) * 1000;
    const until = Date.now() + Math.min(wait, 3000);
    const approval = url.pathname.match(/\/approvals\/([^/]+)$/);
    if (approval) {
      if (this.approvalStatusOverride) return json(this.approvalStatusOverride, { error: "nope" });
      const id = approval[1] ?? "";
      while (this.approvals.get(id)?.status === "pending" && Date.now() < until) await sleep(20);
      const a = this.approvals.get(id);
      return a ? json(200, { approval_id: id, ...a }) : json(404, { error: "not found" });
    }
    if (url.pathname.endsWith("/policy")) {
      this.policyReads++;
      const runs = (url.searchParams.get("runs") ?? "").split(",").filter(Boolean);
      return json(200, { policy: this.policy, escalated: runs.filter((r) => this.escalated.has(r)) });
    }
    if (url.pathname.endsWith("/controls")) {
      const runs = (url.searchParams.get("runs") ?? "").split(",").filter(Boolean);
      const snap = () => JSON.stringify(runs.map((r) => this.controls.get(r)));
      const before = snap();
      while (wait && snap() === before && Date.now() < until) await sleep(20);
      return json(200, Object.fromEntries(runs.filter((r) => this.controls.has(r)).map((r) => [r, this.controls.get(r)])));
    }
    json(404, { error: "not found" });
  }

  resolve(approvalId: string, status: string, comment?: string): void {
    this.approvals.set(approvalId, { status, comment, resolved_by: "tester" });
  }

  /** Resolve the next approval request once it arrives. */
  async resolveWhenRequested(status: string, comment?: string): Promise<void> {
    while (!this.ofType("approval.requested").length) await sleep(10);
    await sleep(50);
    this.resolve(String(this.ofType("approval.requested").at(-1)!.data.approval_id), status, comment);
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  ofType(t: string): Ev[] {
    return this.events.filter((e) => e.type === t);
  }
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
