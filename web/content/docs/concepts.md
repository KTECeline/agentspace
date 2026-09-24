# Concepts

## Events

Everything is an **event**: a small JSON object that follows the [event spec](event-spec). Each one has an `id` (retries are de-duplicated by it), a `type`, a timestamp, the `workspace`, `run_id`, `agent_id` and `team_id` it belongs to, and a `data` payload. There are 15 types:

| Type | Meaning |
|---|---|
| `run.started`, `run.finished`, `run.control` | a task begins or ends; an operator paused, resumed or cancelled it |
| `agent.registered`, `agent.status` | an agent joins; it's thinking, using a tool, waiting, done, failed… |
| `step.started`, `step.finished` | a unit of work (like an OpenTelemetry span) |
| `llm.call` | a model call, with tokens, model and cost |
| `tool.call`, `tool.result` | a tool call and its outcome |
| `handoff`, `message` | one agent passes work (or a message) to another |
| `approval.requested`, `approval.resolved` | an agent asks a person; the person decides |
| `error` | something failed |

## Workspaces, runs, teams and agents

- A **workspace** is a separate office: its own agents, runs and history. Use one per project or environment.
- A **run** is one end-to-end task, like one trace in OpenTelemetry. Totals (tokens, cost, duration) are kept per run.
- A **team** is a room in the office. Agents on the same team sit together; rooms hold six desks and overflow into more rooms.
- An **agent** gets a desk the first time it appears, and keeps it. Desks never move when new agents join.

## Status

An agent's status drives its animation: `idle`, `thinking`, `using_tool`, `waiting`, `waiting_human` (the glow), `blocked`, `done` and `error`. Adapters set it for you; with the manual API, use `agentspace.set_status()`.

## Content and privacy

By default only **metadata** leaves your process: names, statuses, token counts, tool names, durations and short summaries. Prompts, model outputs and tool arguments are sent only with `init(capture_content=True)`, and every content value passes through your `redact` hook first. See [Security and auth](security).

## Totals

Tokens and cost are summed over `llm.call` events only, per agent and per run. Cost carries its source: *reported* by a framework, or *estimated* by the collector. See [Costs and pricing](costs).
