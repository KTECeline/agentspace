"""Oversight policy semantics (spec/v0.1/policy.schema.json, DECISIONS D-045).

The Python implementation. The TypeScript one is ``packages/spec-types/src/policy.ts``; both must
pass ``spec/v0.1/examples/policy.cases.json``, so change the cases first and then both sides.

- A rule matches when its glob matches the whole tool name (case-sensitive; ``*`` any run of
  characters, ``?`` one character) and, if it lists agents, the calling agent is one of them.
- A rule's action is its ``action``, or its ``on_findings`` when the run has findings and that is
  stricter. Findings never relax anything.
- Within one policy: the strictest matching rule; the default (allow) only when none matches.
- Across policies (code, collector): the strictest. Ties go to the first policy, then the first
  rule.
- A finding pauses the run when any policy lists its detector (or ``"*"``) in
  ``on_findings.pause`` and it is at least ``on_findings.min_severity`` (default warning).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

PolicyAction = Literal["allow", "review", "block"]

_RANK = {"allow": 0, "review": 1, "block": 2}
_SEVERITY = {"info": 0, "warning": 1, "critical": 2}


@dataclass(frozen=True)
class PolicyDecision:
    action: PolicyAction
    #: The deciding rule's ``match``, or None when a default decided (or there are no policies).
    rule: str | None
    source: Literal["code", "collector"] | None
    show_arguments: bool
    #: Stricter than the rule's own action because the run has findings.
    escalated: bool
    reason: str | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


ALLOW = PolicyDecision("allow", None, None, True, False, None)


def evaluate_policy(
    policies: list[tuple[str, dict[str, Any]]], tool: str, agent: str | None, escalated: bool
) -> PolicyDecision:
    """``policies`` is ``[(source, policy), ...]`` in priority order (code first)."""
    best = ALLOW
    best_rank = -1
    for source, policy in policies:
        local: PolicyDecision | None = None
        local_rank = -1
        for rule in policy.get("tools") or []:
            if not glob_match(rule["match"], tool):
                continue
            agents = rule.get("agents")
            if agents is not None and (agent is None or agent not in agents):
                continue
            action = rule["action"]
            esc = False
            on_findings = rule.get("on_findings")
            if escalated and on_findings and _RANK[on_findings] > _RANK[action]:
                action, esc = on_findings, True
            if _RANK[action] > local_rank:
                local_rank = _RANK[action]
                local = PolicyDecision(
                    action,
                    rule["match"],
                    source,  # type: ignore[arg-type]
                    rule.get("show_arguments", True),
                    esc,
                    rule.get("reason"),
                )
        if local is None:
            action = policy.get("default", "allow")
            local_rank = _RANK[action]
            local = PolicyDecision(action, None, source, True, False, None)  # type: ignore[arg-type]
        if local_rank > best_rank:
            best_rank, best = local_rank, local
    return best


def should_pause(policies: list[tuple[str, dict[str, Any]]], detector: str, severity: str) -> bool:
    for _source, policy in policies:
        p = policy.get("on_findings") or {}
        pause = p.get("pause") or []
        if not pause or _SEVERITY.get(severity, 0) < _SEVERITY[p.get("min_severity", "warning")]:
            continue
        if "*" in pause or detector in pause:
            return True
    return False


def glob_match(pattern: str, name: str) -> bool:
    """Whole-string glob: ``*`` any run of characters (including none), ``?`` exactly one."""
    p = n = 0
    star, mark = -1, 0
    while n < len(name):
        if p < len(pattern) and (pattern[p] == "?" or pattern[p] == name[n]):
            p += 1
            n += 1
        elif p < len(pattern) and pattern[p] == "*":
            star, mark = p, n
            p += 1
        elif star != -1:
            p = star + 1
            mark += 1
            n = mark
        else:
            return False
    while p < len(pattern) and pattern[p] == "*":
        p += 1
    return p == len(pattern)


_ACTIONS = ("allow", "review", "block")
_RULE_KEYS = ("match", "agents", "action", "on_findings", "show_arguments", "reason")


def parse_policy(raw: Any) -> tuple[dict[str, Any] | None, list[tuple[str, str]]]:
    """Validate a policy document.

    Returns ``(policy, [])`` or ``(None, [(path, message), ...])``.
    """
    errors: list[tuple[str, str]] = []

    def err(path: str, message: str) -> None:
        errors.append((path, message))

    def is_str(v: Any, lo: int, hi: int) -> bool:
        return isinstance(v, str) and lo <= len(v) <= hi

    def known(o: dict[str, Any], keys: tuple[str, ...], at: str) -> None:
        for k in o:
            if k not in keys:
                err(f"{at}.{k}" if at else str(k), "is not a known setting")

    if not isinstance(raw, dict):
        return None, [("", "a policy must be a JSON object")]
    known(raw, ("version", "default", "tools", "on_findings"), "")
    if "version" in raw and (raw["version"] != 1 or isinstance(raw["version"], bool)):
        err("version", "must be 1")
    if "default" in raw and raw["default"] not in _ACTIONS:
        err("default", "must be allow, review or block")
    if "tools" in raw:
        tools = raw["tools"]
        if not isinstance(tools, list) or len(tools) > 500:
            err("tools", "must be a list of at most 500 rules")
        else:
            for i, rule in enumerate(tools):
                at = f"tools[{i}]"
                if not isinstance(rule, dict):
                    err(at, "must be an object")
                    continue
                known(rule, _RULE_KEYS, at)
                if not is_str(rule.get("match"), 1, 256):
                    err(f"{at}.match", "must be a tool name or glob (1 to 256 characters)")
                if rule.get("action") not in _ACTIONS:
                    err(f"{at}.action", "must be allow, review or block")
                agents = rule.get("agents")
                if "agents" in rule and (
                    not isinstance(agents, list)
                    or not 1 <= len(agents) <= 100
                    or not all(is_str(a, 1, 128) for a in agents)
                ):
                    err(f"{at}.agents", "must be a non-empty list of agent ids")
                if "on_findings" in rule and rule["on_findings"] not in _ACTIONS:
                    err(f"{at}.on_findings", "must be allow, review or block")
                if "show_arguments" in rule and not isinstance(rule["show_arguments"], bool):
                    err(f"{at}.show_arguments", "must be true or false")
                if "reason" in rule and not is_str(rule["reason"], 0, 500):
                    err(f"{at}.reason", "must be text (at most 500 characters)")
    if "on_findings" in raw:
        o = raw["on_findings"]
        if not isinstance(o, dict):
            err("on_findings", "must be an object")
        else:
            known(o, ("pause", "min_severity"), "on_findings")
            pause = o.get("pause")
            if "pause" in o and (
                not isinstance(pause, list)
                or len(pause) > 50
                or not all(is_str(d, 1, 64) for d in pause)
            ):
                err("on_findings.pause", 'must be a list of detector ids (or "*")')
            if "min_severity" in o and o["min_severity"] not in _SEVERITY:
                err("on_findings.min_severity", "must be info, warning or critical")
    return (None, errors) if errors else (raw, [])
