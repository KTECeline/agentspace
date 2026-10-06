"""Public API: init(), run(), agent(), step(), emit() and helpers.

Rule: every public function catches its own errors. User exceptions pass through unchanged;
SDK errors are logged and swallowed. Before ``init()`` everything is a cheap no-op.
"""

from __future__ import annotations

import contextlib
import functools
import inspect
import os
import time
import traceback
from collections.abc import Callable
from contextvars import Token
from types import TracebackType
from typing import Any, Literal, TypeVar, overload

from agentspace._client import AgentInfo, Client, Config, RedactHook
from agentspace._context import AgentRef, current_agent, current_run, current_step
from agentspace._control import Cancelled, acheckpoint, checkpoint
from agentspace._log import internal_error, logger
from agentspace._util import new_id, slugify, truncate

F = TypeVar("F", bound=Callable[..., Any])
S = TypeVar("S", bound="_Scope")

AgentStatus = Literal[
    "idle", "thinking", "using_tool", "waiting", "blocked", "waiting_human", "done", "error"
]

DEFAULT_URL = "http://localhost:4800"

_client: Client | None = None


def get_client() -> Client | None:
    """The active client, or ``None`` before ``init()``."""
    return _client


def init(
    url: str | None = None,
    workspace: str | None = None,
    *,
    api_key: str | None = None,
    capture_content: bool = False,
    redact: RedactHook | None = None,
    hash_arguments: bool = True,
    auto_instrument: bool = True,
    enabled: bool | None = None,
    cancel_mode: Literal["raise", "flag"] = "raise",
    **options: Any,
) -> Client | None:
    """Start sending events to an AgentSpace collector.

    Args:
        url: Collector base URL. Env: ``AGENTSPACE_URL``. Default ``http://localhost:4800``.
        workspace: Workspace id. Env: ``AGENTSPACE_WORKSPACE``. Default ``"default"``.
        api_key: Env: ``AGENTSPACE_API_KEY``.
        capture_content: Send full prompts, outputs and tool arguments. Off by default:
            only summaries and metadata leave the process.
        redact: ``redact(field, value) -> value`` applied to every content value. Return
            ``None`` to drop it.
        hash_arguments: Send a keyed hash of each tool call's arguments (not the arguments) so
            the collector can spot an agent repeating the same call. The key is random per
            process, so the hash reveals nothing. Set False to send no hash.
        auto_instrument: Turn on adapters for installed frameworks (e.g. LangGraph).
        enabled: Set False (or env ``AGENTSPACE_DISABLED=1``) to make every call a no-op.
        cancel_mode: What an operator's Cancel does. ``"raise"`` (default) raises
            ``agentspace.Cancelled`` (a BaseException) at the next safe point; ``"flag"`` only
            makes ``agentspace.is_cancelled()`` return True.
        **options: Advanced transport settings: ``max_queue``, ``max_batch``,
            ``flush_interval``, ``timeout``, ``max_content_chars``.
    """
    global _client
    try:
        if enabled is None:
            enabled = os.environ.get("AGENTSPACE_DISABLED", "").lower() not in ("1", "true", "yes")
        config = Config(
            url=url or os.environ.get("AGENTSPACE_URL") or DEFAULT_URL,
            workspace=workspace or os.environ.get("AGENTSPACE_WORKSPACE") or "default",
            api_key=api_key or os.environ.get("AGENTSPACE_API_KEY"),
            capture_content=capture_content,
            redact=redact,
            hash_arguments=hash_arguments,
            enabled=enabled,
            cancel_mode="flag" if cancel_mode == "flag" else "raise",
            **{k: v for k, v in options.items() if k in _CONFIG_OPTIONS},
        )
        if _client is not None:
            _client.shutdown(timeout=0.5)
        _client = Client(config)
        if auto_instrument and enabled:
            from agentspace.adapters import auto_instrument as _auto

            config.adapters = _auto(_client)
        logger.debug(
            "agentspace: sending to %s (workspace=%s, adapters=%s)",
            config.url,
            config.workspace,
            config.adapters,
        )
        return _client
    except Exception as exc:
        internal_error("init", exc)
        return None


_CONFIG_OPTIONS = {"max_queue", "max_batch", "flush_interval", "timeout", "max_content_chars"}


def flush(timeout: float = 2.0) -> bool:
    """Wait until queued events are sent. Returns False on timeout or if the collector is down."""
    try:
        return _client.flush(timeout) if _client else True
    except Exception as exc:
        internal_error("flush", exc)
        return False


def shutdown(timeout: float = 2.0) -> None:
    """Flush and stop the background sender. Called automatically at exit."""
    global _client
    try:
        if _client is not None:
            _client.shutdown(timeout)
        _client = None
    except Exception as exc:
        internal_error("shutdown", exc)


def stats() -> dict[str, int]:
    """Transport counters: sent, dropped, rejected, pending."""
    t = _client.transport if _client else None
    if t is None:
        return {"sent": 0, "dropped": 0, "rejected": 0, "pending": 0}
    return {"sent": t.sent, "dropped": t.dropped, "rejected": t.rejected, "pending": t.pending}


