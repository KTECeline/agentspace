/**
 * Collector REST + WebSocket API types (hand-written; shared by server and web).
 * The event spec itself lives in generated.ts.
 */
import type { AgentSpaceEvent, AgentStatus } from "./generated.ts";

/** An event as stored by the collector: the original event plus an arrival sequence number. */
export type StoredEvent = AgentSpaceEvent & { seq: number };

/** Current state of an agent in a workspace (a projection over its events). */
export interface AgentState {
  workspace: string;
  agent_id: string;
  team_id: string | null;
  name: string;
  role: string | null;
  framework: string | null;
  status: AgentStatus;
  status_detail: string | null;
  last_summary: string | null;
  last_event_at: string | null;
  current_run_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string | null;
}

export type RunStatus = "running" | "ok" | "error" | "cancelled";

/** Operator control over a run. "cancelled" is final. */
export type RunControl = "running" | "paused" | "cancelled";

export interface RunState {
  workspace: string;
  run_id: string;
  name: string | null;
  framework: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  event_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  control: RunControl;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

/** A human approval an agent is (or was) waiting on. */
export interface ApprovalState {
  workspace: string;
  approval_id: string;
  run_id: string;
  agent_id: string | null;
  team_id: string | null;
  reason: string;
  /** What the human is asked to approve. Omitted (null) in public read-only mode. */
  payload: unknown;
  status: ApprovalStatus;
  comment: string | null;
  resolved_by: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
}

/** GET /v1/info: what the browser needs to know before connecting. */
export interface ServerInfo {
  version: string;
  /** Reads (REST + WebSocket) need a token. */
  auth_required: boolean;
  /** Operator actions (approve, pause, cancel) are possible with a token. */
  operator_enabled: boolean;
  /** Public read-only mode: anyone can watch; payloads hidden; no operator actions. */
  public_readonly: boolean;
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  /** First few validation errors, for debugging SDKs. */
  errors: { index: number; id?: string; message: string }[];
  /** Runs in this batch that an operator paused or cancelled (the SDK acts on these). */
  controls?: Record<string, RunControl>;
}

/** Server → browser messages on GET /v1/ws?workspace=... */
export type WsServerMessage =
  | {
      type: "snapshot";
      workspace: string;
      agents: AgentState[];
      runs: RunState[];
      events: StoredEvent[];
      approvals: ApprovalState[];
    }
  | { type: "events"; events: StoredEvent[] }
  | { type: "agents"; agents: AgentState[] }
  | { type: "runs"; runs: RunState[] }
  | { type: "approvals"; approvals: ApprovalState[] };
