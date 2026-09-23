export type * from "./generated.ts";
import type { AgentSpaceEvent, AgentStatus, EventType } from "./generated.ts";

export const SPEC_VERSION = "0.1" as const;

export const EVENT_TYPES = [
  "agent.registered",
  "agent.status",
  "run.started",
  "run.finished",
  "step.started",
  "step.finished",
  "llm.call",
  "tool.call",
  "tool.result",
  "message",
  "handoff",
  "approval.requested",
  "approval.resolved",
  "error",
] as const satisfies readonly EventType[];

export const AGENT_STATUSES = [
  "idle",
  "thinking",
  "using_tool",
  "waiting",
  "blocked",
  "waiting_human",
  "done",
  "error",
] as const satisfies readonly AgentStatus[];

/** Body of POST /v1/events. Declared here because it references the root schema. */
export interface IngestBatch {
  events: AgentSpaceEvent[];
}

/** Narrow an event to one type. */
export type EventOf<T extends EventType> = Extract<AgentSpaceEvent, { type: T }>;

// Compile-time guard: the constant lists above must cover every schema enum value.
type Exhaustive<T extends true> = T;
export type _EventTypesComplete = Exhaustive<Exclude<EventType, (typeof EVENT_TYPES)[number]> extends never ? true : false>;
export type _StatusesComplete = Exhaustive<Exclude<AgentStatus, (typeof AGENT_STATUSES)[number]> extends never ? true : false>;
