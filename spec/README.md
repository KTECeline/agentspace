# AgentSpace event spec

`v0.1/event.schema.json` (JSON Schema 2020-12) is the **single source of truth**. Everything else is generated from it:

| Output | Generator | Command |
|---|---|---|
| `packages/spec-types/src/generated.ts` | json-schema-to-typescript | `make gen-types` |
| `packages/sdk-python/agentspace/models/_generated.py` | datamodel-code-generator (pydantic v2) | `make gen-types` |

CI runs `make check-generated` and fails if the generated files are stale.

## Model

```
workspace ─┬─ team ── agent          (who: the office layout)
           └─ run ── step ── event   (what: the timeline)
```

Every event has the envelope fields: `spec_version`, `id`, `type`, `ts`, `workspace`, `run_id`, `agent_id`, `team_id`, `parent_id`. It can also have `tokens_in`, `tokens_out`, `cost_usd`, `model`, `summary` and `attributes`. The type-specific payload goes in `data`.

`parent_id` is the `step_id` of the enclosing step. Steps nest, so a run's events form a tree, the same way OTel spans do.

Collectors ingest batches as `POST /v1/events` with `{"events": [...]}`, up to 1000 per batch.

- The collector validates each event on its own. Valid events in a batch are stored even if others are rejected, and the response says `{accepted, duplicates, rejected, errors}`.
- Event `id`s are de-duplicated per workspace, so SDK retries are safe.
- **Totals rule:** per-agent and per-run `tokens_in`, `tokens_out` and `cost_usd` are summed over **`llm.call` events only**. Other events may carry those fields for display, but they aren't added again.

## Privacy

`summary` is always safe to display. Full content (`data.input`, `data.output`, `data.arguments`, `data.result`, `data.text`, `data.payload`) is only sent when the SDK runs with `capture_content=True`, and it goes through the redaction hook first.

## Mapping to OpenTelemetry GenAI semantic conventions

These are mapped against [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), which was checked on 2026-09-23 and is still marked **Development** status. The OTLP ingest endpoint (Phase 3) will use this table in reverse.

| AgentSpace | OTel GenAI |
|---|---|
| `run_id` | trace id; `gen_ai.conversation.id` when present |
| `run.started` / `run.finished` (`data.name`) | `invoke_workflow {gen_ai.workflow.name}` span |
| `step.started` / `step.finished` (`kind: agent`) | `invoke_agent {gen_ai.agent.name}` span (start/end) |
| `data.step_id`, `parent_id` | span id, parent span id |
| `agent_id` | `gen_ai.agent.id` (falls back to `gen_ai.agent.name`) |
| `agent.registered.data.name` / `.description` | `gen_ai.agent.name` / `gen_ai.agent.description`; `create_agent` span |
| `llm.call` | `chat` / `text_completion` / `generate_content` span |
| `llm.call.data.provider` | `gen_ai.provider.name` |
| `llm.call.data.operation` | `gen_ai.operation.name` |
| `model` | `gen_ai.response.model` (else `gen_ai.request.model`) |
| `tokens_in` / `tokens_out` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` |
| `llm.call.data.finish_reason` | `gen_ai.response.finish_reasons[0]` |
| `llm.call.data.input` / `.output` | `gen_ai.input.messages` / `gen_ai.output.messages` (opt-in content) |
| `tool.call` + `tool.result` | `execute_tool {gen_ai.tool.name}` span (start/end) |
| `tool.*.data.tool_name` / `call_id` | `gen_ai.tool.name` / `gen_ai.tool.call.id` |
| `tool.call.data.arguments` / `tool.result.data.result` | `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` |
| `error.data.kind` | `error.type` |
| `attributes` | any other span attributes |

These have no OTel equivalent yet, so they're AgentSpace-only: `agent.status`, `handoff`, `message`, `approval.*`, `team_id`, `cost_usd`. If they arrive over OTLP, the collector will read them from span events and attributes under an `agentspace.*` prefix.

## Versioning

See [CHANGELOG.md](CHANGELOG.md).
