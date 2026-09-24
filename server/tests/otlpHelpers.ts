import protobuf from "protobufjs";
import { COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO } from "../src/otlp/protoSources.js";

type Val = string | number | boolean;
const kv = (attrs: Record<string, Val | Val[]>) =>
  Object.entries(attrs).map(([key, v]) => ({
    key,
    value: Array.isArray(v)
      ? { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } }
      : typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v },
  }));

export const TRACE = "5b8efff798038103d269b633813fc60c";
const T0 = 1_790_000_000_000; // ms

export interface SpanSpec {
  id: string; // 16 hex
  parent?: string;
  name: string;
  start: number; // ms offset
  end: number;
  attrs?: Record<string, Val | Val[]>;
  error?: string;
  events?: { name: string; at: number; attrs?: Record<string, Val> }[];
}

export function span(s: SpanSpec) {
  return {
    traceId: TRACE,
    spanId: s.id,
    ...(s.parent ? { parentSpanId: s.parent } : {}),
    name: s.name,
    kind: 1,
    startTimeUnixNano: String(BigInt(T0 + s.start) * 1_000_000n),
    endTimeUnixNano: String(BigInt(T0 + s.end) * 1_000_000n),
    attributes: kv(s.attrs ?? {}),
    events: (s.events ?? []).map((e) => ({ name: e.name, timeUnixNano: String(BigInt(T0 + e.at) * 1_000_000n), attributes: kv(e.attrs ?? {}) })),
    status: s.error ? { code: 2, message: s.error } : { code: 1 },
  };
}

export function request(spans: ReturnType<typeof span>[], resource: Record<string, Val> = { "service.name": "research-bot" }) {
  return { resourceSpans: [{ resource: { attributes: kv(resource) }, scopeSpans: [{ scope: { name: "test" }, spans }] }] };
}

/** A research workflow: planner delegates to writer; each calls a model; writer uses a tool. */
export const S = {
  root: span({ id: "a000000000000001", name: "invoke_workflow research", start: 0, end: 9000, attrs: { "gen_ai.operation.name": "invoke_workflow", "gen_ai.workflow.name": "research" } }),
  planner: span({ id: "a000000000000002", parent: "a000000000000001", name: "invoke_agent Planner", start: 100, end: 3000, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "Planner" } }),
  plannerLlm: span({
    id: "a000000000000003",
    parent: "a000000000000002",
    name: "chat gpt-5",
    start: 200,
    end: 2500,
    attrs: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.response.model": "gpt-5-2026-01-01",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 80,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.input.messages": '[{"role":"user","content":"secret prompt"}]',
    },
  }),
  writer: span({ id: "a000000000000004", parent: "a000000000000001", name: "invoke_agent Writer", start: 3100, end: 8800, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "Writer" } }),
  tool: span({ id: "a000000000000005", parent: "a000000000000004", name: "execute_tool web_search", start: 3200, end: 4200, attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_search", "gen_ai.tool.call.id": "call_42" } }),
  writerLlm: span({
    id: "a000000000000006",
    parent: "a000000000000004",
    name: "chat",
    start: 4300,
    end: 8500,
    attrs: { "gen_ai.operation.name": "chat", "gen_ai.system": "anthropic", "gen_ai.request.model": "claude-sonnet-5", "gen_ai.usage.prompt_tokens": 3000, "gen_ai.usage.completion_tokens": 400, "gen_ai.usage.cache_read.input_tokens": 2000 },
    events: [{ name: "agentspace.status", at: 5000, attrs: { status: "waiting_human", detail: "needs sign-off" } }],
  }),
};

let traceServiceRequest: protobuf.Type | null = null;
export function encodeProtobuf(body: object): Uint8Array {
  if (!traceServiceRequest) {
    const root = new protobuf.Root();
    for (const src of [COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO]) protobuf.parse(src, root);
    root.resolveAll();
    traceServiceRequest = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
  }
  // protobuf wants bytes for ids: convert hex -> base64 strings (protobufjs accepts base64 for bytes).
  const clone = JSON.parse(JSON.stringify(body), (k, v) =>
    (k === "traceId" || k === "spanId" || k === "parentSpanId") && typeof v === "string" ? Buffer.from(v, "hex").toString("base64") : v,
  );
  return traceServiceRequest.encode(traceServiceRequest.fromObject(clone)).finish();
}
