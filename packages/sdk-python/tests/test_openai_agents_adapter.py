"""OpenAI Agents SDK adapter conformance (scripted model, no network)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("agents")

from agents import RunConfig, Runner, set_trace_processors
from conftest import FakeCollector, assert_valid_events, init_fast
from jsonschema import Draft202012Validator
from oa_app import build_support_desk

import agentspace
from agentspace.adapters import openai_agents as oa

GOLDEN = Path(__file__).parent / "fixtures" / "openai_agents_support.golden.json"


@pytest.fixture(autouse=True)
def _only_our_processor() -> None:
    # The SDK's default processor exports to OpenAI's backend; tests must stay offline.
    set_trace_processors([oa.get_processor()])


def run_desk(**kw: Any) -> Any:
    return asyncio.run(Runner.run(build_support_desk(), "Is invoice 42 paid?", **kw))


def normalize(events: list[dict[str, Any]]) -> list[list[Any]]:
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
    return out


def test_support_desk_matches_golden(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)
    assert "openai-agents" in agentspace.get_client().config.adapters  # type: ignore[union-attr]
    result = run_desk(run_config=RunConfig(workflow_name="support-desk"))
    assert result.final_output == "Invoice 42 was paid on 1 September."
    assert agentspace.flush()
    events = collector.events
    assert_valid_events(validator, events)
    got = normalize(events)
    if not GOLDEN.exists():
        GOLDEN.write_text(json.dumps(got, indent=1) + "\n")
    assert got == json.loads(GOLDEN.read_text())


def test_details(collector: FakeCollector) -> None:
    init_fast(collector.url)
    run_desk(
        run_config=RunConfig(
            workflow_name="support-desk", trace_metadata={"agentspace_team": "Support"}
        )
    )
    agentspace.flush()
    ev = collector.events
    llm = [e for e in ev if e["type"] == "llm.call"]
    assert [(e["agent_id"], e["tokens_in"], e["tokens_out"], e["model"]) for e in llm] == [
        ("triage", 150, 12, "scripted-fake"),
        ("billing", 380, 24, "scripted-fake"),
        ("billing", 520, 40, "scripted-fake"),
    ]
    (handoff,) = [e for e in ev if e["type"] == "handoff"]
    assert handoff["data"] == {"from_agent_id": "triage", "to_agent_id": "billing"}
    (tool_call,) = [e for e in ev if e["type"] == "tool.call"]
    (tool_result,) = [e for e in ev if e["type"] == "tool.result"]
    steps = {e["agent_id"]: e["data"]["step_id"] for e in ev if e["type"] == "step.started"}
    assert tool_call["parent_id"] == steps["billing"]
    assert tool_result["data"]["ok"] is True
    assert "arguments" not in tool_call["data"]
    assert {e["team_id"] for e in ev if e["agent_id"]} == {"support"}
    run = [e for e in ev if e["type"] == "run.finished"]
    assert run and run[0]["data"]["status"] == "ok"


def test_capture_content(collector: FakeCollector) -> None:
    init_fast(collector.url, capture_content=True)
    run_desk()
    agentspace.flush()
    (tool_call,) = [e for e in collector.events if e["type"] == "tool.call"]
    assert json.loads(tool_call["data"]["arguments"]) == {"invoice_id": "42"}


def test_inside_manual_run(collector: FakeCollector) -> None:
    init_fast(collector.url)
    with agentspace.run("outer") as r:
        run_desk()
    agentspace.flush()
    assert {e["run_id"] for e in collector.events} == {r.run_id}
    assert [e["type"] for e in collector.events].count("run.started") == 1


def test_noop_without_init() -> None:
    assert run_desk().final_output.startswith("Invoice 42")


def test_state_cleaned_up(collector: FakeCollector) -> None:
    init_fast(collector.url)
    run_desk()
    p = oa.get_processor()
    assert p._nodes == {} and p._runs == {}


# ---------------- pause / cancel ----------------


def _on_billing(action: str) -> Any:
    def auto(e: dict[str, Any]) -> str | None:
        return action if e["type"] == "agent.registered" and e["agent_id"] == "billing" else None

    return auto


def _flush_on_second_reply(n: int) -> None:
    if n == 1:  # billing's first model call: the control arrives with this flush
        assert agentspace.flush()


def test_cancel_stops_run_at_next_span(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    init_fast(collector.url)
    collector.auto_control = _on_billing("cancelled")
    with pytest.raises(agentspace.Cancelled):
        asyncio.run(Runner.run(build_support_desk(_flush_on_second_reply), "Is invoice 42 paid?"))
    agentspace.flush()
    ev = collector.events
    assert_valid_events(validator, ev)
    assert not [e for e in ev if e["type"] in ("error", "tool.call")]  # lookup never ran
    assert [e["data"]["status"] for e in ev if e["type"] == "run.finished"] == ["cancelled"]
    assert oa.get_processor()._runs == {}


def test_control_hooks_pause_until_resumed(collector: FakeCollector) -> None:
    import threading

    init_fast(collector.url)
    collector.auto_control = _on_billing("paused")

    def flush_and_resume(n: int) -> None:
        if n == 1:
            assert agentspace.flush()
            collector.auto_control = None
            run_id = collector.events[0]["run_id"]
            threading.Timer(0.3, lambda: collector.controls.pop(run_id)).start()

    result = asyncio.run(
        Runner.run(
            build_support_desk(flush_and_resume), "Is invoice 42 paid?", hooks=oa.ControlHooks()
        )
    )
    assert result.final_output.startswith("Invoice 42")
    agentspace.flush()
    ev = collector.events
    blocked = [e for e in ev if e["type"] == "agent.status" and e["data"]["status"] == "blocked"]
    assert blocked and blocked[0]["agent_id"] == "billing"
    assert [e["data"]["status"] for e in ev if e["type"] == "run.finished"] == ["ok"]


def test_usage_reads_cache_tokens() -> None:
    from agents.tracing.span_data import GenerationSpanData

    data = GenerationSpanData(
        model="gpt-5-mini",
        usage={
            "input_tokens": 900,
            "output_tokens": 30,
            "input_tokens_details": {"cached_tokens": 512, "cache_write_tokens": 0},
        },
    )
    assert oa._usage(data) == ("gpt-5-mini", 900, 30, 512, None)
