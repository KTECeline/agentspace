/**
 * AgentSpace TypeScript SDK: a live office for your AI agent teams.
 *
 *   import * as agentspace from "agentspace-sdk";
 *   agentspace.init();
 *   await agentspace.agent({ name: "Researcher", team: "research" }, async () => { ... });
 *
 * Rules (same as the Python SDK): every call catches its own errors, user errors propagate
 * unchanged, nothing blocks, memory is bounded, and before init() everything is a no-op.
 */
import type { AgentSpaceEvent, AgentStatus, EventType } from "./spec.js";
import { current, withCtx, type Ctx } from "./context.js";
import { internalError, warnLimited } from "./log.js";
import { parsePolicy } from "../../spec-types/src/policy.js";
import { Transport } from "./transport.js";
import * as control from "./control.js";
import { isCancelled, type ApprovalOptions, type ApprovalResult, type CancelMode, type ControlState } from "./control.js";
import * as oversight from "./oversight.js";
import type { GuardOptions, OversightHost, Policy, PolicyDecision } from "./oversight.js";
import type { SourcedPolicy } from "../../spec-types/src/policy.js";
import { isPromiseLike, newId, nowIso, slugify, truncate } from "./util.js";

export type { AgentSpaceEvent, AgentStatus, EventType } from "./spec.js";
export { hasAsyncContext } from "./context.js";
export { Cancelled, isCancelled } from "./control.js";
export { PolicyDenied, isPolicyDenied } from "./oversight.js";
export type { GuardOptions, Policy, PolicyDecision, PolicyOutcome } from "./oversight.js";
export { hashArguments } from "./hash.js";
export type { ApprovalOptions, ApprovalResult, CancelMode, Decision } from "./control.js";

export const SPEC_VERSION = "0.1";
export const DEFAULT_URL = "http://localhost:4800";

/** `redact(field, value) => value`; return undefined/null to drop the value. */
export type RedactHook = (field: string, value: unknown) => unknown;

export interface InitOptions {
  /** Collector base URL. Env: AGENTSPACE_URL. Default http://localhost:4800. */
  url?: string;
  /** Env: AGENTSPACE_WORKSPACE. Default "default". */
  workspace?: string;
  /** Env: AGENTSPACE_API_KEY. */
  apiKey?: string;
  /** Send full prompts/outputs/arguments. Off by default. */
  captureContent?: boolean;
  redact?: RedactHook;
  /** false (or env AGENTSPACE_DISABLED=1) makes every call a no-op. */
  enabled?: boolean;
  maxQueue?: number;
  maxBatch?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxContentChars?: number;
  /** What an operator's cancel does at a safe point: throw `Cancelled` ("raise", default) or
   * just flag the run (poll `runCancelled()`). */
  cancelMode?: CancelMode;
  /** An oversight policy for tool calls (see `guardTool()` and the policy docs). Combined with
   * the collector's; the stricter result wins. An invalid policy is logged and replaced by
   * `{ default: "review" }` (fails closed). */
  policy?: Policy;
}

export interface AgentOptions {
  name: string;
  team?: string;
  role?: string;
  description?: string;
}

interface AgentInfo {
  agentId: string;
  name: string;
  teamId: string | null;
  role?: string;
  description?: string;
  framework: string;
}

type EnvelopeExtras = Partial<Pick<AgentSpaceEvent, "tokens_in" | "tokens_out" | "tokens_cache_read" | "tokens_cache_write" | "cost_usd" | "cost_source" | "model" | "summary" | "attributes">>;
export interface EmitFields extends EnvelopeExtras {
  runId?: string;
  agentId?: string | null;
  teamId?: string | null;
  parentId?: string | null;
}

const POLL_INTERVAL_MS = 2000;
const ACTIVE_RUN_MS = 60_000;
/** How often the collector's policy is re-read, and how soon a failed first read is retried. */
const POLICY_REFRESH_MS = 30_000;
const POLICY_RETRY_MS = 10_000;

