"""Claude Agent SDK adapter.

The Claude Agent SDK has no global registry; hooks are configured per session through
``ClaudeAgentOptions(hooks=...)``, which is its official extension point. So this adapter
is two small helpers:

    from agentspace.adapters.claude_agent_sdk import instrument_options, track

    options = instrument_options(ClaudeAgentOptions(...), name="Support", team="Support Desk")
    async for message in track(query(prompt="...", options=options)):
        ...

- ``instrument_options`` merges AgentSpace hooks into your options (your hooks keep running).
- ``track`` wraps the message stream to add model/token usage per assistant message and the
  session's billed cost from ``ResultMessage.total_cost_usd``.

Mapping:

- session (session_id)            -> run; each prompt->Stop turn is a step of the main agent
- UserPromptSubmit / Stop         -> main agent thinking / done, run.started / run.finished
- PreToolUse / PostToolUse(Failure) -> using_tool + tool.call / tool.result
- Task/Agent tool, SubagentStart  -> subagent desk (id = agent type) + handoff from the main agent
- SubagentStop                    -> subagent step finished
- PermissionRequest / permission Notification -> waiting_human ("needs you")
- AssistantMessage (via track)    -> llm.call with model and tokens
- ResultMessage (via track)       -> session cost (an llm.call carrying only cost_usd)
"""

from __future__ import annotations

import dataclasses
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, TypeVar

from agentspace import _api
from agentspace._client import AgentInfo
from agentspace._log import internal_error
from agentspace._util import slugify, truncate

if TYPE_CHECKING:
    from agentspace._client import Client

T = TypeVar("T")

SUBAGENT_TOOLS = {"Task", "Agent"}
HOOK_EVENTS = (
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Notification",
    "PermissionRequest",
    "PreCompact",
)


@dataclass
class _Session:
    run_id: str
    main_id: str
    team_id: str | None
    turn_step: str | None = None
    turn_t0: float = 0.0
    turn: int = 0
    #: runtime sub-agent id -> office agent id
    subagents: dict[str, str] = field(default_factory=dict)
    #: Task tool_use_id -> office agent id (to attribute assistant messages)
    task_calls: dict[str, str] = field(default_factory=dict)
    sub_steps: dict[str, tuple[str, float]] = field(default_factory=dict)
    tool_t0: dict[str, float] = field(default_factory=dict)
    seen_messages: set[str] = field(default_factory=set)
    agents: set[str] = field(default_factory=set)


