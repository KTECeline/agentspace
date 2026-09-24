"""A LangGraph dev team (Manager, Triage, Engineer) fixes a seeded bug, live in AgentSpace.

    uv run python main.py            # real Claude (needs ANTHROPIC_API_KEY)
    uv run python main.py --fake     # scripted model, no API key, no network
    uv run python main.py --fake --approve   # the Engineer asks you before writing files

The only AgentSpace code is the two lines marked below.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Literal, TypedDict

from dotenv import load_dotenv
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, tool
from langgraph.graph import END, START, StateGraph

import agentspace  # AgentSpace line 1 of 2

HERE = Path(__file__).parent
MAX_TOOL_STEPS = 8


# ---------------------------------------------------------------------------
# Tools. Each run works in a fresh copy of demo_app/, so the example is repeatable.
# ---------------------------------------------------------------------------


def make_tools(workdir: Path, approve: bool = False) -> dict[str, BaseTool]:
    def safe(path: str) -> Path:
        target = (workdir / path).resolve()
        if workdir.resolve() not in target.parents:
            raise ValueError(f"{path} is outside the project")
        return target

    @tool
    def list_files() -> str:
        """List the files in the project."""
        return "\n".join(sorted(p.name for p in workdir.iterdir() if p.suffix == ".py"))

    @tool
    def read_file(path: str) -> str:
        """Read a file from the project."""
        return safe(path).read_text()

    @tool
    def write_file(path: str, content: str) -> str:
        """Overwrite a file in the project with new content."""
        if approve:
            # Optional: a person approves the change in the office first. Fails closed: if
            # nobody approves in time (or AgentSpace is down), the file is not written.
            from agentspace.adapters.langgraph import request_approval_sync

            decision = request_approval_sync(
                f"Write {path}?", {"path": path, "content": content}, timeout=600
            )
            if not decision.approved:
                why = decision.comment or decision.error or decision.decision
                return f"ERROR: not approved ({why}). Do not retry; explain what you'd change."
        safe(path).write_text(content)
        return f"wrote {len(content)} bytes to {path}"

    @tool
    def run_tests() -> str:
        """Run the project's tests and return the output."""
        proc = subprocess.run(
            [sys.executable, "test_cart.py"],
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        status = "PASSED" if proc.returncode == 0 else "FAILED"
        return f"{status}\n{proc.stdout}{proc.stderr}"

    return {t.name: t for t in (list_files, read_file, write_file, run_tests)}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


def real_model() -> BaseChatModel:
    from langchain_anthropic import ChatAnthropic

    model = os.environ.get("AGENTSPACE_EXAMPLE_MODEL", "claude-sonnet-5")
    return ChatAnthropic(model=model, max_tokens=2048, temperature=0)  # type: ignore[call-arg]


def fake_model(latency: float) -> BaseChatModel:
    from scripted import ScriptedChatModel, dev_team_script

    return ScriptedChatModel(responses=dev_team_script(), latency=latency)


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


class State(TypedDict, total=False):
    bug_report: str
    diagnosis: str
    fix_summary: str
    next: Literal["Triage", "Engineer", "done"]


def tool_loop(
    llm: BaseChatModel, tools: dict[str, BaseTool], system: str, task: str
) -> str:
    """Minimal ReAct loop: let the model call tools until it answers in plain text."""
    bound = llm.bind_tools(list(tools.values()))
    messages: list[BaseMessage] = [SystemMessage(system), HumanMessage(task)]
    for _ in range(MAX_TOOL_STEPS):
        reply = bound.invoke(messages)
        messages.append(reply)
        calls = getattr(reply, "tool_calls", None) or []
        if not calls:
            return str(reply.content)
        for call in calls:
            try:
                result = tools[call["name"]].invoke(call["args"])
            except Exception as exc:  # report tool errors back to the model
                result = f"ERROR: {exc}"
            messages.append(ToolMessage(str(result), tool_call_id=call["id"]))
    return "Stopped: too many tool steps."


def build_graph(llm: BaseChatModel, tools: dict[str, BaseTool]) -> Any:
    def manager(state: State) -> State:
        progress = (
            f"Bug report: {state['bug_report']}\n"
            f"Diagnosis: {state.get('diagnosis') or 'none yet'}\n"
            f"Fix: {state.get('fix_summary') or 'none yet'}"
        )
        reply = llm.invoke(
            [
                SystemMessage(
                    "You manage a small dev team: Triage (finds root causes) and Engineer "
                    "(fixes code and runs tests). Reply with exactly one word: TRIAGE if there "
                    "is no diagnosis, ENGINEER if there is a diagnosis but no verified fix, or "
                    "DONE if the fix is verified by passing tests."
                ),
                HumanMessage(progress),
            ]
        )
        word = str(reply.content).strip().upper()
        nxt: Literal["Triage", "Engineer", "done"] = (
            "Triage" if "TRIAGE" in word else "Engineer" if "ENGINEER" in word else "done"
        )
        return {"next": nxt}

    def triage(state: State) -> State:
        diagnosis = tool_loop(
            llm,
            {k: tools[k] for k in ("list_files", "read_file", "run_tests")},
            "You are Triage. Reproduce the bug with run_tests, read the code, and reply with a "
            "one-paragraph root-cause diagnosis. Do not change any files.",
            state["bug_report"],
        )
        return {"diagnosis": diagnosis}

    def engineer(state: State) -> State:
        summary = tool_loop(
            llm,
            tools,
            "You are Engineer. Fix the bug with the smallest change using write_file (write the "
            "whole file), then run_tests. Reply with a one-line summary once tests pass.",
            f"Bug: {state['bug_report']}\nDiagnosis: {state.get('diagnosis', '')}",
        )
        return {"fix_summary": summary}

    g = StateGraph(State)
    g.add_node("Manager", manager)
    g.add_node("Triage", triage)
    g.add_node("Engineer", engineer)
    g.add_edge(START, "Manager")
    g.add_conditional_edges(
        "Manager", lambda s: s["next"], {"Triage": "Triage", "Engineer": "Engineer", "done": END}
    )
    g.add_edge("Triage", "Manager")
    g.add_edge("Engineer", "Manager")
    return g.compile(name="dev-team")


# ---------------------------------------------------------------------------


def main() -> int:
    load_dotenv(HERE / ".env")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fake", action="store_true", help="use a scripted model (no API key)")
    parser.add_argument("--runs", type=int, default=1, help="how many runs (0 = forever)")
    parser.add_argument("--latency", type=float, default=0.8, help="fake model delay, seconds")
    parser.add_argument(
        "--approve", action="store_true", help="ask a person in the office before writing files"
    )
    args = parser.parse_args()

    if not args.fake and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set. Add it to .env, or run with --fake.", file=sys.stderr)
        return 2

    agentspace.init()  # AgentSpace line 2 of 2: LangGraph is picked up automatically

    n = 0
    while args.runs == 0 or n < args.runs:
        n += 1
        workdir = Path(tempfile.mkdtemp(prefix="agentspace-demo-"))
        try:
            for f in (HERE / "demo_app").glob("*.py"):
                shutil.copy(f, workdir)
            llm = fake_model(args.latency) if args.fake else real_model()
            graph = build_graph(llm, make_tools(workdir, approve=args.approve))
            t0 = time.monotonic()
            result = graph.invoke(
                {"bug_report": "Cart total is wrong: two items priced 2.50x2 and 1.00x3 give 3.0, expected 8.0."},
                config={
                    "metadata": {"agentspace_team": "Engineering"},
                    "recursion_limit": 20,
                },
            )
            print(f"run {n}: {result.get('fix_summary', 'no fix')} ({time.monotonic() - t0:.1f}s)")
        except agentspace.Cancelled:
            print(f"run {n}: cancelled from the office")
            break
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    agentspace.flush()
    s = agentspace.stats()
    print(f"agentspace: sent={s['sent']} dropped={s['dropped']} pending={s['pending']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
