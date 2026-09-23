import protobuf from "protobufjs";
import { COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO } from "./protoSources.js";

/** Attribute values after decoding (OTLP AnyValue flattened to plain JSON). */
export type AttrValue = string | number | boolean | null | AttrValue[] | { [k: string]: AttrValue };
export type Attrs = Record<string, AttrValue>;

/** One span, normalized from either OTLP/JSON or OTLP/protobuf. */
export interface OtlpSpan {
  traceId: string; // lowercase hex
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Attrs;
  resource: Attrs;
  events: { name: string; timeMs: number; attributes: Attrs }[];
  status: { code: number; message?: string }; // 0 unset, 1 ok, 2 error
}

// ---- protobuf ----

let requestType: protobuf.Type | null = null;

function exportRequestType(): protobuf.Type {
  if (!requestType) {
    const root = new protobuf.Root();
    for (const src of [COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO]) protobuf.parse(src, root);
    root.resolveAll();
    requestType = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
  }
  return requestType;
}

/** Decode an OTLP/protobuf ExportTraceServiceRequest into the OTLP/JSON object shape. */
export function protobufToJson(buf: Uint8Array): unknown {
  const type = exportRequestType();
  const msg = type.decode(buf);
  return type.toObject(msg, { longs: String, bytes: String, defaults: false, arrays: true });
}

// ---- JSON (also used for decoded protobuf) ----

interface JsonAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: JsonAnyValue[] };
  kvlistValue?: { values?: JsonKeyValue[] };
  bytesValue?: string;
}
interface JsonKeyValue {
  key: string;
  value?: JsonAnyValue;
}

function anyValue(v: JsonAnyValue | undefined): AttrValue {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return null;
}

function attrs(list: JsonKeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) if (kv?.key) out[kv.key] = anyValue(kv.value);
  return out;
}

/** OTLP/JSON uses hex ids; protobuf→JSON gives base64. Accept both, return lowercase hex. */
export function idToHex(id: unknown): string {
  if (typeof id !== "string" || !id) return "";
  if (/^[0-9a-fA-F]+$/.test(id) && (id.length === 32 || id.length === 16)) return id.toLowerCase();
  return Buffer.from(id, "base64").toString("hex");
}

function nanosToMs(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  try {
    return Number(BigInt(String(v)) / 1_000_000n);
  } catch {
    return Number(v) / 1e6;
  }
}

/** Flatten an ExportTraceServiceRequest (JSON shape) into spans. Throws on a malformed top level. */
export function spansFromJson(body: unknown): OtlpSpan[] {
  const req = body as { resourceSpans?: unknown };
  if (!req || typeof req !== "object" || !Array.isArray(req.resourceSpans)) {
    throw new Error("expected an OTLP ExportTraceServiceRequest with resourceSpans[]");
  }
  const out: OtlpSpan[] = [];
  for (const rs of req.resourceSpans as { resource?: { attributes?: JsonKeyValue[] }; scopeSpans?: { spans?: unknown[] }[] }[]) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const s = raw as Record<string, unknown>;
        const traceId = idToHex(s.traceId);
        const spanId = idToHex(s.spanId);
        if (!traceId || !spanId) continue;
        const parent = idToHex(s.parentSpanId);
        const status = (s.status as { code?: number | string; message?: string } | undefined) ?? {};
        out.push({
          traceId,
          spanId,
          parentSpanId: parent && !/^0+$/.test(parent) ? parent : null,
          name: String(s.name ?? ""),
          startMs: nanosToMs(s.startTimeUnixNano),
          endMs: nanosToMs(s.endTimeUnixNano),
          attributes: attrs(s.attributes as JsonKeyValue[] | undefined),
          resource,
          events: ((s.events as { name?: string; timeUnixNano?: unknown; attributes?: JsonKeyValue[] }[] | undefined) ?? []).map((e) => ({
            name: String(e.name ?? ""),
            timeMs: nanosToMs(e.timeUnixNano),
            attributes: attrs(e.attributes),
          })),
          status: { code: statusCode(status.code), message: status.message },
        });
      }
    }
  }
  return out;
}

function statusCode(code: number | string | undefined): number {
  if (typeof code === "number") return code;
  if (code === "STATUS_CODE_OK") return 1;
  if (code === "STATUS_CODE_ERROR") return 2;
  return 0;
}
