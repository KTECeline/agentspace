from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def new_id() -> str:
    return uuid.uuid4().hex


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def slugify(name: str) -> str:
    """Stable id from a display name: 'QA Engineer' -> 'qa-engineer'."""
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return (slug or "agent")[:128]


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
