from __future__ import annotations

import pytest
from conftest import assert_valid_events, load_jsonl
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from agentspace.models import AgentSpaceEvent


def test_valid_examples_pass(validator: Draft202012Validator) -> None:
    events = load_jsonl("valid.jsonl")
    schema_types = set(validator.schema["$defs"]["EventType"]["enum"])
    assert {e["type"] for e in events} == schema_types, "examples should cover every event type"
    assert_valid_events(validator, events)


@pytest.mark.parametrize("event", load_jsonl("invalid.jsonl"), ids=lambda e: e["id"])
def test_invalid_examples_fail(validator: Draft202012Validator, event: dict[str, object]) -> None:
    assert list(validator.iter_errors(event)), "JSON Schema should reject"
    with pytest.raises(ValidationError):
        AgentSpaceEvent.model_validate(event)
