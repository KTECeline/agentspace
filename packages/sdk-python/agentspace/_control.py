"""Two-way control: human approvals, and pause / resume / cancel from the office.

Approvals fail closed. ``request_approval`` returns "approved" only when a person approved in
time. If AgentSpace isn't initialized, the collector can't be reached, or the deadline
passes, it returns "rejected" or "timeout". It never hangs past its timeout.

Cancel raises :class:`Cancelled` (a ``BaseException``, like ``asyncio.CancelledError``, so
``except Exception`` can't swallow it) at the next safe point: the start of a run, agent,
step, LLM call or tool call, or an explicit ``checkpoint()``. With
``init(cancel_mode="flag")`` nothing is raised; poll ``is_cancelled()`` instead.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from agentspace._context import current_run
from agentspace._log import internal_error, logger, warn_limited
from agentspace._util import new_id, truncate

if TYPE_CHECKING:
    from agentspace._client import Client

Decision = Literal["approved", "rejected", "timeout"]

POLL_WAIT_S = 25  # server long-poll window
MAX_NETWORK_FAILURES = 3  # consecutive failures before an approval fails closed


class Cancelled(BaseException):
    """An operator cancelled this run in the office.

    Subclasses ``BaseException`` (like ``asyncio.CancelledError``) so that a blanket
    ``except Exception`` in agent code can't swallow it. Catch it explicitly to clean up.
    """

    def __init__(self, run_id: str | None = None) -> None:
        super().__init__(f"run {run_id} was cancelled by an operator" if run_id else "cancelled")
        self.run_id = run_id


@dataclass(frozen=True)
class ApprovalResult:
    decision: Decision
    approval_id: str
    comment: str | None = None
    resolved_by: str | None = None
    #: Why the request failed closed (collector unreachable, not initialized, ...), if it did.
    error: str | None = None

    @property
    def approved(self) -> bool:
        return self.decision == "approved"


# ---------------------------------------------------------------------------
# HTTP (stdlib only)
# ---------------------------------------------------------------------------


class CollectorError(Exception):
    pass


def api(
    client: Client, method: str, path: str, timeout: float, body: Any = None
) -> tuple[int, Any]:
    """One JSON request to the collector. Raises CollectorError on network problems."""
    url = client.config.url.rstrip("/") + path
    headers = {"Accept": "application/json", "User-Agent": "agentspace-python"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if client.config.api_key:
        headers["Authorization"] = f"Bearer {client.config.api_key}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw or b"null")
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read() or b"null")
        except Exception:
            payload = None
        return err.code, payload
    except Exception as exc:  # connection refused, timeout, DNS, ...
        raise CollectorError(repr(exc)) from exc


def _ws(client: Client) -> str:
    return urllib.parse.quote(client.config.workspace, safe="")


# ---------------------------------------------------------------------------
# Approvals
# ---------------------------------------------------------------------------


def request_approval_sync(
    reason: str,
    payload: Any = None,
    *,
    timeout: float = 300.0,
    run_id: str | None = None,
    agent_id: str | None = None,
    team_id: str | None = None,
) -> ApprovalResult:
    """Ask a person to approve something in the office and block until they decide.

    Returns "approved" / "rejected" / "timeout". Fails closed: never "approved" unless a
    person approved before ``timeout`` seconds.

    ``run_id`` / ``agent_id`` / ``team_id`` default to the current context; adapters pass
    them explicitly when framework callbacks run outside it.
    """
    from agentspace import _api

    approval_id = new_id()
    client = _api.get_client()
    if client is None or client.transport is None:
        logger.warning(
            "agentspace: request_approval called before init(); rejecting (fails closed)"
        )
        return ApprovalResult("rejected", approval_id, error="agentspace is not initialized")

    deadline = time.monotonic() + max(0.0, timeout)
    who: dict[str, Any] = {}
    if run_id:
        who["run_id"] = run_id
    if agent_id:
        who["agent_id"] = agent_id
        who["team_id"] = team_id

    def show(value: str, detail: str | None = None) -> None:
        _api.set_status(value, detail, **who)  # type: ignore[arg-type]

    try:
        client.emit(
            "approval.requested",
            {
                "approval_id": approval_id,
                "reason": truncate(str(reason), 2000),
                # The payload is what the person reviews, so it's sent even without
                # capture_content, but it still goes through your redaction hook.
                "payload": client.redact_value("approval.payload", payload),
                "timeout_s": timeout,
            },
            summary=truncate(f"needs approval: {reason}", 500),
            **who,
        )
        show("waiting_human", truncate(str(reason), 500))
        if not client.flush(timeout=min(5.0, max(0.5, timeout))):
            show("thinking")
            return ApprovalResult("rejected", approval_id, error="collector unreachable")
    except Exception as exc:  # pragma: no cover - defensive
        internal_error("request_approval", exc)
        return ApprovalResult("rejected", approval_id, error="internal error")

    failures = 0
    path = f"/v1/workspaces/{_ws(client)}/approvals/{approval_id}"
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return ApprovalResult("timeout", approval_id)
            _check_cancel_while_waiting(client, run_id)
            wait = int(min(POLL_WAIT_S, max(1, remaining)))
            try:
                status, body = api(client, "GET", f"{path}?wait={wait}", timeout=wait + 5)
            except CollectorError as exc:
                failures += 1
                if failures >= MAX_NETWORK_FAILURES:
                    logger.warning(
                        "agentspace: approval %s failed closed: collector unreachable (%s)",
                        approval_id,
                        exc,
                    )
                    return ApprovalResult("rejected", approval_id, error="collector unreachable")
                time.sleep(min(0.5 * 2**failures, max(0.0, deadline - time.monotonic())))
                continue
            if status == 200 and isinstance(body, dict):
                failures = 0
                decision = body.get("status")
                if decision in ("approved", "rejected", "timeout"):
                    return ApprovalResult(
                        decision, approval_id, body.get("comment"), body.get("resolved_by")
                    )
                continue  # still pending
            if status in (401, 403):
                return ApprovalResult(
                    "rejected",
                    approval_id,
                    error=f"not authorized to read approvals (HTTP {status})",
                )
            failures += 1  # 404 (not stored yet) or 5xx
            if failures >= MAX_NETWORK_FAILURES:
                return ApprovalResult(
                    "rejected", approval_id, error=f"collector answered HTTP {status}"
                )
            time.sleep(0.5)
    finally:
        show("thinking")


async def request_approval(
    reason: str,
    payload: Any = None,
    *,
    timeout: float = 300.0,
    run_id: str | None = None,
    agent_id: str | None = None,
    team_id: str | None = None,
) -> ApprovalResult:
    """Async version of :func:`request_approval_sync`; waits in a thread, so the event loop
    keeps running."""
    return await asyncio.to_thread(
        request_approval_sync,
        reason,
        payload,
        timeout=timeout,
        run_id=run_id,
        agent_id=agent_id,
        team_id=team_id,
    )


# ---------------------------------------------------------------------------
# Pause / resume / cancel
# ---------------------------------------------------------------------------


def _run_id(client: Client, run_id: str | None) -> str | None:
    return run_id or current_run.get() or client.default_run_id


def is_cancelled(run_id: str | None = None) -> bool:
    """True once an operator cancelled the current (or given) run."""
    from agentspace import _api

    client = _api.get_client()
    rid = client and _run_id(client, run_id)
    return bool(client and rid and client.controls.get(rid) == "cancelled")


def _show(status: str, detail: str | None, who: dict[str, Any] | None) -> None:
    """Set the status of the given agent, or of the current one; no-op without an agent."""
    from agentspace import _api
    from agentspace._context import current_agent

    if who and who.get("agent_id"):
        _api.set_status(status, detail, **who)  # type: ignore[arg-type]
    elif current_agent.get() is not None:
        _api.set_status(status, detail)  # type: ignore[arg-type]


def _cancelled(client: Client, rid: str, who: dict[str, Any] | None = None) -> bool:
    """Handle a cancel. Returns False in flag mode; raises in raise mode.

    In raise mode the exception unwinds through agent scopes / adapter hooks, which mark the
    agents "done (cancelled)" themselves; only flag mode needs to announce it here.
    """
    if client.config.cancel_mode == "raise":
        raise Cancelled(rid)
    if rid not in client.cancel_announced:
        client.cancel_announced.add(rid)
        _show("done", "cancelled by an operator", who)
    return False


def raise_if_cancelled(
    run_id: str, agent_id: str | None = None, team_id: str | None = None
) -> None:
    """Cancel-only safe point for callbacks that must never block (e.g. tracing hooks)."""
    from agentspace import _api

    client = _api.get_client()
    if client is None or client.transport is None:
        return
    if client.controls.get(run_id) == "cancelled":
        who = {"run_id": run_id, "agent_id": agent_id, "team_id": team_id} if agent_id else None
        _cancelled(client, run_id, who)


def _check_cancel_while_waiting(client: Client, run_id: str | None) -> None:
    rid = _run_id(client, run_id)
    if rid and client.controls.get(rid) == "cancelled" and client.config.cancel_mode == "raise":
        raise Cancelled(rid)


def checkpoint(run_id: str | None = None) -> bool:
    """A safe point to pause or stop. Returns True to keep going.

    - paused: blocks until resumed or cancelled (shows "blocked" in the office);
    - cancelled: raises :class:`Cancelled` (``cancel_mode="raise"``) or returns False (``"flag"``).

    Call it inside your own loops. Scopes and adapters call it for you.
    """
    from agentspace import _api

    client = _api.get_client()
    if client is None or client.transport is None:
        return True
    rid = _run_id(client, run_id)
    if not rid:
        return True
    return _checkpoint(client, rid, None)


def _checkpoint(client: Client, rid: str, who: dict[str, Any] | None) -> bool:
    state = client.controls.get(rid)
    if state == "cancelled":
        return _cancelled(client, rid, who)
    if state == "paused":
        _wait_while_paused(client, rid, who)
        if client.controls.get(rid) == "cancelled":
            return _cancelled(client, rid, who)
    return True


def adapter_checkpoint(
    run_id: str, agent_id: str | None = None, team_id: str | None = None
) -> bool:
    """Checkpoint from inside a framework callback. Cancel works everywhere. Pausing blocks
    only when the callback runs off the event loop: blocking an event loop would freeze
    everything else, so async code pauses at ``await acheckpoint()`` (or an async adapter hook).
    """
    from agentspace import _api

    client = _api.get_client()
    if client is None or client.transport is None:
        return True
    if client.controls.get(run_id) == "paused" and _on_event_loop():
        warn_limited(
            "pause-async",
            "agentspace: run paused, but this callback runs on an event loop; it will pause at "
            "the next `await agentspace.acheckpoint()` or async adapter hook",
        )
        return True
    who = {"run_id": run_id, "agent_id": agent_id, "team_id": team_id} if agent_id else None
    return _checkpoint(client, run_id, who)


async def adapter_acheckpoint(
    run_id: str, agent_id: str | None = None, team_id: str | None = None
) -> bool:
    """Async :func:`adapter_checkpoint` for async framework hooks: pausing waits in a thread."""
    from agentspace import _api

    client = _api.get_client()
    if client is None or client.transport is None:
        return True
    who = {"run_id": run_id, "agent_id": agent_id, "team_id": team_id} if agent_id else None
    if client.controls.get(run_id) == "paused":
        await asyncio.to_thread(_wait_while_paused, client, run_id, who)
    return _checkpoint(client, run_id, who)


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


async def acheckpoint(run_id: str | None = None) -> bool:
    """Async :func:`checkpoint`: pausing waits in a thread, not on the event loop."""
    from agentspace import _api

    client = _api.get_client()
    if client is None or client.transport is None:
        return True
    rid = _run_id(client, run_id)
    if rid and client.controls.get(rid) == "paused":
        await asyncio.to_thread(_wait_while_paused, client, rid)
    return checkpoint(rid)


def _wait_while_paused(client: Client, rid: str, who: dict[str, Any] | None = None) -> None:
    _show("blocked", "paused by an operator", who)
    logger.info("agentspace: run %s paused by an operator; waiting to resume", rid)
    run = urllib.parse.quote(rid, safe="")
    path = f"/v1/workspaces/{_ws(client)}/controls?runs={run}&wait={POLL_WAIT_S}"
    while client.controls.get(rid) == "paused":
        try:
            status, body = api(client, "GET", path, timeout=POLL_WAIT_S + 5)
            if status == 200 and isinstance(body, dict):
                client.controls[rid] = body.get(rid, "running")
                if client.controls[rid] == "running":
                    client.controls.pop(rid, None)
                continue
        except CollectorError:
            warn_limited(
                "paused-unreachable",
                "agentspace: run is paused but the collector is unreachable; still paused",
            )
        time.sleep(2.0)
    if client.controls.get(rid) != "cancelled":
        _show("thinking", "resumed", who)
