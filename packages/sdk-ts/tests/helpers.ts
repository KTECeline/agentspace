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
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (this.hang) return; // never answer
        if (this.status === 200) this.events.push(...(JSON.parse(body) as { events: Ev[] }).events);
        res.writeHead(this.status, { "content-type": "application/json" });
        res.end('{"accepted":0,"rejected":0}');
      });
    });
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
