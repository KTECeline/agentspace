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
