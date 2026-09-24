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
import urllib.parse  # noqa: E402
from collections.abc import Iterator  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

import agentspace  # noqa: E402


class FakeCollector:
    """Records batches and emulates the approval and run-control endpoints."""

    def __init__(self, port: int = 0) -> None:
        self.events: list[dict[str, Any]] = []
        self.batches = 0
        self.status = 200
        self.approvals: dict[str, dict[str, Any]] = {}
        self.controls: dict[str, str] = {}
        self.approval_status_override: int | None = None
        self.closing = False
        #: Called per ingested event; may return a control ("paused"/"cancelled") for its run.
        self.auto_control: Any = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _json(self, code: int, body: Any) -> None:
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if outer.status != 200:
                    self._json(outer.status, {"error": "nope"})
                    return
                events = json.loads(body)["events"]
                outer.events.extend(events)
                outer.batches += 1
                runs = set()
                for e in events:
                    runs.add(e["run_id"])
                    if outer.auto_control and (action := outer.auto_control(e)):
                        outer.controls[e["run_id"]] = action
                    if e["type"] == "approval.requested":
                        outer.approvals[e["data"]["approval_id"]] = {"status": "pending"}
                controls = {r: outer.controls[r] for r in runs if r in outer.controls}
                self._json(200, {"accepted": len(events), "rejected": 0, "controls": controls})

            def do_GET(self) -> None:
                url = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(url.query)
                wait = float(q.get("wait", ["0"])[0])
                deadline = time.monotonic() + wait
                if "/approvals/" in url.path:
                    if outer.approval_status_override:
                        self._json(outer.approval_status_override, {"error": "x"})
                        return
                    aid = url.path.rsplit("/", 1)[-1]
                    while (
                        outer.approvals.get(aid, {}).get("status") == "pending"
                        and time.monotonic() < deadline
                    ):
                        if outer.closing:  # like a crash: drop the connection, no response
                            self.close_connection = True
                            self.connection.close()
                            return
                        time.sleep(0.02)
                    a = outer.approvals.get(aid)
                    self._json(200 if a else 404, a or {"error": "not found"})
                elif url.path.endswith("/controls"):
                    runs = q.get("runs", [""])[0].split(",")
                    before = {r: outer.controls.get(r) for r in runs}
                    while (
                        wait
                        and time.monotonic() < deadline
                        and {r: outer.controls.get(r) for r in runs} == before
                    ):
                        time.sleep(0.02)
                    self._json(200, {r: outer.controls[r] for r in runs if r in outer.controls})
                else:
                    self._json(404, {})

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def resolve(self, approval_id: str, decision: str, comment: str | None = None) -> None:
        self.approvals[approval_id] = {
            "status": decision,
            "comment": comment,
            "resolved_by": "operator",
        }

    def stop(self) -> None:
        self.closing = True
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
