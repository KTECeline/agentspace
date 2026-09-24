"""A tiny LangGraph app driven by a scripted chat model (no network)."""

from __future__ import annotations

import contextlib
from typing import Any, TypedDict

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph


@tool
def read_file(path: str) -> str:
    """Read a file from the repo."""
    return "def total(xs): return sum(xs[1:])"


@tool
def broken_tool(path: str) -> str:
    """Always fails."""
    raise ValueError("disk on fire")


class State(TypedDict, total=False):
    bug: str
    route: str
    fixed: bool


def _usage(i: int, o: int) -> dict[str, int]:
    return {"input_tokens": i, "output_tokens": o, "total_tokens": i + o}


def build(fail_in: str | None = None, on_node: Any = None) -> Any:
    """``on_node(name)`` runs at the start of each node (tests use it to flush)."""
    hook = on_node or (lambda name: None)

    llm = FakeMessagesListChatModel(
        responses=[
            AIMessage(content="Route to triage.", usage_metadata=_usage(120, 8)),
            AIMessage(content="Off-by-one in total().", usage_metadata=_usage(200, 12)),
            AIMessage(
                content="",
                tool_calls=[{"name": "read_file", "args": {"path": "cart.py"}, "id": "call_1"}],
                usage_metadata=_usage(300, 20),
            ),
        ]
    )

    def manager(state: State) -> State:
        hook("manager")
        llm.invoke(f"Who should handle: {state['bug']}")
        return {"route": "triage"}

    def triage(state: State) -> State:
        hook("triage")
        if fail_in == "triage":
            raise RuntimeError("triage crashed")
        llm.invoke("Diagnose")
        return {}

    def engineer(state: State) -> State:
        msg = llm.invoke("Fix it")
        read_file.invoke(msg.tool_calls[0])
        if fail_in == "tool":
            with contextlib.suppress(ValueError):
                broken_tool.invoke({"path": "x"})
        return {"fixed": True}

    g = StateGraph(State)
    g.add_node("manager", manager)
    g.add_node("triage", triage)
    g.add_node("engineer", engineer)
    g.add_edge(START, "manager")
    g.add_conditional_edges("manager", lambda s: s["route"], ["triage", "engineer"])
    g.add_edge("triage", "engineer")
    g.add_edge("engineer", END)
    return g.compile(name="dev-team")
