"""A small OpenAI Agents SDK app driven by a scripted model (no network, no API key)."""

from __future__ import annotations

import json
from typing import Any

from agents import Agent, function_tool
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.tracing import generation_span
from agents.usage import Usage
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)


def say(text: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id="msg",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
    )


def call(name: str, args: dict[str, Any], call_id: str) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        id=f"fc_{call_id}",
        type="function_call",
        call_id=call_id,
        name=name,
        arguments=json.dumps(args),
        status="completed",
    )


class ScriptedModel(Model):
    """Returns canned replies in order and records a generation span, like the real models."""

    def __init__(
        self,
        replies: list[tuple[list[Any], int, int]],
        name: str = "scripted-fake",
        on_reply: Any = None,
    ):
        self.replies = list(replies)
        self.name = name
        self.on_reply = on_reply or (lambda n: None)

    async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
        self.on_reply(3 - len(self.replies))
        output, tin, tout = self.replies.pop(0)
        with generation_span(model=self.name, usage={"input_tokens": tin, "output_tokens": tout}):
            pass
        usage = Usage(requests=1, input_tokens=tin, output_tokens=tout, total_tokens=tin + tout)
        return ModelResponse(output=output, usage=usage, response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


@function_tool
def lookup_invoice(invoice_id: str) -> str:
    """Look up an invoice by id."""
    return f"invoice {invoice_id}: paid on 2026-09-01"


@function_tool
def refund(invoice_id: str) -> str:
    """Refund an invoice (always fails in this demo)."""
    raise RuntimeError("refunds are disabled")


def build_support_desk(on_reply: Any = None) -> Agent[Any]:
    """``on_reply(n)`` runs before the model's n-th reply (0-based); tests use it to flush."""
    model = ScriptedModel(
        on_reply=on_reply,
        replies=[
            ([call("transfer_to_billing", {}, "c1")], 150, 12),
            ([call("lookup_invoice", {"invoice_id": "42"}, "c2")], 380, 24),
            ([say("Invoice 42 was paid on 1 September.")], 520, 40),
        ],
    )
    billing = Agent(
        name="Billing",
        instructions="Answer billing questions.",
        tools=[lookup_invoice, refund],
        model=model,
    )
    return Agent(name="Triage", instructions="Route the customer.", handoffs=[billing], model=model)
