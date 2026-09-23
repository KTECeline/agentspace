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
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  /** First few validation errors, for debugging SDKs. */
  errors: { index: number; id?: string; message: string }[];
}

/** Server → browser messages on GET /v1/ws?workspace=... */
export type WsServerMessage =
  | {
      type: "snapshot";
      workspace: string;
      agents: AgentState[];
      runs: RunState[];
      events: StoredEvent[];
    }
  | { type: "events"; events: StoredEvent[] }
  | { type: "agents"; agents: AgentState[] }
  | { type: "runs"; runs: RunState[] };
