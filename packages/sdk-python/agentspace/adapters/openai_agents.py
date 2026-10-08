"""OpenAI Agents SDK adapter.

Uses the SDK's official tracing extension point: a ``TracingProcessor`` registered with
``agents.add_trace_processor``. The SDK calls it live on every trace/span start and end.

Mapping:

- trace                      -> run.started / run.finished (unless inside agentspace.run())
- ``agent`` span             -> agent: agent.registered, step.started(kind=agent), status
- ``handoff`` span           -> handoff (explicit, from_agent -> to_agent)
- agent span nested inside another agent's span (agent-as-tool) -> handoff (delegation)
- ``generation`` / ``response`` span -> llm.call (model, tokens, duration)
- ``function`` span          -> tool.call + tool.result (+ using_tool status)
- ``custom`` / ``guardrail`` span -> step (kind=custom)
- turn / task / other spans  -> context only (children inherit the agent)

Controls: an operator's cancel raises ``agentspace.Cancelled`` at the next agent, model or
tool span start (the run finishes as "cancelled"). Pausing needs an async hook, because the
SDK runs on an event loop: pass ``hooks=agentspace.adapters.openai_agents.ControlHooks()`` to
``Runner.run`` and runs pause before the next agent, model or tool call.

Policy (D-045): tracing can observe a tool call but not refuse it, so the policy is checked by
the SDK's tool input guardrails. ``apply_policy(agent)`` adds ``policy_guardrail`` to the
function tools of the agent and the agents it hands off to (or add it yourself:
``@function_tool(tool_input_guardrails=[policy_guardrail])``). A blocked or refused call doesn't
run; the model gets the reason as the tool's output.

The team (office room) defaults to the trace's workflow name. Override it with trace metadata
``{"agentspace_team": "..."}`` (``RunConfig(trace_metadata=...)``).
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from agents import RunHooks
from agents.tool_guardrails import (
    ToolGuardrailFunctionOutput,
    ToolInputGuardrail,
    ToolInputGuardrailData,
)
from agents.tracing import SpanError, TracingProcessor, get_current_span, get_current_trace

from agentspace import _api
from agentspace._client import AgentInfo
from agentspace._context import current_run
from agentspace._control import Cancelled, adapter_acheckpoint, raise_if_cancelled
from agentspace._log import internal_error, warn_limited
from agentspace._oversight import PolicyDenied, aguard_tool
from agentspace._policy import evaluate_policy
from agentspace._util import slugify, truncate

if TYPE_CHECKING:
    from agents.tracing import Span, Trace

    from agentspace._client import Client


@dataclass
class _Run:
    run_id: str
    owned: bool
    team_id: str | None
    t0: float
    agents: set[str] = field(default_factory=set)
    last_status: dict[str, tuple[str, str | None]] = field(default_factory=dict)


@dataclass
class _Node:
    run: _Run
    agent_id: str | None
    step_id: str | None
    kind: str
    t0: float
    name: str | None = None
    parent_step: str | None = None
    guarded: bool = False  # a function span the policy guardrail checked


class AgentSpaceTracingProcessor(TracingProcessor):
    """Streams OpenAI Agents SDK traces to AgentSpace. Thread-safe; never raises."""

    def __init__(self) -> None:
        self._runs: dict[str, _Run] = {}
        self._nodes: dict[str, _Node] = {}
        self._lock = threading.Lock()

    # ---------------- helpers ----------------

    @staticmethod
    def _client() -> Client | None:
        return _api.get_client()

    def _emit(self, node: _Node, type: str, data: dict[str, Any], **fields: Any) -> None:
        client = self._client()
        if client is None:
            return
        fields.setdefault("agent_id", node.agent_id)
        fields.setdefault("team_id", node.run.team_id if node.agent_id else None)
        fields.setdefault("parent_id", node.step_id)
        client.emit(type, data, run_id=node.run.run_id, **fields)

    def _status(self, node: _Node, status: str, detail: str | None = None) -> None:
        if node.agent_id:
            with self._lock:
                if node.run.last_status.get(node.agent_id) == (status, detail):
                    return  # nothing changed
                node.run.last_status[node.agent_id] = (status, detail)
            self._emit(
                node,
                "agent.status",
                {"status": status, "detail": truncate(detail, 500) if detail else None},
            )

    def _parent(self, span: Span[Any]) -> _Node | None:
        if span.parent_id and span.parent_id in self._nodes:
            return self._nodes[span.parent_id]
        run = self._runs.get(span.trace_id)
        return _Node(run, None, None, "trace", run.t0) if run else None

    # ---------------- traces ----------------

    def on_trace_start(self, trace: Trace) -> None:
        try:
            client = self._client()
            if client is None:
                return
            meta = getattr(trace, "metadata", None) or {}
            active = current_run.get()
            team = meta.get("agentspace_team") or trace.name
            run = _Run(
                active or trace.trace_id,
                active is None,
                slugify(str(team)) if team else None,
                time.monotonic(),
            )
            with self._lock:
                self._runs[trace.trace_id] = run
            if run.owned:
                client.emit(
                    "run.started",
                    {"name": trace.name, "framework": "openai-agents"},
                    run_id=run.run_id,
                    agent_id=None,
                    team_id=None,
                    parent_id=None,
                    summary=trace.name,
                )
        except Exception as exc:
            internal_error("openai_agents.on_trace_start", exc)

    def on_trace_end(self, trace: Trace) -> None:
        try:
            with self._lock:
                run = self._runs.pop(trace.trace_id, None)
                for key in [k for k, n in self._nodes.items() if n.run is run]:
                    del self._nodes[key]
            client = self._client()
            if run is None or client is None:
                return
            cancelled = client.controls.get(run.run_id) == "cancelled"
            for agent_id in sorted(run.agents):
                client.emit(
                    "agent.status",
                    {"status": "done", "detail": "cancelled by an operator" if cancelled else None},
                    run_id=run.run_id,
                    agent_id=agent_id,
                    team_id=run.team_id,
                    parent_id=None,
                )
            if run.owned:
                client.emit(
                    "run.finished",
                    {
                        "status": "cancelled" if cancelled else "ok",
                        "duration_ms": round((time.monotonic() - run.t0) * 1000, 1),
                    },
                    run_id=run.run_id,
                    agent_id=None,
                    team_id=None,
                    parent_id=None,
                )
        except Exception as exc:
            internal_error("openai_agents.on_trace_end", exc)

    # ---------------- spans ----------------

    def on_span_start(self, span: Span[Any]) -> None:
        try:
            if self._client() is None:
                return
            parent = self._parent(span)
            if parent is None:
                return
            data = span.span_data
            kind = data.type
            if kind in ("agent", "generation", "response", "function"):
                agent_id = slugify(str(data.name)) if kind == "agent" else parent.agent_id
                team = parent.run.team_id if agent_id else None
                raise_if_cancelled(parent.run.run_id, agent_id, team)  # may raise Cancelled
            node = _Node(
                parent.run,
                parent.agent_id,
                parent.step_id,
                kind,
                time.monotonic(),
                parent_step=parent.step_id,
            )

            if kind == "agent":
                node = self._start_agent(span, parent)
            elif kind in ("generation", "response"):
                self._status(node, "thinking")
            elif kind == "function":
                node.name = str(getattr(data, "name", "tool"))
                self._status(node, "using_tool", node.name)
                # The SDK fills in the arguments while the span runs. When they're needed (content
                # capture, or the arguments hash), tool.call is sent at span end so it can carry
                # them; otherwise it's sent now.
                if not self._needs_arguments():
                    self._tool_call(node, span, None)
            elif kind in ("custom", "guardrail") and getattr(data, "name", None) not in (
                "turn",
                "task",
            ):
                node.name = truncate(str(getattr(data, "name", kind)), 256)
                node.step_id = span.span_id
                self._emit(
                    node,
                    "step.started",
                    {"step_id": span.span_id, "name": node.name, "kind": "custom"},
                    parent_id=parent.step_id,
                )

            with self._lock:
                self._nodes[span.span_id] = node
        except Exception as exc:
            internal_error("openai_agents.on_span_start", exc)

    def _start_agent(self, span: Span[Any], parent: _Node) -> _Node:
        client = self._client()
        name = str(span.span_data.name)
        agent_id = slugify(name)
        run = parent.run
        if client:
            client.upsert_agent(AgentInfo(agent_id, name, run.team_id, framework="openai-agents"))
        node = _Node(
            run,
            agent_id,
            span.span_id,
            "agent",
            time.monotonic(),
            name=name,
            parent_step=parent.step_id,
        )
        with self._lock:
            run.agents.add(agent_id)
        if parent.agent_id and parent.agent_id != agent_id:  # agent used as a tool by another agent
            self._emit(
                node,
                "handoff",
                {"from_agent_id": parent.agent_id, "to_agent_id": agent_id},
                agent_id=parent.agent_id,
                parent_id=parent.step_id,
                summary=f"handed off to {name}",
            )
        self._emit(
            node,
            "step.started",
            {"step_id": span.span_id, "name": name, "kind": "agent"},
            parent_id=parent.step_id,
        )
        self._status(node, "thinking")
        return node

    def on_span_end(self, span: Span[Any]) -> None:
        try:
            with self._lock:
                node = self._nodes.pop(span.span_id, None)
            if node is None or self._client() is None:
                return
            data = span.span_data
            kind = data.type
            err = span.error
            duration = round((time.monotonic() - node.t0) * 1000, 1)
            err_msg = (
                truncate(str(err.get("message") if isinstance(err, dict) else err), 2000)
                if err
                else None
            )

            if kind == "agent" or (node.kind == "custom" and node.step_id == span.span_id):
                if err:
                    self._emit(node, "error", {"message": err_msg or "error", "kind": "AgentError"})
                self._emit(
                    node,
                    "step.finished",
                    {
                        "step_id": span.span_id,
                        "name": node.name or kind,
                        "ok": not err,
                        "duration_ms": duration,
                        "error": err_msg,
                    },
                    parent_id=node.parent_step,
                )
                if kind == "agent":
                    self._status(node, "error" if err else "idle", err_msg)
            elif kind in ("generation", "response"):
                model, tin, tout, cread, cwrite = _usage(data)
                self._emit(
                    node,
                    "llm.call",
                    {
                        "provider": "openai" if kind == "response" else None,
                        "operation": "chat",
                        "duration_ms": duration,
                        "input": self._content("llm.input", getattr(data, "input", None)),
                        "output": self._content("llm.output", getattr(data, "output", None)),
                    },
                    tokens_in=tin,
                    tokens_out=tout,
                    tokens_cache_read=cread,
                    tokens_cache_write=cwrite,
                    model=model,
                    summary=f"{model or 'model'} replied",
                )
                if err:
                    self._emit(
                        node, "error", {"message": err_msg or "model error", "kind": "ModelError"}
                    )
            elif kind == "handoff":
                # from_agent/to_agent are only filled in by the time the span ends.
                src = getattr(data, "from_agent", None)
                dst = getattr(data, "to_agent", None)
                if src and dst:
                    self._emit(
                        node,
                        "handoff",
                        {"from_agent_id": slugify(src), "to_agent_id": slugify(dst)},
                        agent_id=slugify(src),
                        summary=f"handed off to {dst}",
                    )
            elif kind == "function":
                if not node.guarded:
                    self._warn_unguarded(node)
                if self._needs_arguments():
                    self._tool_call(node, span, getattr(data, "input", None))
                self._emit(
                    node,
                    "tool.result",
                    {
                        "tool_name": node.name or "tool",
                        "call_id": span.span_id,
                        "ok": not err,
                        "duration_ms": duration,
                        "error": err_msg,
                        "result": None
                        if err
                        else self._content("tool.result", getattr(data, "output", None)),
                    },
                    summary=f"{node.name} {'failed' if err else 'ok'}",
                )
                self._status(node, "thinking")
        except Exception as exc:
            internal_error("openai_agents.on_span_end", exc)

    def _warn_unguarded(self, node: _Node) -> None:
        """The policy has a say about a call that didn't go through ``policy_guardrail``."""
        client = self._client()
        policies = client.policies() if client else []
        if not client or not policies:
            return
        tool = node.name or "tool"
        escalated = node.run.run_id in client.escalated
        decision = evaluate_policy(policies, tool, node.agent_id, escalated)
        if decision.action != "allow":
            warn_limited(
                f"openai_agents.unguarded:{tool}",
                "agentspace: the policy says %s for %s, but this tool call wasn't checked. Use "
                "apply_policy(agent) or tool_input_guardrails=[policy_guardrail].",
                decision.action,
                tool,
                interval=3600.0,
            )

    def _tool_call(self, node: _Node, span: Span[Any], arguments: Any) -> None:
        self._emit(
            node,
            "tool.call",
            {
                "tool_name": node.name or "tool",
                "call_id": span.span_id,
                "arguments": self._content("tool.arguments", arguments),
                "arguments_hash": self._args_hash(arguments) if arguments is not None else None,
            },
            summary=f"{node.name}()",
        )

    def _needs_arguments(self) -> bool:
        client = self._client()
        return bool(client and (client.config.capture_content or client.config.hash_arguments))

    def _content(self, field_name: str, value: Any) -> Any:
        client = self._client()
        return client.content(field_name, value) if client else None

    def _args_hash(self, value: Any) -> str | None:
        client = self._client()
        return client.args_hash(value) if client else None

    def shutdown(self) -> None:
        pass

    def force_flush(self) -> None:
        _api.flush(timeout=2.0)