type ClientOptions = Required<Omit<InitOptions, "apiKey" | "redact" | "policy">> & Pick<InitOptions, "apiKey" | "redact" | "policy">;

class Client implements OversightHost {
  readonly transport: Transport | null;
  readonly controls = new Map<string, ControlState>();
  readonly cancelAnnounced = new Set<string>();
  /** Runs with detector findings: policy rules' on_findings apply to them. Only grows. */
  readonly escalated = new Set<string>();
  /** The collector's policy (null: it has none, or not fetched yet). */
  private collectorPolicy: Policy | null = null;
  private policyFetched = false;
  private policyTriedAt = -Infinity;
  private activeRuns = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private agents = new Map<string, AgentInfo>();
  private registered = new Set<string>();
  private defaultRunId: string | null = null;
  private defaultRunStart = 0;
  private closed = false;

  constructor(readonly opts: ClientOptions) {
    this.transport = opts.enabled
      ? new Transport({
          endpoint: opts.url.replace(/\/$/, "") + "/v1/events",
          apiKey: opts.apiKey,
          maxQueue: opts.maxQueue,
          maxBatch: opts.maxBatch,
          flushIntervalMs: opts.flushIntervalMs,
          timeoutMs: opts.timeoutMs,
          onControls: (c) => {
            for (const [runId, state] of Object.entries(c)) control.applyControl(this, runId, state);
          },
          onEscalated: (runs) => this.applyEscalated(runs),
        })
      : null;
    if (this.transport) {
      // Runs that go quiet (e.g. waiting on a slow tool) still learn about pause / cancel.
      this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
  }

  get url() {
    return this.opts.url;
  }
  get workspace() {
    return this.opts.workspace;
  }
  get apiKey() {
    return this.opts.apiKey;
  }
  get cancelMode() {
    return this.opts.cancelMode;
  }
  get enabled() {
    return this.transport !== null && !this.closed;
  }
  currentRunId(): string | undefined {
    return current().runId ?? this.defaultRunId ?? undefined;
  }
  currentAgentId(): string | undefined {
    return current().agent?.agentId;
  }
  flush(timeoutMs: number): Promise<boolean> {
    return this.transport ? this.transport.flush(timeoutMs) : Promise.resolve(true);
  }

  teamOf(agentId: string | undefined): string | null {
    if (!agentId) return null;
    const ctx = current().agent;
    return ctx && ctx.agentId === agentId ? ctx.teamId : (this.agents.get(agentId)?.teamId ?? null);
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const [rid, seen] of this.activeRuns) if (now - seen > ACTIVE_RUN_MS) this.activeRuns.delete(rid);
    if (now - this.policyTriedAt >= POLICY_REFRESH_MS) await this.refreshPolicy();
    await control.pollControls(this, [...this.activeRuns.keys()].slice(0, 50));
  }

  // ---- policy (D-045) ----

  private applyEscalated(runs: unknown[]): void {
    for (const r of runs) if (typeof r === "string") this.escalated.add(r);
  }

  /** Code first, then the collector's: the order ties are broken in. */
  policies(): SourcedPolicy[] {
    const out: SourcedPolicy[] = [];
    if (this.opts.policy) out.push({ source: "code", policy: this.opts.policy });
    if (this.collectorPolicy) out.push({ source: "collector", policy: this.collectorPolicy });
    return out;
  }

  /** Fetch the collector's policy and the escalated runs among active ones. Never throws. */
  async refreshPolicy(timeoutMs = 2000): Promise<boolean> {
    this.policyTriedAt = Date.now();
    if (!this.enabled) return false;
    const runs = [...this.activeRuns.keys()].slice(0, 100).map(encodeURIComponent).join(",");
    try {
      const { status, body } = await control.api(this, "GET", `/v1/workspaces/${encodeURIComponent(this.workspace)}/policy?runs=${runs}`, timeoutMs);
      if (status !== 200 || !body || typeof body !== "object") return false;
      const b = body as { policy?: unknown; escalated?: unknown };
      if (b.policy === null || b.policy === undefined) this.collectorPolicy = null;
      else {
        const parsed = parsePolicy(b.policy);
        // A newer collector may know settings we don't: keep the last good one.
        if (parsed.ok) this.collectorPolicy = parsed.policy;
        else warnLimited("policy-invalid", `ignoring the collector's policy: ${parsed.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")}`);
      }
      this.policyFetched = true;
      if (Array.isArray(b.escalated)) this.applyEscalated(b.escalated);
      return true;
    } catch (err) {
      if (!(err instanceof control.CollectorError)) internalError("refreshPolicy", err);
      return false;
    }
  }

