# AgentSpace

**A live office for your AI agent teams.** Add two lines to your multi-agent app and watch every agent work: who is thinking, which tool is running, who handed off to whom, and what it cost.

AgentSpace is open source (Apache 2.0) and framework-agnostic. You get:

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

- [Quickstart](quickstart): the office running in two minutes, with no API key.
- [Concepts](concepts): runs, agents, teams, steps and events.
- Your framework: [LangGraph](langgraph), [CrewAI](crewai), [OpenAI Agents](openai-agents), [Claude Agent SDK](claude-agent-sdk), [Claude Code](claude-code), [OpenTelemetry](opentelemetry).
