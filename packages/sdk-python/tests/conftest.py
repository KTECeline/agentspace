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


# ---------------------------------------------------------------------------
# Fake collector: records batches, can be told to fail.
# ---------------------------------------------------------------------------

import socket  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from collections.abc import Iterator  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

import agentspace  # noqa: E402


class FakeCollector:
    def __init__(self, port: int = 0) -> None:
        self.events: list[dict[str, Any]] = []
        self.batches = 0
        self.status = 200
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if outer.status == 200:
                    outer.events.extend(json.loads(body)["events"])
                    outer.batches += 1
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"accepted":0,"rejected":0}')

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def wait_for(self, predicate: Any, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.events):
                return True
            time.sleep(0.02)
        return False

    def of_type(self, type_: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] == type_]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
def collector() -> Iterator[FakeCollector]:
    c = FakeCollector()
    yield c
    agentspace.shutdown(timeout=0.5)
    c.stop()


@pytest.fixture(autouse=True)
def _reset_sdk() -> Iterator[None]:
    yield
    agentspace.shutdown(timeout=0.5)


def init_fast(url: str, **kw: Any) -> None:
    """init() with a short flush interval so tests run quickly."""
    kw.setdefault("flush_interval", 0.02)
    agentspace.init(url=url, **kw)
