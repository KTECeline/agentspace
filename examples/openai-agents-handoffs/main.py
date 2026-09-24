"""An OpenAI Agents SDK support desk (Triage -> Billing / Tech Support), live in AgentSpace.

    uv run python main.py --fake        # scripted model: no API key, no network
    uv run python main.py               # real OpenAI models (needs OPENAI_API_KEY)

The only AgentSpace code is the two lines marked below.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from typing import Any

from agents import Agent, RunConfig, Runner, function_tool, set_trace_processors
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.tracing import generation_span
from agents.usage import Usage
from dotenv import load_dotenv
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

import agentspace  # AgentSpace line 1 of 2


@function_tool
async def lookup_invoice(invoice_id: str) -> str:
    """Look up an invoice by id."""
    await asyncio.sleep(0.3)
    return f"invoice {invoice_id}: paid on 2026-09-01, 49 USD"


@function_tool
async def check_status_page() -> str:
    """Check the service status page."""
    await asyncio.sleep(0.3)
    return "All systems operational."


def say(text: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(id="msg", type="message", role="assistant", status="completed", content=[ResponseOutputText(type="output_text", text=text, annotations=[])])


def call(name: str, args: dict[str, Any], call_id: str) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(id=f"fc_{call_id}", type="function_call", call_id=call_id, name=name, arguments=json.dumps(args), status="completed")


class ScriptedModel(Model):
    """Canned replies with realistic pacing; records a generation span like the real models."""

    def __init__(self, replies: list[tuple[list[Any], int, int]], latency: float):
        self.replies, self.latency = list(replies), latency

    async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
        await asyncio.sleep(self.latency * random.uniform(0.6, 1.4))
        output, tin, tout = self.replies.pop(0)
        with generation_span(model="scripted-fake", usage={"input_tokens": tin, "output_tokens": tout}):
            pass
        return ModelResponse(output=output, usage=Usage(requests=1, input_tokens=tin, output_tokens=tout, total_tokens=tin + tout), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


def script() -> list[tuple[list[Any], int, int]]:
    return [
        ([call("transfer_to_billing", {}, "c1")], 180, 14),
        ([call("lookup_invoice", {"invoice_id": "42"}, "c2")], 420, 26),
        ([say("Invoice 42 was paid on 1 September (49 USD).")], 560, 38),
    ]


def build(model: Model | None) -> Agent[Any]:
    kw = {"model": model} if model else {}
    billing = Agent(name="Billing", instructions="Answer billing questions using lookup_invoice.", tools=[lookup_invoice], **kw)
    tech = Agent(name="Tech Support", instructions="Help with outages using check_status_page.", tools=[check_status_page], **kw)
    return Agent(name="Triage", instructions="Route the customer to Billing or Tech Support.", handoffs=[billing, tech], **kw)


async def main_async(args: argparse.Namespace) -> None:
    n = 0
    while args.runs == 0 or n < args.runs:
        n += 1
        model = ScriptedModel(script(), args.latency) if args.fake else None
        result = await Runner.run(
            build(model),
            "Was invoice 42 paid?",
            run_config=RunConfig(workflow_name="support-desk", trace_metadata={"agentspace_team": "Support Desk"}),
        )
        print(f"run {n}: {result.final_output}")


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fake", action="store_true", help="scripted model (no API key)")
    parser.add_argument("--runs", type=int, default=1, help="how many runs (0 = forever)")
    parser.add_argument("--latency", type=float, default=0.8, help="fake model delay, seconds")
    args = parser.parse_args()
    if not args.fake and not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is not set. Add it to .env, or run with --fake.", file=sys.stderr)
        return 2
    if args.fake:
        set_trace_processors([])  # don't try to export traces to OpenAI without a key

    agentspace.init()  # AgentSpace line 2 of 2: the OpenAI Agents SDK is picked up automatically

    asyncio.run(main_async(args))
    agentspace.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
