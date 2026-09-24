"""Background batching transport.

Design goals (see docs/DECISIONS.md D-008, D-011):
- ``put()`` is O(1) and never blocks: a bounded deque plus an optional wake-up signal.
- One daemon thread sends batches with stdlib ``urllib``, so there are no runtime dependencies.
- If the collector is down, events stay buffered up to ``max_queue``. After that the oldest
  are dropped and a rate-limited warning is logged. The sender backs off exponentially.
- Nothing here raises into the caller.
"""

from __future__ import annotations

import contextlib
import json
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Callable
from typing import Any

from agentspace._log import internal_error, logger, warn_limited

_MAX_BACKOFF_S = 10.0


class Transport:
    def __init__(
        self,
        endpoint: str,
        *,
        api_key: str | None = None,
        max_queue: int = 10_000,
        max_batch: int = 100,
        flush_interval: float = 0.2,
        timeout: float = 2.0,
    ) -> None:
        self.endpoint = endpoint
        self.max_queue = max_queue
        self.max_batch = max_batch
        self.flush_interval = flush_interval
        self.timeout = timeout
        self._headers = {"Content-Type": "application/json", "User-Agent": "agentspace-python"}
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"

        self._queue: deque[dict[str, Any]] = deque(maxlen=max_queue)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._sending = False
        self._backoff = 0.0
        self._down_since: float | None = None

        # Counters (read by tests and `agentspace.stats()`).
        self.sent = 0
        self.dropped = 0
        self.rejected = 0

        #: Called with the ingest response's "controls" ({run_id: "paused" | "cancelled"}).
        self.on_controls: Callable[[dict[str, str]], None] | None = None
        #: Called every ``poll_interval`` seconds from the sender thread (control polling).
        self.poll: Callable[[], None] | None = None
        self.poll_interval = 2.0
        self._last_poll = 0.0

        self._thread = threading.Thread(target=self._run, name="agentspace-transport", daemon=True)
        self._thread.start()

    # ---- producer side (called from user code; must be cheap and never raise) ----

    def put(self, event: dict[str, Any]) -> None:
        q = self._queue
        if len(q) >= self.max_queue:
            # deque(maxlen) drops the oldest item on append; we only count and warn.
            self.dropped += 1
            warn_limited(
                "queue-full",
                "agentspace: event buffer full (%d events), dropping oldest events. "
                "Is the collector at %s running?",
                self.max_queue,
                self.endpoint,
            )
        q.append(event)
        if len(q) >= self.max_batch:
            self._wake.set()

    def flush(self, timeout: float = 2.0) -> bool:
        """Block until the queue is empty or ``timeout`` passes. Returns True if drained."""
        deadline = time.monotonic() + timeout
        self._wake.set()
        while time.monotonic() < deadline:
            if not self._queue and not self._sending:
                return True
            if self._down_since is not None:
                return False  # collector is down; don't make the caller wait for nothing
            time.sleep(0.01)
        return not self._queue and not self._sending

    def shutdown(self, timeout: float = 2.0) -> None:
        self.flush(timeout)
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=0.5)

    @property
    def pending(self) -> int:
        return len(self._queue)

    # ---- consumer side (background thread) ----

    def _run(self) -> None:
        while not self._stop.is_set():
            if self._backoff:
                # While the collector is down, ignore wake-ups from put() so we don't hammer it.
                self._stop.wait(self._backoff)
            else:
                self._wake.wait(self.flush_interval)
            self._wake.clear()
            try:
                self._drain()
            except Exception as exc:  # pragma: no cover - defensive
                internal_error("transport", exc)
            if (
                self.poll is not None
                and not self._backoff
                and time.monotonic() - self._last_poll >= self.poll_interval
            ):
                self._last_poll = time.monotonic()
                try:
                    self.poll()
                except Exception as exc:  # pragma: no cover - defensive
                    internal_error("transport.poll", exc)

    def _drain(self) -> None:
        while self._queue and not self._stop.is_set():
            batch: list[dict[str, Any]] = []
            self._sending = True
            try:
                while self._queue and len(batch) < self.max_batch:
                    batch.append(self._queue.popleft())
                ok = self._send(batch)
            finally:
                self._sending = False
            if not ok:
                # Put the batch back at the front (oldest first) if there is room, then back off.
                room = self.max_queue - len(self._queue)
                keep = batch[-room:] if room > 0 else []
                self.dropped += len(batch) - len(keep)
                self._queue.extendleft(reversed(keep))
                self._backoff = min(_MAX_BACKOFF_S, (self._backoff or 0.25) * 2)
                return
            self._backoff = 0.0

    def _send(self, batch: list[dict[str, Any]]) -> bool:
        """Returns False when the batch should be retried later."""
        body = json.dumps({"events": batch}, default=str, separators=(",", ":")).encode()
        req = urllib.request.Request(self.endpoint, data=body, headers=self._headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                self._on_response(resp.status, resp.read(), len(batch))
            return True
        except urllib.error.HTTPError as err:
            if 400 <= err.code < 500 and err.code != 429:
                # The collector rejected the whole batch; retrying won't help.
                self.rejected += len(batch)
                warn_limited(
                    "http-4xx",
                    "agentspace: collector rejected %d events (HTTP %d): %s",
                    len(batch),
                    err.code,
                    _read_error(err),
                )
                self._mark_up()
                return True
            self._mark_down(f"HTTP {err.code}")
            return False
        except Exception as exc:  # URLError, timeout, connection reset, ...
            self._mark_down(repr(exc))
            return False

    def _on_response(self, status: int, raw: bytes, n: int) -> None:
        self._mark_up()
        rejected = 0
        with contextlib.suppress(Exception):
            body = json.loads(raw or b"{}")
            rejected = int(body.get("rejected", 0))
            controls = body.get("controls")
            if controls and self.on_controls is not None:
                self.on_controls(controls)
        self.rejected += rejected
        self.sent += n - rejected
        if rejected:
            warn_limited(
                "partial-reject",
                "agentspace: collector rejected %d of %d events (schema mismatch?)",
                rejected,
                n,
            )

    def _mark_down(self, why: str) -> None:
        if self._down_since is None:
            self._down_since = time.monotonic()
            logger.warning(
                "agentspace: collector at %s unreachable (%s). Buffering up to %d events; "
                "your app keeps running normally.",
                self.endpoint,
                why,
                self.max_queue,
            )

    def _mark_up(self) -> None:
        if self._down_since is not None:
            logger.info(
                "agentspace: collector reachable again after %.1fs",
                time.monotonic() - self._down_since,
            )
            self._down_since = None


def _read_error(err: urllib.error.HTTPError) -> str:
    try:
        return err.read(500).decode("utf-8", "replace")
    except Exception:
        return ""
