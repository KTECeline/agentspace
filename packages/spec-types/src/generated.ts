/* eslint-disable */
/** GENERATED from spec/v0.1/event.schema.json by scripts/gen.mjs. Do not edit. */

/**
 * One AgentSpace event (spec v0.1). The `type` field selects the shape of `data`.
 */
export type AgentSpaceEvent =
  | AgentRegisteredEvent
  | AgentStatusEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunControlEvent
  | StepStartedEvent
  | StepFinishedEvent
  | LlmCallEvent
  | ToolCallEvent
  | ToolResultEvent
  | MessageEvent
  | HandoffEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ErrorEvent;
export type AgentRegisteredEvent = EventBase & {
  type: "agent.registered";
  data: AgentRegisteredData;
};
export type EventType =
  | "agent.registered"
  | "agent.status"
  | "run.started"
  | "run.finished"
  | "run.control"
  | "step.started"
  | "step.finished"
  | "llm.call"
  | "tool.call"
  | "tool.result"
  | "message"
  | "handoff"
  | "approval.requested"
  | "approval.resolved"
  | "error";
export type Id = string;
export type AgentStatusEvent = EventBase & {
  type: "agent.status";
  data: AgentStatusData;
};
export type AgentStatus =
  "idle" | "thinking" | "using_tool" | "waiting" | "blocked" | "waiting_human" | "done" | "error";
export type RunStartedEvent = EventBase & {
  type: "run.started";
  data: RunStartedData;
};
/**
 * Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction.
 */
export type Content = string | {} | unknown[] | null;
export type RunFinishedEvent = EventBase & {
  type: "run.finished";
  data: RunFinishedData;
};
export type RunControlEvent = EventBase & {
  type: "run.control";
  data: RunControlData;
};
export type StepStartedEvent = EventBase & {
  type: "step.started";
  data: StepStartedData;
};
export type StepFinishedEvent = EventBase & {
  type: "step.finished";
  data: StepFinishedData;
};
export type LlmCallEvent = EventBase & {
  type: "llm.call";
  data: LlmCallData;
};
export type ToolCallEvent = EventBase & {
  type: "tool.call";
  data: ToolCallData;
};
export type ToolResultEvent = EventBase & {
  type: "tool.result";
  data: ToolResultData;
};
export type MessageEvent = EventBase & {
  type: "message";
  data: MessageData;
};
export type NullableId = Id | null;
export type HandoffEvent = EventBase & {
  type: "handoff";
  data: HandoffData;
};
export type ApprovalRequestedEvent = EventBase & {
  type: "approval.requested";
  data: ApprovalRequestedData;
};
export type ApprovalResolvedEvent = EventBase & {
  type: "approval.resolved";
  data: ApprovalResolvedData;
};
export type ErrorEvent = EventBase & {
  type: "error";
  data: ErrorData;
};

/**
 * Fields every event carries.
 */
export interface EventBase {
  spec_version: "0.1";
  /**
   * Unique event id (used for de-duplication).
   */
  id: string;
  type: EventType;
  /**
   * RFC 3339 timestamp, UTC.
   */
  ts: string;
  workspace: Id;
  /**
   * OTel: trace id / gen_ai.conversation.id.
   */
  run_id: string;
  /**
   * OTel: gen_ai.agent.id. Null for run-level events with no single agent.
   */
  agent_id: Id | null;
  /**
   * Becomes a department zone in the office.
   */
  team_id: Id | null;
  /**
   * The enclosing step's step_id (OTel: parent span id).
   */
  parent_id: Id | null;
  /**
   * OTel: gen_ai.usage.input_tokens.
   */
  tokens_in?: number;
  /**
   * OTel: gen_ai.usage.output_tokens.
   */
  tokens_out?: number;
  cost_usd?: number;
  /**
   * OTel: gen_ai.response.model (or gen_ai.request.model).
   */
  model?: string;
  /**
   * Short, human-readable description. Always safe to display.
   */
  summary?: string;
  /**
   * Free-form extra metadata (string/number/bool values). OTel attributes land here on OTLP import.
   */
  attributes?: {
    [k: string]: string | number | boolean;
  };
}
export interface AgentRegisteredData {
  /**
   * OTel: gen_ai.agent.name.
   */
  name: string;
  team_name?: string;
  role?: string;
  /**
   * OTel: gen_ai.agent.description.
   */
  description?: string;
  /**
   * e.g. langgraph, crewai, manual.
   */
  framework?: string;
}
export interface AgentStatusData {
  status: AgentStatus;
  detail?: string;
}
export interface RunStartedData {
  /**
   * OTel: gen_ai.workflow.name.
   */
  name?: string;
  framework?: string;
  input?: Content;
}
export interface RunFinishedData {
  status: "ok" | "error" | "cancelled";
  duration_ms?: number;
  output?: Content;
}
export interface RunControlData {
  action: "pause" | "resume" | "cancel";
  /**
   * Who asked (operator name or 'api').
   */
  by?: string;
}
export interface StepStartedData {
  /**
   * OTel: span id.
   */
  step_id: string;
  name: string;
  /**
   * agent ≈ OTel invoke_agent span.
   */
  kind?: "agent" | "chain" | "custom";
}
export interface StepFinishedData {
  step_id: Id;
  name: string;
  ok: boolean;
  duration_ms?: number;
  error?: string;
}
export interface LlmCallData {
  /**
   * OTel: gen_ai.provider.name.
   */
  provider?: string;
  /**
   * OTel: gen_ai.operation.name (chat, text_completion, ...).
   */
  operation?: string;
  duration_ms?: number;
  /**
   * OTel: gen_ai.response.finish_reasons[0].
   */
  finish_reason?: string;
  /**
   * Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction.
   */
  input?: string | {} | unknown[] | null;
  /**
   * Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction.
   */
  output?: string | {} | unknown[] | null;
}
export interface ToolCallData {
  /**
   * OTel: gen_ai.tool.name.
   */
  tool_name: string;
  /**
   * OTel: gen_ai.tool.call.id.
   */
  call_id: string;
  /**
   * Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction.
   */
  arguments?: string | {} | unknown[] | null;
}
export interface ToolResultData {
  tool_name: string;
  call_id: Id;
  ok: boolean;
  duration_ms?: number;
  error?: string;
  /**
   * Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction.
   */
  result?: string | {} | unknown[] | null;
}
export interface MessageData {
  from_agent_id?: NullableId;
  to_agent_id?: NullableId;
  role?: string;
  text?: Content;
}
export interface HandoffData {
  from_agent_id: Id;
  to_agent_id: Id;
  reason?: string;
}
export interface ApprovalRequestedData {
  approval_id: Id;
  reason: string;
  payload?: Content;
  timeout_s?: number;
}
export interface ApprovalResolvedData {
  approval_id: Id;
  decision: "approved" | "rejected" | "timeout";
  comment?: string;
  resolved_by?: string;
}
export interface ErrorData {
  message: string;
  /**
   * Exception class name (OTel: error.type).
   */
  kind?: string;
  stack?: string;
}
