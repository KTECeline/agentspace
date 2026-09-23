"""Context propagation with contextvars (works across asyncio tasks and copied contexts)."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class AgentRef:
    agent_id: str
    team_id: str | None


current_run: ContextVar[str | None] = ContextVar("agentspace_run", default=None)
current_agent: ContextVar[AgentRef | None] = ContextVar("agentspace_agent", default=None)
current_step: ContextVar[str | None] = ContextVar("agentspace_step", default=None)
