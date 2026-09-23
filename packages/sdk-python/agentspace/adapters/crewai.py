"""CrewAI adapter.

Uses CrewAI's official event system: a ``BaseEventListener`` subscribed to the global
``crewai_event_bus``.

CrewAI runs synchronous handlers in a thread pool, so events can reach us concurrently and out
of order. The adapter therefore:

- stamps every AgentSpace event with CrewAI's own event timestamp, not the arrival time;
- processes events one at a time under a lock;
- drops agent-status updates that are older than one already applied, so a late "thinking"
  can never overwrite "done".

Mapping:

- crew kickoff started / completed / failed -> run.started / run.finished
- agent execution started / completed / error -> agent (registered, step, status)
- next agent in a crew                     -> handoff from the previous agent
- "Delegate work to coworker" / "Ask question to coworker" tools -> handoff to the coworker
- LLM call started / completed / failed    -> status + llm.call (tokens, model, duration)
- tool usage started / finished / error    -> status + tool.call / tool.result

The team (office room) is the crew's name. CrewAI crews always get their own run: handlers run
on CrewAI's threads, so an enclosing ``agentspace.run()`` isn't visible to them.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from crewai.events import BaseEventListener

from agentspace import _api
from agentspace._client import AgentInfo
from agentspace._log import internal_error
from agentspace._util import new_id, slugify, truncate

if TYPE_CHECKING:
    from agentspace._client import Client

DELEGATION_TOOLS = {"delegate work to coworker", "ask question to coworker"}


@dataclass
class _Run:
    run_id: str
    team_id: str | None
    started: datetime
    last_agent: str | None = None
    agents: set[str] = field(default_factory=set)
    #: agent_id -> step_id of its current execution
    steps: dict[str, str] = field(default_factory=dict)
    #: agent_id -> (timestamp, status, detail) of the newest status applied
    status: dict[str, tuple[datetime, str, str | None]] = field(default_factory=dict)


class AgentSpaceCrewListener(BaseEventListener):
    """Streams CrewAI events to AgentSpace. Registered once per process; never raises."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runs: list[_Run] = []  # active runs, newest last
        self._started: dict[str, datetime] = {}  # event_id -> timestamp (for durations)
        super().__init__()

    # ---------------- plumbing ----------------

    @staticmethod
    def _client() -> Client | None:
        return _api.get_client()

    def _run(self) -> _Run | None:
        return self._runs[-1] if self._runs else None

    def _emit(
        self,
        run: _Run,
        ev: Any,
        type: str,
        data: dict[str, Any],
        agent_id: str | None,
        **fields: Any,
    ) -> None:
        client = self._client()
        if client is None:
            return
        fields.setdefault("team_id", run.team_id if agent_id else None)
        fields.setdefault("parent_id", run.steps.get(agent_id) if agent_id else None)
        client.emit(type, data, run_id=run.run_id, agent_id=agent_id, ts=_iso(_ts(ev)), **fields)

    def _status(
        self, run: _Run, ev: Any, agent_id: str | None, status: str, detail: str | None = None
    ) -> None:
        if not agent_id:
            return
        when = _ts(ev)
        prev = run.status.get(agent_id)
        if prev and (prev[0] > when or (prev[1], prev[2]) == (status, detail)):
            return  # stale (arrived out of order) or unchanged
        run.status[agent_id] = (when, status, detail)
        self._emit(
            run,
            ev,
            "agent.status",
            {"status": status, "detail": truncate(detail, 500) if detail else None},
            agent_id,
        )

    def _content(self, field_name: str, value: Any) -> Any:
        client = self._client()
        return client.content(field_name, value) if client else None

    def _guard(self, where: str, fn: Any, *args: Any) -> None:
        if self._client() is None:
            return
        try:
            with self._lock:
                fn(*args)
        except Exception as exc:
            internal_error(f"crewai.{where}", exc)

    # ---------------- registration ----------------

    def setup_listeners(self, crewai_event_bus: Any) -> None:
        from crewai.events.types import agent_events as ae
        from crewai.events.types import crew_events as ce
        from crewai.events.types import llm_events as le
        from crewai.events.types import tool_usage_events as tu

        handlers = {
            ce.CrewKickoffStartedEvent: self._crew_started,
            ce.CrewKickoffCompletedEvent: self._crew_completed,
            ce.CrewKickoffFailedEvent: self._crew_failed,
            ae.AgentExecutionStartedEvent: self._agent_started,
            ae.AgentExecutionCompletedEvent: self._agent_completed,
            ae.AgentExecutionErrorEvent: self._agent_error,
            le.LLMCallStartedEvent: self._llm_started,
            le.LLMCallCompletedEvent: self._llm_completed,
            le.LLMCallFailedEvent: self._llm_failed,
            tu.ToolUsageStartedEvent: self._tool_started,
            tu.ToolUsageFinishedEvent: self._tool_finished,
            tu.ToolUsageErrorEvent: self._tool_error,
        }
        for event_type, handler in handlers.items():
            crewai_event_bus.on(event_type)(_bind(self, handler.__name__))

    # ---------------- crew ----------------

    def _crew_started(self, source: Any, ev: Any) -> None:
        client = self._client()
        if client is None:
            return
        name = getattr(ev, "crew_name", None) or getattr(source, "name", None) or "crew"
        run = _Run(new_id(), slugify(str(name)), _ts(ev))
        self._runs.append(run)
        client.emit(
            "run.started",
            {
                "name": str(name),
                "framework": "crewai",
                "input": self._content("run.input", getattr(ev, "inputs", None)),
            },
            run_id=run.run_id,
            agent_id=None,
            team_id=None,
            parent_id=None,
            ts=_iso(_ts(ev)),
            summary=str(name),
        )

    def _finish_run(self, ev: Any, ok: bool, error: str | None) -> None:
        run = self._run()
        client = self._client()
        if run is None or client is None:
            return
        self._runs.remove(run)
        final = "done" if ok else "error"
        for agent_id in sorted(run.agents):
            prev = run.status.get(agent_id)
            if not prev or prev[1] != "error":
                self._status(run, ev, agent_id, final)
        if error:
            client.emit(
                "error",
                {"message": truncate(error, 2000), "kind": "CrewError"},
                run_id=run.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
                ts=_iso(_ts(ev)),
            )
        duration = max(0.0, (_ts(ev) - run.started).total_seconds() * 1000)
        client.emit(
            "run.finished",
            {
                "status": "ok" if ok else "error",
                "duration_ms": round(duration, 1),
                "output": self._content("run.output", str(getattr(ev, "output", "")) or None),
            },
            run_id=run.run_id,
            agent_id=None,
            team_id=None,
            parent_id=None,
            ts=_iso(_ts(ev)),
        )

    def _crew_completed(self, source: Any, ev: Any) -> None:
        self._finish_run(ev, True, None)

    def _crew_failed(self, source: Any, ev: Any) -> None:
        self._finish_run(ev, False, str(getattr(ev, "error", "crew failed")))

    # ---------------- agents ----------------

    def _agent_started(self, source: Any, ev: Any) -> None:
        run = self._run()
        client = self._client()
        if run is None or client is None:
            return
        role = _role(ev) or "agent"
        agent_id = slugify(role)
        agent = getattr(ev, "agent", None)
        client.upsert_agent(
            AgentInfo(
                agent_id,
                role,
                run.team_id,
                role=truncate(str(getattr(agent, "goal", "") or ""), 256) or None,
                framework="crewai",
            )
        )
        run.agents.add(agent_id)
        if run.last_agent and run.last_agent != agent_id:
            self._emit(
                run,
                ev,
                "handoff",
                {"from_agent_id": run.last_agent, "to_agent_id": agent_id},
                run.last_agent,
                parent_id=None,
                summary=f"handed off to {role}",
            )
        run.last_agent = agent_id
        step_id = ev.event_id
        task = getattr(ev, "task", None)
        name = truncate(
            str(getattr(task, "name", None) or getattr(task, "description", None) or role), 256
        )
        self._emit(
            run,
            ev,
            "step.started",
            {"step_id": step_id, "name": name, "kind": "agent"},
            agent_id,
            parent_id=None,
        )
        run.steps[agent_id] = step_id
        self._started[ev.event_id] = _ts(ev)
        self._status(run, ev, agent_id, "thinking")

    def _agent_done(self, ev: Any, error: str | None) -> None:
        run = self._run()
        if run is None:
            return
        agent_id = slugify(_role(ev) or "agent")
        step_id = run.steps.pop(agent_id, None)
        if error:
            self._emit(
                run,
                ev,
                "error",
                {"message": truncate(error, 2000), "kind": "AgentError"},
                agent_id,
                parent_id=step_id,
            )
        if step_id:
            started = self._started.pop(step_id, None)
            duration = (_ts(ev) - started).total_seconds() * 1000 if started else None
            self._emit(
                run,
                ev,
                "step.finished",
                {
                    "step_id": step_id,
                    "name": truncate(_role(ev) or "agent", 256),
                    "ok": error is None,
                    "duration_ms": round(max(0.0, duration), 1) if duration is not None else None,
                    "error": truncate(error, 2000) if error else None,
                },
                agent_id,
                parent_id=None,
            )
        self._status(run, ev, agent_id, "error" if error else "idle", error)

    def _agent_completed(self, source: Any, ev: Any) -> None:
        self._agent_done(ev, None)

    def _agent_error(self, source: Any, ev: Any) -> None:
        self._agent_done(ev, str(getattr(ev, "error", "error")))

    # ---------------- LLM calls ----------------

    def _llm_started(self, source: Any, ev: Any) -> None:
        run = self._run()
        if run is None:
            return
        self._started[ev.event_id] = _ts(ev)
        self._status(
            run,
            ev,
            _agent_id(ev),
            "thinking",
            f"asking {ev.model}" if getattr(ev, "model", None) else None,
        )

    def _llm_completed(self, source: Any, ev: Any) -> None:
        run = self._run()
        if run is None:
            return
        agent_id = _agent_id(ev)
        started = self._started.pop(getattr(ev, "started_event_id", None) or "", None)
        usage = getattr(ev, "usage", None) or {}
        tin = usage.get("prompt_tokens", usage.get("input_tokens"))
        tout = usage.get("completion_tokens", usage.get("output_tokens"))
        response = getattr(ev, "response", None)
        text = response if isinstance(response, str) else None
        captured = self._content("llm.output", text)
        if isinstance(captured, str) and captured.strip():
            summary = truncate(" ".join(captured.split()), 200)
        else:
            summary = (
                _react_summary(text) if text else None
            ) or f"{getattr(ev, 'model', None) or 'model'} replied"
        self._emit(
            run,
            ev,
            "llm.call",
            {
                "provider": _provider(getattr(ev, "model", None)),
                "operation": "chat",
                "duration_ms": round(max(0.0, (_ts(ev) - started).total_seconds() * 1000), 1)
                if started
                else None,
                "finish_reason": getattr(ev, "finish_reason", None),
                "input": self._content("llm.input", getattr(ev, "messages", None)),
                "output": captured,
            },
            agent_id,
            tokens_in=_int(tin),
            tokens_out=_int(tout),
            model=getattr(ev, "model", None),
            summary=summary,
        )

    def _llm_failed(self, source: Any, ev: Any) -> None:
        run = self._run()
        if run is None:
            return
        self._emit(
            run,
            ev,
            "error",
            {
                "message": truncate(str(getattr(ev, "error", "LLM call failed")), 2000),
                "kind": "LLMError",
            },
            _agent_id(ev),
        )

    # ---------------- tools ----------------

    def _tool_started(self, source: Any, ev: Any) -> None:
        run = self._run()
        if run is None:
            return
        agent_id = _agent_id(ev)
        tool = str(getattr(ev, "tool_name", "tool"))
        self._started[ev.event_id] = _ts(ev)
        self._status(run, ev, agent_id, "using_tool", tool)
        self._emit(
            run,
            ev,
            "tool.call",
            {
                "tool_name": truncate(tool, 256),
                "call_id": ev.event_id,
                "arguments": self._content("tool.arguments", getattr(ev, "tool_args", None)),
            },
            agent_id,
            summary=f"{tool}()",
        )
        if tool.strip().lower() in DELEGATION_TOOLS and agent_id:
            coworker = _coworker(getattr(ev, "tool_args", None))
            if coworker and slugify(coworker) != agent_id:
                self._emit(
                    run,
                    ev,
                    "handoff",
                    {
                        "from_agent_id": agent_id,
                        "to_agent_id": slugify(coworker),
                        "reason": truncate(tool, 500),
                    },
                    agent_id,
                    summary=f"handed off to {coworker}",
                )

    def _tool_done(self, ev: Any, error: str | None) -> None:
        run = self._run()
        if run is None:
            return
        agent_id = _agent_id(ev)
        call_id = getattr(ev, "started_event_id", None) or ev.event_id
        started = self._started.pop(call_id, None)
        begin = getattr(ev, "started_at", None) or started
        end = getattr(ev, "finished_at", None) or _ts(ev)
        duration = (_aware(end) - _aware(begin)).total_seconds() * 1000 if begin else None
        failure = getattr(ev, "failure", None)
        if error is None and failure is not None:
            error = str(getattr(failure, "message", failure))
        self._emit(
            run,
            ev,
            "tool.result",
            {
                "tool_name": truncate(str(getattr(ev, "tool_name", "tool")), 256),
                "call_id": call_id,
                "ok": error is None,
                "duration_ms": round(max(0.0, duration), 1) if duration is not None else None,
                "error": truncate(error, 2000) if error else None,
                "result": None
                if error
                else self._content("tool.result", getattr(ev, "output", None)),
            },
            agent_id,
            summary=f"{getattr(ev, 'tool_name', 'tool')} {'failed' if error else 'ok'}",
        )
        self._status(run, ev, agent_id, "thinking")

    def _tool_finished(self, source: Any, ev: Any) -> None:
        self._tool_done(ev, None)

    def _tool_error(self, source: Any, ev: Any) -> None:
        self._tool_done(ev, str(getattr(ev, "error", "tool failed")))


