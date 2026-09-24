/**
 * Two-way control: human approvals, and pause / resume / cancel from the office.
 *
 * Approvals fail closed: `requestApproval` resolves "approved" only when a person approved in
 * time. If AgentSpace isn't initialized, the collector can't be reached, or the deadline
 * passes, it resolves "rejected" or "timeout". It never waits past its timeout, and never
 * rejects its promise.
 *
 * Cancel throws `Cancelled` at the next safe point (an `agent()` / `step()` scope start or an
 * `await checkpoint()`). JavaScript has no BaseException, so a catch-all `catch (e) {}` can
 * swallow it: rethrow when `isCancelled(e)`. With `cancelMode: "flag"` nothing is thrown;
 * poll `runCancelled()` instead. Pausing needs an `await`, so it happens at `checkpoint()`.
 */
import { warnLimited } from "./log.js";
import { newId, truncate } from "./util.js";

export type Decision = "approved" | "rejected" | "timeout";
export type CancelMode = "raise" | "flag";
export type ControlState = "paused" | "cancelled";

/** An operator cancelled this run in the office. */
export class Cancelled extends Error {
  override readonly name = "Cancelled";
  constructor(readonly runId?: string) {
    super(runId ? `run ${runId} was cancelled by an operator` : "cancelled");
  }
}

/** True for a `Cancelled` error (use it to rethrow from catch-all blocks). */
export function isCancelled(err: unknown): err is Cancelled {
  return err instanceof Cancelled || (err instanceof Error && err.name === "Cancelled");
}

export interface ApprovalResult {
  decision: Decision;
  approvalId: string;
  approved: boolean;
  comment?: string;
  resolvedBy?: string;
  /** Why the request failed closed (collector unreachable, not initialized, ...), if it did. */
  error?: string;
}

export interface ApprovalOptions {
  /** Default 300 000 (5 minutes). */
  timeoutMs?: number;
  runId?: string;
  agentId?: string;
  teamId?: string | null;
}

/** What the control code needs from the SDK client. */
export interface ControlHost {
  readonly url: string;
  readonly workspace: string;
  readonly apiKey?: string;
  readonly cancelMode: CancelMode;
  readonly controls: Map<string, ControlState>;
  readonly cancelAnnounced: Set<string>;
  readonly enabled: boolean;
  emit(type: string, data: Record<string, unknown>, fields: Record<string, unknown>): string | null;
  flush(timeoutMs: number): Promise<boolean>;
  redactValue(field: string, value: unknown): unknown;
  currentRunId(): string | undefined;
  currentAgentId(): string | undefined;
}

export const POLL_WAIT_S = 25;
const MAX_NETWORK_FAILURES = 3;

class CollectorError extends Error {}

async function api(host: ControlHost, method: string, path: string, timeoutMs: number, body?: unknown): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "agentspace-ts" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (host.apiKey) headers.authorization = `Bearer ${host.apiKey}`;
  let res: Response;
  try {
    res = await fetch(host.url.replace(/\/$/, "") + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CollectorError(String(err));
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // empty or non-JSON body
  }
  return { status: res.status, body: parsed };
}

const ws = (host: ControlHost) => encodeURIComponent(host.workspace);
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
  });

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function requestApproval(host: ControlHost | null, reason: string, payload: unknown, opts: ApprovalOptions = {}): Promise<ApprovalResult> {
  const approvalId = newId();
  const result = (decision: Decision, extra: Partial<ApprovalResult> = {}): ApprovalResult => ({ decision, approvalId, approved: decision === "approved", ...extra });
  if (!host || !host.enabled) {
    warnLimited("approval-no-init", "requestApproval called before init(); rejecting (fails closed)");
    return result("rejected", { error: "agentspace is not initialized" });
  }
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 300_000);
  const deadline = Date.now() + timeoutMs;
  const who: Record<string, unknown> = {};
  if (opts.runId) who.runId = opts.runId;
  if (opts.agentId) {
    who.agentId = opts.agentId;
    who.teamId = opts.teamId ?? null;
  }
  const show = (status: string, detail?: string) => host.emit("agent.status", { status, detail }, who);
  const runId = opts.runId ?? host.currentRunId();

  try {
    host.emit(
      "approval.requested",
      {
        approval_id: approvalId,
        reason: truncate(String(reason), 2000),
        // The payload is what the person reviews, so it's sent even without captureContent,
        // but it still goes through your redact hook.
        payload: host.redactValue("approval.payload", payload),
        timeout_s: timeoutMs / 1000,
      },
      { ...who, summary: truncate(`needs approval: ${reason}`, 500) },
    );
    show("waiting_human", truncate(String(reason), 500));
    if (!(await host.flush(Math.min(5000, Math.max(500, timeoutMs))))) {
      show("thinking");
      return result("rejected", { error: "collector unreachable" });
    }
  } catch (err) {
    warnLimited("approval-internal", `internal error in requestApproval: ${String(err)}`);
    return result("rejected", { error: "internal error" });
  }

  const path = `/v1/workspaces/${ws(host)}/approvals/${approvalId}`;
  let failures = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result("timeout");
      if (runId && host.controls.get(runId) === "cancelled" && host.cancelMode === "raise") throw new Cancelled(runId);
      const wait = Math.floor(Math.min(POLL_WAIT_S, Math.max(1, remaining / 1000)));
      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await api(host, "GET", `${path}?wait=${wait}`, (wait + 5) * 1000));
      } catch (err) {
        if (!(err instanceof CollectorError)) throw err;
        if (++failures >= MAX_NETWORK_FAILURES) {
          warnLimited("approval-down", `approval ${approvalId} failed closed: collector unreachable (${err.message})`);
          return result("rejected", { error: "collector unreachable" });
        }
        await sleep(Math.min(500 * 2 ** failures, deadline - Date.now()));
        continue;
      }
      if (status === 200 && body && typeof body === "object") {
        failures = 0;
        const b = body as { status?: string; comment?: string | null; resolved_by?: string | null };
        if (b.status === "approved" || b.status === "rejected" || b.status === "timeout") {
          return result(b.status, { comment: b.comment ?? undefined, resolvedBy: b.resolved_by ?? undefined });
        }
        continue; // still pending
      }
      if (status === 401 || status === 403) return result("rejected", { error: `not authorized to read approvals (HTTP ${status})` });
      if (++failures >= MAX_NETWORK_FAILURES) return result("rejected", { error: `collector answered HTTP ${status}` });
      await sleep(500);
    }
  } finally {
    show("thinking");
  }
}

