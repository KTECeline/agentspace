"""Client: turns API calls into spec v0.1 event dicts and hands them to the transport."""

from __future__ import annotations

import atexit
import contextlib
import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from agentspace._context import current_agent, current_run, current_step
from agentspace._log import internal_error
from agentspace._transport import Transport
from agentspace._util import new_id, now_iso, truncate

SPEC_VERSION = "0.1"

#: ``redact(field, value) -> value``. ``field`` names where the content came from, e.g.
#: ``"llm.input"`` or ``"tool.arguments"``. Return ``None`` to drop the value.
RedactHook = Callable[[str, Any], Any]


class _Unset:
    pass


UNSET: Any = _Unset()

_ENVELOPE_OPTIONALS = (
    "tokens_in",
    "tokens_out",
    "tokens_cache_read",
    "tokens_cache_write",
    "cost_usd",
    "cost_source",
    "model",
    "summary",
    "attributes",
)


@dataclass
class AgentInfo:
    agent_id: str
    name: str
    team_id: str | None
    role: str | None = None
    description: str | None = None
    framework: str | None = None


@dataclass
class Config:
    url: str
    workspace: str
    api_key: str | None = None
    capture_content: bool = False
    redact: RedactHook | None = None
    max_content_chars: int = 16_000
    max_queue: int = 10_000
    max_batch: int = 100
    flush_interval: float = 0.2
    timeout: float = 2.0
    enabled: bool = True
    #: "raise": Cancel raises agentspace.Cancelled at the next safe point.
    #: "flag": nothing is raised; poll agentspace.is_cancelled().
    cancel_mode: str = "raise"
    adapters: list[str] = field(default_factory=list)


