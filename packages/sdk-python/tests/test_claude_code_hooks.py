"""Claude Code hook command: payload mapping, never-fail behaviour, and settings install."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeCollector, assert_valid_events, free_port
from jsonschema import Draft202012Validator

from agentspace import claude_code as cc

BASE = {"session_id": "s-1", "transcript_path": "/tmp/t.jsonl", "cwd": "/Users/me/code/my-app"}


def hook(event: str, **fields: Any) -> dict[str, Any]:
    return {**BASE, "hook_event_name": event, **fields}


SESSION = [
    hook("SessionStart", source="startup"),
    hook("UserPromptSubmit", prompt="fix the failing test"),
    hook(
        "PreToolUse",
        tool_name="Read",
        tool_input={"file_path": "/Users/me/code/my-app/src/cart.py"},
        tool_use_id="t1",
    ),
    hook(
        "PostToolUse", tool_name="Read", tool_input={}, tool_response={"ok": True}, tool_use_id="t1"
    ),
    hook(
        "PreToolUse",
        tool_name="Task",
        tool_input={"subagent_type": "code-reviewer", "description": "review"},
        tool_use_id="t2",
    ),
    hook("SubagentStart", agent_id="a-9", agent_type="code-reviewer"),
    hook(
        "PreToolUse",
        tool_name="Grep",
        tool_input={"pattern": "def total"},
        tool_use_id="t3",
        agent_id="a-9",
        agent_type="code-reviewer",
    ),
    hook(
        "PostToolUseFailure",
        tool_name="Grep",
        tool_input={},
        tool_use_id="t3",
        error="timeout",
        agent_id="a-9",
        agent_type="code-reviewer",
    ),
    hook(
        "SubagentStop",
        agent_id="a-9",
        agent_type="code-reviewer",
        stop_hook_active=False,
        agent_transcript_path="/tmp/a",
    ),
    hook("PostToolUse", tool_name="Task", tool_input={}, tool_response="ok", tool_use_id="t2"),
    hook(
        "Notification",
        message="Claude needs your permission to use Bash",
        notification_type="permission_prompt",
    ),
    hook("Stop", stop_hook_active=False),
    hook("SessionEnd", reason="exit"),
]


def test_session_maps_to_valid_events(validator: Draft202012Validator) -> None:
    events = [e for p in SESSION for e in cc.events_from_hook(p, "ws")]
    assert_valid_events(validator, events)
    assert {e["run_id"] for e in events} == {"s-1"}
    assert {e["team_id"] for e in events if e["agent_id"]} == {"my-app"}  # project dir = room
    agents = {e["agent_id"] for e in events if e["type"] == "agent.registered"}
    assert agents == {"claude-code", "code-reviewer"}
    calls = [
        (e["agent_id"], e["data"]["tool_name"], e.get("summary"))
        for e in events
        if e["type"] == "tool.call"
    ]
    assert calls == [
        ("claude-code", "Read", "Read cart.py"),  # file name only, never contents or full path
        ("claude-code", "Task", "Task code-reviewer"),
        ("code-reviewer", "Grep", "Grep"),  # search patterns can be sensitive: not sent
    ]
    (handoff,) = [e for e in events if e["type"] == "handoff"]
    assert handoff["data"] == {"from_agent_id": "claude-code", "to_agent_id": "code-reviewer"}
    assert [e["data"]["ok"] for e in events if e["type"] == "tool.result"] == [True, False, True]
    statuses = [(e["agent_id"], e["data"]["status"]) for e in events if e["type"] == "agent.status"]
    assert ("claude-code", "waiting_human") in statuses
    assert statuses[-1] == ("claude-code", "done")
    assert events[-1]["type"] == "run.finished"
    assert "prompt" not in json.dumps(events)  # prompts never leave the machine


@pytest.mark.parametrize(
    "payload", ["", "not json", "[]", '{"hook_event_name": 42}', '{"tool_input": null}']
)
def test_odd_input_never_fails(payload: str) -> None:
    cc.run_hook(payload)  # must not raise


def test_command_is_silent_fast_and_exits_zero_with_collector_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = {"AGENTSPACE_URL": f"http://127.0.0.1:{free_port()}", "PATH": "/usr/bin:/bin"}
    t0 = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-m", "agentspace.claude_code", "hook"],
        input=json.dumps(SESSION[2]),
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )
    assert proc.returncode == 0
    assert proc.stdout == ""  # stdout would be fed back into Claude's context
    assert time.monotonic() - t0 < 5


def test_events_reach_the_collector(
    collector: FakeCollector, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENTSPACE_URL", collector.url)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(SESSION[0])))
    assert cc.main(["hook"]) == 0
    assert collector.of_type("run.started")


def test_install_is_idempotent_and_keeps_existing_settings(tmp_path: Path) -> None:
    path = tmp_path / ".claude" / "settings.json"
    path.parent.mkdir()
    mine = {"type": "command", "command": "echo mine"}
    path.write_text(
        json.dumps(
            {"model": "opus", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [mine]}]}}
        )
    )

    assert cc.install(path, command="python -m agentspace.claude_code hook") is True
    assert cc.install(path, command="python -m agentspace.claude_code hook") is False  # idempotent
    settings = json.loads(path.read_text())
    assert settings["model"] == "opus"
    assert settings["hooks"]["PreToolUse"][0] == {"matcher": "Bash", "hooks": [mine]}
    assert set(settings["hooks"]) == set(cc.HOOK_EVENTS)

    assert cc.uninstall(path) is True
    settings = json.loads(path.read_text())
    assert settings == {
        "model": "opus",
        "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [mine]}]},
    }
