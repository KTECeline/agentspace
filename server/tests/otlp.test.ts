import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentSpaceEvent, AgentState, RunState, StoredEvent } from "@agentspace/spec-types";
import { OtlpAssembler } from "../src/otlp/assembler.js";
import { spansFromJson } from "../src/otlp/decode.js";
import { validateEvent } from "../src/validate.js";
import { makeApp } from "./helpers.js";
import { S, TRACE, encodeProtobuf, request } from "./otlpHelpers.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

// Children end (and are exported) before parents: this is the order a BatchSpanProcessor sends.
const batch1 = request([S.plannerLlm, S.tool]);
const batch2 = request([S.planner, S.writerLlm]);
const batch3 = request([S.writer, S.root]);

function types(events: AgentSpaceEvent[]) {
  return events.map((e) => `${e.type}:${e.agent_id ?? "-"}`);
}

describe("OtlpAssembler", () => {
  it("waits for parents across batches, then attributes spans to the right agents", () => {
    const asm = new OtlpAssembler();
    const e1 = asm.ingest(spansFromJson(batch1), undefined, 0);
    expect(e1).toEqual([]); // both spans wait for their agent parents
    const e2 = asm.ingest(spansFromJson(batch2), undefined, 100);
    const e3 = asm.ingest(spansFromJson(batch3), undefined, 200);
    const all = [...e1, ...e2, ...e3];
    expect(asm.pendingCount).toBe(0);
    for (const e of all) expect(validateEvent(e).ok, JSON.stringify(e)).toBe(true);

    const llm = all.filter((e) => e.type === "llm.call");
    expect(llm.map((e) => [e.agent_id, e.tokens_in, e.tokens_out, e.model])).toEqual([
      ["planner", 1200, 80, "gpt-5-2026-01-01"],
      ["writer", 3000, 400, "claude-sonnet-5"],
    ]);
    const tool = all.find((e) => e.type === "tool.call")!;
    expect(tool.agent_id).toBe("writer");
    expect(tool.parent_id).toBe("a000000000000004");
    const handoff = all.find((e) => e.type === "handoff")!;
    expect(handoff.data).toEqual({ from_agent_id: "planner", to_agent_id: "writer" });
    expect(all.find((e) => e.type === "run.started")!.data).toMatchObject({ name: "research" });
    expect(all.find((e) => e.type === "run.finished")!.data).toMatchObject({ status: "ok", duration_ms: 9000 });
    expect(new Set(all.map((e) => e.run_id))).toEqual(new Set([TRACE]));
    expect(all.filter((e) => e.agent_id).every((e) => e.team_id === "research-bot")).toBe(true); // service.name
    expect(all.some((e) => e.type === "agent.status" && e.data.status === "waiting_human")).toBe(true);
  });

  it("does not forward prompt content unless enabled", () => {
    const off = new OtlpAssembler().ingest(spansFromJson(request([S.plannerLlm])), undefined, 0);
    expect(off).toEqual([]); // held for its parent
    const offAll = new OtlpAssembler().ingest(spansFromJson(request([S.planner, S.plannerLlm])), undefined, 0);
    expect(offAll.find((e) => e.type === "llm.call")!.data).not.toHaveProperty("input");
    const onAll = new OtlpAssembler({ captureContent: true }).ingest(spansFromJson(request([S.planner, S.plannerLlm])), undefined, 0);
    expect(onAll.find((e) => e.type === "llm.call")!.data).toMatchObject({ input: [{ role: "user", content: "secret prompt" }] });
  });

  it("releases orphans after the hold time using their own attributes", () => {
    const asm = new OtlpAssembler({ holdMs: 1000 });
    expect(asm.ingest(spansFromJson(request([S.tool])), undefined, 0)).toEqual([]);
    const later = asm.flush(1500);
    expect(types(later)).toContain("tool.call:-");
    expect(asm.pendingCount).toBe(0);
  });

  it("marks failed agent spans as errors", () => {
    const failing = { ...S.planner, status: { code: 2, message: "rate limited" } };
    const out = new OtlpAssembler().ingest(spansFromJson(request([failing])), undefined, 0);
    expect(out.find((e) => e.type === "error")!.data).toMatchObject({ message: "rate limited" });
    expect(out.find((e) => e.type === "step.finished")!.data).toMatchObject({ ok: false });
  });
});

