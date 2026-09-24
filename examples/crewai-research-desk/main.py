"""A CrewAI research desk (Researcher -> Fact Checker -> Writer), live in AgentSpace.

    uv run python main.py --fake        # scripted LLM: no API key, no network
    uv run python main.py               # real model (needs ANTHROPIC_API_KEY, see .env.example)

The only AgentSpace code is the two lines marked below.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time

# Keep CrewAI's own telemetry off for this example.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from typing import Any  # noqa: E402

from crewai import LLM, Agent, Crew, Process, Task  # noqa: E402
from crewai.events.types.llm_events import LLMCallType  # noqa: E402
from crewai.llms.base_llm import BaseLLM, llm_call_context  # noqa: E402
from crewai.tools import tool  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
from pydantic import Field  # noqa: E402

import agentspace  # AgentSpace line 1 of 2  # noqa: E402

SOURCES = {
    "agent observability": "Agent observability means tracing each model call, tool call and handoff.",
    "opentelemetry genai": "OpenTelemetry defines gen_ai.* span attributes for model and agent spans.",
}


@tool("search_notes")
def search_notes(query: str) -> str:
    """Search the team's research notes."""
    time.sleep(0.3)
    return SOURCES.get(query.lower(), "No notes found.")


class ScriptedLLM(BaseLLM):
    """Canned ReAct replies with realistic pacing; emits the same events a real provider does."""

    replies: list[tuple[str, int, int]] = Field(default_factory=list)
    latency: float = 0.8

    def call(self, messages: Any, tools: Any = None, callbacks: Any = None, available_functions: Any = None, from_task: Any = None, from_agent: Any = None, response_model: Any = None) -> str:
        with llm_call_context():
            self._emit_call_started_event(messages=messages, from_task=from_task, from_agent=from_agent)
            time.sleep(self.latency * random.uniform(0.6, 1.4))
            text, tin, tout = self.replies.pop(0)
            self._emit_call_completed_event(response=text, call_type=LLMCallType.LLM_CALL, from_task=from_task, from_agent=from_agent, messages=messages, usage={"prompt_tokens": tin, "completion_tokens": tout})
            return text

    def supports_function_calling(self) -> bool:
        return False


def script() -> list[tuple[str, int, int]]:
    return [
        ('Thought: Check our notes first.\nAction: search_notes\nAction Input: {"query": "agent observability"}', 640, 36),
        ('Thought: And the standard.\nAction: search_notes\nAction Input: {"query": "opentelemetry genai"}', 820, 34),
        ("Thought: Enough.\nFinal Answer: Observability for agents = tracing model calls, tools and handoffs; OpenTelemetry's gen_ai.* attributes standardise it.", 1100, 58),
        ("Thought: Both claims match the notes.\nFinal Answer: Verified: both facts are supported by the notes.", 700, 22),
        ("Thought: Write it up.\nFinal Answer: # Watching AI agents\nTrace every model call, tool call and handoff. OpenTelemetry's gen_ai.* attributes make that portable.", 1300, 120),
    ]


def build(llm: BaseLLM | LLM) -> Crew:
    researcher = Agent(role="Researcher", goal="Find accurate facts in our notes", backstory="Careful and curious.", llm=llm, tools=[search_notes], verbose=False)
    checker = Agent(role="Fact Checker", goal="Verify every claim", backstory="Skeptical by trade.", llm=llm, verbose=False)
    writer = Agent(role="Writer", goal="Write a clear, short report", backstory="Plain words only.", llm=llm, verbose=False)
    tasks = [
        Task(name="research", description="Research how to observe AI agents.", expected_output="Two facts", agent=researcher),
        Task(name="check", description="Verify the research against the notes.", expected_output="A verdict", agent=checker),
        Task(name="report", description="Write a three-line report.", expected_output="Markdown", agent=writer),
    ]
    return Crew(name="Research Desk", agents=[researcher, checker, writer], tasks=tasks, process=Process.sequential, verbose=False)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fake", action="store_true", help="scripted LLM (no API key)")
    parser.add_argument("--runs", type=int, default=1, help="how many runs (0 = forever)")
    parser.add_argument("--latency", type=float, default=0.8, help="fake model delay, seconds")
    args = parser.parse_args()
    if not args.fake and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set. Add it to .env, or run with --fake.", file=sys.stderr)
        return 2

    agentspace.init()  # AgentSpace line 2 of 2: CrewAI is picked up automatically

    n = 0
    while args.runs == 0 or n < args.runs:
        n += 1
        llm: BaseLLM | LLM = (
            ScriptedLLM(model="scripted-fake", replies=script(), latency=args.latency)
            if args.fake
            else LLM(model=os.environ.get("AGENTSPACE_EXAMPLE_MODEL", "anthropic/claude-sonnet-5"))
        )
        out = build(llm).kickoff()
        print(f"run {n}: {str(out).splitlines()[0]}")
    agentspace.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
