"""Keyed hashes of tool arguments (spec: ``tool.call.data.arguments_hash``, DECISIONS D-044).

The collector uses them to spot an agent calling the same tool with the same arguments over and
over, without ever seeing the arguments. The key is random per process: a plain hash of a small
value (``user_id=18291``) could be reversed by trying every value, a keyed one can't, and equal
hashes only mean something within one process (one run), which is all the detectors need.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from typing import Any

from agentspace._log import internal_error

_KEY = secrets.token_bytes(32)

#: Only this much of the serialized arguments is hashed, so a huge argument costs a bounded
#: amount of hashing. Two calls that differ only after 64 KB hash the same, which is fine for
#: spotting repeats.
MAX_HASHED_BYTES = 65_536


def hash_arguments(value: Any) -> str | None:
    """Return the 16-hex-character keyed hash of a tool call's arguments, or None on failure.

    Dicts are serialized with sorted keys, so key order doesn't matter. A string that holds a
    JSON object or array is parsed first, so ``'{"b":1,"a":2}'`` and ``{"a": 2, "b": 1}`` hash
    the same. Never raises.
    """
    try:
        data = _canonical(value)
        return hmac.new(_KEY, data[:MAX_HASHED_BYTES], hashlib.sha256).hexdigest()[:16]
    except Exception as exc:
        internal_error("hash_arguments", exc)
        return None


def _canonical(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        text: str = value
        stripped = text.strip()
        if stripped[:1] not in ("{", "[") or len(stripped) > MAX_HASHED_BYTES:
            return text[:MAX_HASHED_BYTES].encode("utf-8", "replace")
        try:
            value = json.loads(stripped)
        except ValueError:
            return text.encode("utf-8", "replace")
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False)
    return text.encode("utf-8", "replace")