// ---------------------------------------------------------------------------
// Pause / resume / cancel
// ---------------------------------------------------------------------------

function announce(host: ControlHost, status: string, detail: string, who?: Record<string, unknown>): void {
  if (who?.agentId) host.emit("agent.status", { status, detail }, who);
  else if (host.currentAgentId()) host.emit("agent.status", { status, detail }, {});
}

/** In raise mode the error unwinds through agent() scopes, which mark agents "done
 * (cancelled)" themselves; only flag mode needs to announce it here. */
function cancelled(host: ControlHost, runId: string, who?: Record<string, unknown>): false {
  if (host.cancelMode === "raise") throw new Cancelled(runId);
  if (!host.cancelAnnounced.has(runId)) {
    host.cancelAnnounced.add(runId);
    announce(host, "done", "cancelled by an operator", who);
  }
  return false;
}

/** Synchronous safe point: throws `Cancelled` (raise mode) or returns false once cancelled. */
export function cancelPoint(host: ControlHost | null, runId?: string, who?: Record<string, unknown>): boolean {
  if (!host || !host.enabled) return true;
  const rid = runId ?? host.currentRunId();
  if (rid && host.controls.get(rid) === "cancelled") return cancelled(host, rid, who);
  return true;
}

/** Async safe point: waits while paused, then behaves like `cancelPoint`. */
export async function checkpoint(host: ControlHost | null, runId?: string, who?: Record<string, unknown>): Promise<boolean> {
  if (!host || !host.enabled) return true;
  const rid = runId ?? host.currentRunId();
  if (!rid) return true;
  if (host.controls.get(rid) === "paused") await waitWhilePaused(host, rid, who);
  return cancelPoint(host, rid, who);
}

async function waitWhilePaused(host: ControlHost, runId: string, who?: Record<string, unknown>): Promise<void> {
  announce(host, "blocked", "paused by an operator", who);
  const path = `/v1/workspaces/${ws(host)}/controls?runs=${encodeURIComponent(runId)}&wait=${POLL_WAIT_S}`;
  while (host.controls.get(runId) === "paused") {
    try {
      const { status, body } = await api(host, "GET", path, (POLL_WAIT_S + 5) * 1000);
      if (status === 200 && body && typeof body === "object") {
        const state = (body as Record<string, string>)[runId];
        if (state === "paused" || state === "cancelled") host.controls.set(runId, state);
        else host.controls.delete(runId);
        continue;
      }
    } catch (err) {
      if (!(err instanceof CollectorError)) throw err;
      warnLimited("paused-unreachable", "run is paused but the collector is unreachable; still paused");
    }
    await sleep(2000);
  }
  if (host.controls.get(runId) !== "cancelled") announce(host, "thinking", "resumed", who);
}

/** Ask the collector about recently active runs (so idle runs learn about pause/cancel). */
export async function pollControls(host: ControlHost, runIds: string[]): Promise<void> {
  if (!runIds.length) return;
  const query = runIds.map(encodeURIComponent).join(",");
  try {
    const { status, body } = await api(host, "GET", `/v1/workspaces/${ws(host)}/controls?runs=${query}`, 2000);
    if (status !== 200 || !body || typeof body !== "object") return;
    for (const rid of runIds) {
      const state = (body as Record<string, string>)[rid];
      if (state === "paused" || state === "cancelled") applyControl(host, rid, state);
      else if (host.controls.get(rid) === "paused") host.controls.delete(rid); // resumed
    }
  } catch {
    // collector down: try again next tick
  }
}

export function applyControl(host: ControlHost, runId: string, state: string): void {
  if ((state === "paused" || state === "cancelled") && host.controls.get(runId) !== "cancelled") host.controls.set(runId, state);
}
