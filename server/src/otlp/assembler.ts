import type { AgentSpaceEvent, AgentStatus } from "@agentspace/spec-types";
import type { AttrValue, Attrs, OtlpSpan } from "./decode.js";
import { hashArguments } from "../hash.js";

/**
 * Turns OTLP spans (OpenTelemetry GenAI semantic conventions) into AgentSpace events.
 *
 * Exporters send a span when it ENDS, so children usually arrive before their parents, often
 * in an earlier batch. A non-agent span is processed once its parent is known (or it has no
 * parent), so it inherits the right agent. Agent spans are processed right away. Spans whose parent never shows up are processed after `holdMs`
 * using only their own attributes. Event ids are derived from span ids, so re-exported spans
 * are de-duplicated by the store.
 *
 * Mapping (see spec/README.md):
 *   invoke_agent / create_agent span (or any span with gen_ai.agent.name) -> agent + step events
 *   chat / text_completion / generate_content / embeddings                -> llm.call
 *   execute_tool (or gen_ai.tool.name)                                    -> tool.call + tool.result
 *   root span (no parent)                                                 -> run.started + run.finished
 *   span events "agentspace.handoff" / "agentspace.status" / "exception"  -> handoff / agent.status / error
 */

export interface AssemblerOptions {
  /** How long to wait for a parent span before giving up (ms). */
  holdMs?: number;
  /** Forward gen_ai.input/output messages and tool arguments. Off by default (privacy). */
  captureContent?: boolean;
  /** Span contexts remembered for parent lookups. */
  maxKnown?: number;
  defaultWorkspace?: string;
}

interface Ctx {
  agentId: string | null;
  teamId: string | null;
  /** The step the span's children hang under (the nearest agent span). */
  stepId: string | null;
}

interface Pending {
  span: OtlpSpan;
  workspace: string;
  receivedAt: number;
}

const LLM_OPS = new Set(["chat", "text_completion", "generate_content", "embeddings"]);
const AGENT_OPS = new Set(["invoke_agent", "create_agent"]);

export class OtlpAssembler {
  private readonly holdMs: number;
  private readonly captureContent: boolean;
  private readonly maxKnown: number;
  private readonly defaultWorkspace: string;
  private known = new Map<string, Ctx>();
  private pending = new Map<string, Pending>();
  private lastAgent = new Map<string, { agentId: string; endMs: number }>();

  constructor(opts: AssemblerOptions = {}) {
    this.holdMs = opts.holdMs ?? 10_000;
    this.captureContent = opts.captureContent ?? false;
    this.maxKnown = opts.maxKnown ?? 50_000;
    this.defaultWorkspace = opts.defaultWorkspace ?? "default";
  }

  /** Add a batch of spans; returns every event that can be emitted now. */
  ingest(spans: OtlpSpan[], workspace: string | undefined, now = Date.now()): AgentSpaceEvent[] {
    for (const span of spans) {
      const ws = workspace ?? str(span.resource["agentspace.workspace"]) ?? this.defaultWorkspace;
      this.pending.set(span.spanId, { span, workspace: ws, receivedAt: now });
    }
    return this.drain(now);
  }