async function agentsAndRuns(ws = "default") {
  const agents = (await app.inject(`/v1/workspaces/${ws}/agents`)).json() as AgentState[];
  const runs = (await app.inject(`/v1/workspaces/${ws}/runs`)).json() as RunState[];
  return { agents, runs };
}

describe("POST /v1/traces", () => {

  it("accepts OTLP/JSON and shows the agents and run", async () => {
    ({ app } = await makeApp());
    for (const b of [batch1, batch2, batch3]) {
      const res = await app.inject({ method: "POST", url: "/v1/traces", payload: b });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    }
    const { agents, runs } = await agentsAndRuns();
    expect(agents.map((a) => [a.agent_id, a.status, a.tokens_in])).toEqual([
      ["planner", "done", 1200],
      ["writer", "done", 3000],
    ]);
    expect(runs[0]).toMatchObject({ run_id: TRACE, name: "research", status: "ok", tokens_in: 4200 });
  });

  it("accepts gzipped OTLP/protobuf with a workspace header, and is idempotent", async () => {
    ({ app } = await makeApp());
    const body = gzipSync(encodeProtobuf(request([S.root, S.planner, S.plannerLlm])));
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/traces",
        payload: body,
        headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip", "x-agentspace-workspace": "otel" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/x-protobuf");
    }
    const { agents, runs } = await agentsAndRuns("otel");
    expect(agents.map((a) => a.agent_id)).toEqual(["planner"]);
    expect(runs[0]!.tokens_in).toBe(1200); // not doubled by the retry
    const events = (await app.inject(`/v1/workspaces/otel/runs/${TRACE}/events`)).json() as StoredEvent[];
    expect(events.filter((e) => e.type === "llm.call")).toHaveLength(1);
  });

  it("rejects malformed payloads with 400", async () => {
    ({ app } = await makeApp());
    const bad = await app.inject({ method: "POST", url: "/v1/traces", payload: { nope: true } });
    expect(bad.statusCode).toBe(400);
    const garbage = await app.inject({ method: "POST", url: "/v1/traces", payload: Buffer.from([1, 2, 3, 250]), headers: { "content-type": "application/x-protobuf" } });
    expect(garbage.statusCode).toBe(400);
  });
});

describe("recorded OTLP from the OpenTelemetry Python SDK (examples/otel-generic)", () => {
  it("turns real exporter payloads into the expected agents and run", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("./fixtures/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.startsWith("otlp-python-")).sort();
    expect(files.length).toBeGreaterThan(0);
    ({ app } = await makeApp());
    for (const f of files) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/traces",
        payload: readFileSync(new URL(f, dir)),
        headers: { "content-type": "application/x-protobuf" },
      });
      expect(res.statusCode).toBe(200);
    }
    const { agents, runs } = await agentsAndRuns();
    expect(agents.map((a) => [a.agent_id, a.team_id, a.status])).toEqual([
      ["researcher", "support-bot", "done"],
      ["router", "support-bot", "done"],
      ["writer", "support-bot", "done"],
    ]);
    expect(agents.find((a) => a.agent_id === "router")!.model).toBe("claude-haiku-4-5");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: "support-ticket", status: "ok", tokens_in: 4120 });
    const events = (await app.inject(`/v1/workspaces/default/runs/${runs[0]!.run_id}/events`)).json() as StoredEvent[];
    expect(events.filter((e) => e.type === "handoff").map((e) => `${e.data.from_agent_id}->${e.data.to_agent_id}`)).toEqual(["router->researcher", "researcher->writer"]);
    expect(events.some((e) => e.type === "agent.status" && e.data.status === "waiting_human")).toBe(true);
  });
});
