"""AgentSpace: a live office for AI agent teams.

    import agentspace
    agentspace.init()          # auto-instruments LangGraph if installed

Docs: https://github.com/KTECeline/agentspace
"""

from agentspace._api import (
    agent,
    emit,
    flush,
    get_client,
    handoff,
    init,
    run,
    set_status,
    shutdown,
    stats,
    step,
)

__version__ = "0.1.0.dev0"

__all__ = [
    "__version__",
    "agent",
    "emit",
    "flush",
    "get_client",
    "handoff",
    "init",
    "run",
    "set_status",
    "shutdown",
    "stats",
    "step",
]
