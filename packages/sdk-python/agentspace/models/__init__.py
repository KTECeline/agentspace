"""Pydantic models generated from the event spec. Requires ``pip install agentspace[models]``.

The SDK itself never imports this module: events are built as plain dicts on the hot path.
"""

try:
    from agentspace.models._generated import *  # noqa: F403
    from agentspace.models._generated import AgentSpaceEvent, IngestBatch
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "agentspace.models needs pydantic. Install it with: pip install 'agentspace[models]'"
    ) from exc

__all__ = ["AgentSpaceEvent", "IngestBatch"]
