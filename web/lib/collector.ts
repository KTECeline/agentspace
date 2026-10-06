import type { ApprovalState, PriceTable, RunState, ServerInfo, StatsResponse, StoredEvent } from "@agentspace/spec-types";

/**
 * The collector's REST API for operator actions (approve, pause, cancel), plus the operator
 * token kept in this browser. The token is only ever sent to the collector.
 */

const TOKEN_KEY = "agentspace.operatorToken";

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null; // private mode, blocked storage, SSR
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // the token then lasts only for this page
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

async function call<T>(base: string, path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(base.replace(/\/$/, "") + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "Can’t reach the collector.");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  return body as T;
}

export function fetchInfo(base: string): Promise<ServerInfo> {
  return call<ServerInfo>(base, "/v1/info", null);
}

const ws = (workspace: string) => encodeURIComponent(workspace);

export function fetchStats(base: string, workspace: string, since: string | null, token: string | null): Promise<StatsResponse> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return call(base, `/v1/workspaces/${ws(workspace)}/stats${q}`, token);
}

/** Most recent runs first. */
export function fetchRuns(base: string, workspace: string, token: string | null, limit = 200): Promise<RunState[]> {
  return call(base, `/v1/workspaces/${ws(workspace)}/runs?limit=${limit}`, token);
}

const PAGE = 5000;
/** Enough for any run worth replaying; longer ones are cut (and say so). */
export const MAX_REPLAY_EVENTS = 50_000;

/** Every stored event of a run, oldest first (paged by `after`). */
export async function fetchRunEvents(base: string, workspace: string, runId: string, token: string | null): Promise<{ events: StoredEvent[]; truncated: boolean }> {
  const events: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await call<StoredEvent[]>(base, `/v1/workspaces/${ws(workspace)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${PAGE}`, token);
    events.push(...page);
    if (page.length < PAGE) return { events, truncated: false };
    if (events.length >= MAX_REPLAY_EVENTS) return { events: events.slice(0, MAX_REPLAY_EVENTS), truncated: true };
    after = page[page.length - 1]!.seq;
  }
}

export function fetchPricing(base: string): Promise<PriceTable> {
  return call(base, "/v1/pricing", null);
}

export function resolveApproval(
  base: string,
  workspace: string,
  approvalId: string,
  decision: "approved" | "rejected",
  comment: string,
  token: string | null,
): Promise<ApprovalState> {
  return call(base, `/v1/workspaces/${ws(workspace)}/approvals/${encodeURIComponent(approvalId)}/resolve`, token, {
    method: "POST",
    body: { decision, comment: comment.trim() || undefined },
  });
}

export type ControlAction = "pause" | "resume" | "cancel";

export function controlRun(base: string, workspace: string, runId: string, action: ControlAction, token: string | null): Promise<RunState> {
  return call(base, `/v1/workspaces/${ws(workspace)}/runs/${encodeURIComponent(runId)}/control`, token, { method: "POST", body: { action } });
}

/** A short, human message for a failed operator action. */
export function actionError(err: unknown, what: string): string {
  if (!(err instanceof ApiError)) return `Couldn’t ${what}. Try again.`;
  if (err.status === 0) return `Couldn’t ${what}: the collector isn’t reachable. Try again.`;
  if (err.status === 401) return `Couldn’t ${what}: this collector needs an operator token. Add one with the key button at the top.`;
  if (err.status === 403) return `Couldn’t ${what}: this office is read-only.`;
  return `Couldn’t ${what}: ${err.message}.`;
}

/** Which operator actions a run allows now. Mirrors the collector's rules. */
export function allowedActions(run: Pick<RunState, "status" | "control">): ControlAction[] {
  if (run.status !== "running" || run.control === "cancelled") return [];
  return run.control === "paused" ? ["resume", "cancel"] : ["pause", "cancel"];
}