  /** Before the first guarded tool call, fetch the collector's policy once (1 s at most). */
  async ensurePolicy(): Promise<void> {
    if (!this.policyFetched && Date.now() - this.policyTriedAt > POLICY_RETRY_MS) await this.refreshPolicy(1000);
  }

  /** Like content(), but ignores captureContent (used for approval payloads a person reviews). */
  redactValue(field: string, value: unknown): unknown {
    if (value === undefined || value === null) return undefined;
    try {
      let v: unknown = value;
      if (this.opts.redact) {
        v = this.opts.redact(field, v);
        if (v === undefined || v === null) return undefined;
      }
      if (typeof v === "string") return truncate(v, this.opts.maxContentChars);
      const s = JSON.stringify(v);
      return s.length > this.opts.maxContentChars ? truncate(s, this.opts.maxContentChars) : JSON.parse(s);
    } catch (err) {
      internalError("redact", err);
      return undefined;
    }
  }

  emit(type: EventType, data: Record<string, unknown> = {}, f: EmitFields = {}): string | null {
    if (!this.transport || this.closed) return null;
    const ctx = current();
    const agentId = f.agentId !== undefined ? f.agentId : (ctx.agent?.agentId ?? null);
    const teamId = f.teamId !== undefined ? f.teamId : ctx.agent && ctx.agent.agentId === agentId ? ctx.agent.teamId : (this.agents.get(agentId ?? "")?.teamId ?? null);
    const parentId = f.parentId !== undefined ? f.parentId : (ctx.stepId ?? null);
    const runId = f.runId ?? ctx.runId ?? this.defaultRun();
    if (agentId) this.ensureRegistered(runId, agentId);
    this.activeRuns.set(runId, Date.now());

    const id = newId();
    const ev: Record<string, unknown> = {
      spec_version: SPEC_VERSION,
      id,
      type,
      ts: nowIso(),
      workspace: this.opts.workspace,
      run_id: runId,
      agent_id: agentId,
      team_id: teamId,
      parent_id: parentId,
      data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null)),
    };
    for (const key of ["tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "cost_usd", "cost_source", "model", "summary", "attributes"] as const) {
      if (f[key] !== undefined && f[key] !== null) ev[key] = f[key];
    }
    if (typeof ev.summary === "string") ev.summary = truncate(ev.summary, 500);
    if (typeof ev.model === "string") ev.model = truncate(ev.model, 256);
    this.transport.put(ev);
    return id;
  }

  content(field: string, value: unknown): unknown {
    if (!this.opts.captureContent || value === undefined || value === null) return undefined;
    try {
      let v: unknown = value;
      if (this.opts.redact) {
        v = this.opts.redact(field, v);
        if (v === undefined || v === null) return undefined;
      }
      if (typeof v === "string") return truncate(v, this.opts.maxContentChars);
      const s = JSON.stringify(v);
      return s.length > this.opts.maxContentChars ? truncate(s, this.opts.maxContentChars) : JSON.parse(s);
    } catch (err) {
      internalError("content/redact", err);
      return undefined;
    }
  }

  upsertAgent(info: AgentInfo): void {
    const known = this.agents.get(info.agentId);
    if (!known || JSON.stringify(known) !== JSON.stringify(info)) {
      this.agents.set(info.agentId, info);
      for (const k of [...this.registered]) if (k.endsWith(`\u0000${info.agentId}`)) this.registered.delete(k);
    }
  }

  private ensureRegistered(runId: string, agentId: string): void {
    const key = `${runId}\u0000${agentId}`;
    if (this.registered.has(key)) return;
    this.registered.add(key);
    const info = this.agents.get(agentId) ?? { agentId, name: agentId, teamId: null, framework: "manual" };
    this.emit(
      "agent.registered",
      { name: info.name, team_name: info.teamId ?? undefined, role: info.role, description: info.description, framework: info.framework },
      { runId, agentId, teamId: info.teamId, parentId: null },
    );
  }

  private defaultRun(): string {
    if (!this.defaultRunId) {
      this.defaultRunId = newId();
      this.defaultRunStart = Date.now();
      this.emit("run.started", { name: "session" }, { runId: this.defaultRunId, agentId: null, teamId: null, parentId: null });
    }
    return this.defaultRunId;
  }

  async shutdown(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    if (this.defaultRunId) {
      this.emit("run.finished", { status: "ok", duration_ms: Date.now() - this.defaultRunStart }, { runId: this.defaultRunId, agentId: null, teamId: null, parentId: null });
    }
    this.closed = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    await this.transport?.shutdown(timeoutMs);
  }
}