def _usage(data: Any) -> tuple[str | None, int | None, int | None, int | None, int | None]:
    """Model name and token usage (input, output, cache read, cache write) from a generation or
    response span. OpenAI counts cached tokens inside ``input_tokens``."""
    usage = getattr(data, "usage", None)
    model = getattr(data, "model", None)
    response = getattr(data, "response", None)
    if response is not None:
        model = model or getattr(response, "model", None)
        usage = usage or getattr(response, "usage", None)
    if isinstance(usage, dict):
        tin, tout = usage.get("input_tokens"), usage.get("output_tokens")
        details = usage.get("input_tokens_details") or {}
        cread, cwrite = details.get("cached_tokens"), details.get("cache_write_tokens")
    else:
        tin, tout = getattr(usage, "input_tokens", None), getattr(usage, "output_tokens", None)
        details = getattr(usage, "input_tokens_details", None)
        cread = getattr(details, "cached_tokens", None)
        cwrite = getattr(details, "cache_write_tokens", None)
    return (
        str(model) if model else None,
        _int(tin),
        _int(tout),
        _int(cread) or None,
        _int(cwrite) or None,
    )


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None and int(v) >= 0 else None
    except (TypeError, ValueError):
        return None


class ControlHooks(RunHooks[Any]):
    """Run hooks that make agent, model and tool starts pause/cancel safe points.

    ``Runner.run(agent, input, hooks=ControlHooks())``. Pausing waits in a thread, so the
    event loop keeps running. Subclass it to add your own hooks (call ``super()``).
    """

    async def on_agent_start(self, context: Any, agent: Any) -> None:
        await self._checkpoint(agent)

    async def on_llm_start(
        self, context: Any, agent: Any, system_prompt: Any, input_items: Any
    ) -> None:
        await self._checkpoint(agent)

    async def on_tool_start(self, context: Any, agent: Any, tool: Any) -> None:
        await self._checkpoint(agent)

    @staticmethod
    async def _checkpoint(agent: Any) -> None:
        trace = get_current_trace()
        run = get_processor()._runs.get(trace.trace_id) if trace else None
        run_id = run.run_id if run else current_run.get()
        if not run_id:
            return
        agent_id = slugify(str(getattr(agent, "name", ""))) or None
        await adapter_acheckpoint(run_id, agent_id, run.team_id if run else None)


