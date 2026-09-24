"""Claude Agent SDK adapter conformance: replay a hook + message recording (no CLI, no key)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("claude_agent_sdk")

from conftest import FakeCollector, assert_valid_events, init_fast
from jsonschema import Draft202012Validator

import agentspace
from agentspace.adapters import claude_agent_sdk as cas

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "claude_agent_support.json").read_text())


def replay(**init: Any) -> None:
    tracker = cas.ClaudeAgentTracker(**FIXTURE["tracker"])
    cas.replay(FIXTURE["items"], tracker)
    assert agentspace.flush()


def test_session_replay(collector: FakeCollector, validator: Draft202012Validator) -> None:
    init_fast(collector.url)
    replay()
    ev = collector.events
    assert_valid_events(validator, ev)

    agents = {e["agent_id"]: e["data"] for e in ev if e["type"] == "agent.registered"}
    assert set(agents) == {"support", "billing-specialist"}
    assert agents["support"]["role"] == "customer support lead"
    assert {e["team_id"] for e in ev if e["agent_id"]} == {"support-desk"}

    (handoff,) = [e for e in ev if e["type"] == "handoff"]
    assert handoff["data"]["from_agent_id"] == "support"
    assert handoff["data"]["to_agent_id"] == "billing-specialist"

    tools = [(e["agent_id"], e["data"]["tool_name"]) for e in ev if e["type"] == "tool.call"]
    assert tools == [
        ("support", "Task"),
        ("billing-specialist", "mcp__crm__lookup_invoice"),
        ("support", "mcp__billing__refund"),
    ]
    assert all("arguments" not in e["data"] for e in ev if e["type"] == "tool.call")

    llm = [e for e in ev if e["type"] == "llm.call"]
    assert [
        (e["agent_id"], e.get("model"), e.get("tokens_in"), e.get("tokens_out")) for e in llm[:4]
    ] == [
        ("support", "claude-sonnet-5", 3000, 64),  # input + cache reads
        ("billing-specialist", "claude-haiku-4-5", 900, 40),  # attributed via parent_tool_use_id
        ("support", "claude-sonnet-5", 2400, 52),
        ("support", "claude-sonnet-5", 2600, 30),
    ]
    cost = [e for e in llm if e.get("cost_usd")]
    assert len(cost) == 1 and cost[0]["cost_usd"] == pytest.approx(0.0231)
    assert not cost[0].get("tokens_in")  # cost entry never double counts tokens

    statuses = [(e["agent_id"], e["data"]["status"]) for e in ev if e["type"] == "agent.status"]
    assert ("support", "waiting_human") in statuses  # the refund needed approval
    final = {}
    for agent_id, status in statuses:
        final[agent_id] = status
    assert final == {"support": "done", "billing-specialist": "done"}
    types = [e["type"] for e in ev]
    assert types[0] == "run.started" and "run.finished" in types


def test_hooks_merge_with_user_hooks() -> None:
    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

    async def mine(*_: Any) -> dict[str, Any]:
        return {}

    options = ClaudeAgentOptions(hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[mine])]})
    out = cas.instrument_options(options, name="Support")
    assert out is not options
    assert out.hooks["PreToolUse"][0].hooks == [mine]  # user hook first, untouched
    assert len(out.hooks["PreToolUse"]) == 2
    assert "SubagentStart" in out.hooks
    assert (
        options.hooks is not None and len(options.hooks["PreToolUse"]) == 1
    )  # original not mutated


def test_hook_callbacks_never_change_behaviour_or_raise(collector: FakeCollector) -> None:
    init_fast(collector.url)
    tracker = cas.ClaudeAgentTracker("Support")
    callback = tracker.hooks()["PreToolUse"][0].hooks[0]
    assert asyncio.run(callback({"garbage": object()}, None, None)) == {}
    assert asyncio.run(callback(None, None, None)) == {}  # not even a dict


def test_track_passes_messages_through(collector: FakeCollector) -> None:
    from claude_agent_sdk import ResultMessage

    init_fast(collector.url)
    msg = ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        total_cost_usd=0.01,
    )

    async def stream() -> Any:
        yield msg
        yield "not a message"

    async def collect() -> list[Any]:
        return [m async for m in cas.track(stream())]

    assert asyncio.run(collect()) == [msg, "not a message"]
    agentspace.flush()
    assert any(e.get("cost_usd") == 0.01 for e in collector.events)


def test_noop_without_init() -> None:
    cas.replay(FIXTURE["items"], cas.ClaudeAgentTracker())


def test_budget_stop_without_stop_hook_still_finishes_the_run(collector: FakeCollector) -> None:
    """Seen live: hitting max_budget_usd ends with an error ResultMessage and no Stop hook."""
    init_fast(collector.url)
    items = [
        i
        for i in FIXTURE["items"]
        if i.get("hook") != "Stop" and i.get("message") != "ResultMessage"
    ]
    items.append(
        {
            "message": "ResultMessage",
            "data": {
                "subtype": "error_max_budget_usd",
                "duration_ms": 5000,
                "duration_api_ms": 4000,
                "is_error": True,
                "num_turns": 2,
                "session_id": "sess-1",
                "total_cost_usd": 0.1,
                "errors": ["Reached maximum budget ($0.1)"],
            },
        }
    )
    cas.replay(items, cas.ClaudeAgentTracker(**FIXTURE["tracker"]))
    agentspace.flush()
    ev = collector.events
    finished = [e for e in ev if e["type"] == "run.finished"]
    assert len(finished) == 1 and finished[0]["data"]["status"] == "error"
    errors = [e["data"]["message"] for e in ev if e["type"] == "error"]
    assert "Reached maximum budget ($0.1)" in errors
    assert [e for e in ev if e["type"] == "step.finished" and e["data"]["name"] == "turn 1"]


def test_split_assistant_messages_are_merged(collector: FakeCollector) -> None:
    """Seen live: one API response arrives as several AssistantMessages with the same id;
    early ones carry partial output usage. Count the response once, with its final usage."""
    init_fast(collector.url)
    base = {"model": "claude-haiku-4-5", "message_id": "msg_x", "session_id": "s9"}
    items = [
        {"hook": "UserPromptSubmit", "data": {"session_id": "s9", "prompt": "hi"}},
        {
            "message": "AssistantMessage",
            "data": {
                **base,
                "content": [{"type": "text", "text": "Let me check."}],
                "usage": {"input_tokens": 3700, "output_tokens": 6},
            },
        },
        {
            "message": "AssistantMessage",
            "data": {
                **base,
                "content": [{"type": "tool_use", "id": "t1", "name": "Agent", "input": {}}],
                "usage": {"input_tokens": 3700, "output_tokens": 58},
            },
        },
        {
            "message": "ResultMessage",
            "data": {
                "subtype": "success",
                "duration_ms": 1,
                "duration_api_ms": 1,
                "is_error": False,
                "num_turns": 1,
                "session_id": "s9",
            },
        },
    ]
    cas.replay(items, cas.ClaudeAgentTracker("Support"))
    agentspace.flush()
    (llm,) = [e for e in collector.events if e["type"] == "llm.call"]
    assert (llm["tokens_in"], llm["tokens_out"]) == (3700, 58)
    assert llm["summary"] == "chose tool: Agent"
