# OpenTelemetry-only agent

A three-agent support pipeline (Router → Researcher → Writer) that knows nothing about AgentSpace. It's instrumented with plain **OpenTelemetry**, following the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai), and exports over OTLP/HTTP. AgentSpace's collector turns the spans into agents in the office.

This works the same way for anything that already emits GenAI spans: OpenLLMetry, OpenInference, the Vercel AI SDK (`experimental_telemetry`), Pydantic AI, and others. Point the OTLP exporter at the collector:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4800/v1/traces
```

## Run it

```bash
docker compose up -d                  # from the repo root
cd examples/otel-generic
uv run python main.py --runs 0        # simulated model calls, no API key
```

Open http://localhost:4801.

## What turns into what

| Span | In the office |
|---|---|
| `invoke_agent` with `gen_ai.agent.name` | an agent at a desk (thinking → done / error) |
| `chat` with `gen_ai.usage.*` | an LLM call with tokens and model |
| `execute_tool` with `gen_ai.tool.name` | a tool call (errors show as failed) |
| the root span | the run (its name comes from `gen_ai.workflow.name`) |
| the next agent span in the same trace | a handoff packet between desks |
| span event `agentspace.status {status, detail}` | any status, e.g. `waiting_human` ("needs you") |
| span event `agentspace.handoff {to_agent}` | an explicit handoff |

The team (room) is `resource["agentspace.team"]`, or `service.name` if that isn't set. The workspace comes from the `x-agentspace-workspace` header or `resource["agentspace.workspace"]`.

Prompt and response content (`gen_ai.input.messages` etc.) is dropped by the collector unless it runs with `AGENTSPACE_OTLP_CAPTURE_CONTENT=true`.
