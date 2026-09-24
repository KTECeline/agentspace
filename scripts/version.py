#!/usr/bin/env python3
"""One version for every package.

    python3 scripts/version.py show
    python3 scripts/version.py set 0.1.0          # or 0.1.0-rc.1 (Python gets 0.1.0rc1)
    python3 scripts/version.py check v0.1.0       # CI: fail unless every package matches the tag

The npm/semver form is the source of truth; Python uses the PEP 440 equivalent. The event
spec version (SPEC_VERSION, "0.1") and the price table version are separate and never touched.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc|dev)\.(\d+))?$")
PEP440 = {"alpha": "a", "beta": "b", "rc": "rc", "dev": ".dev"}

# (file, regex with one group around the version, "npm" or "python" form)
TARGETS = [
    ("packages/sdk-ts/package.json", r'^  "version": "([^"]+)"', "npm"),
    ("server/package.json", r'^  "version": "([^"]+)"', "npm"),
    ("web/package.json", r'^  "version": "([^"]+)"', "npm"),
    ("server/src/app.ts", r'^export const VERSION = "([^"]+)";', "npm"),
    ("packages/sdk-python/pyproject.toml", r'^version = "([^"]+)"', "python"),
    ("packages/sdk-python/agentspace/__init__.py", r'^__version__ = "([^"]+)"', "python"),
]


def to_python(v: str) -> str:
    m = SEMVER.match(v)
    if not m:
        raise SystemExit(f"not a version: {v!r} (expected 1.2.3 or 1.2.3-rc.1)")
    major, minor, patch, pre, n = m.groups()
    return f"{major}.{minor}.{patch}" + (f"{PEP440[pre]}{n}" if pre else "")


def current() -> dict[str, str]:
    out = {}
    for path, pattern, _ in TARGETS:
        m = re.search(pattern, (ROOT / path).read_text(), re.M)
        out[path] = m.group(1) if m else "?"
    return out


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "show"
    if cmd == "show":
        for path, v in current().items():
            print(f"{v:<14} {path}")
        return 0
    if cmd == "set" and len(argv) == 3:
        v = argv[2].removeprefix("v")
        py = to_python(v)
        for path, pattern, form in TARGETS:
            f = ROOT / path
            text = f.read_text()
            new = form == "npm" and v or py
            text, n = re.subn(pattern, lambda m, new=new: m.group(0).replace(m.group(1), new), text, count=1, flags=re.M)
            if n != 1:
                raise SystemExit(f"version not found in {path}")
            f.write_text(text)
        print(f"set {v} (Python {py}). Next: re-lock the examples (see docs/RELEASING.md).")
        return 0
    if cmd == "check" and len(argv) == 3:
        v = argv[2].removeprefix("refs/tags/").removeprefix("v")
        want = {"npm": v, "python": to_python(v)}
        bad = [(p, have, want[form]) for (p, _, form), have in zip(TARGETS, current().values()) if have != want[form]]
        for p, have, w in bad:
            print(f"::error file={p}::version {have}, tag wants {w}")
        if bad:
            print(f"Run: python3 scripts/version.py set {v}")
            return 1
        print(f"all packages at {v}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
