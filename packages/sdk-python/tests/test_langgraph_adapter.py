"""LangGraph adapter conformance: a scripted graph must produce a known, valid event stream."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeCollector, approve_when_requested, assert_valid_events, init_fast
from jsonschema import Draft202012Validator
from lg_app import build

import agentspace
from agentspace.adapters.langgraph import AgentSpaceCallbackHandler

GOLDEN = Path(__file__).parent / "fixtures" / "langgraph_dev_team.golden.json"


def normalize(events: list[dict[str, Any]]) -> list[list[Any]]:
    """Drop ids and timings; keep what the office shows."""
    out: list[list[Any]] = []
    for e in events:
        d = e["data"]
        detail = (
            d.get("status")
            or d.get("tool_name")
            or (f"{d['from_agent_id']}->{d['to_agent_id']}" if e["type"] == "handoff" else None)
            or d.get("name")
            or ("ok" if d.get("ok") else None)
        )
        out.append([e["type"], e["agent_id"], e.get("team_id"), detail])
    return out


def run_graph(collector: FakeCollector, **kw: Any) -> list[dict[str, Any]]:
    build().invoke({"bug": "cart total is wrong"}, **kw)
    assert agentspace.flush()
    return collector.events


def test_auto_instrumented_graph_matches_golden(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)  # auto_instrument=True: no callbacks passed below
    assert "langgraph" in agentspace.get_client().config.adapters  # type: ignore[union-attr]
    events = run_graph(collector, config={"metadata": {"agentspace_team": "Engineering"}})
    assert_valid_events(validator, events)

    got = normalize(events)
    if not GOLDEN.exists():  # first run writes the fixture; review it, then commit it
        GOLDEN.write_text(json.dumps(got, indent=1) + "\n")
    assert got == json.loads(GOLDEN.read_text())


def test_llm_and_tool_details(collector: FakeCollector) -> None:
    init_fast(collector.url)
    events = run_graph(collector)
    calls = [e for e in events if e["type"] == "llm.call"]
    assert [(c["agent_id"], c["tokens_in"], c["tokens_out"]) for c in calls] == [
        ("manager", 120, 8),
        ("triage", 200, 12),
        ("engineer", 300, 20),
    ]
    assert calls[2]["summary"] == "chose tool: read_file"
    assert all("input" not in c["data"] and "output" not in c["data"] for c in calls)

    (tool_call,) = [e for e in events if e["type"] == "tool.call"]
    (tool_result,) = [e for e in events if e["type"] == "tool.result"]
    assert tool_call["data"]["call_id"] == "call_1" == tool_result["data"]["call_id"]
    assert tool_result["data"]["ok"] is True
    steps = {e["agent_id"]: e["data"]["step_id"] for e in events if e["type"] == "step.started"}
    assert tool_call["parent_id"] == steps["engineer"]
    assert {e["team_id"] for e in events if e["agent_id"]} == {"dev-team"}  # graph name


def test_capture_content(collector: FakeCollector) -> None:
    init_fast(collector.url, capture_content=True)
    events = run_graph(collector)
    first = next(e for e in events if e["type"] == "llm.call")
    assert first["data"]["output"] == "Route to triage."
    assert first["summary"] == "Route to triage."
    assert first["data"]["input"][0]["content"].startswith("Who should handle")
    tool_call = next(e for e in events if e["type"] == "tool.call")
    assert tool_call["data"]["arguments"] == {"path": "cart.py"}
    assert tool_call["data"]["arguments_hash"] == agentspace.hash_arguments({"path": "cart.py"})


def test_node_error_propagates_and_is_recorded(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)
    with pytest.raises(RuntimeError, match="triage crashed"):
        build(fail_in="triage").invoke({"bug": "x"})
    agentspace.flush()
    events = collector.events
    assert_valid_events(validator, events)
    assert any(e["type"] == "error" and e["agent_id"] == "triage" for e in events)
    finished = [e for e in events if e["type"] == "run.finished"]
    assert finished[-1]["data"]["status"] == "error"
    statuses = [e["data"]["status"] for e in events if e["type"] == "agent.status"]
    assert statuses[-1] == "error"


def test_tool_error(collector: FakeCollector, validator: Draft202012Validator) -> None:
    init_fast(collector.url)
    build(fail_in="tool").invoke({"bug": "x"})
    agentspace.flush()
    assert_valid_events(validator, collector.events)
    results = [e for e in collector.events if e["type"] == "tool.result"]
    assert [r["data"]["ok"] for r in results] == [True, False]


def test_async_invoke(collector: FakeCollector, validator: Draft202012Validator) -> None:
    init_fast(collector.url)
    asyncio.run(build().ainvoke({"bug": "x"}))
    agentspace.flush()
    assert_valid_events(validator, collector.events)
    types = [e["type"] for e in collector.events]
    assert types.count("step.started") == 3 and types.count("handoff") == 2
    if sys.version_info >= (3, 11):
        # Python 3.10: LangGraph can't propagate callbacks into calls inside async-run nodes
        # unless the node passes `config` through (a documented LangGraph limitation).
        assert types.count("llm.call") == 3


def test_inside_manual_run_reuses_run_id(collector: FakeCollector) -> None:
    init_fast(collector.url)
    with agentspace.run("outer") as r:
        build().invoke({"bug": "x"})
    agentspace.flush()
    assert {e["run_id"] for e in collector.events} == {r.run_id}
    assert [e["type"] for e in collector.events].count("run.started") == 1


def test_explicit_handler_without_init_is_noop() -> None:
    # Handler with no client: must be silent and harmless.
    build().invoke({"bug": "x"}, config={"callbacks": [AgentSpaceCallbackHandler()]})


def test_handler_state_is_cleaned_up(collector: FakeCollector) -> None:
    init_fast(collector.url)
    from agentspace.adapters import langgraph as lg

    run_graph(collector)
    assert lg._handler is not None and lg._handler._nodes == {}


# ---------------- pause / cancel ----------------


def _control_on_triage(action: str) -> Any:
    def auto(e: dict[str, Any]) -> str | None:
        hit = e["type"] == "step.started" and e["agent_id"] == "triage"
        return action if hit else None

    return auto


def _flush_in_triage(name: str) -> None:
    if name == "triage":
        assert agentspace.flush()  # the ingest response carries the control


def test_cancel_stops_graph_at_next_safe_point(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)
    collector.auto_control = _control_on_triage("cancelled")
    with pytest.raises(agentspace.Cancelled):
        build(on_node=_flush_in_triage).invoke({"bug": "x"})
    agentspace.flush()
    events = collector.events
    assert_valid_events(validator, events)
    assert not [e for e in events if e["type"] == "error"]
    assert [e["data"]["status"] for e in events if e["type"] == "run.finished"] == ["cancelled"]
    # triage's model call never happened, and the engineer never started
    assert not [e for e in events if e["type"] == "llm.call" and e["agent_id"] == "triage"]
    assert not [e for e in events if e["agent_id"] == "engineer"]
    triage = [e for e in events if e["type"] == "step.finished" and e["data"]["name"] == "triage"]
    assert triage[-1]["data"]["error"] == "cancelled"
    last = [e["data"] for e in events if e["type"] == "agent.status"][-1]
    assert last["status"] == "done" and "cancelled" in (last["detail"] or "")


def test_pause_blocks_sync_graph_until_resumed(collector: FakeCollector) -> None:
    import threading

    init_fast(collector.url)
    collector.auto_control = _control_on_triage("paused")

    def flush_and_resume(name: str) -> None:
        if name == "triage":
            _flush_in_triage(name)
            collector.auto_control = None
            run_id = collector.events[0]["run_id"]
            threading.Timer(0.3, lambda: collector.controls.pop(run_id)).start()

    build(on_node=flush_and_resume).invoke({"bug": "x"})
    agentspace.flush()
    events = collector.events
    blocked = [
        e for e in events if e["type"] == "agent.status" and e["data"]["status"] == "blocked"
    ]
    assert blocked and blocked[0]["agent_id"] == "triage"
    assert [e["data"]["status"] for e in events if e["type"] == "run.finished"] == ["ok"]
    assert [e for e in events if e["agent_id"] == "engineer"]  # carried on after resume


def test_request_approval_inside_a_tool_is_attached_to_the_node(collector: FakeCollector) -> None:
    from langchain_core.tools import tool

    from agentspace.adapters import langgraph as lg

    results: list[Any] = []

    @tool
    def deploy(env: str) -> str:
        """Deploy somewhere."""
        r = lg.request_approval_sync(f"Deploy to {env}?", {"env": env}, timeout=10)
        results.append(r)
        return r.decision

    init_fast(collector.url)
    approve_when_requested(collector, "approved")

    def on_node(name: str) -> None:
        if name == "triage":
            deploy.invoke({"env": "prod"})

    build(on_node=on_node).invoke({"bug": "x"})
    agentspace.flush()
    assert results[0].approved
    (req,) = collector.of_type("approval.requested")
    started = collector.of_type("run.started")[0]
    assert req["run_id"] == started["run_id"]
    assert (req["agent_id"], req["team_id"]) == ("triage", "dev-team")


def test_usage_reads_cache_tokens() -> None:
    from langchain_core.messages import AIMessage

    from agentspace.adapters.langgraph import _usage

    msg = AIMessage(
        content="hi",
        usage_metadata={
            "input_tokens": 1000,
            "output_tokens": 20,
            "total_tokens": 1020,
            "input_token_details": {"cache_read": 600, "cache_creation": 100},
        },
    )
    assert _usage(msg, None) == (1000, 20, 600, 100)
    assert _usage(AIMessage(content="hi"), None) == (None, None, None, None)


# ---------------- policy (D-045) ----------------

POLICY = {
    "tools": [
        {"match": "deploy", "action": "block", "reason": "No deploys on Fridays."},
        {"match": "write_*", "action": "review"},
    ]
}


def _tool_graph(calls: list[str], *, wrapped: bool = True) -> tuple[Any, list[Any]]:
    """agent -> tools (a ToolNode) -> agent, with one model turn calling ``calls``."""
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.tools import tool
    from langgraph.graph import START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode, tools_condition

    from agentspace.adapters.langgraph import apolicy_wrapper, policy_wrapper

    ran: list[Any] = []

    @tool
    def deploy(env: str) -> str:
        """Deploy somewhere."""
        ran.append(("deploy", env))
        return "deployed"

    @tool
    def write_file(path: str) -> str:
        """Write a file."""
        ran.append(("write_file", path))
        return "written"

    @tool
    def read_file(path: str) -> str:
        """Read a file."""
        ran.append(("read_file", path))
        return "contents"

    tool_calls = [
        {
            "name": n,
            "args": {"env": "prod"} if n == "deploy" else {"path": "a.py"},
            "id": f"call_{i}",
        }
        for i, n in enumerate(calls)
    ]
    llm = FakeMessagesListChatModel(
        responses=[AIMessage(content="", tool_calls=tool_calls), AIMessage(content="Done.")]
    )
    seen: list[Any] = []

    def agent(state: MessagesState) -> dict[str, Any]:
        seen.append(list(state["messages"]))
        return {"messages": [llm.invoke(state["messages"])]}

    kw: dict[str, Any] = (
        {"wrap_tool_call": policy_wrapper, "awrap_tool_call": apolicy_wrapper} if wrapped else {}
    )
    g = StateGraph(MessagesState)
    g.add_node("agent", agent)
    g.add_node("tools", ToolNode([deploy, write_file, read_file], **kw))
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", tools_condition)
    g.add_edge("tools", "agent")
    return g.compile(name="ops"), [ran, seen]


def test_policy_block_returns_an_error_message_to_the_model(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url, policy=POLICY)
    graph, (ran, seen) = _tool_graph(["deploy", "read_file"])
    graph.invoke({"messages": [("user", "ship it")]})
    assert agentspace.flush()
    assert ran == [("read_file", "a.py")]  # the blocked tool never ran; the other one did
    replies = {m.tool_call_id: m for m in seen[-1] if getattr(m, "type", "") == "tool"}
    assert replies["call_0"].status == "error"
    assert "deploy is blocked by policy (rule deploy): No deploys on Fridays." in str(
        replies["call_0"].content
    )
    assert replies["call_1"].status == "success"
    results = {r["data"]["call_id"]: r["data"] for r in collector.of_type("tool.result")}
    assert results["call_0"]["ok"] is False and "blocked by policy" in results["call_0"]["error"]
    assert results["call_1"]["ok"] is True
    (err,) = collector.of_type("error")
    run_id = collector.of_type("run.started")[0]["run_id"]
    assert err["data"]["kind"] == "PolicyDenied" and err["run_id"] == run_id
    assert_valid_events(validator, collector.events)


def test_policy_review_asks_and_follows_the_decision(collector: FakeCollector) -> None:
    init_fast(collector.url, policy=POLICY)
    approve_when_requested(collector, "rejected")
    graph, (ran, seen) = _tool_graph(["write_file"])
    graph.invoke({"messages": [("user", "edit")]})
    assert agentspace.flush()
    assert ran == []
    assert "rejected by an operator" in str(seen[-1][-1].content)
    (req,) = collector.of_type("approval.requested")
    assert req["data"]["policy"]["tool"] == "write_file"
    assert req["run_id"] == collector.of_type("run.started")[0]["run_id"]


def test_policy_async_graph(collector: FakeCollector) -> None:
    init_fast(collector.url, policy=POLICY)
    approve_when_requested(collector, "approved")
    graph, (ran, _) = _tool_graph(["deploy", "write_file"])
    asyncio.run(graph.ainvoke({"messages": [("user", "go")]}))
    assert agentspace.flush()
    assert ran == [("write_file", "a.py")]
    assert len(collector.of_type("approval.requested")) == 1


def test_unguarded_tool_node_warns_once(
    collector: FakeCollector, caplog: pytest.LogCaptureFixture
) -> None:
    init_fast(collector.url, policy=POLICY)
    graph, (ran, _) = _tool_graph(["deploy"], wrapped=False)
    with caplog.at_level("WARNING", logger="agentspace"):
        graph.invoke({"messages": [("user", "ship it")]})
    assert ran == [("deploy", "prod")]  # callbacks can't refuse a call; they only warn
    assert "the policy says block for deploy" in caplog.text


def test_guard_tool_before_a_call_counts_as_checked(
    collector: FakeCollector, caplog: pytest.LogCaptureFixture
) -> None:
    from langchain_core.tools import tool

    from agentspace.adapters import langgraph as lg

    @tool
    def write_notes(text: str) -> str:
        """Write notes."""
        return "ok"

    init_fast(collector.url, policy={"tools": [{"match": "write_notes", "action": "review"}]})
    approve_when_requested(collector, "approved")

    def on_node(name: str) -> None:
        if name == "triage":
            lg.guard_tool("write_notes", {"text": "hi"}, timeout=10)
            write_notes.invoke({"text": "hi"})

    with caplog.at_level("WARNING", logger="agentspace"):
        build(on_node=on_node).invoke({"bug": "x"})
    assert "wasn't checked" not in caplog.text


def test_guard_tool_inside_a_node_is_attached_to_it(collector: FakeCollector) -> None:
    from agentspace.adapters import langgraph as lg

    init_fast(collector.url, policy={"tools": [{"match": "deploy", "action": "block"}]})
    denied: list[Any] = []

    def on_node(name: str) -> None:
        if name == "triage":
            lg.guard_tool("read_file")  # allowed: no rule
            try:
                lg.guard_tool("deploy", {"env": "prod"})
            except agentspace.PolicyDenied as e:
                denied.append(e)

    build(on_node=on_node).invoke({"bug": "x"})
    agentspace.flush()
    assert denied and denied[0].outcome == "blocked"
    (err,) = collector.of_type("error")
    assert (err["agent_id"], err["team_id"]) == ("triage", "dev-team")
    assert err["run_id"] == collector.of_type("run.started")[0]["run_id"]