# ---------------- helpers ----------------


def _bind(listener: AgentSpaceCrewListener, name: str) -> Any:
    def handler(source: Any, event: Any) -> None:
        listener._guard(name, getattr(listener, name), source, event)

    handler.__name__ = f"agentspace_{name}"
    return handler


def _ts(ev: Any) -> datetime:
    return _aware(getattr(ev, "timestamp", None) or datetime.now(timezone.utc))


def _aware(dt: Any) -> datetime:
    if not isinstance(dt, datetime):
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _role(ev: Any) -> str | None:
    for attr in ("agent", "from_agent"):
        role = getattr(getattr(ev, attr, None), "role", None)
        if role:
            return str(role)
    role = getattr(ev, "agent_role", None)
    return str(role) if role else None


def _agent_id(ev: Any) -> str | None:
    role = _role(ev)
    return slugify(role) if role else None


def _coworker(args: Any) -> str | None:
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return None
    if isinstance(args, dict):
        value = args.get("coworker")
        return str(value) if value else None
    return None


def _provider(model: str | None) -> str | None:
    if not model:
        return None
    if "/" in model:
        return model.split("/", 1)[0]
    lower = model.lower()
    for prefix, provider in (
        ("claude", "anthropic"),
        ("gpt", "openai"),
        ("o1", "openai"),
        ("o3", "openai"),
        ("gemini", "google"),
    ):
        if lower.startswith(prefix):
            return provider
    return None


def _react_summary(text: str) -> str | None:
    """A metadata-only summary for ReAct replies: which tool was chosen, or that it answered."""
    for line in text.splitlines():
        s = line.strip()
        if s.lower().startswith("action:"):
            return "chose tool: " + truncate(s.split(":", 1)[1].strip(), 200)
        if s.lower().startswith("final answer"):
            return "wrote the final answer"
    return None


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None and int(v) >= 0 else None
    except (TypeError, ValueError):
        return None


_listener: AgentSpaceCrewListener | None = None


def instrument(client: Client | None = None) -> bool:
    """Subscribe to CrewAI's event bus. Idempotent."""
    global _listener
    if _listener is None:
        _listener = AgentSpaceCrewListener()
    return True