class Client:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.transport: Transport | None = None
        if config.enabled:
            self.transport = Transport(
                config.url.rstrip("/") + "/v1/events",
                api_key=config.api_key,
                max_queue=config.max_queue,
                max_batch=config.max_batch,
                flush_interval=config.flush_interval,
                timeout=config.timeout,
            )
        self._lock = threading.Lock()
        #: run_id -> "paused" | "cancelled" (absent = running), as last reported by the collector.
        self.controls: dict[str, str] = {}
        self.cancel_announced: set[str] = set()
        self._active_runs: dict[str, float] = {}  # run_id -> last event time (monotonic)
        if self.transport is not None:
            self.transport.on_controls = self._apply_controls
            self.transport.poll = self.poll_controls
        self._agents: dict[str, AgentInfo] = {}
        self._registered: set[tuple[str, str]] = set()
        self._default_run_id: str | None = None
        self._default_run_started_at = 0.0
        self._closed = False
        atexit.register(self.shutdown)

    # ---- events ----

    def emit(
        self,
        type: str,
        data: dict[str, Any] | None = None,
        *,
        run_id: str | None = None,
        agent_id: Any = UNSET,
        team_id: Any = UNSET,
        parent_id: Any = UNSET,
        ts: str | None = None,
        **extra: Any,
    ) -> str | None:
        """Build one event from the current context and queue it. Returns the event id.

        ``ts`` overrides the timestamp (RFC 3339), for adapters that receive events late or out
        of order and know when they really happened.
        """
        if self.transport is None or self._closed:
            return None
        if agent_id is UNSET or team_id is UNSET:
            ref = current_agent.get()
            if agent_id is UNSET:
                agent_id = ref.agent_id if ref else None
            if team_id is UNSET:
                team_id = ref.team_id if ref else self._team_of(agent_id)
        if parent_id is UNSET:
            parent_id = current_step.get()
        rid = run_id or current_run.get() or self.default_run()
        self._active_runs[rid] = time.monotonic()
        if agent_id is not None:
            self._ensure_registered(rid, agent_id, team_id)

        event_id = new_id()
        event: dict[str, Any] = {
            "spec_version": SPEC_VERSION,
            "id": event_id,
            "type": type,
            "ts": ts or now_iso(),
            "workspace": self.config.workspace,
            "run_id": rid,
            "agent_id": agent_id,
            "team_id": team_id,
            "parent_id": parent_id,
            "data": {k: v for k, v in (data or {}).items() if v is not None},
        }
        for key in _ENVELOPE_OPTIONALS:
            value = extra.get(key)
            if value is not None:
                event[key] = value
        if "summary" in event:
            event["summary"] = truncate(str(event["summary"]), 500)
        if "model" in event:
            event["model"] = truncate(str(event["model"]), 256)
        self.transport.put(event)
        return event_id

    def content(self, field_name: str, value: Any) -> Any:
        """Return ``value`` ready to send as content, or ``None`` if content capture is off."""
        if not self.config.capture_content or value is None:
            return None
        try:
            if self.config.redact is not None:
                value = self.config.redact(field_name, value)
                if value is None:
                    return None
            limit = self.config.max_content_chars
            if isinstance(value, str):
                return truncate(value, limit)
            dumped = json.dumps(value, default=str)
            if len(dumped) > limit:
                return truncate(dumped, limit)
            return json.loads(dumped)
        except Exception as exc:
            internal_error("content/redact", exc)
            return None

    def redact_value(self, field_name: str, value: Any) -> Any:
        """Like ``content`` but ignores ``capture_content``: for values the developer passes
        on purpose for a person to see (approval payloads). Redaction still applies."""
        if value is None:
            return None
        try:
            if self.config.redact is not None:
                value = self.config.redact(field_name, value)
                if value is None:
                    return None
            if isinstance(value, str):
                return truncate(value, self.config.max_content_chars)
            dumped = json.dumps(value, default=str)
            return (
                truncate(dumped, self.config.max_content_chars)
                if len(dumped) > self.config.max_content_chars
                else json.loads(dumped)
            )
        except Exception as exc:
            internal_error("redact_value", exc)
            return None

    # ---- controls ----

    def _apply_controls(self, controls: dict[str, str]) -> None:
        for run_id, state in controls.items():
            if state in ("paused", "cancelled") and self.controls.get(run_id) != "cancelled":
                self.controls[run_id] = state

    def poll_controls(self) -> None:
        """Ask the collector about runs that were active in the last minute (sender thread)."""
        from agentspace._control import CollectorError, api

        now = time.monotonic()
        for rid, seen in list(self._active_runs.items()):
            if now - seen > 60:
                self._active_runs.pop(rid, None)
        runs = list(self._active_runs)[:50]
        if not runs:
            return
        import urllib.parse

        ws = urllib.parse.quote(self.config.workspace, safe="")
        query = urllib.parse.quote(",".join(runs), safe=",")
        try:
            status, body = api(
                self, "GET", f"/v1/workspaces/{ws}/controls?runs={query}", timeout=2.0
            )
        except CollectorError:
            return
        if status != 200 or not isinstance(body, dict):
            return
        for rid in runs:
            state = body.get(rid)
            if state in ("paused", "cancelled"):
                self._apply_controls({rid: state})
            elif self.controls.get(rid) == "paused":
                self.controls.pop(rid, None)  # resumed

    @property
    def default_run_id(self) -> str | None:
        return self._default_run_id

    # ---- agents ----

    def upsert_agent(self, info: AgentInfo) -> None:
        with self._lock:
            known = self._agents.get(info.agent_id)
            if known is None or known != info:
                self._agents[info.agent_id] = info
                # Force re-registration so the collector learns about the change.
                self._registered = {k for k in self._registered if k[1] != info.agent_id}

    def _team_of(self, agent_id: str | None) -> str | None:
        info = self._agents.get(agent_id) if agent_id else None
        return info.team_id if info else None

    def _ensure_registered(self, run_id: str, agent_id: str, team_id: str | None = None) -> None:
        key = (run_id, agent_id)
        if key in self._registered:
            return
        with self._lock:
            if key in self._registered:
                return
            self._registered.add(key)
            # Unknown agent: register it with the team of the event that mentioned it.
            info = self._agents.get(agent_id) or AgentInfo(agent_id, agent_id, team_id)
        self.emit(
            "agent.registered",
            {
                "name": info.name,
                "team_name": info.team_id,
                "role": info.role,
                "description": info.description,
                "framework": info.framework,
            },
            run_id=run_id,
            agent_id=agent_id,
            team_id=info.team_id,
            parent_id=None,
        )

    # ---- runs ----

    def default_run(self) -> str:
        """The implicit run used when events are emitted outside ``agentspace.run()``."""
        if self._default_run_id is None:
            with self._lock:
                if self._default_run_id is None:
                    self._default_run_id = new_id()
                    self._default_run_started_at = time.monotonic()
                    started = True
                else:
                    started = False
            if started:
                self.emit(
                    "run.started",
                    {"name": "session"},
                    run_id=self._default_run_id,
                    agent_id=None,
                    team_id=None,
                    parent_id=None,
                )
        return self._default_run_id

    # ---- lifecycle ----

    def flush(self, timeout: float = 2.0) -> bool:
        return self.transport.flush(timeout) if self.transport else True

    def shutdown(self, timeout: float = 2.0) -> None:
        if self._closed:
            return
        try:
            if self._default_run_id is not None:
                duration = (time.monotonic() - self._default_run_started_at) * 1000
                self.emit(
                    "run.finished",
                    {"status": "ok", "duration_ms": round(duration, 1)},
                    run_id=self._default_run_id,
                    agent_id=None,
                    team_id=None,
                    parent_id=None,
                )
            self._closed = True
            if self.transport:
                self.transport.shutdown(timeout)
        except Exception as exc:  # pragma: no cover
            internal_error("shutdown", exc)
        finally:
            self._closed = True
            with contextlib.suppress(Exception):
                atexit.unregister(self.shutdown)