def emit(type: str, data: dict[str, Any] | None = None, **fields: Any) -> str | None:
    """Emit a raw spec event. Envelope fields (``run_id``, ``agent_id``, ``team_id``,
    ``parent_id``) default to the current context. ``tokens_in``, ``tokens_out``,
    ``tokens_cache_read``, ``tokens_cache_write``, ``cost_usd``, ``cost_source``, ``model``,
    ``summary`` and ``attributes`` may be passed as keywords.

    Leave ``cost_usd`` unset to let the collector estimate the cost from its price table. Pass
    ``cost_source="reported"`` without a cost when the framework reports it on another event."""
    try:
        return _client.emit(type, data, **fields) if _client else None
    except Exception as exc:
        internal_error("emit", exc)
        return None


def set_status(status: AgentStatus, detail: str | None = None, **fields: Any) -> None:
    """Set the current agent's status (shown on its desk in the office)."""
    emit("agent.status", {"status": status, "detail": _short(detail)}, **fields)


def handoff(to: str, reason: str | None = None, *, from_agent: str | None = None) -> None:
    """Record that work is being handed to another agent (by name or id)."""
    ref = current_agent.get()
    src = slugify(from_agent) if from_agent else (ref.agent_id if ref else None)
    if src is None:
        return
    emit(
        "handoff",
        {"from_agent_id": src, "to_agent_id": slugify(to), "reason": _short(reason)},
        agent_id=src,
        summary=f"handed off to {to}",
    )


def _short(text: str | None, limit: int = 500) -> str | None:
    return truncate(text, limit) if text else None


# ---------------------------------------------------------------------------
# Scopes: run / agent / step. Each works as a sync or async context manager.
# `agent` also works as a decorator.
# ---------------------------------------------------------------------------


