"""A scripted chat model for `--fake` mode: deterministic, offline, with realistic pacing.

The replies follow the dev-team flow: Manager -> Triage -> Manager -> Engineer -> Manager.
"""

from __future__ import annotations

import random
import time
from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatResult

FIXED_CART = '''"""A tiny shopping cart. It has a seeded bug for the agents to find."""


def total(items: list[dict]) -> float:
    """Sum of price * qty over all items."""
    result = 0.0
    for item in items:
        result += item["price"] * item["qty"]
    return round(result, 2)
'''


def _msg(content: str = "", calls: list[dict[str, Any]] | None = None, tin: int = 0, tout: int = 0) -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=[{**c, "id": f"call_{i}_{c['name']}"} for i, c in enumerate(calls or [])],
        usage_metadata={"input_tokens": tin, "output_tokens": tout, "total_tokens": tin + tout},
        response_metadata={"model_name": "scripted-fake", "stop_reason": "tool_use" if calls else "end_turn"},
    )


def dev_team_script() -> list[AIMessage]:
    return [
        _msg("TRIAGE", tin=180, tout=3),  # Manager
        _msg(calls=[{"name": "run_tests", "args": {}}], tin=420, tout=18),  # Triage
        _msg(calls=[{"name": "read_file", "args": {"path": "cart.py"}}], tin=560, tout=22),
        _msg(
            "total() loops over range(1, len(items)), so it skips the first item. "
            "With the report's cart that drops 2.50x2 and returns 3.0 instead of 8.0.",
            tin=790,
            tout=64,
        ),
        _msg("ENGINEER", tin=260, tout=3),  # Manager
        _msg(calls=[{"name": "write_file", "args": {"path": "cart.py", "content": FIXED_CART}}], tin=880, tout=140),
        _msg(calls=[{"name": "run_tests", "args": {}}], tin=1040, tout=16),  # Engineer
        _msg("Iterate over every item in total(); tests pass.", tin=1150, tout=21),
        _msg("DONE", tin=300, tout=2),  # Manager
    ]


BAD_FIX = '''"""A tiny shopping cart. It has a seeded bug for the agents to find."""


def total(items: list[dict]) -> float:
    """Sum of price * qty over all items."""
    result = 0.0
    for item in items[:-1]:
        result += item["price"] * item["qty"]
    return round(result, 2)
'''


def regression_script() -> list[AIMessage]:
    """`--story`: the same task, but the Engineer's fix is wrong and it keeps re-running the tests.

    After the second write_file the script branches (see StoryChatModel): if a person rejected
    the change, the Engineer gives up; if they approved it, the right fix goes in and tests pass.
    """
    return [
        _msg("TRIAGE", tin=180, tout=3),  # Manager
        _msg(calls=[{"name": "run_tests", "args": {}}], tin=420, tout=18),  # Triage
        _msg(calls=[{"name": "read_file", "args": {"path": "cart.py"}}], tin=560, tout=22),
        _msg(
            "total() loops over range(1, len(items)), so it skips the first item. "
            "With the report's cart that drops 2.50x2 and returns 3.0 instead of 8.0.",
            tin=790,
            tout=64,
        ),
        _msg("ENGINEER", tin=260, tout=3),  # Manager
        # Engineer: a wrong fix (it now skips the *last* item), then the tests, again and again.
        _msg(calls=[{"name": "write_file", "args": {"path": "cart.py", "content": BAD_FIX}}], tin=880, tout=140),
        _msg(calls=[{"name": "run_tests", "args": {}}], tin=1040, tout=16),
        _msg("The tests may be flaky; running them again.", [{"name": "run_tests", "args": {}}], tin=1310, tout=24),
        _msg("Running the tests once more to be sure.", [{"name": "run_tests", "args": {}}], tin=1590, tout=22),
        _msg(
            "Trying a different change to total().",
            [{"name": "write_file", "args": {"path": "cart.py", "content": FIXED_CART}}],
            tin=1880,
            tout=150,
        ),
        # <- StoryChatModel.BRANCH: the replies below depend on that write.
    ]


ON_REJECTED = [
    _msg(
        "I couldn't fix it: my first change made total() skip the last item, and the operator "
        "stopped my second change. Handing back with the failing test output.",
        tin=2050,
        tout=48,
    ),
    _msg("FAILED", tin=340, tout=2),  # Manager: the run ends as failed
]
ON_APPROVED = [
    _msg(calls=[{"name": "run_tests", "args": {}}], tin=2050, tout=16),
    _msg("Iterate over every item in total(); tests pass.", tin=2170, tout=21),
    _msg("DONE", tin=340, tout=2),  # Manager
]


class ScriptedChatModel(FakeMessagesListChatModel):
    latency: float = 0.8

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedChatModel:  # type: ignore[override]
        return self

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        if self.latency:
            time.sleep(self.latency * random.uniform(0.6, 1.4))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


class StoryChatModel(ScriptedChatModel):
    """The regression script, which branches on whether a person let the second write through."""

    calls: int = 0

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        scripted = len(regression_script())
        if self.calls == scripted:
            result = _last_tool_result(messages) or ""
            self.responses.extend(ON_REJECTED if result.startswith("ERROR") else ON_APPROVED)
            self.i = scripted  # the base class wrapped around to 0 after the last reply
        self.calls += 1
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _last_tool_result(messages: list[BaseMessage]) -> str | None:
    for m in reversed(messages):
        if m.type == "tool":
            return str(m.content)
    return None