class ClaudeAgentTracker:
    """Hook callbacks + message tracking for one agent identity (name/team)."""

    def __init__(self, name: str = "Claude", team: str | None = None, role: str | None = None):
        self.name = name
        self.main_id = slugify(name)
        self.team_id = slugify(team) if team else None
        self.role = role
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    # ---------------- plumbing ----------------

    @staticmethod
    def _client() -> Client | None:
        return _api.get_client()

    def _session(self, session_id: str) -> _Session:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None:
                s = _Session(session_id, self.main_id, self.team_id)
                self._sessions[session_id] = s
        client = self._client()
        if client:
            client.upsert_agent(
                AgentInfo(
                    self.main_id,
                    self.name,
                    self.team_id,
                    role=self.role,
                    framework="claude-agent-sdk",
                )
            )
        return s

    def _emit(
        self, s: _Session, type: str, data: dict[str, Any], agent_id: str | None, **fields: Any
    ) -> None:
        client = self._client()
        if client is None:
            return
        fields.setdefault("team_id", s.team_id if agent_id else None)
        if "parent_id" not in fields:
            sub = next(
                (st for aid, st in s.sub_steps.items() if s.subagents.get(aid) == agent_id), None
            )
            fields["parent_id"] = sub[0] if sub else s.turn_step
        client.emit(type, data, run_id=s.run_id, agent_id=agent_id, **fields)

    def _status(self, s: _Session, agent_id: str, status: str, detail: str | None = None) -> None:
        self._emit(
            s,
            "agent.status",
            {"status": status, "detail": truncate(detail, 500) if detail else None},
            agent_id,
        )

    def _agent_of(self, s: _Session, data: dict[str, Any]) -> str:
        runtime = data.get("agent_id")
        if runtime and runtime in s.subagents:
            return s.subagents[runtime]
        if runtime and data.get("agent_type"):
            return self._register_subagent(s, str(runtime), str(data["agent_type"]))
        return s.main_id

    def _register_subagent(self, s: _Session, runtime_id: str, agent_type: str) -> str:
        agent_id = slugify(agent_type)
        s.subagents[runtime_id] = agent_id
        if agent_id not in s.agents:
            s.agents.add(agent_id)
            client = self._client()
            if client:
                client.upsert_agent(
                    AgentInfo(
                        agent_id,
                        agent_type,
                        s.team_id,
                        role="subagent",
                        framework="claude-agent-sdk",
                    )
                )
        return agent_id

    def _content(self, field_name: str, value: Any) -> Any:
        client = self._client()
        return client.content(field_name, value) if client else None

    # ---------------- hooks ----------------

    def hooks(self) -> dict[str, list[Any]]:
        """``{event: [HookMatcher(...)]}`` for ``ClaudeAgentOptions(hooks=...)``."""
        from claude_agent_sdk import HookMatcher

        return {
            event: [HookMatcher(matcher=None, hooks=[self._callback(event)])]
            for event in HOOK_EVENTS
        }

    def _callback(self, event: str) -> Any:
        async def callback(
            input_data: Any, tool_use_id: str | None, context: Any
        ) -> dict[str, Any]:
            try:
                self.handle(event, dict(input_data), tool_use_id)
            except Exception as exc:
                internal_error(f"claude_agent_sdk.{event}", exc)
            return {}  # never change the agent's behaviour

        callback.__name__ = f"agentspace_{event}"
        return callback

    def handle(self, event: str, data: dict[str, Any], tool_use_id: str | None = None) -> None:
        """Process one hook payload. Public so recorded hook payloads can be replayed."""
        if self._client() is None:
            return
        session_id = str(data.get("session_id") or "session")
        s = self._session(session_id)
        handler = getattr(self, f"_on_{slugify(event).replace('-', '_')}", None)
        if handler:
            handler(s, data, tool_use_id or data.get("tool_use_id"))

    def _on_userpromptsubmit(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        client = self._client()
        if client is None:
            return
        s.turn += 1
        if s.turn == 1 or s.turn_step is None:
            client.emit(
                "run.started",
                {
                    "name": f"{self.name} session",
                    "framework": "claude-agent-sdk",
                    "input": self._content("run.input", data.get("prompt")),
                },
                run_id=s.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
                summary=f"{self.name} session",
            )
        s.agents.add(s.main_id)
        s.turn_step = f"{s.run_id}-turn{s.turn}"
        s.turn_t0 = time.monotonic()
        self._emit(
            s,
            "step.started",
            {"step_id": s.turn_step, "name": f"turn {s.turn}", "kind": "agent"},
            s.main_id,
            parent_id=None,
        )
        self._status(s, s.main_id, "thinking")

    def _on_pretooluse(self, s: _Session, data: dict[str, Any], tool_use_id: str | None) -> None:
        agent_id = self._agent_of(s, data)
        tool = str(data.get("tool_name") or "tool")
        call_id = str(tool_use_id or f"{tool}-{time.monotonic_ns()}")
        s.tool_t0[call_id] = time.monotonic()
        tool_input = data.get("tool_input") or {}
        if tool in SUBAGENT_TOOLS and isinstance(tool_input, dict):
            sub_type = tool_input.get("subagent_type") or tool_input.get("agent_type")
            if sub_type:
                sub_id = slugify(str(sub_type))
                s.task_calls[call_id] = sub_id
                if sub_id not in s.agents:
                    s.agents.add(sub_id)
                    client = self._client()
                    if client:
                        client.upsert_agent(
                            AgentInfo(
                                sub_id,
                                str(sub_type),
                                s.team_id,
                                role="subagent",
                                framework="claude-agent-sdk",
                            )
                        )
                self._emit(
                    s,
                    "handoff",
                    {
                        "from_agent_id": agent_id,
                        "to_agent_id": sub_id,
                        "reason": truncate(str(tool_input.get("description") or ""), 500) or None,
                    },
                    agent_id,
                    summary=f"handed off to {sub_type}",
                )
        self._status(s, agent_id, "using_tool", tool)
        self._emit(
            s,
            "tool.call",
            {
                "tool_name": truncate(tool, 256),
                "call_id": call_id[:128],
                "arguments": self._content("tool.arguments", tool_input),
            },
            agent_id,
            summary=f"{tool}()",
        )

    def _tool_done(
        self, s: _Session, data: dict[str, Any], tool_use_id: str | None, error: str | None
    ) -> None:
        agent_id = self._agent_of(s, data)
        tool = str(data.get("tool_name") or "tool")
        call_id = str(tool_use_id or tool)
        t0 = s.tool_t0.pop(call_id, None)
        self._emit(
            s,
            "tool.result",
            {
                "tool_name": truncate(tool, 256),
                "call_id": call_id[:128],
                "ok": error is None,
                "duration_ms": round((time.monotonic() - t0) * 1000, 1) if t0 else None,
                "error": truncate(error, 2000) if error else None,
                "result": None
                if error
                else self._content("tool.result", data.get("tool_response")),
            },
            agent_id,
            summary=f"{tool} {'failed' if error else 'ok'}",
        )
        self._status(s, agent_id, "thinking")

    def _on_posttooluse(self, s: _Session, data: dict[str, Any], tool_use_id: str | None) -> None:
        self._tool_done(s, data, tool_use_id, None)

    def _on_posttoolusefailure(
        self, s: _Session, data: dict[str, Any], tool_use_id: str | None
    ) -> None:
        self._tool_done(s, data, tool_use_id, str(data.get("error") or "tool failed"))

    def _on_subagentstart(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        runtime = str(data.get("agent_id") or "")
        agent_id = self._register_subagent(s, runtime, str(data.get("agent_type") or "subagent"))
        step_id = f"{s.run_id}-{runtime}"[:128]
        s.sub_steps[runtime] = (step_id, time.monotonic())
        self._emit(
            s,
            "step.started",
            {"step_id": step_id, "name": str(data.get("agent_type") or agent_id), "kind": "agent"},
            agent_id,
            parent_id=s.turn_step,
        )
        self._status(s, agent_id, "thinking")

    def _on_subagentstop(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        runtime = str(data.get("agent_id") or "")
        agent_id = s.subagents.get(runtime) or slugify(str(data.get("agent_type") or "subagent"))
        step = s.sub_steps.pop(runtime, None)
        if step:
            self._emit(
                s,
                "step.finished",
                {
                    "step_id": step[0],
                    "name": str(data.get("agent_type") or agent_id),
                    "ok": True,
                    "duration_ms": round((time.monotonic() - step[1]) * 1000, 1),
                },
                agent_id,
                parent_id=s.turn_step,
            )
        self._status(s, agent_id, "done")

    def _on_permissionrequest(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        agent_id = self._agent_of(s, data)
        self._status(s, agent_id, "waiting_human", f"approve {data.get('tool_name') or 'tool'}?")

    def _on_notification(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        kind = str(data.get("notification_type") or "")
        message = str(data.get("message") or "")
        if "permission" in kind or "permission" in message.lower() or kind == "idle_prompt":
            self._status(s, s.main_id, "waiting_human", truncate(message, 500) or "needs input")

    def _on_precompact(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        self._status(s, s.main_id, "thinking", "compacting context")

    def _on_stop(self, s: _Session, data: dict[str, Any], _: Any) -> None:
        client = self._client()
        if client is None:
            return
        if s.turn_step:
            self._emit(
                s,
                "step.finished",
                {
                    "step_id": s.turn_step,
                    "name": f"turn {s.turn}",
                    "ok": True,
                    "duration_ms": round((time.monotonic() - s.turn_t0) * 1000, 1),
                },
                s.main_id,
                parent_id=None,
            )
        for agent_id in sorted(s.agents):
            self._status(s, agent_id, "done")
        client.emit(
            "run.finished",
            {
                "status": "ok",
                "duration_ms": round((time.monotonic() - s.turn_t0) * 1000, 1)
                if s.turn_t0
                else None,
            },
            run_id=s.run_id,
            agent_id=None,
            team_id=None,
            parent_id=None,
        )
        s.turn_step = None

    # ---------------- messages ----------------

    def observe(self, message: Any) -> None:
        """Record model usage from one SDK message. Public so recorded streams can be replayed."""
        try:
            if self._client() is None:
                return
            kind = type(message).__name__
            if kind == "AssistantMessage":
                self._assistant(message)
            elif kind == "ResultMessage":
                self._result(message)
        except Exception as exc:
            internal_error("claude_agent_sdk.observe", exc)

    def _assistant(self, msg: Any) -> None:
        session_id = str(getattr(msg, "session_id", None) or next(iter(self._sessions), "session"))
        s = self._session(session_id)
        key = str(getattr(msg, "message_id", None) or getattr(msg, "uuid", None) or id(msg))
        usage = getattr(msg, "usage", None) or {}
        if key in s.seen_messages or not usage:
            return  # the SDK can split one API message into several; count it once
        s.seen_messages.add(key)
        parent = getattr(msg, "parent_tool_use_id", None)
        agent_id = s.task_calls.get(str(parent), s.main_id) if parent else s.main_id
        tools = [b.name for b in getattr(msg, "content", []) if type(b).__name__ == "ToolUseBlock"]
        text = " ".join(
            getattr(b, "text", "")
            for b in getattr(msg, "content", [])
            if type(b).__name__ == "TextBlock"
        ).strip()
        captured = self._content("llm.output", text or None)
        tin = (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
        )
        summary = (
            "chose tool: " + ", ".join(tools)
            if tools
            else (
                truncate(captured, 200)
                if isinstance(captured, str) and captured
                else f"{msg.model} replied"
            )
        )
        self._emit(
            s,
            "llm.call",
            {
                "provider": "anthropic",
                "operation": "chat",
                "finish_reason": getattr(msg, "stop_reason", None),
                "output": captured,
            },
            agent_id,
            tokens_in=tin or None,
            tokens_out=usage.get("output_tokens"),
            model=getattr(msg, "model", None),
            summary=summary,
        )

    def _result(self, msg: Any) -> None:
        s = self._session(str(getattr(msg, "session_id", None) or "session"))
        cost = getattr(msg, "total_cost_usd", None)
        if cost:
            # Per-message costs aren't reported; attach the session's billed cost as one entry so
            # run and agent totals are right (tokens were already counted per message).
            self._emit(
                s,
                "llm.call",
                {
                    "provider": "anthropic",
                    "operation": "chat",
                    "duration_ms": getattr(msg, "duration_api_ms", None),
                },
                s.main_id,
                cost_usd=float(cost),
                summary=f"session cost ${float(cost):.4f} ({getattr(msg, 'num_turns', '?')} turns)",
            )
        if getattr(msg, "is_error", False):
            self._emit(
                s,
                "error",
                {
                    "message": truncate(
                        "; ".join(getattr(msg, "errors", None) or ["run failed"]), 2000
                    ),
                    "kind": str(getattr(msg, "subtype", "error")),
                },
                s.main_id,
            )
            self._status(s, s.main_id, "error")


# ---------------- public helpers ----------------

_default = ClaudeAgentTracker()


def instrument_options(
    options: T, *, name: str | None = None, team: str | None = None, role: str | None = None
) -> T:
    """Return a copy of ``ClaudeAgentOptions`` with AgentSpace hooks added (yours keep running)."""
    global _default
    try:
        if name or team or role:
            _default = ClaudeAgentTracker(name or "Claude", team, role)
        hooks: dict[str, list[Any]] = {
            k: list(v) for k, v in (getattr(options, "hooks", None) or {}).items()
        }
        for event, matchers in _default.hooks().items():
            hooks.setdefault(event, []).extend(matchers)
        return dataclasses.replace(options, hooks=hooks)  # type: ignore[type-var]
    except Exception as exc:
        internal_error("claude_agent_sdk.instrument_options", exc)
        return options


async def track(
    messages: AsyncIterator[T], tracker: ClaudeAgentTracker | None = None
) -> AsyncIterator[T]:
    """Pass every message through unchanged, recording model usage and cost on the way."""
    t = tracker or _default
    async for message in messages:
        t.observe(message)
        yield message


def replay(recording: list[dict[str, Any]], tracker: ClaudeAgentTracker | None = None) -> None:
    """Feed a recorded session (hook payloads + messages) through the adapter, no CLI needed.

    Items look like ``{"hook": "PreToolUse", "data": {...}, "tool_use_id": "..."}`` or
    ``{"message": "AssistantMessage", "data": {...}}``; see the example's recording.
    """
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolUseBlock

    t = tracker or _default
    for item in recording:
        if "hook" in item:
            t.handle(item["hook"], dict(item["data"]), item.get("tool_use_id"))
        elif item.get("message") == "AssistantMessage":
            d = dict(item["data"])
            blocks: list[Any] = [
                ToolUseBlock(id=b["id"], name=b["name"], input=b.get("input", {}))
                if b["type"] == "tool_use"
                else TextBlock(text=b["text"])
                for b in d.pop("content")
            ]
            t.observe(AssistantMessage(content=blocks, **d))
        elif item.get("message") == "ResultMessage":
            t.observe(ResultMessage(**item["data"]))


def instrument(client: Client | None = None) -> bool:
    """No global hook exists for the Claude Agent SDK; use ``instrument_options`` + ``track``."""
    return False