# ---------------- policy (D-045) ----------------


async def _check_policy(data: ToolInputGuardrailData) -> ToolGuardrailFunctionOutput:
    ctx = data.context
    tool = str(ctx.tool_name)
    try:
        span = get_current_span()
        processor = get_processor()
        node = processor._nodes.get(span.span_id) if span else None
        if node is not None:
            node.guarded = True
        trace = get_current_trace()
        run = processor._runs.get(trace.trace_id) if trace else None
        try:
            arguments: Any = json.loads(ctx.tool_arguments) if ctx.tool_arguments else None
        except ValueError:
            arguments = ctx.tool_arguments
        agent_id = slugify(str(getattr(data.agent, "name", ""))) or None
    except Exception as exc:
        internal_error("openai_agents.policy", exc)
        span, run, arguments, agent_id = None, None, None, None
    try:
        await aguard_tool(
            tool,
            arguments,
            run_id=run.run_id if run else None,
            agent_id=agent_id,
            team_id=run.team_id if run and agent_id else None,
        )
    except PolicyDenied as denied:
        if span is not None:
            # The function span (and every trace processor) sees the call as failed.
            span.set_error(SpanError(message=str(denied), data={"kind": "PolicyDenied"}))
        return ToolGuardrailFunctionOutput.reject_content(str(denied))
    return ToolGuardrailFunctionOutput.allow()


