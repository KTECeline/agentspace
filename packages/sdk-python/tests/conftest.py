from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

SPEC_DIR = Path(__file__).resolve().parents[3] / "spec" / "v0.1"


@pytest.fixture(scope="session")
def validator() -> Draft202012Validator:
    schema = json.loads((SPEC_DIR / "event.schema.json").read_text())
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def load_jsonl(name: str) -> list[dict[str, Any]]:
    lines = (SPEC_DIR / "examples" / name).read_text().splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def assert_valid_events(validator: Draft202012Validator, events: list[dict[str, Any]]) -> None:
    """Every event must pass both the JSON Schema and the generated pydantic models."""
    from agentspace.models import AgentSpaceEvent

    for ev in events:
        errors = list(validator.iter_errors(ev))
        assert not errors, f"{ev.get('type')}: {errors[0].message}"
        AgentSpaceEvent.model_validate(ev)
