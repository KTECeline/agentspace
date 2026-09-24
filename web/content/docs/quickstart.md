# Quickstart

## 1. Start the collector and the office

```bash
git clone https://github.com/KTECeline/agentspace && cd agentspace
docker compose up -d        # collector on :4800, office on http://localhost:4801
```

Open http://localhost:4801. The office is empty until something sends events.

**No Docker?** Run from source with Node 22, pnpm and uv: `make install && make dev`.

## 2. Watch an example team (no API key)

```bash
cd examples/langgraph-dev-team
uv run python main.py --fake --runs 0
```

A Manager, a Triage agent and an Engineer appear at their desks and fix a seeded bug, over and over. `--fake` uses a scripted model, so it costs nothing. Every example has a fake or replay mode:

| Example | Framework | Offline mode |
|---|---|---|
| `langgraph-dev-team` | LangGraph | `--fake` (add `--approve` for an approval) |
| `crewai-research-desk` | CrewAI | `--fake` |
| `openai-agents-handoffs` | OpenAI Agents SDK | `--fake` |
| `claude-agent-sdk-support` | Claude Agent SDK | `--replay` (add `--approve`) |
| `otel-generic` | plain OpenTelemetry | runs as is |

**No collector at all?** Open `/demo` in the office for recorded runs of every example.

## 3. Instrument your own app

```bash
pip install agentspace-sdk      # Python 3.10+, no dependencies
```

```python
import agentspace
agentspace.init()   # LangGraph, CrewAI and the OpenAI Agents SDK are picked up automatically
```

That's it for those three frameworks. For the others, see [Claude Agent SDK](claude-agent-sdk), [OpenTelemetry](opentelemetry), [TypeScript](typescript-sdk), or the manual API in the [Python SDK](python-sdk):

```python
@agentspace.agent(team="research", role="finds sources")
def researcher(query): ...

with agentspace.run("weekly-report"):
    researcher("agent observability")
```

By default the SDK sends to `http://localhost:4800` (set `AGENTSPACE_URL` to change it) and to the workspace `default` (`AGENTSPACE_WORKSPACE`). If the collector isn't running, your app keeps working: events are buffered in bounded memory, and you get one warning.

## Next

- Let agents [ask for approval](approvals-and-controls), and pause or cancel runs.
- Check [costs](costs), and [replay](replay-and-dashboard) a run.
- Before exposing the collector beyond your machine, read [Security and auth](security).
