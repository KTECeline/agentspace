import type {
  AgentSpaceEvent,
  AgentState,
  ApprovalState,
  ApprovalStatus,
  RunControl,
  RunState,
  StatsResponse,
  StoredEvent,
} from "@agentspace/spec-types";
import type { BaselineRows } from "../detect/baseline.js";
import type { StatsWindow } from "./stats.js";

export interface InsertResult {
  inserted: StoredEvent[];
  duplicates: number;
  /** Projection rows that changed, for the WebSocket deltas. */
  agents: AgentState[];
  runs: RunState[];
  approvals: ApprovalState[];
}

export type ResolveOutcome =
  | { result: "resolved"; approval: ApprovalState; changes: InsertResult }
  | { result: "conflict"; approval: ApprovalState }
  | { result: "not_found" };

export type ControlAction = "pause" | "resume" | "cancel";

export type ControlOutcome =
  | { result: "ok"; run: RunState; changes: InsertResult }
  | { result: "conflict"; run: RunState }
  | { result: "not_found" };

/**
 * Storage backend. SQLite (default) and Postgres implement the same contract, and the same
 * test suite runs against both. Every method is async so network databases fit.
 *
 * Rules every implementation must follow:
 * - `insert` stores events idempotently (unique per workspace + id) and updates the
 *   agent/run/approval projections in the same transaction.
 * - Totals (tokens, cost) are summed over `llm.call` events only. `cost_estimated_usd` is the
 *   part with `cost_source: "estimated"`; `unpriced_calls` counts calls with tokens and neither
 *   a cost nor a cost source (see `usageOf` in sqlite.ts; D-037).
 * - `resolveApproval` and `setControl` are atomic, and so is the event they emit. A second
 *   resolve of the same approval is a conflict and emits nothing.
 */
export interface Store {
  insert(events: AgentSpaceEvent[]): Promise<InsertResult>;

  agents(workspace: string): Promise<AgentState[]>;
  runs(workspace: string, limit?: number): Promise<RunState[]>;
  run(workspace: string, runId: string): Promise<RunState | undefined>;
  /** Dashboard aggregates for events with since <= ts < until. Build them with `computeStats`. */
  stats(workspace: string, window: StatsWindow): Promise<StatsResponse>;
  runEvents(workspace: string, runId: string, after?: number, limit?: number): Promise<StoredEvent[]>;
  /** Detector baselines (D-044): the last `limit` successful runs named `name` (newest first), and each
   * agent's tool calls in them. Build the baseline with `computeBaseline`. */
  baselineRows(workspace: string, name: string, limit: number): Promise<BaselineRows>;
  recentEvents(workspace: string, limit?: number): Promise<StoredEvent[]>;
  workspaces(): Promise<{ workspace: string; agents: number }[]>;

  approvals(workspace: string, status?: ApprovalStatus, limit?: number): Promise<ApprovalState[]>;
  approval(workspace: string, approvalId: string): Promise<ApprovalState | undefined>;
  resolveApproval(
    workspace: string,
    approvalId: string,
    decision: "approved" | "rejected" | "timeout",
    opts: { comment?: string; by?: string; now?: Date },
  ): Promise<ResolveOutcome>;
  /** Pending approvals whose deadline has passed. */
  expiredApprovals(now?: Date): Promise<ApprovalState[]>;

  setControl(workspace: string, runId: string, action: ControlAction, opts: { by?: string; now?: Date }): Promise<ControlOutcome>;
  /** Control state of the given runs (runs that are unknown or running are omitted). */
  controls(workspace: string, runIds: string[]): Promise<Record<string, RunControl>>;

  /** Delete events (and finished runs, resolved approvals) older than `days`. */
  prune(days: number, now?: Date): Promise<number>;
  close(): Promise<void>;
}
