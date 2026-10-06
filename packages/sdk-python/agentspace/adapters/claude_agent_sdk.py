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
- AssistantMessage (via track)    -> llm.call with model, tokens and cache tokens
                                     (cost_source="reported": the cost comes on ResultMessage)
- ResultMessage (via track)       -> session cost (an llm.call carrying only cost_usd)

Controls: every PreToolUse is a safe point. While the run is paused the hook waits (off the
event loop) before the tool runs; once it's cancelled the hook denies the tool and stops the
session (``continue: false``), and the run finishes as "cancelled". Cancelling is final, so
later prompts in the same session are stopped too.

Approvals: ``ClaudeAgentOptions(can_use_tool=approval_callback())`` asks a person in the
office before each tool call (or only the tools you list) and fails closed.
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
from agentspace._control import Cancelled, adapter_acheckpoint, request_approval
from agentspace._log import internal_error
from agentspace._util import slugify, truncate

if TYPE_CHECKING:
    from agentspace._client import Client

T = TypeVar("T")

#: How long a PreToolUse hook may wait while the run is paused (the SDK's default is 60 s).
PAUSE_HOOK_TIMEOUT_S = 3600.0
CANCELLED_REASON = "Cancelled by an operator in AgentSpace"

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
    #: assistant messages still being assembled: the SDK splits one API response into several
    #: AssistantMessages with the same message id, and early ones carry partial usage.
    pending: dict[str, dict[str, Any]] = field(default_factory=dict)
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

    def _args_hash(self, value: Any) -> str | None:
        client = self._client()
        return client.args_hash(value) if client else None

    # ---------------- hooks ----------------

    def hooks(self) -> dict[str, list[Any]]:
        """``{event: [HookMatcher(...)]}`` for ``ClaudeAgentOptions(hooks=...)``."""
        from claude_agent_sdk import HookMatcher

        return {
            event: [
                HookMatcher(
                    matcher=None,
                    hooks=[self._callback(event)],
                    timeout=PAUSE_HOOK_TIMEOUT_S if event == "PreToolUse" else None,
                )
            ]
            for event in HOOK_EVENTS
        }

    def _callback(self, event: str) -> Any:
        async def callback(
            input_data: Any, tool_use_id: str | None, context: Any
        ) -> dict[str, Any]:
            data: dict[str, Any] = {}
            try:
                data = dict(input_data)
                self.handle(event, data, tool_use_id)
            except Exception as exc:
                internal_error(f"claude_agent_sdk.{event}", exc)
            if event == "PreToolUse":
                return await self._gate(data)
            return {}  # never change the agent's behaviour

        callback.__name__ = f"agentspace_{event}"
        return callback

    async def _gate(self, data: dict[str, Any]) -> dict[str, Any]:
        """Pause/cancel safe point before a tool runs. Only ever stops, never approves."""
        if self._client() is None:
            return {}
        s = self._session(str(data.get("session_id") or "session"))
        agent_id = self._agent_of(s, data)
        try:
            keep_going = await adapter_acheckpoint(s.run_id, agent_id, s.team_id)
        except Cancelled:
            keep_going = False
        except Exception as exc:
            internal_error("claude_agent_sdk.gate", exc)
            return {}
        if keep_going:
            return {}
        return {
            "continue_": False,
            "stopReason": CANCELLED_REASON,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": CANCELLED_REASON,
            },
        }

    def _cancelled(self, s: _Session) -> bool:
        client = self._client()
        return bool(client and client.controls.get(s.run_id) == "cancelled")

    def handle(self, event: str, data: dict[str, Any], tool_use_id: str | None = None) -> None:
        """Process one hook payload. Public so recorded hook payloads can be replayed."""
        if self._client() is None:
            return
        session_id = str(data.get("session_id") or "session")
        s = self._session(session_id)
        if event in ("PreToolUse", "SubagentStart", "Stop"):
            self._flush_messages(s)  # the model's message that led here is complete
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
                "arguments_hash": self._args_hash(tool_input),
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
        cancelled = self._cancelled(s)
        for agent_id in sorted(s.agents):
            self._status(s, agent_id, "done", "cancelled by an operator" if cancelled else None)
        client.emit(
            "run.finished",
            {
                "status": "cancelled" if cancelled else "ok",
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

    def latest_session(self) -> _Session | None:
        """The most recently started session (``can_use_tool`` isn't told which one)."""
        with self._lock:
            return next(reversed(self._sessions.values()), None) if self._sessions else None

    def status(self, status: str, detail: str | None = None) -> None:
        """Set the main agent's status in the most recent session, e.g. ``waiting_human`` while
        your ``can_use_tool`` callback asks a person."""
        try:
            if self._client() is None or not self._sessions:
                return
            s = self._sessions[next(reversed(self._sessions))]
            self._status(s, s.main_id, status, detail)
        except Exception as exc:
            internal_error("claude_agent_sdk.status", exc)

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
        # A new message id means every earlier message is complete.
        for other in [k for k in s.pending if k != key]:
            self._flush_message(s, other)
        parent = getattr(msg, "parent_tool_use_id", None)
        entry = s.pending.setdefault(
            key,
            {
                "agent_id": s.task_calls.get(str(parent), s.main_id) if parent else s.main_id,
                "model": getattr(msg, "model", None),
                "usage": {},
                "tools": [],
                "text": [],
                "stop_reason": None,
            },
        )
        for k, v in (getattr(msg, "usage", None) or {}).items():
            if isinstance(v, (int, float)):
                entry["usage"][k] = max(entry["usage"].get(k, 0), v)
        for b in getattr(msg, "content", []) or []:
            kind = type(b).__name__
            if kind == "ToolUseBlock":
                entry["tools"].append(b.name)
            elif kind == "TextBlock":
                text = getattr(b, "text", None)
                if text:
                    entry["text"].append(text)
        entry["stop_reason"] = getattr(msg, "stop_reason", None) or entry["stop_reason"]

    def _flush_messages(self, s: _Session) -> None:
        for key in list(s.pending):
            self._flush_message(s, key)

    def _flush_message(self, s: _Session, key: str) -> None:
        entry = s.pending.pop(key, None)
        if entry is None or not entry["usage"]:
            return
        usage = entry["usage"]
        text = " ".join(entry["text"]).strip()
        captured = self._content("llm.output", text or None)
        tin = (
            (usage.get("input_tokens") or 0)
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
        )
        if entry["tools"]:
            summary = "chose tool: " + ", ".join(entry["tools"])
        elif isinstance(captured, str) and captured:
            summary = truncate(captured, 200)
        else:
            summary = f"{entry['model'] or 'model'} replied"
        self._emit(
            s,
            "llm.call",
            {
                "provider": "anthropic",
                "operation": "chat",
                "finish_reason": entry["stop_reason"],
                "output": captured,
            },
            entry["agent_id"],
            tokens_in=tin or None,
            tokens_out=usage.get("output_tokens"),
            tokens_cache_read=usage.get("cache_read_input_tokens") or None,
            tokens_cache_write=usage.get("cache_creation_input_tokens") or None,
            # The SDK bills the whole session on ResultMessage (see _result), so the collector
            # must not also estimate a price for each message.
            cost_source="reported",
            model=entry["model"],
            summary=summary,
        )

    def _result(self, msg: Any) -> None:
        s = self._session(str(getattr(msg, "session_id", None) or "session"))
        self._flush_messages(s)
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
                cost_source="reported",
                summary=f"session cost ${float(cost):.4f} ({getattr(msg, 'num_turns', '?')} turns)",
            )
        cancelled = self._cancelled(s)
        failed = bool(getattr(msg, "is_error", False)) and not cancelled
        if failed:
            self._emit(
                s,
                "error",
                {
                    "message": truncate(
                        "; ".join(
                            getattr(msg, "errors", None)
                            or [str(getattr(msg, "subtype", "run failed"))]
                        ),
                        2000,
                    ),
                    "kind": str(getattr(msg, "subtype", "error")),
                },
                s.main_id,
            )
        # The result message ends the query. If no Stop hook closed the turn (e.g. the budget
        # or turn limit was hit), close it here so the run doesn't stay "running" forever.
        if s.turn_step is not None:
            client = self._client()
            if client is not None:
                self._emit(
                    s,
                    "step.finished",
                    {
                        "step_id": s.turn_step,
                        "name": f"turn {s.turn}",
                        "ok": not failed and not cancelled,
                    },
                    s.main_id,
                    parent_id=None,
                )
                for agent_id in sorted(s.agents):
                    self._status(
                        s,
                        agent_id,
                        "error" if failed and agent_id == s.main_id else "done",
                        "cancelled by an operator" if cancelled else None,
                    )
                client.emit(
                    "run.finished",
                    {
                        "status": "cancelled" if cancelled else "error" if failed else "ok",
                        "duration_ms": getattr(msg, "duration_ms", None),
                    },
                    run_id=s.run_id,
                    agent_id=None,
                    team_id=None,
                    parent_id=None,
                )
                s.turn_step = None
        elif failed:
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


def approval_callback(
    tools: set[str] | list[str] | None = None,
    *,
    timeout: float = 300.0,
    tracker: ClaudeAgentTracker | None = None,
) -> Any:
    """A ``can_use_tool`` callback that asks a person in the office to approve tool calls.

    ``ClaudeAgentOptions(can_use_tool=approval_callback({"Bash", "Write"}))``. Tools not in
    ``tools`` are allowed without asking (``None`` asks for every tool). Fails closed: a
    rejection, timeout, or unreachable collector denies the call. Claude only asks
    ``can_use_tool`` for calls your permission settings don't already allow.
    """
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    wanted = set(tools) if tools is not None else None

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any) -> Any:
        if wanted is not None and tool_name not in wanted:
            return PermissionResultAllow()
        t = tracker or _default
        s = t.latest_session()
        agent_id = team_id = run_id = None
        if s is not None:
            runtime = getattr(context, "agent_id", None)
            agent_id = t._agent_of(s, {"agent_id": runtime}) if runtime else s.main_id
            team_id, run_id = s.team_id, s.run_id
        reason = getattr(context, "title", None) or f"{t.name} wants to use {tool_name}"
        try:
            result = await request_approval(
                reason,
                {"tool": tool_name, "input": tool_input},
                timeout=timeout,
                run_id=run_id,
                agent_id=agent_id,
                team_id=team_id,
            )
        except Cancelled:
            return PermissionResultDeny(message=CANCELLED_REASON, interrupt=True)
        if result.approved:
            return PermissionResultAllow()
        why = result.error or result.comment or f"{result.decision} in AgentSpace"
        return PermissionResultDeny(message=f"Not approved: {why}")

    return can_use_tool


def tracker() -> ClaudeAgentTracker:
    """The tracker ``instrument_options`` configured (for ``tracker().status(...)``)."""
    return _default


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