class _Scope:
    #: Scopes that are a safe point to pause or cancel (agents and steps; not the run itself).
    _checkpoint = False
    #: Checkpoint after starting (inside the scope) instead of before. Agents do this so a
    #: pause shows on their own desk; a cancel then closes the scope before re-raising.
    _checkpoint_inside = False

    def __enter__(self: S) -> S:
        if self._checkpoint and not self._checkpoint_inside:
            checkpoint()  # may block (paused) or raise Cancelled; both on purpose
        self._enter()
        if self._checkpoint_inside:
            try:
                checkpoint()
            except BaseException as exc:
                self.__exit__(type(exc), exc, exc.__traceback__)
                raise
        return self

    def _enter(self: S) -> S:
        try:
            self._start()
        except Exception as exc:
            internal_error(type(self).__name__, exc)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        try:
            self._end(exc)
        except Exception as err:
            internal_error(type(self).__name__, err)
        return False  # never swallow user exceptions

    async def __aenter__(self: S) -> S:
        if self._checkpoint and not self._checkpoint_inside:
            await acheckpoint()  # pausing waits in a thread, not on the event loop
        self._enter()
        if self._checkpoint_inside:
            try:
                await acheckpoint()
            except BaseException as exc:
                self.__exit__(type(exc), exc, exc.__traceback__)
                raise
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        return self.__exit__(exc_type, exc, tb)

    def _start(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _end(self, exc: BaseException | None) -> None:  # pragma: no cover - abstract
        raise NotImplementedError


def _reset(var: Any, token: Token[Any] | None) -> None:
    if token is None:
        return
    # ValueError: exited in a different context (e.g. an async generator closed elsewhere).
    with contextlib.suppress(ValueError):
        var.reset(token)


def _error_data(exc: BaseException) -> dict[str, Any]:
    return {
        "message": truncate(str(exc) or type(exc).__name__, 2000),
        "kind": type(exc).__name__,
        "stack": truncate("".join(traceback.format_exception(exc))[-16000:], 16000),
    }


class run(_Scope):
    """A run: one end-to-end task (one trace). Events inside share ``run_id``.

    >>> with agentspace.run("fix-bug-12"):
    ...     manager()
    """

    def __init__(
        self,
        name: str | None = None,
        *,
        run_id: str | None = None,
        framework: str | None = None,
        input: Any = None,
    ) -> None:
        self.name = name
        self.run_id = run_id or new_id()
        self.framework = framework
        self.input = input
        self._token: Token[str | None] | None = None
        self._t0 = 0.0

    def _start(self) -> None:
        self._t0 = time.monotonic()
        self._token = current_run.set(self.run_id)
        if _client:
            _client.emit(
                "run.started",
                {
                    "name": self.name,
                    "framework": self.framework,
                    "input": _client.content("run.input", self.input),
                },
                run_id=self.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
                summary=self.name,
            )

    def _end(self, exc: BaseException | None) -> None:
        if _client:
            cancelled = isinstance(exc, Cancelled)
            if exc is not None and not cancelled:  # a cancel is not an error
                _client.emit(
                    "error", _error_data(exc), run_id=self.run_id, agent_id=None, team_id=None
                )
            _client.emit(
                "run.finished",
                {
                    "status": "cancelled" if cancelled else "error" if exc else "ok",
                    "duration_ms": round((time.monotonic() - self._t0) * 1000, 1),
                },
                run_id=self.run_id,
                agent_id=None,
                team_id=None,
                parent_id=None,
            )
        _reset(current_run, self._token)


class step(_Scope):
    """A unit of work inside an agent. Steps nest; child events point at it via ``parent_id``.
    Entering a step is a safe point to pause or cancel.

    >>> with agentspace.step("reproduce bug"):
    ...     run_tests()
    """

    _checkpoint = True

    def __init__(self, name: str, *, kind: Literal["agent", "chain", "custom"] = "custom") -> None:
        self.name = truncate(name, 256)
        self.kind = kind
        self.step_id = new_id()
        self._token: Token[str | None] | None = None
        self._t0 = 0.0

    def _start(self) -> None:
        self._t0 = time.monotonic()
        emit("step.started", {"step_id": self.step_id, "name": self.name, "kind": self.kind})
        self._token = current_step.set(self.step_id)

    def _end(self, exc: BaseException | None) -> None:
        _reset(current_step, self._token)
        emit(
            "step.finished",
            {
                "step_id": self.step_id,
                "name": self.name,
                "ok": exc is None,
                "duration_ms": round((time.monotonic() - self._t0) * 1000, 1),
                "error": "cancelled"
                if isinstance(exc, Cancelled)
                else truncate(repr(exc), 2000)
                if exc
                else None,
            },
        )


class _AgentScope(_Scope):
    """Makes an agent the "current agent": registers it, opens an agent step, and tracks status."""

    _checkpoint = True
    _checkpoint_inside = True

    def __init__(
        self,
        name: str,
        team: str | None,
        role: str | None,
        description: str | None,
        framework: str,
    ) -> None:
        self.info = AgentInfo(
            agent_id=slugify(name),
            name=name,
            team_id=slugify(team) if team else None,
            role=role,
            description=description,
            framework=framework,
        )
        self._token: Token[AgentRef | None] | None = None
        self._step: step | None = None

    def _start(self) -> None:
        if _client is None:
            return
        _client.upsert_agent(self.info)
        outer = current_agent.get()
        ref = AgentRef(self.info.agent_id, self.info.team_id)
        if outer is not None and outer.agent_id != ref.agent_id:
            handoff(self.info.agent_id, from_agent=outer.agent_id)
        self._token = current_agent.set(ref)
        self._step = step(self.info.name, kind="agent")
        self._step._start()
        set_status("thinking")

    def _end(self, exc: BaseException | None) -> None:
        if self._token is None:
            return
        if isinstance(exc, Cancelled):
            set_status("done", "cancelled by an operator")
        elif exc is not None:
            emit("error", _error_data(exc), summary=f"{type(exc).__name__}: {exc}")
            set_status("error", detail=truncate(str(exc), 500))
        else:
            set_status("done")
        if self._step is not None:
            self._step._end(exc)
        _reset(current_agent, self._token)


class agent:
    """Mark a function (sync or async) or a block of code as an agent's work.

    >>> @agentspace.agent(team="research")
    ... def researcher(query): ...

    >>> with agentspace.agent("Reviewer", team="qa"):
    ...     review()

    The agent id is the slug of the name. Nested agent calls record a ``handoff``.
    """

    @overload
    def __init__(self, name: F) -> None: ...
    @overload
    def __init__(
        self,
        name: str | None = None,
        *,
        team: str | None = None,
        role: str | None = None,
        description: str | None = None,
    ) -> None: ...

    def __init__(
        self,
        name: Any = None,
        *,
        team: str | None = None,
        role: str | None = None,
        description: str | None = None,
    ) -> None:
        self._fn: Callable[..., Any] | None = None
        if callable(name):  # bare @agentspace.agent
            self._fn, name = name, None
        self.name: str | None = name
        self.team = team
        self.role = role
        self.description = description
        self._scopes: list[_AgentScope] = []  # stack, so `with` can nest
        if self._fn is not None:
            self._wrapped = self._wrap(self._fn)
            functools.update_wrapper(self, self._fn)

    def _new_scope(self, fallback_name: str) -> _AgentScope:
        return _AgentScope(
            self.name or fallback_name, self.team, self.role, self.description, "manual"
        )

    # decorator usage
    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        if self._fn is not None:
            return self._wrapped(*args, **kwargs)
        if len(args) == 1 and not kwargs and callable(args[0]):
            return self._wrap(args[0])
        raise TypeError("agentspace.agent(...) must decorate a function or be used with 'with'")

    def _wrap(self, fn: F) -> F:
        name = getattr(fn, "__name__", "agent")
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                async with self._new_scope(name):
                    return await fn(*args, **kwargs)

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with self._new_scope(name):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    # context-manager usage
    def __enter__(self) -> agent:
        scope = self._new_scope(self.name or "agent")
        self._scopes.append(scope)
        scope.__enter__()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        if self._scopes:
            self._scopes.pop().__exit__(exc_type, exc, tb)
        return False

    async def __aenter__(self) -> agent:
        return self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        return self.__exit__(exc_type, exc, tb)
