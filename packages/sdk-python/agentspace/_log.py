"""Internal logging. The SDK only ever logs; it never raises into user code."""

from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger("agentspace")

_last_logged: dict[str, float] = {}
_lock = threading.Lock()


def warn_limited(key: str, msg: str, *args: object, interval: float = 30.0) -> None:
    """Log a warning at most once per ``interval`` seconds for a given key."""
    now = time.monotonic()
    with _lock:
        last = _last_logged.get(key)
        if last is not None and now - last < interval:
            return
        _last_logged[key] = now
    logger.warning(msg, *args)


def internal_error(where: str, exc: BaseException) -> None:
    """Report a bug inside the SDK without disturbing the host app."""
    warn_limited(
        f"internal:{where}",
        "agentspace: internal error in %s (ignored, your app is unaffected): %r",
        where,
        exc,
    )
