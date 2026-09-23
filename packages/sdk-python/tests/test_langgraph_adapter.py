"""LangGraph adapter conformance: a scripted graph must produce a known, valid event stream."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeCollector, assert_valid_events, init_fast
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
    assert agentspace.get_client().config.adapters == ["langgraph"]  # type: ignore[union-attr]
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
