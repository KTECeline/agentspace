# GENERATED from spec/v0.1/event.schema.json by `make gen-types`. Do not edit.

from __future__ import annotations

from typing import Annotated, Any, Literal
from pydantic import AwareDatetime, BaseModel, Field, RootModel


class EventType(
    RootModel[
        Literal[
            "agent.registered",
            "agent.status",
            "run.started",
            "run.finished",
            "run.control",
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
        ]
    ]
):
    root: Literal[
        "agent.registered",
        "agent.status",
        "run.started",
        "run.finished",
        "run.control",
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
    ]


class AgentStatus(
    RootModel[
        Literal[
            "idle", "thinking", "using_tool", "waiting", "blocked", "waiting_human", "done", "error"
        ]
    ]
):
    root: Literal[
        "idle", "thinking", "using_tool", "waiting", "blocked", "waiting_human", "done", "error"
    ]


class Id(RootModel[str]):
    root: Annotated[str, Field(max_length=128, min_length=1)]


class NullableId(RootModel[Id | None]):
    root: Id | None


class Content(RootModel[str | dict[str, Any] | list[Any] | None]):
    root: Annotated[
        str | dict[str, Any] | list[Any] | None,
        Field(
            description="Full prompt/output/argument content. Only present when the SDK runs with capture_content=True, after redaction."
        ),
    ]


class EventBase(BaseModel):
    spec_version: Literal["0.1"]
    id: Annotated[Id, Field(description="Unique event id (used for de-duplication).")]
    type: EventType
    ts: Annotated[AwareDatetime, Field(description="RFC 3339 timestamp, UTC.")]
    workspace: Id
    run_id: Annotated[Id, Field(description="OTel: trace id / gen_ai.conversation.id.")]
    agent_id: Annotated[
        NullableId | None,
        Field(description="OTel: gen_ai.agent.id. Null for run-level events with no single agent."),
    ]
    team_id: Annotated[
        NullableId | None, Field(description="Becomes a department zone in the office.")
    ]
    parent_id: Annotated[
        NullableId | None, Field(description="The enclosing step's step_id (OTel: parent span id).")
    ]
    tokens_in: Annotated[
        int | None, Field(description="OTel: gen_ai.usage.input_tokens.", ge=0)
    ] = None
    tokens_out: Annotated[
        int | None, Field(description="OTel: gen_ai.usage.output_tokens.", ge=0)
    ] = None
    cost_usd: Annotated[float | None, Field(ge=0.0)] = None
    model: Annotated[
        str | None,
        Field(description="OTel: gen_ai.response.model (or gen_ai.request.model).", max_length=256),
    ] = None
    summary: Annotated[
        str | None,
        Field(
            description="Short, human-readable description. Always safe to display.", max_length=500
        ),
    ] = None
    attributes: Annotated[
        dict[str, str | float | bool] | None,
        Field(
            description="Free-form extra metadata (string/number/bool values). OTel attributes land here on OTLP import."
        ),
    ] = None


class AgentRegisteredData(BaseModel):
    name: Annotated[str, Field(description="OTel: gen_ai.agent.name.", max_length=256)]
    team_name: Annotated[str | None, Field(max_length=256)] = None
    role: Annotated[str | None, Field(max_length=256)] = None
    description: Annotated[
        str | None, Field(description="OTel: gen_ai.agent.description.", max_length=2000)
    ] = None
    framework: Annotated[
        str | None, Field(description="e.g. langgraph, crewai, manual.", max_length=64)
    ] = None


class AgentStatusData(BaseModel):
    status: AgentStatus
    detail: Annotated[str | None, Field(max_length=500)] = None


class RunStartedData(BaseModel):
    name: Annotated[
        str | None, Field(description="OTel: gen_ai.workflow.name.", max_length=256)
    ] = None
    framework: Annotated[str | None, Field(max_length=64)] = None
    input: Content | None = None


class RunFinishedData(BaseModel):
    status: Literal["ok", "error", "cancelled"]
    duration_ms: Annotated[float | None, Field(ge=0.0)] = None
    output: Content | None = None


class RunControlData(BaseModel):
    action: Literal["pause", "resume", "cancel"]
    by: Annotated[
        str | None, Field(description="Who asked (operator name or 'api').", max_length=256)
    ] = None


class StepStartedData(BaseModel):
    step_id: Annotated[Id, Field(description="OTel: span id.")]
    name: Annotated[str, Field(max_length=256)]
    kind: Annotated[
        Literal["agent", "chain", "custom"] | None,
        Field(description="agent ≈ OTel invoke_agent span."),
    ] = None


class StepFinishedData(BaseModel):
    step_id: Id
    name: Annotated[str, Field(max_length=256)]
    ok: bool
    duration_ms: Annotated[float | None, Field(ge=0.0)] = None
    error: Annotated[str | None, Field(max_length=2000)] = None


