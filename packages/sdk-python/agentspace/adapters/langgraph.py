"""LangGraph / LangChain adapter.

Uses LangChain's official callback system:

- ``AgentSpaceCallbackHandler`` is a ``BaseCallbackHandler``. You can pass it yourself:
  ``graph.invoke(x, config={"callbacks": [AgentSpaceCallbackHandler()]})``.
- ``instrument()`` (called by ``agentspace.init()``) registers it globally through
  ``langchain_core.tracers.context.register_configure_hook``, the same public hook LangSmith
  uses, so every graph and runnable is traced with no code changes.

Mapping:

- root chain (no parent)           -> run.started / run.finished (unless inside agentspace.run())
- graph node (name == langgraph_node) -> agent: agent.registered, step.started(kind=agent),
                                      handoff from the previous node's agent, status changes
- chat model / llm                 -> agent.status(thinking) + llm.call (tokens, model, duration)
- tool                             -> agent.status(using_tool) + tool.call / tool.result

Per-call config: ``config={"metadata": {"agentspace_team": "engineering"}}`` sets the team
(the office zone). Otherwise the team is the graph's name. ``agentspace_agents`` can map node
names to display names, e.g. ``{"qa": "QA Engineer"}``.

Controls: an operator's cancel raises ``agentspace.Cancelled`` at the next node, model or
tool start (the run finishes as "cancelled"). Pause blocks there too for sync graphs; async
graphs pause at an ``await agentspace.acheckpoint()`` inside a node.

Python 3.10 + async graphs: LangGraph can't propagate callbacks into model/tool calls made
inside nodes unless the node accepts ``config`` and passes it on (``llm.invoke(x, config)``).
Node/agent/handoff events still work. Python 3.11+ has no such limitation.
"""

from __future__ import annotations

import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from agentspace import _api
from agentspace._client import AgentInfo
from agentspace._context import current_run
from agentspace._control import Cancelled, adapter_checkpoint
from agentspace._log import internal_error
from agentspace._util import slugify, truncate

if TYPE_CHECKING:
    from agentspace._client import Client

_IGNORED_NODES = {"__start__", "__end__"}
_BUBBLE_UP_NAMES = {"GraphInterrupt", "NodeInterrupt", "ParentCommand", "GraphBubbleUp"}


@dataclass
class _Run:
    """Bookkeeping for one LangGraph invocation (one AgentSpace run)."""

    run_id: str
    owned: bool  # we emitted run.started and must emit run.finished
    team_id: str | None
    names: dict[str, str]
    t0: float
    last_agent: str | None = None
    agents: set[str] = field(default_factory=set)
    last_status: dict[str, tuple[str, str | None]] = field(default_factory=dict)


@dataclass
class _Node:
    """Anything with a LangChain run_id we have seen start: root, node, llm, tool, chain."""

    run: _Run
    agent_id: str | None
    step_id: str | None  # the step this node's children hang under
    kind: str  # root | agent | chain | llm | tool
    t0: float
    name: str | None = None
    model: str | None = None
    provider: str | None = None
    call_id: str | None = None
    parent_step: str | None = None  # for agent nodes: the enclosing step


