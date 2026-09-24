# OpenTelemetry (OTLP)

Anything that exports OpenTelemetry **GenAI** spans can use AgentSpace with no SDK: the Vercel AI SDK, OpenLLMetry, OpenInference, or your own tracer.

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4800/v1/traces
```

The collector accepts OTLP/HTTP as JSON or protobuf, optionally gzipped, on `POST /v1/traces`.

## Mapping

| OpenTelemetry | AgentSpace |
|---|---|
| trace id (or `gen_ai.conversation.id`) | run |
| `invoke_workflow {name}` span | run name |
| `invoke_agent {gen_ai.agent.name}` span | an agent, with a step; a new agent span is a handoff |
| `chat` / `text_completion` / `generate_content` span | `llm.call`: `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, model |
| `execute_tool {gen_ai.tool.name}` span | tool call and result |
| span status error | `error` |

**AgentSpace extensions:** resource attributes `agentspace.workspace` and `agentspace.team` (the team falls back to `service.name`); span events `agentspace.status {status, detail}` and `agentspace.handoff {to_agent, reason}`. The workspace can also come from the `X-AgentSpace-Workspace` header.

**Ordering:** exporters send spans when they *end*, so child spans are held (up to `AGENTSPACE_OTLP_HOLD_MS`, 10 s) until their parent arrives. Event ids come from span ids, so re-exported batches don't double count.

**Privacy:** `gen_ai.input.messages`, `gen_ai.output.messages` and tool arguments and results are dropped unless `AGENTSPACE_OTLP_CAPTURE_CONTENT=true`.

Model calls are priced by the collector like any other ([Costs](costs)).

Example: [`examples/otel-generic`](https://github.com/KTECeline/agentspace/tree/main/examples/otel-generic).
