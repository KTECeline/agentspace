import type { AgentSpaceEvent } from "@agentspace/spec-types";

export type Severity = "info" | "warning" | "critical";

/** What a detector reports. The engine turns it into an `anomaly.detected` event (D-044). */
export interface Finding {
  detector: string;
  /** Unique per run and detector: the event id is derived from it, so a finding is sent once. */
  key: string;
  severity: Severity;
  /** Short, safe to display: names and numbers, never content. */
  message: string;
  evidence: Record<string, number | string | boolean>;
  /** The event that tipped it over (its agent, step and time are the finding's). */
  trigger: AgentSpaceEvent;
  subjectIds: string[];
}

/** Medians and 95th percentiles over the last successful runs of the same workflow. */
export interface Stat {
  p50: number;
  p95: number;
}

export interface Baseline {
  /** How many runs it's based on. */
  runs: number;
  /** Tool calls per run, per agent (0 for runs the agent wasn't in). */
  toolCalls: Record<string, Stat>;
  /** Tokens in + out per run. */
  tokens: Stat | null;
  cost: Stat | null;
}

export interface RunContext {
  workspace: string;
  runId: string;
  /** Filled in by the engine once the run's name is known (null: no baseline for this run). */
  baseline: Baseline | null;
}

/**
 * A detector makes one checker per run. The checker sees the run's events in order and returns
 * findings; its state lives in the closure. Checkers must be deterministic and must not throw
 * for any valid event (the engine catches anyway).
 */
export interface Detector<C = unknown> {
  id: string;
  create(ctx: RunContext, config: C): (event: AgentSpaceEvent) => Finding[];
}

export interface DetectorConfig {
  repeated_tool_call: { enabled: boolean; min_count: number };
  failure_loop: { enabled: boolean; min_count: number };
  handoff_loop: { enabled: boolean; min_round_trips: number };
  tool_call_outlier: { enabled: boolean; min_runs: number; factor: number; min_extra: number };
  usage_outlier: { enabled: boolean; min_runs: number; factor: number };
}