let client: Client | null = null;
let exitHookInstalled = false;

function env(name: string): string | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  } catch {
    return undefined;
  }
}

/** Start sending events to an AgentSpace collector. Safe to call more than once. */
export function init(options: InitOptions = {}): void {
  try {
    const disabled = ["1", "true", "yes"].includes((env("AGENTSPACE_DISABLED") ?? "").toLowerCase());
    const previous = client;
    client = new Client({
      url: options.url ?? env("AGENTSPACE_URL") ?? DEFAULT_URL,
      workspace: options.workspace ?? env("AGENTSPACE_WORKSPACE") ?? "default",
      apiKey: options.apiKey ?? env("AGENTSPACE_API_KEY"),
      captureContent: options.captureContent ?? false,
      redact: options.redact,
      enabled: options.enabled ?? !disabled,
      maxQueue: options.maxQueue ?? 10_000,
      maxBatch: options.maxBatch ?? 100,
      flushIntervalMs: options.flushIntervalMs ?? 200,
      timeoutMs: options.timeoutMs ?? 2000,
      maxContentChars: options.maxContentChars ?? 16_000,
      cancelMode: options.cancelMode ?? "raise",
      policy: options.policy === undefined ? undefined : oversight.loadPolicy(options.policy),
    });
    if (previous) void previous.shutdown(500);
    installExitHook();
  } catch (err) {
    internalError("init", err);
  }
}

/** Flush once when Node is about to exit, so short scripts don't lose their last events. */
function installExitHook(): void {
  const proc = (globalThis as { process?: { once?: (ev: string, fn: () => void) => void } }).process;
  if (exitHookInstalled || !proc?.once) return;
  exitHookInstalled = true;
  proc.once("beforeExit", () => {
    void client?.shutdown(2000);
  });
}

export function isInitialized(): boolean {
  return client !== null;
}

/** Wait until queued events are sent. Resolves false on timeout or when the collector is down. */
export async function flush(timeoutMs = 2000): Promise<boolean> {
  try {
    return client?.transport ? await client.transport.flush(timeoutMs) : true;
  } catch (err) {
    internalError("flush", err);
    return false;
  }
}

/** Flush and stop. */
export async function shutdown(timeoutMs = 2000): Promise<void> {
  try {
    const c = client;
    client = null;
    await c?.shutdown(timeoutMs);
  } catch (err) {
    internalError("shutdown", err);
  }
}

export function stats(): { sent: number; dropped: number; rejected: number; pending: number } {
  const t = client?.transport;
  return t ? { sent: t.sent, dropped: t.dropped, rejected: t.rejected, pending: t.pending } : { sent: 0, dropped: 0, rejected: 0, pending: 0 };
}