class AgentSpaceCallbackHandler(BaseCallbackHandler):
    """Streams LangChain / LangGraph callbacks to AgentSpace. Safe to share across threads."""

    # Run synchronously inside the caller: all work is an O(1) enqueue, and inline keeps order.
    run_inline = True
    raise_error = False

    def __init__(self) -> None:
        super().__init__()
        self._nodes: dict[UUID, _Node] = {}
        self._lock = threading.Lock()

    # ---------------- helpers ----------------

    @staticmethod
    def _client() -> Client | None:
        return _api.get_client()

    def _parent(self, parent_run_id: UUID | None) -> _Node | None:
        return self._nodes.get(parent_run_id) if parent_run_id else None

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
            key = (status, detail)
            with self._lock:
                if node.run.last_status.get(node.agent_id) == key:
                    return  # nothing changed; don't spam the office
                node.run.last_status[node.agent_id] = key
            self._emit(
                node,
                "agent.status",
                {"status": status, "detail": truncate(detail, 500) if detail else None},
            )

    @staticmethod
    def _checkpoint(parent: _Node) -> None:
        """A safe point: blocks while paused, raises Cancelled once cancelled."""
        team = parent.run.team_id if parent.agent_id else None
        adapter_checkpoint(parent.run.run_id, parent.agent_id, team)

    def _content(self, field_name: str, value: Any) -> Any:
        client = self._client()
        return client.content(field_name, value) if client else None

    # ---------------- chains (graph + nodes) ----------------

    def on_chain_start(
        self,
        serialized: dict[str, Any] | None,
        inputs: Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            client = self._client()
            if client is None:
                return
            metadata = metadata or {}
            name = kwargs.get("name") or (serialized or {}).get("name")
            parent = self._parent(parent_run_id)

            if parent is None:
                self._start_root(client, run_id, name, metadata, inputs)
                return

            node_name = metadata.get("langgraph_node")
            if node_name and name == node_name and node_name not in _IGNORED_NODES:
                agent_id = slugify(str(node_name))
                adapter_checkpoint(parent.run.run_id, agent_id, parent.run.team_id)  # may raise
                self._start_agent(client, run_id, parent, str(node_name))
                return

            # Any other chain (router, sub-runnable): inherit the parent's context.
            with self._lock:
                self._nodes[run_id] = _Node(
                    parent.run, parent.agent_id, parent.step_id, "chain", time.monotonic()
                )
        except Exception as exc:
            internal_error("langgraph.on_chain_start", exc)

    def _start_root(
        self,
        client: Client,
        run_id: UUID,
        name: str | None,
        metadata: dict[str, Any],
        inputs: Any,
    ) -> None:
        active = current_run.get()
        team = metadata.get("agentspace_team") or name
        run = _Run(
            run_id=active or run_id.hex,
            owned=active is None,
            team_id=slugify(str(team)) if team else None,
            names=dict(metadata.get("agentspace_agents") or {}),
            t0=time.monotonic(),
        )
        with self._lock:
            self._nodes[run_id] = _Node(run, None, None, "root", run.t0, name=name)
        if run.owned:
            client.emit(
                "run.started",
                {
                    "name": name,
                    "framework": "langgraph",
                    "input": client.content("run.input", inputs),
                },
                run_id=run.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
                summary=name,
            )

    def _start_agent(self, client: Client, run_id: UUID, parent: _Node, node_name: str) -> None:
        run = parent.run
        display = str(run.names.get(node_name) or node_name)
        agent_id = slugify(node_name)
        client.upsert_agent(AgentInfo(agent_id, display, run.team_id, framework="langgraph"))
        step_id = run_id.hex
        node = _Node(
            run,
            agent_id,
            step_id,
            "agent",
            time.monotonic(),
            name=display,
            parent_step=parent.step_id,
        )
        with self._lock:
            self._nodes[run_id] = node
            prev, run.last_agent = run.last_agent, agent_id
            run.agents.add(agent_id)
        if prev and prev != agent_id:
            self._emit(
                node,
                "handoff",
                {"from_agent_id": prev, "to_agent_id": agent_id},
                agent_id=prev,
                parent_id=parent.step_id,
                summary=f"handed off to {display}",
            )
        self._emit(
            node,
            "step.started",
            {"step_id": step_id, "name": display, "kind": "agent"},
            parent_id=parent.step_id,
        )
        self._status(node, "thinking")

    def on_chain_end(
        self,
        outputs: Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._end_chain(run_id, outputs, None)
        except Exception as exc:
            internal_error("langgraph.on_chain_end", exc)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._end_chain(run_id, None, error)
        except Exception as exc:
            internal_error("langgraph.on_chain_error", exc)

    def _end_chain(self, run_id: UUID, outputs: Any, error: BaseException | None) -> None:
        with self._lock:
            node = self._nodes.pop(run_id, None)
        if node is None or self._client() is None:
            return
        bubbling = error is not None and _is_bubble_up(error)
        cancelled = isinstance(error, Cancelled)
        failed = error is not None and not bubbling and not cancelled
        duration = round((time.monotonic() - node.t0) * 1000, 1)

        if node.kind == "agent":
            if failed:
                assert error is not None
                self._emit(node, "error", _error_data(error), summary=_error_summary(error))
            self._emit(
                node,
                "step.finished",
                {
                    "step_id": node.step_id,
                    "name": node.name or "",
                    "ok": error is None or bubbling,
                    "duration_ms": duration,
                    "error": "cancelled"
                    if cancelled
                    else truncate(repr(error), 2000)
                    if failed
                    else None,
                },
                parent_id=node.parent_step,
            )
            if failed:
                self._status(node, "error", str(error))
            elif cancelled:
                self._status(node, "done", "cancelled by an operator")
            elif bubbling:
                self._status(node, "waiting_human" if _is_interrupt(error) else "waiting")
            else:
                self._status(node, "idle")
        elif node.kind == "root":
            self._finish_root(
                node, outputs, error if failed else None, duration, bubbling, cancelled
            )

    def _finish_root(
        self,
        node: _Node,
        outputs: Any,
        error: BaseException | None,
        duration: float,
        interrupted: bool,
        cancelled: bool = False,
    ) -> None:
        run = node.run
        # Clean up any children left behind (e.g. the graph was cancelled mid-node).
        with self._lock:
            for key in [k for k, n in self._nodes.items() if n.run is run]:
                del self._nodes[key]
        if interrupted:
            return  # the run resumes later; don't mark agents done
        final = "error" if error else "done"
        detail = "cancelled by an operator" if cancelled else None
        for agent_id in sorted(run.agents):
            self._emit(
                node,
                "agent.status",
                {"status": final, "detail": detail},
                agent_id=agent_id,
                team_id=run.team_id,
                parent_id=None,
            )
        if not run.owned:
            return
        client = self._client()
        if client is None:
            return
        if error is not None:
            client.emit(
                "error",
                _error_data(error),
                run_id=run.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
                summary=_error_summary(error),
            )
        client.emit(
            "run.finished",
            {
                "status": "cancelled" if cancelled else "error" if error else "ok",
                "duration_ms": duration,
                "output": client.content("run.output", outputs),
            },
            run_id=run.run_id,
            agent_id=None,
            team_id=None,
            parent_id=None,
        )

    # ---------------- models ----------------

    def on_chat_model_start(
        self,
        serialized: dict[str, Any] | None,
        messages: list[list[Any]],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._start_llm(run_id, parent_run_id, metadata, kwargs, messages)
        except Exception as exc:
            internal_error("langgraph.on_chat_model_start", exc)

    def on_llm_start(
        self,
        serialized: dict[str, Any] | None,
        prompts: list[str],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._start_llm(run_id, parent_run_id, metadata, kwargs, prompts)
        except Exception as exc:
            internal_error("langgraph.on_llm_start", exc)

    def _start_llm(
        self,
        run_id: UUID,
        parent_run_id: UUID | None,
        metadata: dict[str, Any] | None,
        kwargs: dict[str, Any],
        prompt: Any,
    ) -> None:
        parent = self._parent(parent_run_id)
        if parent is None:
            return
        self._checkpoint(parent)
        metadata = metadata or {}
        params = kwargs.get("invocation_params") or {}
        model = metadata.get("ls_model_name") or params.get("model") or params.get("model_name")
        node = _Node(
            parent.run,
            parent.agent_id,
            parent.step_id,
            "llm",
            time.monotonic(),
            model=str(model) if model else None,
            provider=metadata.get("ls_provider"),
        )
        node.name = _message_payload(prompt)  # stash; only sent if capture_content
        with self._lock:
            self._nodes[run_id] = node
        self._status(node, "thinking", f"asking {node.model}" if node.model else None)

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            with self._lock:
                node = self._nodes.pop(run_id, None)
            if node is None:
                return
            message, text, finish = _first_generation(response)
            usage = _usage(message, response)
            model = node.model or _response_model(message, response)
            raw_calls = getattr(message, "tool_calls", None) or []
            tool_calls = [tc.get("name", "?") for tc in raw_calls]
            client = self._client()
            captured = client.content("llm.output", text) if client else None
            if tool_calls:
                summary = "chose tool: " + ", ".join(tool_calls)
            elif isinstance(captured, str) and captured.strip():
                summary = truncate(" ".join(captured.split()), 200)
            else:
                summary = f"{model or 'model'} replied"
            self._emit(
                node,
                "llm.call",
                {
                    "provider": node.provider,
                    "operation": "chat",
                    "duration_ms": round((time.monotonic() - node.t0) * 1000, 1),
                    "finish_reason": finish,
                    "input": self._content("llm.input", node.name),
                    "output": captured,
                },
                tokens_in=usage[0],
                tokens_out=usage[1],
                model=model,
                summary=summary,
            )
        except Exception as exc:
            internal_error("langgraph.on_llm_end", exc)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            with self._lock:
                node = self._nodes.pop(run_id, None)
            if node is None:
                return
            self._emit(node, "error", _error_data(error), summary=_error_summary(error))
        except Exception as exc:
            internal_error("langgraph.on_llm_error", exc)

    # ---------------- tools ----------------

    def on_tool_start(
        self,
        serialized: dict[str, Any] | None,
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            parent = self._parent(parent_run_id)
            if parent is None:
                return
            self._checkpoint(parent)
            tool_name = str(kwargs.get("name") or (serialized or {}).get("name") or "tool")
            call_id = str(kwargs.get("tool_call_id") or run_id.hex)
            node = _Node(
                parent.run,
                parent.agent_id,
                parent.step_id,
                "tool",
                time.monotonic(),
                name=tool_name,
                call_id=call_id,
            )
            with self._lock:
                self._nodes[run_id] = node
            self._status(node, "using_tool", tool_name)
            self._emit(
                node,
                "tool.call",
                {
                    "tool_name": tool_name,
                    "call_id": call_id,
                    "arguments": self._content(
                        "tool.arguments", inputs if inputs is not None else input_str
                    ),
                },
                summary=f"{tool_name}()",
            )
        except Exception as exc:
            internal_error("langgraph.on_tool_start", exc)

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._end_tool(run_id, output, None)
        except Exception as exc:
            internal_error("langgraph.on_tool_end", exc)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            self._end_tool(run_id, None, error)
        except Exception as exc:
            internal_error("langgraph.on_tool_error", exc)

    def _end_tool(self, run_id: UUID, output: Any, error: BaseException | None) -> None:
        with self._lock:
            node = self._nodes.pop(run_id, None)
        if node is None:
            return
        result = getattr(output, "content", output)
        self._emit(
            node,
            "tool.result",
            {
                "tool_name": node.name or "tool",
                "call_id": node.call_id or run_id.hex,
                "ok": error is None,
                "duration_ms": round((time.monotonic() - node.t0) * 1000, 1),
                "error": truncate(repr(error), 2000) if error else None,
                "result": self._content("tool.result", result) if error is None else None,
            },
            summary=f"{node.name} {'failed' if error else 'ok'}",
        )
        self._status(node, "thinking")


# ---------------- registration ----------------

_handler: AgentSpaceCallbackHandler | None = None
_hook_var: ContextVar[AgentSpaceCallbackHandler | None] | None = None


def instrument(client: Client | None = None) -> bool:
    """Register the handler globally for all LangChain/LangGraph runs. Idempotent.

    The handler always reads the *current* client, so calling ``agentspace.init()`` again
    doesn't need re-registration.
    """
    global _handler, _hook_var
    if _hook_var is not None:
        return True
    from langchain_core.tracers.context import register_configure_hook

    _handler = AgentSpaceCallbackHandler()
    # A ContextVar whose *default* is the handler, so it's active in every thread and task.
    _hook_var = ContextVar("agentspace_langchain_handler", default=_handler)
    register_configure_hook(_hook_var, True)
    return True


def get_handler() -> AgentSpaceCallbackHandler:
    """The shared handler (for passing explicitly via ``config={"callbacks": [...]}``)."""
    global _handler
    if _handler is None:
        _handler = AgentSpaceCallbackHandler()
    return _handler


# ---------------- small pure helpers ----------------


def _is_bubble_up(error: BaseException) -> bool:
    return any(cls.__name__ in _BUBBLE_UP_NAMES for cls in type(error).__mro__)


def _is_interrupt(error: BaseException | None) -> bool:
    return error is not None and any(
        cls.__name__ in ("GraphInterrupt", "NodeInterrupt") for cls in type(error).__mro__
    )


def _error_data(exc: BaseException) -> dict[str, Any]:
    return {"message": truncate(str(exc) or type(exc).__name__, 2000), "kind": type(exc).__name__}


def _error_summary(exc: BaseException) -> str:
    return truncate(f"{type(exc).__name__}: {exc}", 500)


def _message_payload(prompt: Any) -> Any:
    """Turn LangChain messages into plain dicts (only used when capture_content=True)."""
    if isinstance(prompt, list) and prompt and isinstance(prompt[0], list):
        prompt = prompt[0]
    if isinstance(prompt, list):
        out = []
        for m in prompt:
            role = getattr(m, "type", None)
            out.append({"role": role, "content": getattr(m, "content", m)} if role else m)
        return out
    return prompt


def _first_generation(response: Any) -> tuple[Any, str | None, str | None]:
    try:
        gen = response.generations[0][0]
    except Exception:
        return None, None, None
    message = getattr(gen, "message", None)
    text = getattr(gen, "text", None) or (getattr(message, "content", None) if message else None)
    if not isinstance(text, str):
        text = str(text) if text else None
    info = getattr(gen, "generation_info", None) or {}
    meta = getattr(message, "response_metadata", None) or {}
    finish = info.get("finish_reason") or meta.get("stop_reason") or meta.get("finish_reason")
    return message, text, str(finish) if finish else None


def _usage(message: Any, response: Any) -> tuple[int | None, int | None]:
    um = getattr(message, "usage_metadata", None)
    if um:
        return um.get("input_tokens"), um.get("output_tokens")
    llm_output = getattr(response, "llm_output", None) or {}
    usage = llm_output.get("usage") or llm_output.get("token_usage") or {}
    tin = usage.get("input_tokens", usage.get("prompt_tokens"))
    tout = usage.get("output_tokens", usage.get("completion_tokens"))
    return tin, tout


def _response_model(message: Any, response: Any) -> str | None:
    meta = getattr(message, "response_metadata", None) or {}
    model = meta.get("model_name") or meta.get("model")
    if not model:
        model = (getattr(response, "llm_output", None) or {}).get("model_name")
    return str(model) if model else None
