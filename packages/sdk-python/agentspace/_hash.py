"""Keyed hashes of tool arguments (spec: ``tool.call.data.arguments_hash``, DECISIONS D-044).

The collector uses them to spot an agent calling the same tool with the same arguments over and
over, without ever seeing the arguments. The key is random per process: a plain hash of a small
value (``user_id=18291``) could be reversed by trying every value, a keyed one can't, and equal
hashes only mean something within one process (one run), which is all the detectors need.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import secrets
from collections.abc import Iterator
from itertools import islice
from typing import Any

from agentspace._log import internal_error

_KEY = secrets.token_bytes(32)

#: Hashing cost is bounded whatever the argument's size: a long string is reduced to a digest of
#: its first ``MAX_STRING_CHARS`` characters (one C-speed pass), and the walk over nested
#: structures stops after ``MAX_NODES`` values. Arguments that differ only beyond those limits
#: hash the same, which is fine for spotting repeats.
MAX_STRING_CHARS = 262_144
MAX_NODES = 500
_SHORT = 256


def hash_arguments(value: Any) -> str | None:
    """Return the 16-hex-character keyed hash of a tool call's arguments, or None on failure.

    Dicts are serialized with sorted keys, so key order doesn't matter. A string that holds a
    JSON object or array is parsed first, so ``'{"b":1,"a":2}'`` and ``{"a": 2, "b": 1}`` hash
    the same. Never raises.
    """
    try:
        return hmac.new(_KEY, _canonical(value), hashlib.sha256).hexdigest()[:16]
    except Exception as exc:
        internal_error("hash_arguments", exc)
        return None


def _canonical(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value[:MAX_STRING_CHARS]
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in ("{", "[") and len(stripped) <= MAX_STRING_CHARS:
            with contextlib.suppress(ValueError):
                value = json.loads(stripped)
    budget = [MAX_NODES]
    return "".join(_chunks(value, budget, 0)).encode("utf-8", "replace")


_MAX_DEPTH = 32


def _chunks(value: Any, budget: list[int], depth: int) -> Iterator[str]:
    """Sorted-key compact JSON, piece by piece; long strings become digests (see the limits)."""
    budget[0] -= 1
    if budget[0] < 0:
        return
    if value is None or isinstance(value, (bool, int, float)):
        yield json.dumps(value)
    elif isinstance(value, str):
        if len(value) <= _SHORT:
            yield json.dumps(value, ensure_ascii=False)
        else:
            digest = hashlib.sha256(value[:MAX_STRING_CHARS].encode("utf-8", "replace"))
            yield f"#{len(value)}:{digest.hexdigest()}"
    elif depth >= _MAX_DEPTH:
        yield from _chunks(str(value), budget, depth)
    elif isinstance(value, dict):
        yield "{"
        # Sorting a huge dict would cost more than the budget lets us read; keep its order then.
        keys = sorted(value, key=str) if len(value) <= MAX_NODES else islice(value, MAX_NODES)
        for i, key in enumerate(keys):
            if budget[0] < 0:
                break
            yield ("," if i else "") + json.dumps(str(key), ensure_ascii=False) + ":"
            yield from _chunks(value[key], budget, depth + 1)
        yield "}"
    elif isinstance(value, (list, tuple)):
        yield "["
        for i, item in enumerate(value):
            if budget[0] < 0:
                break
            if i:
                yield ","
            yield from _chunks(item, budget, depth + 1)
        yield "]"
    else:
        yield from _chunks(str(value), budget, depth)
