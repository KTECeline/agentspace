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
  /** Total cost of the agent's `llm.call` events, reported and estimated together. */
  cost_usd: number;
  /** The part of `cost_usd` the collector estimated from its price table (D-037). */
  cost_estimated_usd: number;
  /** `llm.call` events with tokens whose model has no price (so they add $0). */
  unpriced_calls: number;
  model: string | null;
  /** `anomaly.detected` events about this agent in its current run (D-044). */
  findings: number;
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
  cost_estimated_usd: number;
  unpriced_calls: number;
  control: RunControl;
  /** `anomaly.detected` events in this run (D-044). */
  findings: number;
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

/** Prices in USD per 1M tokens. Cached tokens are part of the input tokens. */
export interface PriceTier {
  input: number;
  output: number;
  /** Reading from the prompt cache. Missing: priced as input. */
  cache_read?: number;
  /** Writing to the prompt cache (Anthropic: the 5-minute rate). Missing: priced as input. */
  cache_write?: number;
}

export interface PricePeriod extends PriceTier {
  /** First day (YYYY-MM-DD) these prices apply; omitted on the first period. */
  from?: string;
  /** Higher prices for prompts over `above_input_tokens` input tokens. */
  long_context?: PriceTier & { above_input_tokens: number };
}

export interface ModelPrice {
  id: string;
  provider?: string;
  aliases?: string[];
  /** When the prices were last checked against `source`. */
  as_of: string;
  /** The official pricing page. */
  source: string;
  note?: string;
  prices: PricePeriod[];
}

/** GET /v1/pricing: the collector's price table (built in, plus AGENTSPACE_PRICES_FILE). */
export interface PriceTable {
  version: string;
  models: ModelPrice[];
}

/** Cost and token totals over a set of `llm.call` events. */
export interface CostTotals {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  cost_estimated_usd: number;
  unpriced_calls: number;
}

/** Latency of a set of calls, in ms (null when none had a duration). */
export interface Latency {
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface RunStats extends CostTotals {
  run_id: string;
  name: string | null;
  status: RunStatus;
  started_at: string | null;
  duration_ms: number | null;
  errors: number;
  /** Detector findings in the run (D-044). */
  findings: number;
}

export interface AgentStats extends CostTotals, Latency {
  agent_id: string;
  name: string;
  team_id: string | null;
  errors: number;
}

export interface ModelStats extends CostTotals, Latency {
  /** "unknown" when the event carried no model. */
  model: string;
}

export interface ToolStats extends Latency {
  tool_name: string;
  calls: number;
  errors: number;
  max_ms: number | null;
}

/**
 * GET /v1/workspaces/:ws/stats?since=&until= — aggregates for the cost dashboard.
 * Covers events with since <= ts < until (both optional, ISO 8601). Aggregates only: no content.
 */
export interface StatsResponse {
  workspace: string;
  since: string | null;
  until: string | null;
  totals: CostTotals &
    Latency & {
      runs: number;
      runs_ok: number;
      runs_failed: number;
      runs_cancelled: number;
      /** runs_failed / (runs_ok + runs_failed); null when no run finished. */
      error_rate: number | null;
      errors: number;
      tool_calls: number;
      tool_errors: number;
    };
  /** Most recent first, at most 200. */
  by_run: RunStats[];
  /** Highest cost first. */
  by_agent: AgentStats[];
  by_model: ModelStats[];
  /** Cost per UTC day, oldest first. */
  by_day: (Pick<CostTotals, "calls" | "cost_usd" | "cost_estimated_usd"> & { day: string })[];
  /** Slowest first (by p95), at most 10. */
  slowest_tools: ToolStats[];
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
