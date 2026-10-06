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
from agentspace._control import (
    ApprovalResult,
    Cancelled,
    acheckpoint,
    checkpoint,
    is_cancelled,
    request_approval,
    request_approval_sync,
)
from agentspace._hash import hash_arguments

__version__ = "0.1.0.dev0"

__all__ = [
    "ApprovalResult",
    "Cancelled",
    "__version__",
    "acheckpoint",
    "agent",
    "checkpoint",
    "emit",
    "flush",
    "get_client",
    "handoff",
    "hash_arguments",
    "init",
    "is_cancelled",
    "request_approval",
    "request_approval_sync",
    "run",
    "set_status",
    "shutdown",
    "stats",
    "step",
]
