"""An agent team instrumented ONLY with OpenTelemetry. No AgentSpace SDK anywhere.

It emits spans that follow the OpenTelemetry GenAI semantic conventions, the same attributes
that OpenLLMetry, OpenInference, the Vercel AI SDK and others produce, and sends them to
AgentSpace's OTLP endpoint. The collector turns them into agents in the office.

    uv run python main.py            # one run
    uv run python main.py --runs 0   # forever (live demo)

The "model calls" are simulated (sleep plus canned token counts), so no API key is needed.
"""

from __future__ import annotations

import argparse
import os
import random
import time

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode


def setup(endpoint: str, workspace: str) -> TracerProvider:
    # Standard OTel setup. The only AgentSpace-specific part is the endpoint URL; the workspace
    # header is optional.
    provider = TracerProvider(resource=Resource.create({"service.name": "support-bot"}))
    exporter = OTLPSpanExporter(endpoint=endpoint, headers={"x-agentspace-workspace": workspace})
    provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=500))
    trace.set_tracer_provider(provider)
    return provider


tracer = trace.get_tracer("otel-generic-example")


def think(latency: float) -> None:
    time.sleep(latency * random.uniform(0.6, 1.4))


def chat(model: str, tokens_in: int, tokens_out: int, latency: float) -> None:
    with tracer.start_as_current_span(f"chat {model}") as span:
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.provider.name", "anthropic")
        span.set_attribute("gen_ai.request.model", model)
        think(latency)
        span.set_attribute("gen_ai.response.model", model)
        span.set_attribute("gen_ai.usage.input_tokens", tokens_in)
        span.set_attribute("gen_ai.usage.output_tokens", tokens_out)
        span.set_attribute("gen_ai.response.finish_reasons", ["end_turn"])


def tool(name: str, latency: float, fail: bool = False) -> None:
    with tracer.start_as_current_span(f"execute_tool {name}") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", name)
        span.set_attribute("gen_ai.tool.call.id", f"call_{random.randrange(10**6)}")
        think(latency / 2)
        if fail:
            span.set_status(Status(StatusCode.ERROR, f"{name} timed out"))


def agent(name: str, body, latency: float) -> None:  # type: ignore[no-untyped-def]
    with tracer.start_as_current_span(f"invoke_agent {name}") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", name)
        body(span, latency)


def router(span: trace.Span, latency: float) -> None:
    chat("claude-haiku-4-5", 420, 12, latency)


def researcher(span: trace.Span, latency: float) -> None:
    tool("search_kb", latency)
    tool("fetch_order", latency, fail=random.random() < 0.3)
    chat("claude-sonnet-5", 2100, 180, latency)


def writer(span: trace.Span, latency: float) -> None:
    chat("claude-sonnet-5", 1600, 260, latency)
    # AgentSpace-specific span event: show "needs you" while a human reviews the draft.
    span.add_event("agentspace.status", {"status": "waiting_human", "detail": "reply needs review"})
    think(latency * 1.5)


def run_once(latency: float) -> None:
    with tracer.start_as_current_span("invoke_workflow support-ticket") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_workflow")
        span.set_attribute("gen_ai.workflow.name", "support-ticket")
        agent("Router", router, latency)
        agent("Researcher", researcher, latency)
        agent("Writer", writer, latency)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--runs", type=int, default=1, help="how many runs (0 = forever)")
    parser.add_argument("--latency", type=float, default=0.8, help="simulated model latency, seconds")
    args = parser.parse_args()

    base = os.environ.get("AGENTSPACE_URL", "http://localhost:4800").rstrip("/")
    workspace = os.environ.get("AGENTSPACE_WORKSPACE", "default")
    provider = setup(f"{base}/v1/traces", workspace)

    n = 0
    while args.runs == 0 or n < args.runs:
        n += 1
        run_once(args.latency)
        print(f"run {n} done")
    provider.shutdown()  # flush remaining spans
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
