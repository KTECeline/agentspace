"""Framework adapters. Each one uses the framework's official extension point.

``auto_instrument`` turns on every adapter whose framework is importable.
"""

from __future__ import annotations

import importlib
import importlib.util
from typing import TYPE_CHECKING

from agentspace._log import internal_error, logger

if TYPE_CHECKING:
    from agentspace._client import Client

#: adapter name -> (module that must be importable, adapter module)
ADAPTERS: dict[str, tuple[str, str]] = {
    "langgraph": ("langchain_core", "agentspace.adapters.langgraph"),
    "openai-agents": ("agents.tracing", "agentspace.adapters.openai_agents"),
    "crewai": ("crewai.events", "agentspace.adapters.crewai"),
}


def _importable(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):  # parent package missing, or a same-named unrelated module
        return False


def auto_instrument(client: Client) -> list[str]:
    enabled: list[str] = []
    for name, (probe, adapter) in ADAPTERS.items():
        if not _importable(probe):
            continue
        try:
            if importlib.import_module(adapter).instrument(client):
                enabled.append(name)
        except Exception as exc:
            internal_error(f"adapters.{name}", exc)
    logger.debug("agentspace: adapters enabled: %s", enabled)
    return enabled
