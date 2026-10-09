# AgentSpace

**Debug, observe and control your multi-agent systems.** When a run goes wrong, AgentSpace shows you where, compares it with a run that went right, and can pause the next one before the risky tool runs. Add two lines to your app, and every agent works at a desk in a live office, so incidents show up where you're already looking.

AgentSpace is open source (Apache 2.0) and framework-agnostic. You get:

- **Debugging.** A [trace](debugging) of every run, tied to its replay, with **First error**; and a [comparison](debugging#comparing-two-runs) with the last good run: what changed, and where the two first differ.
- **Detectors.** The collector flags repeated calls, failure loops, handoff loops and runs far above their usual tool calls or cost, with the numbers ([detectors](detectors)). Deterministic, no LLM.
- **Oversight you write.** A [policy](policy) says which tools run freely, need a person, or never run. Findings can make it stricter for a run that looks wrong, never looser, and every review shows the evidence.
- **A live 3D office** (with a 2D view). Each team gets a room, each agent a desk. Agents animate by status, handoffs fly between desks as packets, and an agent that needs a person glows.
- **Approvals, pause and cancel.** Agents can ask a person before doing something. Operators can pause or cancel a run from the office.
- **Costs you can trust.** A framework's billed cost is shown as reported. Otherwise the collector estimates it from a dated price table and marks it **est.**
- **Replay and a Costs page.** Scrub through any stored run, and see cost, latency and errors per run, agent, model and day.
- **Works with your stack**: LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK, Claude Code, anything that speaks OpenTelemetry, and a manual API for Python and TypeScript.
- **Private and safe by default.** Only metadata leaves your process unless you opt in, and the SDK never breaks or blocks your app ([benchmarks](benchmarks)).

## How it fits together

```
 your agent app                 AgentSpace collector              the office
┌─────────────────────┐ batched ┌────────────────────────┐ WebSocket ┌──────────────┐
│ your framework      │──HTTP──▶│ validates, stores      │─────────▶│ 3D / 2D view │
│ + agentspace SDK    │ or OTLP │ (SQLite), prices,      │ snapshot │ approvals,   │
│ (background thread) │◀────────│ approvals and controls │ + deltas │ replay, costs│
└─────────────────────┘controls └────────────────────────┘          └──────────────┘
```

1. The **SDK** (or an OpenTelemetry exporter) records events: agents registering, status changes, model and tool calls, handoffs. It sends them in batches from a background thread.
2. The **collector** validates each event against the [event spec](event-spec), stores it, prices model calls, and streams changes to browsers.
3. The **office** shows it all live. Operators can approve, pause and cancel from there, and the SDK picks those decisions up.

## Where to go next

- [The failure story](debugging#the-failure-story): the whole loop in five minutes, recorded at `/demo` or live with `make demo-story`.

- [Quickstart](quickstart): the office running in two minutes, with no API key.
- [Concepts](concepts): runs, agents, teams, steps and events.
- Your framework: [LangGraph](langgraph), [CrewAI](crewai), [OpenAI Agents](openai-agents), [Claude Agent SDK](claude-agent-sdk), [Claude Code](claude-code), [OpenTelemetry](opentelemetry).
