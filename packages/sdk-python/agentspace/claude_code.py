"""Watch your own Claude Code sessions in the AgentSpace office.

Claude Code runs "command" hooks as short-lived processes with the hook payload as JSON on stdin.
This module is that command:

    python -m agentspace.claude_code install            # this project (.claude/settings.json)
    python -m agentspace.claude_code install --user     # every project (~/.claude/settings.json)
    python -m agentspace.claude_code uninstall [--user]

Each hook run turns one payload into a few AgentSpace events and POSTs them with a 300 ms
timeout. Because PreToolUse hooks block Claude Code, the command:

- never prints anything (hook stdout can be fed back into Claude's context);
- always exits 0, even if the collector is down or the payload is odd;
- keeps no state between runs.

Mapping: session -> run; the project directory -> team (room); Claude Code -> agent "Claude Code";
subagents -> their own desks (by agent type); tool hooks -> tool calls; permission prompts and
permission notifications -> "needs you".

Env: ``AGENTSPACE_URL`` (default http://localhost:4800), ``AGENTSPACE_WORKSPACE`` (default
``default``), ``AGENTSPACE_API_KEY``.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import urllib.request
from pathlib import Path
from typing import Any

from agentspace._util import new_id, now_iso, slugify, truncate

MAIN_NAME = "Claude Code"
MAIN_ID = slugify(MAIN_NAME)
TIMEOUT_S = 0.3
MARKER = "agentspace.claude_code"

HOOK_EVENTS = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Notification",
    "PermissionRequest",
    "PreCompact",
]


def events_from_hook(payload: dict[str, Any], workspace: str = "default") -> list[dict[str, Any]]:
    """Map one Claude Code hook payload to AgentSpace events. Pure; never raises on odd input."""
    event = str(payload.get("hook_event_name") or "")
    session = str(payload.get("session_id") or "claude-code")[:128]
    team = slugify(Path(str(payload.get("cwd") or "claude-code")).name or "claude-code")
    sub_runtime = payload.get("agent_id")
    sub_type = payload.get("agent_type")
    actor = slugify(str(sub_type)) if sub_runtime and sub_type else MAIN_ID
    out: list[dict[str, Any]] = []

    def ev(type_: str, data: dict[str, Any], agent: str | None = actor, **extra: Any) -> None:
        e: dict[str, Any] = {
            "spec_version": "0.1",
            "id": new_id(),
            "type": type_,
            "ts": now_iso(),
            "workspace": workspace,
            "run_id": session,
            "agent_id": agent,
            "team_id": team if agent else None,
            "parent_id": None,
            "data": {k: v for k, v in data.items() if v is not None},
        }
        e.update({k: v for k, v in extra.items() if v is not None})
        out.append(e)

    def status(value: str, detail: str | None = None, agent: str = actor) -> None:
        ev(
            "agent.status",
            {"status": value, "detail": truncate(detail, 500) if detail else None},
            agent,
        )

    def register(agent_id: str, name: str, role: str) -> None:
        ev(
            "agent.registered",
            {"name": name, "team_name": team, "role": role, "framework": "claude-code"},
            agent_id,
        )

    tool = truncate(str(payload.get("tool_name") or "tool"), 256)
    call_id = truncate(str(payload.get("tool_use_id") or new_id()), 128)

    if event == "SessionStart":
        ev(
            "run.started",
            {"name": f"Claude Code · {team}", "framework": "claude-code"},
            None,
            summary=str(payload.get("source") or "session"),
        )
        register(MAIN_ID, MAIN_NAME, "coding agent")
        status("idle", agent=MAIN_ID)
    elif event == "UserPromptSubmit":
        register(MAIN_ID, MAIN_NAME, "coding agent")
        status("thinking", agent=MAIN_ID)
    elif event == "PreToolUse":
        detail = _tool_detail(tool, payload.get("tool_input"))
        status("using_tool", detail)
        ev("tool.call", {"tool_name": tool, "call_id": call_id}, summary=truncate(detail, 500))
        if tool in ("Task", "Agent"):
            target = (
                (payload.get("tool_input") or {}).get("subagent_type")
                if isinstance(payload.get("tool_input"), dict)
                else None
            )
            if target:
                ev(
                    "handoff",
                    {"from_agent_id": actor, "to_agent_id": slugify(str(target))},
                    summary=f"handed off to {target}",
                )
    elif event in ("PostToolUse", "PostToolUseFailure"):
        failed = event == "PostToolUseFailure"
        ev(
            "tool.result",
            {
                "tool_name": tool,
                "call_id": call_id,
                "ok": not failed,
                "error": truncate(str(payload.get("error") or "failed"), 2000) if failed else None,
            },
            summary=f"{tool} {'failed' if failed else 'ok'}",
        )
        status("thinking")
    elif event == "SubagentStart" and sub_type:
        register(actor, str(sub_type), "subagent")
        status("thinking")
    elif event == "SubagentStop":
        agent = slugify(str(sub_type)) if sub_type else MAIN_ID
        status("done", agent=agent)
    elif event in ("PermissionRequest",):
        status("waiting_human", f"approve {tool}?")
    elif event == "Notification":
        message = str(payload.get("message") or "")
        kind = str(payload.get("notification_type") or "")
        if "permission" in kind or "permission" in message.lower():
            status("waiting_human", message or "needs permission", agent=MAIN_ID)
        elif kind == "idle_prompt" or "waiting for your input" in message.lower():
            status("waiting", message or "waiting for input", agent=MAIN_ID)
    elif event == "PreCompact":
        status("thinking", "compacting context", agent=MAIN_ID)
    elif event == "Stop":
        status("done", agent=MAIN_ID)
    elif event == "SessionEnd":
        status("done", agent=MAIN_ID)
        ev("run.finished", {"status": "ok"}, None, summary=str(payload.get("reason") or "ended"))
    return out


def _tool_detail(tool: str, tool_input: Any) -> str:
    """A short, metadata-only description: a file *name* or subagent type, never contents,
    full paths, search patterns, URLs or commands (those can contain secrets)."""
    if not isinstance(tool_input, dict):
        return tool
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return f"{tool} {truncate(Path(value).name, 80)}"
    sub = tool_input.get("subagent_type")
    if isinstance(sub, str) and sub:
        return f"{tool} {truncate(sub, 80)}"
    return tool


def send(events: list[dict[str, Any]]) -> None:
    if not events:
        return
    url = os.environ.get("AGENTSPACE_URL", "http://localhost:4800").rstrip("/") + "/v1/events"
    headers = {"Content-Type": "application/json", "User-Agent": "agentspace-claude-code"}
    key = os.environ.get("AGENTSPACE_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S):
            pass
    except Exception:
        pass  # the collector being down must never affect Claude Code


def run_hook(stdin: str) -> None:
    try:
        payload = json.loads(stdin or "{}")
        if isinstance(payload, dict):
            send(events_from_hook(payload, os.environ.get("AGENTSPACE_WORKSPACE", "default")))
    except Exception:
        pass


# ---------------- install / uninstall ----------------


def hook_command() -> str:
    """The command written into settings.json: this Python, so it works outside any venv."""
    return f"{shlex.quote(sys.executable)} -m {MARKER} hook"


def settings_path(user: bool, project_dir: Path | None = None) -> Path:
    return (Path.home() if user else (project_dir or Path.cwd())) / ".claude" / "settings.json"


def install(path: Path, command: str | None = None) -> bool:
    """Add AgentSpace hooks to a settings.json. Idempotent; keeps every other setting and hook."""
    command = command or hook_command()
    settings: dict[str, Any] = json.loads(path.read_text()) if path.exists() else {}
    hooks = settings.setdefault("hooks", {})
    changed = False
    for event in HOOK_EVENTS:
        groups = hooks.setdefault(event, [])
        if any(MARKER in h.get("command", "") for g in groups for h in g.get("hooks", [])):
            continue
        entry: dict[str, Any] = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
        if event in ("PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"):
            entry["matcher"] = "*"
        groups.append(entry)
        changed = True
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(settings, indent=2) + "\n")
    return changed


def uninstall(path: Path) -> bool:
    """Remove only the AgentSpace hooks from a settings.json."""
    if not path.exists():
        return False
    settings = json.loads(path.read_text())
    hooks = settings.get("hooks", {})
    changed = False
    for event in list(hooks):
        kept = []
        for group in hooks[event]:
            inner = [h for h in group.get("hooks", []) if MARKER not in h.get("command", "")]
            if len(inner) != len(group.get("hooks", [])):
                changed = True
            if inner:
                kept.append({**group, "hooks": inner})
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    if changed:
        path.write_text(json.dumps(settings, indent=2) + "\n")
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m agentspace.claude_code",
        description="Watch Claude Code sessions in AgentSpace.",
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("hook", help="(used by Claude Code) read one hook payload from stdin")
    for name in ("install", "uninstall"):
        p = sub.add_parser(name, help=f"{name} the hooks in .claude/settings.json")
        p.add_argument(
            "--user", action="store_true", help="use ~/.claude/settings.json (all projects)"
        )
    args = parser.parse_args(argv)

    if args.cmd in (None, "hook"):
        run_hook(sys.stdin.read())
        return 0
    path = settings_path(args.user)
    if args.cmd == "install":
        changed = install(path)
        print(f"{'Added' if changed else 'Already present:'} AgentSpace hooks in {path}")
        print("Start the office (docker compose up), then use Claude Code as usual.")
    else:
        changed = uninstall(path)
        verb, prep = ("Removed", "from") if changed else ("No", "found in")
        print(f"{verb} AgentSpace hooks {prep} {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
