"""A small CrewAI crew driven by a scripted LLM (no network, no API key)."""

from __future__ import annotations

import os

# Keep CrewAI's own telemetry and tracing off in tests: nothing may leave the machine.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from typing import Any

from crewai import Agent, Crew, Process, Task
from crewai.events.types.llm_events import LLMCallType
from crewai.llms.base_llm import BaseLLM, llm_call_context
from crewai.tools import tool
from pydantic import Field


class ScriptedLLM(BaseLLM):
    """Returns canned ReAct replies and emits the same LLM events a real provider would."""

    replies: list[tuple[str, int, int]] = Field(default_factory=list)

    def call(
        self,
        messages: Any,
        tools: Any = None,
        callbacks: Any = None,
        available_functions: Any = None,
        from_task: Any = None,
        from_agent: Any = None,
        response_model: Any = None,
    ) -> str:
        with llm_call_context():
            self._emit_call_started_event(
                messages=messages, from_task=from_task, from_agent=from_agent
            )
            text, tin, tout = self.replies.pop(0)
            self._emit_call_completed_event(
                response=text,
                call_type=LLMCallType.LLM_CALL,
                from_task=from_task,
                from_agent=from_agent,
                messages=messages,
                usage={"prompt_tokens": tin, "completion_tokens": tout},
            )
            return text

    def supports_function_calling(self) -> bool:
        return False


@tool("web_search")
def web_search(query: str) -> str:
    """Search the web for a query."""
    return "AgentSpace is an open-source live office for AI agent teams."


@tool("fetch_page")
def fetch_page(url: str) -> str:
    """Fetch a web page (always fails in this demo)."""
    raise ConnectionError("503 from example.com")


def research_replies() -> list[tuple[str, int, int]]:
    return [
        (
            "Thought: I should search first.\n"
            'Action: web_search\nAction Input: {"query": "agentspace"}',
            620,
            38,
        ),
        (
            "Thought: I have enough.\n"
            "Final Answer: AgentSpace shows AI agents working in a live office.",
            910,
            44,
        ),
        (
            "Thought: Time to write.\n"
            "Final Answer: # AgentSpace\nA live office for AI agent teams.",
            1180,
            96,
        ),
    ]


def build_research_desk(replies: list[tuple[str, int, int]] | None = None) -> Crew:
    llm = ScriptedLLM(model="scripted-fake", replies=replies or research_replies())
    researcher = Agent(
        role="Researcher",
        goal="Find accurate facts",
        backstory="Curious and careful.",
        llm=llm,
        tools=[web_search],
        verbose=False,
    )
    writer = Agent(
        role="Writer", goal="Write a clear report", backstory="Plain words.", llm=llm, verbose=False
    )
    research = Task(
        name="research",
        description="Research AgentSpace",
        expected_output="Key facts",
        agent=researcher,
    )
    report = Task(
        name="report",
        description="Write a short report",
        expected_output="A markdown report",
        agent=writer,
    )
    return Crew(
        name="Research Desk",
        agents=[researcher, writer],
        tasks=[research, report],
        process=Process.sequential,
        verbose=False,
    )
