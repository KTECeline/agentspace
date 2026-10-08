"""Policy conformance: the same cases as the TypeScript implementation.

See server/tests/policy.test.ts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agentspace._policy import evaluate_policy, glob_match, parse_policy, should_pause

CASES: dict[str, Any] = json.loads(
    (Path(__file__).parents[3] / "spec" / "v0.1" / "examples" / "policy.cases.json").read_text()
)


def _policies(c: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return [(p["source"], p["policy"]) for p in c["policies"]]


@pytest.mark.parametrize("case", CASES["evaluate"], ids=lambda c: c["name"])
def test_evaluate(case: dict[str, Any]) -> None:
    i = case["input"]
    decision = evaluate_policy(_policies(case), i["tool"], i["agent"], i["escalated"])
    assert decision.as_dict() == case["expect"]


@pytest.mark.parametrize("case", CASES["pause"], ids=lambda c: c["name"])
def test_pause(case: dict[str, Any]) -> None:
    f = case["finding"]
    assert should_pause(_policies(case), f["detector"], f["severity"]) is case["expect"]


@pytest.mark.parametrize("case", CASES["invalid"], ids=lambda c: c["name"])
def test_invalid(case: dict[str, Any]) -> None:
    policy, errors = parse_policy(case["policy"])
    assert policy is None
    assert case["path"] in [path for path, _ in errors]


def test_valid() -> None:
    docs = CASES["valid"] + [p["policy"] for c in CASES["evaluate"] for p in c["policies"]]
    for doc in docs:
        assert parse_policy(doc) == (doc, [])


def test_glob() -> None:
    assert glob_match("*", "")
    assert glob_match("a*b*c", "aXXbYYc")
    assert not glob_match("a*b*c", "aXXbYY")
    assert glob_match("**x", "abx")
    assert not glob_match("[ab]", "a")