/** Emit a raw spec event. Envelope fields default to the current run/agent/step. */
export function emit(type: EventType, data?: Record<string, unknown>, fields?: EmitFields): string | null {
  try {
    return client ? client.emit(type, data, fields) : null;
  } catch (err) {
    internalError("emit", err);
    return null;
  }
}

/** Set the current agent's status (shown on its desk in the office). */
export function setStatus(status: AgentStatus, detail?: string, fields?: EmitFields): void {
  emit("agent.status", { status, detail: detail ? truncate(detail, 500) : undefined }, fields);
}

/** Record that work is being handed to another agent (by name or id). */
export function handoff(to: string, reason?: string, fromAgent?: string): void {
  const src = fromAgent ? slugify(fromAgent) : current().agent?.agentId;
  if (!src) return;
  emit("handoff", { from_agent_id: src, to_agent_id: slugify(to), reason: reason ? truncate(reason, 500) : undefined }, { agentId: src, summary: `handed off to ${to}` });
}

/** Content for a spec content field, or undefined when captureContent is off. */
export function content(field: string, value: unknown): unknown {
  return client?.content(field, value);
}

// ---------------------------------------------------------------------------
// Scopes. Each runs `fn` inside a context and emits start/end events. Works for sync and async
// functions; the return value (or promise) is passed through untouched.
// ---------------------------------------------------------------------------

function errorData(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { message: truncate(e.message || e.name, 2000), kind: e.name, stack: e.stack ? truncate(e.stack, 16_000) : undefined };
}

/**
 * Runs `start` (safely), then `fn` inside `ctx`, then `end(error?)` (safely) when fn finishes,
 * whether it returns, throws, resolves or rejects. User results and errors are passed through.
 */
function scoped<T>(ctx: Ctx | null, start: () => void, end: (err?: unknown) => void, fn: () => T): T {
  const safe = (f: () => void, where: string) => {
    try {
      f();
    } catch (err) {
      internalError(where, err);
    }
  };
  if (!client || !ctx) return fn();
  return withCtx(ctx, () => {
    safe(start, "scope.start");
    let result: T;
    try {
      result = fn();
    } catch (err) {
      safe(() => end(err), "scope.end");
      throw err;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (v) => {
          safe(() => end(), "scope.end");
          return v;
        },
        (err: unknown) => {
          safe(() => end(err), "scope.end");
          throw err;
        },
      ) as T;
    }
    safe(() => end(), "scope.end");
    return result;
  });
}

export interface RunOptions {
  runId?: string;
  framework?: string;
  input?: unknown;
}

/** A run: one end-to-end task. Everything inside shares a run id. */
export function run<T>(name: string, fn: () => T, opts: RunOptions = {}): T {
  const runId = opts.runId ?? newId();
  const t0 = Date.now();
  const none = { runId, agentId: null, teamId: null, parentId: null };
  return scoped(
    client ? { runId, agent: undefined, stepId: undefined } : null,
    () => client?.emit("run.started", { name, framework: opts.framework, input: client.content("run.input", opts.input) }, { ...none, summary: name }),
    (err) => {
      const cancelled = isCancelled(err);
      if (err !== undefined && !cancelled) client?.emit("error", errorData(err), none); // a cancel is not an error
      client?.emit("run.finished", { status: cancelled ? "cancelled" : err !== undefined ? "error" : "ok", duration_ms: Date.now() - t0 }, none);
    },
    fn,
  );
}

/** A unit of work inside an agent. Child events point at it via parent_id. */
export function step<T>(name: string, fn: () => T, kind: "agent" | "chain" | "custom" = "custom"): T {
  const stepId = newId();
  const t0 = Date.now();
  const parent = current().stepId ?? null;
  const label = truncate(name, 256);
  control.cancelPoint(client); // a safe point: throws Cancelled once the run is cancelled
  return scoped(
    client ? { stepId } : null,
    () => emit("step.started", { step_id: stepId, name: label, kind }, { parentId: parent }),
    (err) =>
      emit(
        "step.finished",
        { step_id: stepId, name: label, ok: err === undefined, duration_ms: Date.now() - t0, error: isCancelled(err) ? "cancelled" : err !== undefined ? truncate(String(err), 2000) : undefined },
        { parentId: parent },
      ),
    fn,
  );
}

