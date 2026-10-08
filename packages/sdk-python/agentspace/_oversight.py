"""Policy enforcement for tool calls (DECISIONS D-045).

``guard_tool`` is called just before a tool runs: by the adapters through their framework's own
hook, or by your code. Allowed calls cost a local, O(1)-ish policy check. A review asks a person
in the office (fail closed, like every approval). A blocked or refused call raises
``PolicyDenied``, whose message is written for the model, so an agent can change course.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from agentspace._context import current_agent, current_run
from agentspace._log import internal_error
from agentspace._policy import ALLOW, PolicyDecision, evaluate_policy
from agentspace._util import truncate

Outcome = Literal["blocked", "rejected", "timeout"]


class PolicyDenied(Exception):
    """A tool call the policy blocked, or that a person didn't approve.

    A plain ``Exception`` on purpose: frameworks turn it into a tool error the model can read
    (unlike ``Cancelled``, which stops the run).
    """

    def __init__(
        self, tool: str, outcome: Outcome, decision: PolicyDecision, comment: str | None = None
    ) -> None:
        self.tool = tool
        self.outcome = outcome
        self.decision = decision
        self.comment = comment
        rule = f" (rule {decision.rule})" if decision.rule else ""
        if outcome == "blocked":
            text = f"{tool} is blocked by policy{rule}"
            if decision.reason:
                text += f": {decision.reason}"
        elif outcome == "rejected":
            text = f"{tool} was rejected by an operator"
            if comment:
                text += f": {comment}"
        else:
            text = f"{tool} wasn't approved in time"
        super().__init__(text + ". Don't retry it; choose another way or report back.")


def decide(tool: str, *, run_id: str | None = None, agent_id: str | None = None) -> PolicyDecision:
    """What the policy says about this call, without asking anyone. Never raises."""
    from agentspace import _api

    client = _api.get_client()
    if client is None:
        return ALLOW
    policies = client.policies()
    try:
        client.ensure_policy()
        policies = client.policies()
        if not policies:
            return ALLOW
        ref = current_agent.get()
        aid = agent_id or (ref.agent_id if ref else None)
        rid = run_id or current_run.get() or client.default_run_id
        return evaluate_policy(policies, tool, aid, rid in client.escalated)
    except Exception as exc:
        internal_error("policy.decide", exc)
        # Fails closed when there is a policy to honour.
        return (
            PolicyDecision("review", None, None, True, False, "the policy couldn't be checked")
            if policies
            else ALLOW
        )


def guard_tool(
    tool: str,
    arguments: Any = None,
    *,
    timeout: float = 300.0,
    run_id: str | None = None,
    agent_id: str | None = None,
    team_id: str | None = None,
) -> PolicyDecision:
    """Check a tool call against the policy before it runs.

    Returns the decision when the call may go ahead (allowed, or approved by a person). Raises
    ``PolicyDenied`` when it's blocked, rejected or not approved in time. Blocks while a person
    decides; use :func:`aguard_tool` in async code.
    """
    from agentspace import _api
    from agentspace._control import request_approval_sync

    decision = decide(tool, run_id=run_id, agent_id=agent_id)
    if decision.action == "allow":
        return decision
    if decision.action == "block":
        raise PolicyDenied(tool, "blocked", decision)

    client = _api.get_client()
    ref = current_agent.get()
    aid = agent_id or (ref.agent_id if ref else None)
    tid = team_id or (ref.team_id if ref else None)
    rid = run_id or current_run.get() or (client.default_run_id if client else None)
    try:
        payload: dict[str, Any] = {"tool": tool}
        if client and decision.show_arguments:
            payload["arguments"] = client.redact_value("tool.arguments", arguments)
        policy = {
            "tool": truncate(tool, 256),
            "action": "review",
            "rule": decision.rule,
            "source": decision.source,
            "reason": decision.reason,
            "escalated": decision.escalated or None,
            "arguments_hash": client.args_hash(arguments) if client else None,
        }
        policy = {k: v for k, v in policy.items() if v is not None}
        reason = f"Run {tool}?"
        if decision.reason:
            reason += f" {decision.reason}"
        if decision.escalated:
            reason += " (asked because this run has detector findings)"
    except Exception as exc:  # pragma: no cover - defensive
        internal_error("guard_tool", exc)
        payload, reason = {"tool": tool}, tool
        policy = {"tool": truncate(tool, 256), "action": "review"}
    result = request_approval_sync(
        reason,
        payload,
        timeout=timeout,
        run_id=rid,
        agent_id=aid,
        team_id=tid,
        policy=policy,
    )
    if result.approved:
        return decision
    outcome: Outcome = "timeout" if result.decision == "timeout" else "rejected"
    raise PolicyDenied(tool, outcome, decision, result.comment or result.error)


async def aguard_tool(
    tool: str,
    arguments: Any = None,
    *,
    timeout: float = 300.0,
    run_id: str | None = None,
    agent_id: str | None = None,
    team_id: str | None = None,
) -> PolicyDecision:
    """Async :func:`guard_tool`: a review waits in a thread, so the event loop keeps running."""
    decision = decide(tool, run_id=run_id, agent_id=agent_id)
    if decision.action != "review":
        return guard_tool(tool, arguments, timeout=timeout, run_id=run_id, agent_id=agent_id)
    ref = current_agent.get()
    return await asyncio.to_thread(
        guard_tool,
        tool,
        arguments,
        timeout=timeout,
        run_id=run_id or current_run.get(),
        agent_id=agent_id or (ref.agent_id if ref else None),
        team_id=team_id or (ref.team_id if ref else None),
    )
