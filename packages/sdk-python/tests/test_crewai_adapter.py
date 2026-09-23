"""CrewAI adapter conformance (scripted LLM, no network)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("crewai")

from conftest import FakeCollector, assert_valid_events, init_fast
from crew_app import build_research_desk
from crewai.events import crewai_event_bus
from jsonschema import Draft202012Validator

import agentspace

GOLDEN = Path(__file__).parent / "fixtures" / "crewai_research_desk.golden.json"


def kickoff(crew: Any = None) -> Any:
    out = (crew or build_research_desk()).kickoff()
    crewai_event_bus.flush()  # CrewAI runs handlers on a thread pool
    assert agentspace.flush()
    return out


def normalize(events: list[dict[str, Any]]) -> list[list[Any]]:
    """Order-independent summary. CrewAI emits several events per millisecond from a thread
    pool, so exact ordering varies by machine; ordering that matters is asserted separately."""
    out = []
    for e in events:
        if e["type"] == "agent.status":
            continue  # which intermediate statuses survive depends on arrival order (thread pool)
        d = e["data"]
        detail = (
            d.get("status")
            or d.get("tool_name")
            or (f"{d['from_agent_id']}->{d['to_agent_id']}" if e["type"] == "handoff" else None)
            or d.get("name")
            or e.get("model")
        )
        out.append([e["type"], e["agent_id"], e.get("team_id"), detail])
    return sorted(out, key=lambda r: json.dumps(r))


def test_research_desk_matches_golden(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)
    assert "crewai" in agentspace.get_client().config.adapters  # type: ignore[union-attr]
    out = kickoff()
    assert "A live office" in str(out)
    events = collector.events
    assert_valid_events(validator, events)
    got = normalize(events)
    if not GOLDEN.exists():
        GOLDEN.write_text(json.dumps(got, indent=1) + "\n")
    assert got == json.loads(GOLDEN.read_text())


def test_details(collector: FakeCollector) -> None:
    init_fast(collector.url)
    kickoff()
    ev = collector.events
    llm = sorted((e for e in ev if e["type"] == "llm.call"), key=lambda e: e["ts"])
    assert [(e["agent_id"], e["tokens_in"], e["tokens_out"]) for e in llm] == [
        ("researcher", 620, 38),
        ("researcher", 910, 44),
        ("writer", 1180, 96),
    ]
    assert llm[0]["summary"] == "chose tool: web_search"
    assert all("output" not in e["data"] for e in llm)  # privacy by default
    (handoff,) = [e for e in ev if e["type"] == "handoff"]
    assert handoff["data"] == {"from_agent_id": "researcher", "to_agent_id": "writer"}
    (call,) = [e for e in ev if e["type"] == "tool.call"]
    (result,) = [e for e in ev if e["type"] == "tool.result"]
    assert call["data"]["call_id"] == result["data"]["call_id"] and result["data"]["ok"] is True
    assert {e["team_id"] for e in ev if e["agent_id"]} == {"research-desk"}
    finished = [e for e in ev if e["type"] == "run.finished"]
    assert finished and finished[0]["data"]["status"] == "ok"
    # Ordering that matters (by CrewAI's own timestamps):
    by_ts = sorted(ev, key=lambda e: e["ts"])
    assert by_ts[0]["type"] == "run.started" and by_ts[-1]["type"] == "run.finished"
    researcher_done = max(
        e["ts"] for e in ev if e["type"] == "step.finished" and e["agent_id"] == "researcher"
    )
    assert handoff["ts"] >= researcher_done
    # final statuses: everyone done
    last: dict[str, str] = {}
    for e in sorted((e for e in ev if e["type"] == "agent.status"), key=lambda e: e["ts"]):
        last[e["agent_id"]] = e["data"]["status"]
    assert last == {"researcher": "done", "writer": "done"}


def test_tool_error_is_recorded(collector: FakeCollector) -> None:
    from crew_app import ScriptedLLM, fetch_page
    from crewai import Agent, Crew, Task

    init_fast(collector.url)
    llm = ScriptedLLM(
        model="scripted-fake",
        replies=[
            (
                'Thought: fetch it.\nAction: fetch_page\nAction Input: {"url": "https://example.com"}',
                100,
                10,
            ),
            ("Thought: it failed.\nFinal Answer: The page was unavailable.", 120, 12),
        ],
    )
    fetcher = Agent(
        role="Fetcher",
        goal="fetch",
        backstory="b",
        llm=llm,
        tools=[fetch_page],
        verbose=False,
        max_retry_limit=0,
    )
    crew = Crew(
        name="fetch",
        agents=[fetcher],
        tasks=[Task(description="Fetch example.com", expected_output="text", agent=fetcher)],
        verbose=False,
    )
    kickoff(crew)
    results = [e for e in collector.events if e["type"] == "tool.result"]
    assert results and results[0]["data"]["ok"] is False


def test_noop_without_init() -> None:
    assert "A live office" in str(build_research_desk().kickoff())


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_survives_out_of_order_delivery(
    seed: int, collector: FakeCollector, validator: Draft202012Validator
) -> None:
    """CrewAI runs handlers on a thread pool. Replay a real crew's events in shuffled order."""
    import random

    from crewai.events.types import agent_events as ae
    from crewai.events.types import crew_events as ce
    from crewai.events.types import llm_events as le
    from crewai.events.types import tool_usage_events as tu

    from agentspace.adapters import crewai as adapter

    captured: list[tuple[Any, Any]] = []
    kinds = [
        ce.CrewKickoffStartedEvent, ce.CrewKickoffCompletedEvent,
        ae.AgentExecutionStartedEvent, ae.AgentExecutionCompletedEvent,
        le.LLMCallStartedEvent, le.LLMCallCompletedEvent,
        tu.ToolUsageStartedEvent, tu.ToolUsageFinishedEvent,
    ]  # fmt: skip
    with crewai_event_bus.scoped_handlers():
        for kind in kinds:
            crewai_event_bus.on(kind)(lambda src, ev: captured.append((src, ev)))
        build_research_desk().kickoff()
        crewai_event_bus.flush()

    init_fast(collector.url)
    listener = adapter._listener
    assert listener is not None
    names = {
        ce.CrewKickoffStartedEvent: "_crew_started",
        ce.CrewKickoffCompletedEvent: "_crew_completed",
        ae.AgentExecutionStartedEvent: "_agent_started",
        ae.AgentExecutionCompletedEvent: "_agent_completed",
        le.LLMCallStartedEvent: "_llm_started",
        le.LLMCallCompletedEvent: "_llm_completed",
        tu.ToolUsageStartedEvent: "_tool_started",
        tu.ToolUsageFinishedEvent: "_tool_finished",
    }
    # The crew must start first (a run needs to exist); everything else arrives in any order.
    first, rest = captured[0], captured[1:]
    random.Random(seed).shuffle(rest)
    for src, ev in [first, *rest]:
        name = names[type(ev)]
        listener._guard(name, getattr(listener, name), src, ev)
    assert agentspace.flush()

    ev = collector.events
    assert_valid_events(validator, ev)
    no_team = [
        (e["type"], e["agent_id"]) for e in ev if e["agent_id"] and e["team_id"] != "research-desk"
    ]
    assert not no_team, f"every agent event has its team: {no_team}"
    assert {e["agent_id"] for e in ev if e["type"] == "llm.call"} == {"researcher", "writer"}
    last: dict[str, tuple[str, str]] = {}
    for e in ev:
        if e["type"] == "agent.status":
            prev = last.get(e["agent_id"])
            if prev is None or e["ts"] >= prev[0]:
                last[e["agent_id"]] = (e["ts"], e["data"]["status"])
    assert {k: v[1] for k, v in last.items()} == {"researcher": "done", "writer": "done"}
    assert [e["type"] for e in ev].count("run.finished") == 1
