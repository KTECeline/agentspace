"""A Claude Agent SDK support desk, live in AgentSpace.

A "Support" lead hands invoice questions to a "billing-specialist" subagent, then asks YOU to
approve a refund. While it waits, its desk glows ("needs you").

    uv run python main.py --replay      # replay a recorded session: no API key, no CLI
    uv run python main.py               # real run (needs the Claude Code CLI and a key:
                                        #   OPENROUTER_API_KEY, preferred, or ANTHROPIC_API_KEY)

Add --approve to decide the refund in the office (Approvals tab) instead of the terminal. It uses
the adapter's approval_callback(), which fails closed: no answer, a timeout or an unreachable
collector means no refund. It works with --replay too.

Real runs are capped: Haiku by default, at most 6 turns, and --budget (default $0.10).
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
from agentspace.adapters.claude_agent_sdk import (
    ClaudeAgentTracker,
    approval_callback,
    instrument_options,
    replay,
    track,
)

HERE = Path(__file__).parent
PROMPT = (
    "Customer #881 was double-charged for invoice 42 and is owed a refund. "
    "Have billing-specialist confirm the invoice, then issue the refund. Keep replies short."
)

# Anthropic's own model name: OpenRouter accepts it, and Claude Code can price it (so the
# --budget cap is accurate). "~anthropic/..." ids work too, but Claude Code can't price them.
OPENROUTER_MODEL = "claude-haiku-4-5"


def provider_env() -> tuple[dict[str, str], str]:
    """Env for the Claude Code CLI, plus the model to use. OpenRouter is preferred when set:
    it exposes an Anthropic-compatible API that Claude Code can call directly."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        model = os.environ.get("AGENTSPACE_EXAMPLE_MODEL", OPENROUTER_MODEL)
        return (
            {
                "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
                "ANTHROPIC_AUTH_TOKEN": key,
                "ANTHROPIC_API_KEY": "",  # never fall back to Anthropic billing
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                "CLAUDE_CODE_SUBAGENT_MODEL": model,
            },
            model,
        )
    return {}, os.environ.get("AGENTSPACE_EXAMPLE_MODEL", "claude-haiku-4-5")


REFUND_TOOL = "mcp__billing__refund"


def run_replay(runs: int, delay: float, approve: bool) -> None:
    """Feed the recorded hook payloads and messages through the adapter, with pacing.

    With ``approve``, the recorded permission request goes through the same approval_callback a
    real run uses, and a rejected refund is replayed as a failed tool call."""
    recording = json.loads((HERE / "recording.json").read_text())
    n = 0
    while runs == 0 or n < runs:
        n += 1
        tracker = ClaudeAgentTracker(**recording["tracker"])
        ask = approval_callback({REFUND_TOOL}, tracker=tracker, timeout=300)
        session = f"sess-{n}-{int(time.time())}"  # fresh id per replay: each is its own run
        denied: str | None = None
        for i, item in enumerate(recording["items"]):
            item = json.loads(json.dumps(item).replace("sess-1", session))
            data = item.get("data", {})
            if denied and item.get("hook") == "PostToolUse" and data.get("tool_name") == REFUND_TOOL:
                item = {**item, "hook": "PostToolUseFailure", "data": {**data, "error": denied}}
            replay([item], tracker)
            if approve and item.get("hook") == "PermissionRequest" and data.get("tool_name") == REFUND_TOOL:
                print("Waiting for a decision in the office (Approvals tab)...")
                result = asyncio.run(ask(REFUND_TOOL, data.get("tool_input", {}), None))
                denied = None if type(result).__name__ == "PermissionResultAllow" else getattr(result, "message", "Not approved")
                print("Refund approved." if denied is None else f"Refund refused: {denied}")
            else:
                time.sleep(delay * (2.5 if item.get("hook") == "PermissionRequest" else 1))
        print(f"run {n}: replayed {i + 1} recorded hooks/messages")


async def run_real(budget: float, approve: bool) -> None:
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
        # The PermissionRequest hook already shows "needs you" in the office while we wait.
        answer = await asyncio.to_thread(input, f"\nApprove refund {tool_input}? [y/N] ")
        return PermissionResultAllow() if answer.strip().lower() == "y" else PermissionResultDeny(message="The human said no.")

    server = create_sdk_mcp_server("billing", tools=[lookup_invoice, refund])
    env, model = provider_env()
    options = ClaudeAgentOptions(
        model=model,
        env=env,
        max_turns=6,
        max_budget_usd=budget,
        system_prompt=(
            "You lead customer support. Never look up invoices yourself: always delegate that to "
            "the billing-specialist agent. When a refund is owed, call the refund tool right away. "
            "Do not ask the customer to confirm; the refund tool asks a human for approval itself."
        ),
        mcp_servers={"billing": server},
        # Only the tools this example needs. Claude Code's full built-in toolset adds ~35k
        # input tokens to every call; trimming it makes real runs several times cheaper.
        tools=["Agent"],
        setting_sources=[],  # don't load your personal ~/.claude settings, skills or hooks
        allowed_tools=["mcp__billing__lookup_invoice", "Agent"],
        agents={
            "billing-specialist": AgentDefinition(
                description="Looks up invoices",
                prompt="Use lookup_invoice and report the facts briefly.",
                tools=["mcp__billing__lookup_invoice"],
                model="haiku",
            )
        },
        # --approve: decide in the office; otherwise answer y/N in this terminal.
        can_use_tool=approval_callback({REFUND_TOOL}) if approve else ask_human,
    )
    options = instrument_options(options, name="Support", team="Support Desk", role="customer support lead")
    async for message in track(query(prompt=PROMPT, options=options)):
        if type(message).__name__ == "ResultMessage":
            cost = getattr(message, "total_cost_usd", None)
            print("result:", getattr(message, "result", "") or getattr(message, "subtype", ""))
            print(f"cost reported by the CLI: ${cost or 0:.4f} (turns: {getattr(message, 'num_turns', '?')})")


def main() -> int:
    load_dotenv(HERE / ".env")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--replay", action="store_true", help="replay the recorded session (no key)")
    parser.add_argument("--runs", type=int, default=1, help="replay runs (0 = forever)")
    parser.add_argument("--delay", type=float, default=0.6, help="seconds between replayed items")
    parser.add_argument("--budget", type=float, default=0.10, help="max USD for a real run")
    parser.add_argument("--approve", action="store_true", help="approve the refund in the office, not the terminal")
    args = parser.parse_args()
    if not args.replay and not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")):
        print("Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env, or run with --replay.", file=sys.stderr)
        return 2

    agentspace.init()
    if args.replay:
        run_replay(args.runs, args.delay, args.approve)
    else:
        try:
            # An approval can take a while; without one, 2 minutes is plenty.
            asyncio.run(asyncio.wait_for(run_real(args.budget, args.approve), timeout=420 if args.approve else 120))
        except TimeoutError:
            print("Stopped: the run took too long.", file=sys.stderr)
            return 1
    agentspace.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