#: Checks each function tool call against the policy before it runs (D-045).
policy_guardrail: ToolInputGuardrail[Any] = ToolInputGuardrail(
    guardrail_function=_check_policy, name="agentspace_policy"
)


def apply_policy(*agents: Any) -> None:
    """Add :data:`policy_guardrail` to the function tools of ``agents`` and of the agents they
    hand off to. Idempotent. It changes the tool objects, so shared tools are guarded everywhere.
    """
    from agents import Agent, FunctionTool

    seen: set[int] = set()
    todo = list(agents)
    while todo:
        agent = todo.pop()
        if id(agent) in seen or not isinstance(agent, Agent):
            continue
        seen.add(id(agent))
        for tool in agent.tools:
            if isinstance(tool, FunctionTool):
                guards = list(tool.tool_input_guardrails or [])
                if policy_guardrail not in guards:
                    tool.tool_input_guardrails = [*guards, policy_guardrail]
        todo.extend(h for h in agent.handoffs if isinstance(h, Agent))


_processor: AgentSpaceTracingProcessor | None = None


def instrument(client: Client | None = None) -> bool:
    """Register the processor with the OpenAI Agents SDK. Idempotent."""
    global _processor
    if _processor is not None:
        return True
    from agents import add_trace_processor

    _processor = AgentSpaceTracingProcessor()
    add_trace_processor(_processor)
    return True


def get_processor() -> AgentSpaceTracingProcessor:
    """The shared processor, e.g. for ``agents.set_trace_processors([get_processor()])``."""
    global _processor
    if _processor is None:
        _processor = AgentSpaceTracingProcessor()
    return _processor


__all__ = [
    "AgentSpaceTracingProcessor",
    "Cancelled",
    "ControlHooks",
    "apply_policy",
    "get_processor",
    "instrument",
    "policy_guardrail",
]