/**
 * Run `fn` as an agent. Registers it, opens an agent step, and tracks its status. Calling one
 * agent from inside another records a handoff.
 */
export function agent<T>(options: AgentOptions | string, fn: () => T): T {
  const o = typeof options === "string" ? { name: options } : options;
  const info: AgentInfo = {
    agentId: slugify(o.name),
    name: o.name,
    teamId: o.team ? slugify(o.team) : null,
    role: o.role,
    description: o.description,
    framework: "manual",
  };
  const outer = current().agent;
  const stepId = newId();
  const parent = current().stepId ?? null;
  const t0 = Date.now();
  control.cancelPoint(client); // a safe point: throws Cancelled once the run is cancelled
  return scoped(
    client ? { agent: { agentId: info.agentId, teamId: info.teamId }, stepId } : null,
    () => {
      client?.upsertAgent(info);
      if (outer && outer.agentId !== info.agentId) handoff(info.agentId, undefined, outer.agentId);
      emit("step.started", { step_id: stepId, name: info.name, kind: "agent" }, { parentId: parent });
      setStatus("thinking");
    },
    (err) => {
      if (isCancelled(err)) setStatus("done", "cancelled by an operator");
      else if (err !== undefined) {
        emit("error", errorData(err), { summary: truncate(`${errorData(err).kind}: ${errorData(err).message}`, 500) });
        setStatus("error", String(err));
      } else setStatus("done");
      emit(
        "step.finished",
        { step_id: stepId, name: info.name, ok: err === undefined, duration_ms: Date.now() - t0, error: isCancelled(err) ? "cancelled" : err !== undefined ? truncate(String(err), 2000) : undefined },
        { parentId: parent },
      );
    },
    fn,
  );
}

/** Wrap a function so every call runs as the given agent. */
export function wrapAgent<A extends unknown[], R>(options: AgentOptions | string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => agent(options, () => fn(...args));
}

// ---------------------------------------------------------------------------
// Two-way control: approvals and pause / resume / cancel. See control.ts for the semantics.
// ---------------------------------------------------------------------------

/**
 * Ask a person in the office to approve something, and wait for their decision. Fails closed:
 * resolves "approved" only if a person approved before `timeoutMs` (default 5 minutes); never
 * rejects. Throws `Cancelled` if the run is cancelled while waiting (raise mode).
 */
export function requestApproval(reason: string, payload?: unknown, opts?: ApprovalOptions): Promise<ApprovalResult> {
  return control.requestApproval(client, reason, payload, opts);
}

/**
 * A safe point to pause or stop: waits while the run is paused (showing "blocked"), then
 * throws `Cancelled` (raise mode) or resolves false (flag mode) once it's cancelled. Resolves
 * true to keep going. Call it inside your own loops; `agent()` and `step()` check for cancel.
 */
export async function checkpoint(runId?: string): Promise<boolean> {
  try {
    return await control.checkpoint(client, runId);
  } catch (err) {
    if (isCancelled(err)) throw err;
    internalError("checkpoint", err);
    return true;
  }
}

/**
 * Check a tool call against the oversight policy before it runs (D-045). Resolves with the
 * decision when the call may go ahead (allowed, or approved by a person). Throws `PolicyDenied`
 * when it's blocked, rejected or not approved in time: its message is written for the model, so
 * hand it back as the tool's error. A review waits for a person (default up to 5 minutes).
 */
export async function guardTool(tool: string, args?: unknown, opts?: GuardOptions): Promise<PolicyDecision> {
  return oversight.guardTool(client, tool, args, opts);
}

/** True once an operator cancelled the current (or given) run. */
export function runCancelled(runId?: string): boolean {
  const rid = runId ?? client?.currentRunId();
  return !!(client && rid && client.controls.get(rid) === "cancelled");
}

