"""Policy enforcement: guard_tool / aguard_tool (D-045)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import pytest
from conftest import FakeCollector, assert_valid_events, free_port, init_fast
from jsonschema import Draft202012Validator

import agentspace

Denied = agentspace.PolicyDenied

POLICY = {
    "tools": [
        {"match": "delete_*", "action": "block", "reason": "Deletes are never automatic."},
        {"match": "deploy", "action": "review", "reason": "Production change."},
        {"match": "send_email", "action": "review", "show_arguments": False},
        {"match": "write_file", "action": "allow", "on_findings": "review"},
    ]
}


def test_without_init_everything_is_allowed() -> None:
    agentspace.shutdown(timeout=0.1)
    assert agentspace.guard_tool("delete_everything").action == "allow"


def test_allowed_calls_ask_nobody(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, policy=POLICY)
    with agentspace.run("r"), agentspace.agent("Coder"):
        d = agentspace.guard_tool("search", {"q": "x"})
    assert (d.action, d.source) == ("allow", "code")
    assert agentspace.flush()
    assert not collector.of_type("approval.requested")


def test_blocked_calls_raise_a_message_for_the_model(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, policy=POLICY)
    with (
        agentspace.run("r"),
        agentspace.agent("Coder"),
        pytest.raises(Denied) as err,
    ):
        agentspace.guard_tool("delete_customer", {"id": 1})
    assert err.value.outcome == "blocked"
    assert str(err.value).startswith(
        "delete_customer is blocked by policy (rule delete_*): Deletes are never automatic."
    )
    assert isinstance(err.value, Exception)  # a tool error, not a run-stopping BaseException
    assert agentspace.flush()
    assert not collector.of_type("approval.requested")


def test_review_asks_with_the_rule_and_redacted_arguments(
    collector: FakeCollector, validator: Draft202012Validator
) -> None:
    def redact(field: str, value: Any) -> Any:
        return {**value, "token": "[redacted]"} if field == "tool.arguments" else value

    init_fast(collector.url, auto_instrument=False, policy=POLICY, redact=redact)
    collector.on_approval = lambda e: ("approved", "ok")
    args = {"version": "1.2", "token": "s3cret"}
    with agentspace.run("r"), agentspace.agent("Deployer"):
        d = agentspace.guard_tool("deploy", args, timeout=10)
    assert d.action == "review"
    assert agentspace.flush()
    (req,) = collector.of_type("approval.requested")
    assert req["agent_id"] == "deployer"
    assert req["data"]["reason"] == "Run deploy? Production change."
    assert req["data"]["payload"] == {
        "tool": "deploy",
        "arguments": {"version": "1.2", "token": "[redacted]"},
    }
    assert req["data"]["policy"] == {
        "tool": "deploy",
        "action": "review",
        "rule": "deploy",
        "source": "code",
        "reason": "Production change.",
        "arguments_hash": agentspace.hash_arguments(args),
    }
    assert_valid_events(validator, collector.events)


def test_rejected_and_hidden_arguments(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, policy=POLICY)
    collector.on_approval = lambda e: ("rejected", "wrong recipient")
    with (
        agentspace.run("r"),
        agentspace.agent("Support"),
        pytest.raises(Denied) as err,
    ):
        agentspace.guard_tool("send_email", {"to": "a@example.com"}, timeout=10)
    assert err.value.outcome == "rejected"
    assert "rejected by an operator: wrong recipient" in str(err.value)
    assert agentspace.flush()
    (req,) = collector.of_type("approval.requested")
    assert req["data"]["payload"] == {"tool": "send_email"}  # show_arguments: false
    assert len(req["data"]["policy"]["arguments_hash"]) == 16


def test_the_collector_policy_counts_and_the_stricter_one_wins(collector: FakeCollector) -> None:
    collector.policy = {"tools": [{"match": "search", "action": "block", "reason": "Offline."}]}
    init_fast(
        collector.url,
        auto_instrument=False,
        policy={"tools": [{"match": "search", "action": "allow"}]},
    )
    with (
        agentspace.run("r"),
        agentspace.agent("Coder"),
        pytest.raises(Denied) as err,
    ):
        agentspace.guard_tool("search")
    assert err.value.decision.source == "collector"
    assert collector.policy_requests >= 1


def test_findings_escalate_a_run(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, policy=POLICY)
    collector.on_approval = lambda e: ("approved", None)
    with agentspace.run("r") as run, agentspace.agent("Coder"):
        assert agentspace.guard_tool("write_file").action == "allow"
        collector.escalated.add(run.run_id)
        agentspace.set_status("thinking")  # any event: the ingest response says "escalated"
        assert agentspace.flush()
        d = agentspace.guard_tool("write_file", {"path": "a.py"}, timeout=10)
    assert (d.action, d.escalated) == ("review", True)
    (req,) = collector.of_type("approval.requested")
    assert req["data"]["policy"]["escalated"] is True
    assert "detector findings" in req["data"]["reason"]


def test_review_fails_closed_without_a_collector() -> None:
    url = f"http://127.0.0.1:{free_port()}"
    init_fast(url, auto_instrument=False, policy=POLICY, timeout=0.2)
    started = time.monotonic()
    with (
        agentspace.run("r"),
        agentspace.agent("Deployer"),
        pytest.raises(Denied) as err,
    ):
        agentspace.guard_tool("deploy", timeout=30)
    assert err.value.outcome == "rejected"
    assert time.monotonic() - started < 10
    agentspace.shutdown(timeout=0.1)


def test_an_invalid_code_policy_fails_closed(
    collector: FakeCollector, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger="agentspace"):
        init_fast(collector.url, auto_instrument=False, policy={"tools": [{"match": "x"}]})
    assert "tools[0].action" in caplog.text
    collector.on_approval = lambda e: ("rejected", None)
    with agentspace.run("r"), agentspace.agent("Coder"), pytest.raises(Denied):
        agentspace.guard_tool("search", timeout=10)


def test_pause_rules_in_code_are_ignored_with_a_warning(
    collector: FakeCollector, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="agentspace"):
        init_fast(collector.url, auto_instrument=False, policy={"on_findings": {"pause": ["*"]}})
    assert "only works in the collector's policy" in caplog.text


def test_policy_from_a_file(collector: FakeCollector, tmp_path: Any) -> None:
    path = tmp_path / "policy.json"
    path.write_text('{"tools": [{"match": "rm", "action": "block"}]}')
    init_fast(collector.url, auto_instrument=False, policy=str(path))
    with agentspace.run("r"), pytest.raises(Denied):
        agentspace.guard_tool("rm")


def test_aguard_tool_waits_without_blocking_the_loop(collector: FakeCollector) -> None:
    init_fast(collector.url, auto_instrument=False, policy=POLICY)

    def decide_later(e: dict[str, Any]) -> None:
        def run() -> None:
            time.sleep(0.3)
            collector.resolve(e["data"]["approval_id"], "approved")

        import threading

        threading.Thread(target=run, daemon=True).start()

    collector.on_approval = decide_later

    async def main() -> tuple[str, int]:
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        t = asyncio.create_task(ticker())
        with agentspace.run("r"), agentspace.agent("Deployer"):
            d = await agentspace.aguard_tool("deploy", timeout=10)
        t.cancel()
        return d.action, ticks

    action, ticks = asyncio.run(main())
    assert action == "review" and ticks > 10


def test_denial_message_punctuation() -> None:
    from agentspace._oversight import PolicyDenied
    from agentspace._policy import PolicyDecision

    with_dot = PolicyDecision("block", "deploy", "code", True, False, "No deploys on Fridays.")
    plain = PolicyDecision("block", "deploy", "code", True, False, "no deploys")
    assert str(PolicyDenied("deploy", "blocked", with_dot)).startswith(
        "deploy is blocked by policy (rule deploy): No deploys on Fridays. Don't retry"
    )
    assert "no deploys. Don't retry" in str(PolicyDenied("deploy", "blocked", plain))
