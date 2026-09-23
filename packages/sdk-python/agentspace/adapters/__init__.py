"""Framework adapters. Each one uses the framework's official extension point.

``auto_instrument`` turns on every adapter whose framework is importable.
"""

from __future__ import annotations

import importlib.util
from typing import TYPE_CHECKING

from agentspace._log import internal_error, logger

if TYPE_CHECKING:
    from agentspace._client import Client


def auto_instrument(client: Client) -> list[str]:
    enabled: list[str] = []
    if importlib.util.find_spec("langchain_core") is not None:
        try:
            from agentspace.adapters.langgraph import instrument

            if instrument(client):
                enabled.append("langgraph")
        except Exception as exc:
            internal_error("adapters.langgraph", exc)
    logger.debug("agentspace: adapters enabled: %s", enabled)
    return enabled