class LlmCallData(BaseModel):
    provider: Annotated[
        str | None, Field(description="OTel: gen_ai.provider.name.", max_length=64)
    ] = None
    operation: Annotated[
        str | None,
        Field(
            description="OTel: gen_ai.operation.name (chat, text_completion, ...).", max_length=64
        ),
    ] = None
    duration_ms: Annotated[float | None, Field(ge=0.0)] = None
    finish_reason: Annotated[
        str | None, Field(description="OTel: gen_ai.response.finish_reasons[0].", max_length=64)
    ] = None
    input: Annotated[Content | None, Field(description="OTel: gen_ai.input.messages.")] = None
    output: Annotated[Content | None, Field(description="OTel: gen_ai.output.messages.")] = None


class ToolCallData(BaseModel):
    tool_name: Annotated[str, Field(description="OTel: gen_ai.tool.name.", max_length=256)]
    call_id: Annotated[Id, Field(description="OTel: gen_ai.tool.call.id.")]
    arguments: Annotated[Content | None, Field(description="OTel: gen_ai.tool.call.arguments.")] = (
        None
    )


class ToolResultData(BaseModel):
    tool_name: Annotated[str, Field(max_length=256)]
    call_id: Id
    ok: bool
    duration_ms: Annotated[float | None, Field(ge=0.0)] = None
    error: Annotated[str | None, Field(max_length=2000)] = None
    result: Annotated[Content | None, Field(description="OTel: gen_ai.tool.call.result.")] = None


class MessageData(BaseModel):
    from_agent_id: NullableId | None = None
    to_agent_id: NullableId | None = None
    role: Annotated[str | None, Field(max_length=32)] = None
    text: Content | None = None


class HandoffData(BaseModel):
    from_agent_id: Id
    to_agent_id: Id
    reason: Annotated[str | None, Field(max_length=500)] = None


class ApprovalRequestedData(BaseModel):
    approval_id: Id
    reason: Annotated[str, Field(max_length=2000)]
    payload: Content | None = None
    timeout_s: Annotated[float | None, Field(ge=0.0)] = None


class ApprovalResolvedData(BaseModel):
    approval_id: Id
    decision: Literal["approved", "rejected", "timeout"]
    comment: Annotated[str | None, Field(max_length=2000)] = None
    resolved_by: Annotated[str | None, Field(max_length=256)] = None


class ErrorData(BaseModel):
    message: Annotated[str, Field(max_length=2000)]
    kind: Annotated[
        str | None, Field(description="Exception class name (OTel: error.type).", max_length=256)
    ] = None
    stack: Annotated[str | None, Field(max_length=16000)] = None


class AgentRegisteredEvent(EventBase):
    type: Literal["agent.registered"]
    data: AgentRegisteredData


class AgentStatusEvent(EventBase):
    type: Literal["agent.status"]
    data: AgentStatusData


class RunStartedEvent(EventBase):
    type: Literal["run.started"]
    data: RunStartedData


class RunFinishedEvent(EventBase):
    type: Literal["run.finished"]
    data: RunFinishedData


class RunControlEvent(EventBase):
    type: Literal["run.control"]
    data: RunControlData


class StepStartedEvent(EventBase):
    type: Literal["step.started"]
    data: StepStartedData


class StepFinishedEvent(EventBase):
    type: Literal["step.finished"]
    data: StepFinishedData


class LlmCallEvent(EventBase):
    type: Literal["llm.call"]
    data: LlmCallData


class ToolCallEvent(EventBase):
    type: Literal["tool.call"]
    data: ToolCallData


class ToolResultEvent(EventBase):
    type: Literal["tool.result"]
    data: ToolResultData


class MessageEvent(EventBase):
    type: Literal["message"]
    data: MessageData


class HandoffEvent(EventBase):
    type: Literal["handoff"]
    data: HandoffData


class ApprovalRequestedEvent(EventBase):
    type: Literal["approval.requested"]
    data: ApprovalRequestedData


class ApprovalResolvedEvent(EventBase):
    type: Literal["approval.resolved"]
    data: ApprovalResolvedData


class ErrorEvent(EventBase):
    type: Literal["error"]
    data: ErrorData


class AgentSpaceEvent(
    RootModel[
        AgentRegisteredEvent
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
        | ErrorEvent
    ]
):
    root: Annotated[
        AgentRegisteredEvent
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
        | ErrorEvent,
        Field(
            description="One AgentSpace event (spec v0.1). The `type` field selects the shape of `data`.",
            title="AgentSpaceEvent",
        ),
    ]


class IngestBatch(BaseModel):
    events: Annotated[list[AgentSpaceEvent], Field(max_length=1000)]