  /** Emit spans that waited too long for their parent. Call periodically. */
  flush(now = Date.now()): AgentSpaceEvent[] {
    return this.drain(now);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private drain(now: number): AgentSpaceEvent[] {
    const out: AgentSpaceEvent[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      // Oldest spans first, so parents that are ready get processed before their children.
      const ready = [...this.pending.values()]
        .filter((p) => {
          const parent = p.span.parentSpanId;
          // Agent spans carry their own identity, so they never wait (their parent is usually the
          // workflow root, which only arrives when the whole run ends).
          return !parent || isAgentSpan(p.span.attributes) || this.known.has(parent) || now - p.receivedAt >= this.holdMs;
        })
        .sort((a, b) => a.span.startMs - b.span.startMs);
      for (const p of ready) {
        if (!this.pending.delete(p.span.spanId)) continue;
        out.push(...this.process(p.span, p.workspace));
        progress = true;
      }
    }
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  private remember(spanId: string, ctx: Ctx): void {
    this.known.set(spanId, ctx);
    if (this.known.size > this.maxKnown) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }

  private process(span: OtlpSpan, workspace: string): AgentSpaceEvent[] {
    const a = span.attributes;
    const op = str(a["gen_ai.operation.name"]);
    const parentCtx = span.parentSpanId ? this.known.get(span.parentSpanId) : undefined;
    const team = slug(str(a["agentspace.team"]) ?? str(span.resource["agentspace.team"]) ?? str(span.resource["service.name"]));
    const agentName = str(a["gen_ai.agent.name"]);
    const agentIdAttr = str(a["gen_ai.agent.id"]);
    const isLlm = (op !== undefined && LLM_OPS.has(op)) || (!op && a["gen_ai.request.model"] !== undefined && a["gen_ai.tool.name"] === undefined);
    const isTool = op === "execute_tool" || (!isLlm && a["gen_ai.tool.name"] !== undefined);
    const isAgent = (op !== undefined && AGENT_OPS.has(op)) || (!isLlm && !isTool && (agentName !== undefined || agentIdAttr !== undefined));

    const out: AgentSpaceEvent[] = [];
    const base = (suffix: string, type: AgentSpaceEvent["type"], tsMs: number, ctx: Ctx, data: object, extra: object = {}) =>
      ({
        spec_version: "0.1",
        id: `otlp-${span.spanId}-${suffix}`,
        type,
        ts: iso(tsMs),
        workspace,
        run_id: span.traceId,
        agent_id: ctx.agentId,
        team_id: ctx.agentId ? ctx.teamId : null,
        parent_id: ctx.stepId,
        attributes: { "otel.span_name": span.name.slice(0, 200) },
        data: compact(data),
        ...compact(extra),
      }) as AgentSpaceEvent;

    let ctx: Ctx;
    if (isAgent) {
      const agentId = (agentIdAttr ?? slug(agentName) ?? span.spanId).slice(0, 128);
      ctx = { agentId, teamId: team ?? parentCtx?.teamId ?? null, stepId: span.spanId };
      const outer: Ctx = { agentId, teamId: ctx.teamId, stepId: parentCtx?.stepId ?? null };
      out.push(
        base("reg", "agent.registered", span.startMs, outer, {
          name: agentName ?? agentId,
          description: str(a["gen_ai.agent.description"]),
          framework: str(span.resource["telemetry.sdk.name"]) ?? "opentelemetry",
        }),
      );
      // Delegation (agent span inside another agent) or a sequential switch within the trace.
      const prev = parentCtx?.agentId ?? this.lastAgent.get(span.traceId)?.agentId;
      if (prev && prev !== agentId) {
        out.push(
          base("handoff", "handoff", span.startMs, { ...outer, agentId: prev }, { from_agent_id: prev, to_agent_id: agentId }, { summary: `handed off to ${agentName ?? agentId}` }),
        );
      }
      if (op !== "create_agent") {
        const failed = span.status.code === 2;
        out.push(base("start", "step.started", span.startMs, outer, { step_id: span.spanId, name: span.name.slice(0, 256), kind: "agent" }));
        out.push(base("thinking", "agent.status", span.startMs, ctx, { status: "thinking" }));
        if (failed) out.push(base("err", "error", span.endMs, ctx, errorData(span)));
        out.push(
          base("end", "step.finished", span.endMs, outer, {
            step_id: span.spanId,
            name: span.name.slice(0, 256),
            ok: !failed,
            duration_ms: Math.max(0, span.endMs - span.startMs),
            error: failed ? (span.status.message ?? "error").slice(0, 2000) : undefined,
          }),
        );
        out.push(base("final", "agent.status", span.endMs, ctx, { status: (failed ? "error" : "done") satisfies AgentStatus }));
        this.lastAgent.set(span.traceId, { agentId, endMs: span.endMs });
      }
    } else {
      ctx = parentCtx ?? {
        agentId: agentIdAttr ?? slug(agentName) ?? null,
        teamId: team ?? null,
        stepId: null,
      };
    }

    if (isLlm) {
      const model = str(a["gen_ai.response.model"]) ?? str(a["gen_ai.request.model"]);
      const tin = num(a["gen_ai.usage.input_tokens"]) ?? num(a["gen_ai.usage.prompt_tokens"]);
      const tout = num(a["gen_ai.usage.output_tokens"]) ?? num(a["gen_ai.usage.completion_tokens"]);
      const cacheRead = num(a["gen_ai.usage.cache_read.input_tokens"]);
      const cacheWrite = num(a["gen_ai.usage.cache_creation.input_tokens"]);
      const finish = a["gen_ai.response.finish_reasons"];
      out.push(
        base(
          "llm",
          "llm.call",
          span.endMs,
          ctx,
          {
            provider: str(a["gen_ai.provider.name"]) ?? str(a["gen_ai.system"]),
            operation: op ?? "chat",
            duration_ms: Math.max(0, span.endMs - span.startMs),
            finish_reason: Array.isArray(finish) ? str(finish[0]) : str(finish),
            input: this.content(a["gen_ai.input.messages"]),
            output: this.content(a["gen_ai.output.messages"]),
          },
          {
            tokens_in: tin,
            tokens_out: tout,
            tokens_cache_read: cacheRead || undefined,
            tokens_cache_write: cacheWrite || undefined,
            model: model?.slice(0, 256),
            summary: `${model ?? "model"} replied`,
          },
        ),
      );
      if (span.status.code === 2) out.push(base("llm-err", "error", span.endMs, ctx, errorData(span)));
    }

    if (isTool) {
      const tool = (str(a["gen_ai.tool.name"]) ?? span.name).slice(0, 256);
      const callId = (str(a["gen_ai.tool.call.id"]) ?? span.spanId).slice(0, 128);
      const ok = span.status.code !== 2;
      if (ctx.agentId) out.push(base("tool-status", "agent.status", span.startMs, ctx, { status: "using_tool", detail: tool }));
      const args = a["gen_ai.tool.call.arguments"];
      out.push(
        base(
          "tool-call",
          "tool.call",
          span.startMs,
          ctx,
          { tool_name: tool, call_id: callId, arguments: this.content(args), arguments_hash: args !== undefined && args !== null ? hashArguments(args) : undefined },
          { summary: `${tool}()` },
        ),
      );
      out.push(
        base("tool-result", "tool.result", span.endMs, ctx, {
          tool_name: tool,
          call_id: callId,
          ok,
          duration_ms: Math.max(0, span.endMs - span.startMs),
          error: ok ? undefined : (span.status.message ?? "error").slice(0, 2000),
          result: ok ? this.content(a["gen_ai.tool.call.result"]) : undefined,
        }),
      );
      if (ctx.agentId) out.push(base("tool-done", "agent.status", span.endMs, ctx, { status: "thinking" }));
    }

    // AgentSpace-specific span events, plus standard exception events.
    span.events.forEach((ev, i) => {
      if (ev.name === "agentspace.handoff") {
        const to = slug(str(ev.attributes["to_agent"]) ?? str(ev.attributes["agentspace.to_agent"]));
        if (to && ctx.agentId) out.push(base(`ev${i}`, "handoff", ev.timeMs, ctx, { from_agent_id: ctx.agentId, to_agent_id: to, reason: str(ev.attributes["reason"]) }));
      } else if (ev.name === "agentspace.status") {
        const status = str(ev.attributes["status"]);
        if (status && ctx.agentId && STATUSES.has(status)) out.push(base(`ev${i}`, "agent.status", ev.timeMs, ctx, { status, detail: str(ev.attributes["detail"])?.slice(0, 500) }));
      } else if (ev.name === "exception" && !isAgent && !isLlm) {
        out.push(
          base(`ev${i}`, "error", ev.timeMs, ctx, {
            message: (str(ev.attributes["exception.message"]) ?? "exception").slice(0, 2000),
            kind: str(ev.attributes["exception.type"])?.slice(0, 256),
          }),
        );
      }
    });

    if (!span.parentSpanId) {
      const run: Ctx = { agentId: null, teamId: null, stepId: null };
      out.push(
        base("run-start", "run.started", span.startMs, run, {
          name: (str(a["gen_ai.workflow.name"]) ?? span.name).slice(0, 256),
          framework: str(span.resource["telemetry.sdk.name"]) ?? "opentelemetry",
        }),
        base("run-end", "run.finished", span.endMs, run, { status: span.status.code === 2 ? "error" : "ok", duration_ms: Math.max(0, span.endMs - span.startMs) }),
      );
    }

    this.remember(span.spanId, ctx);
    return out;
  }

  private content(v: AttrValue | undefined): AttrValue | undefined {
    if (!this.captureContent || v === undefined || v === null) return undefined;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as AttrValue; // gen_ai.*.messages are often JSON-encoded strings
      } catch {
        return v.slice(0, 16_000);
      }
    }
    return v;
  }
}

function isAgentSpan(a: Attrs): boolean {
  const op = str(a["gen_ai.operation.name"]);
  if (op !== undefined && AGENT_OPS.has(op)) return true;
  if (op !== undefined && (LLM_OPS.has(op) || op === "execute_tool")) return false;
  return a["gen_ai.agent.name"] !== undefined || a["gen_ai.agent.id"] !== undefined;
}

const STATUSES = new Set(["idle", "thinking", "using_tool", "waiting", "blocked", "waiting_human", "done", "error"]);

function errorData(span: OtlpSpan) {
  const exc = span.events.find((e) => e.name === "exception");
  return {
    message: (str(exc?.attributes["exception.message"]) ?? span.status.message ?? "error").slice(0, 2000),
    kind: str(exc?.attributes["exception.type"])?.slice(0, 256),
  };
}

function str(v: AttrValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function num(v: AttrValue | undefined): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Same rule as the Python SDK's slugify: "QA Engineer" -> "qa-engineer". */
export function slug(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "agent").slice(0, 128);
}

function iso(ms: number): string {
  return new Date(ms > 0 ? ms : Date.now()).toISOString();
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
}

export type { Attrs };
