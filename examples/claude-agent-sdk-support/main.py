"""A Claude Agent SDK support desk, live in AgentSpace.

A "Support" lead hands invoice questions to a "billing-specialist" subagent, then asks YOU to
approve a refund. While it waits, its desk glows ("needs you").

    uv run python main.py --replay      # replay a recorded session: no API key, no CLI
    uv run python main.py               # real run (needs ANTHROPIC_API_KEY and the Claude Code CLI)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import agentspace
from agentspace.adapters.claude_agent_sdk import ClaudeAgentTracker, instrument_options, replay, tracker, track

HERE = Path(__file__).parent
PROMPT = "Customer #881 asks: was invoice 42 paid, and can they get a refund?"


def run_replay(runs: int, delay: float) -> None:
    """Feed the recorded hook payloads and messages through the adapter, with pacing."""
    recording = json.loads((HERE / "recording.json").read_text())
    n = 0
    while runs == 0 or n < runs:
        n += 1
        tracker = ClaudeAgentTracker(**recording["tracker"])
        session = f"sess-{n}-{int(time.time())}"  # fresh id per replay: each is its own run
        for i, item in enumerate(recording["items"]):
            item = json.loads(json.dumps(item).replace("sess-1", session))
            replay([item], tracker)
            time.sleep(delay * (2.5 if item.get("hook") == "PermissionRequest" else 1))
        print(f"run {n}: replayed {i + 1} recorded hooks/messages")


async def run_real() -> None:
    from claude_agent_sdk import (
        AgentDefinition,
        ClaudeAgentOptions,
        PermissionResultAllow,
        PermissionResultDeny,
        create_sdk_mcp_server,
        query,
        tool,
    )

    @tool("lookup_invoice", "Look up an invoice by id", {"invoice_id": str})
    async def lookup_invoice(args: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": f"invoice {args['invoice_id']}: paid, 49 USD"}]}

    @tool("refund", "Refund an invoice", {"invoice_id": str, "amount": float})
    async def refund(args: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": f"refunded {args['amount']} for {args['invoice_id']}"}]}

    async def ask_human(tool_name: str, tool_input: dict[str, Any], context: Any) -> Any:
        if not tool_name.endswith("refund"):
            return PermissionResultAllow()
        # Show "needs you" in the office while the terminal waits for an answer.
        tracker().status("waiting_human", "approve refund?")
        answer = await asyncio.to_thread(input, f"\nApprove refund {tool_input}? [y/N] ")
        tracker().status("thinking")
        return PermissionResultAllow() if answer.strip().lower() == "y" else PermissionResultDeny(message="The human said no.")

    server = create_sdk_mcp_server("billing", tools=[lookup_invoice, refund])
    options = ClaudeAgentOptions(
        model=os.environ.get("AGENTSPACE_EXAMPLE_MODEL", "claude-sonnet-5"),
        system_prompt="You lead customer support. Delegate invoice lookups to billing-specialist. Refunds need the refund tool.",
        mcp_servers={"billing": server},
        allowed_tools=["mcp__billing__lookup_invoice", "Task"],
        agents={
            "billing-specialist": AgentDefinition(
                description="Looks up invoices",
                prompt="Use lookup_invoice and report the facts briefly.",
                tools=["mcp__billing__lookup_invoice"],
                model="haiku",
            )
        },
        can_use_tool=ask_human,
    )
    options = instrument_options(options, name="Support", team="Support Desk", role="customer support lead")
    async for message in track(query(prompt=PROMPT, options=options)):
        if type(message).__name__ == "ResultMessage":
            print("result:", getattr(message, "result", ""))


def main() -> int:
    load_dotenv(HERE / ".env")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--replay", action="store_true", help="replay the recorded session (no key)")
    parser.add_argument("--runs", type=int, default=1, help="replay runs (0 = forever)")
    parser.add_argument("--delay", type=float, default=0.6, help="seconds between replayed items")
    args = parser.parse_args()
    if not args.replay and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set. Add it to .env, or run with --replay.", file=sys.stderr)
        return 2

    agentspace.init()
    if args.replay:
        run_replay(args.runs, args.delay)
    else:
        asyncio.run(run_real())
    agentspace.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
