"""A LangGraph dev team (Manager, Triage, Engineer) fixes a seeded bug, live in AgentSpace.

    uv run python main.py            # real Claude (needs ANTHROPIC_API_KEY)
    uv run python main.py --fake     # scripted model, no API key, no network
    uv run python main.py --fake --approve   # the Engineer asks you before writing files
    uv run python main.py --story    # the failure story: good runs, then one that goes wrong

The only AgentSpace code is the two lines marked below, plus the oversight hooks that
`--story` turns on (marked "story").
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


def make_tools(workdir: Path, approve: bool = False, strict: bool = False) -> dict[str, BaseTool]:
    """``strict``: failing tests raise, so they count as a failed tool call (the story's detectors
    watch for those). Otherwise the output just says FAILED."""
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
                print(f"  {path} was not written: {decision.decision} ({why})")
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
        if strict and proc.returncode != 0:
            raise RuntimeError(f"tests failed\n{proc.stdout}{proc.stderr}".strip())
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
    llm: BaseChatModel, tools: dict[str, BaseTool], system: str, task: str, story: bool = False
) -> str:
    """Minimal ReAct loop: let the model call tools until it answers in plain text.

    ``story``: each call is checked against the oversight policy first, and events are flushed
    after each result, so a finding (and the pause it triggers) lands before the next step.
    """
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
                if story:  # story: blocked or refused calls don't run; the model is told why
                    from agentspace.adapters.langgraph import guard_tool

                    guard_tool(call["name"], call["args"], timeout=900)
                result = tools[call["name"]].invoke(call["args"])
            except Exception as exc:  # report tool errors (and refusals) back to the model
                result = f"ERROR: {exc}"
            messages.append(ToolMessage(str(result), tool_call_id=call["id"]))
            if story:
                agentspace.flush()
    return "Stopped: too many tool steps."


def build_graph(
    llm: BaseChatModel,
    tools: dict[str, BaseTool],
    story: bool = False,
    engineer_tools: dict[str, BaseTool] | None = None,
) -> Any:
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
                    "is no diagnosis, ENGINEER if there is a diagnosis but no verified fix, "
                    "DONE if the fix is verified by passing tests, or FAILED if the Engineer "
                    "gave up."
                ),
                HumanMessage(progress),
            ]
        )
        word = str(reply.content).strip().upper()
        if "FAILED" in word:
            raise RuntimeError(f"No verified fix: {state.get('fix_summary') or 'the Engineer gave up'}")
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
            story,
        )
        return {"diagnosis": diagnosis}

    def engineer(state: State) -> State:
        summary = tool_loop(
            llm,
            engineer_tools or tools,
            "You are Engineer. Fix the bug with the smallest change using write_file (write the "
            "whole file), then run_tests. Reply with a one-line summary once tests pass.",
            f"Bug: {state['bug_report']}\nDiagnosis: {state.get('diagnosis', '')}",
            story,
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

BUG_REPORT = "Cart total is wrong: two items priced 2.50x2 and 1.00x3 give 3.0, expected 8.0."
CONFIG: Any = {"metadata": {"agentspace_team": "Engineering"}, "recursion_limit": 20}


def run_once(llm: BaseChatModel, approve: bool = False, story: bool = False) -> dict[str, Any]:
    """One run in a fresh copy of demo_app/."""
    workdir = Path(tempfile.mkdtemp(prefix="agentspace-demo-"))
    try:
        for f in (HERE / "demo_app").glob("*.py"):
            shutil.copy(f, workdir)
        # In the story, the Engineer's failing tests are tool failures (Triage expects a failure).
        engineer_tools = make_tools(workdir, approve=approve, strict=True) if story else None
        graph = build_graph(llm, make_tools(workdir, approve=approve), story, engineer_tools)
        return dict(graph.invoke({"bug_report": BUG_REPORT}, config=CONFIG))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def story(baseline: int, latency: float, baseline_latency: float = 0.05) -> None:
    """The failure story (docs/debugging): good runs build a baseline, then one goes wrong.

    Start the collector with examples/langgraph-dev-team/policy.json (see the README): the
    failure_loop finding pauses the run, and the Engineer's next write needs a person.
    """
    from scripted import StoryChatModel, regression_script

    for n in range(1, baseline + 1):
        t0 = time.monotonic()
        result = run_once(fake_model(baseline_latency), story=True)
        print(f"good run {n}/{baseline}: {result.get('fix_summary', 'no fix')} ({time.monotonic() - t0:.1f}s)")
    print("\nNow the regression. Watch the office: the run pauses after the third failed test run.")
    print("Resume it from the run bar, then approve or reject the Engineer's next write.\n")
    t0 = time.monotonic()
    try:
        result = run_once(StoryChatModel(responses=regression_script(), latency=latency), story=True)
        print(f"regression run: {result.get('fix_summary', 'no fix')} ({time.monotonic() - t0:.1f}s)")
    except RuntimeError as exc:
        print(f"regression run failed: {exc} ({time.monotonic() - t0:.1f}s)")


def main() -> int:
    load_dotenv(HERE / ".env")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fake", action="store_true", help="use a scripted model (no API key)")
    parser.add_argument("--runs", type=int, default=1, help="how many runs (0 = forever)")
    parser.add_argument("--latency", type=float, default=0.8, help="fake model delay, seconds")
    parser.add_argument(
        "--approve", action="store_true", help="ask a person in the office before writing files"
    )
    parser.add_argument(
        "--story", action="store_true", help="the failure story (scripted model, needs policy.json)"
    )
    parser.add_argument("--baseline", type=int, default=5, help="--story: good runs first")
    parser.add_argument(
        "--baseline-latency", type=float, default=0.05, help="--story: fake model delay in good runs"
    )
    args = parser.parse_args()

    if not (args.fake or args.story) and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set. Add it to .env, or run with --fake.", file=sys.stderr)
        return 2

    agentspace.init()  # AgentSpace line 2 of 2: LangGraph is picked up automatically

    if args.story:
        try:
            story(args.baseline, args.latency, args.baseline_latency)
        except agentspace.Cancelled:
            print("regression run: cancelled from the office")
        agentspace.flush()
        return 0

    n = 0
    while args.runs == 0 or n < args.runs:
        n += 1
        try:
            t0 = time.monotonic()
            llm = fake_model(args.latency) if args.fake else real_model()
            result = run_once(llm, approve=args.approve)
            print(f"run {n}: {result.get('fix_summary', 'no fix')} ({time.monotonic() - t0:.1f}s)")
        except agentspace.Cancelled:
            print(f"run {n}: cancelled from the office")
            break

    agentspace.flush()
    s = agentspace.stats()
    print(f"agentspace: sent={s['sent']} dropped={s['dropped']} pending={s['pending']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
