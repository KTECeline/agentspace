# Event spec

The event spec is a JSON Schema (draft 2020-12) at [`spec/v0.1/event.schema.json`](https://github.com/KTECeline/agentspace/blob/main/spec/v0.1/event.schema.json). It's the single source of truth: the TypeScript and Python types are generated from it, and the collector validates every event against it.

## The envelope

Every event carries these fields:

| Field | Required | Notes |
|---|---|---|
| `spec_version` | yes | `"0.1"` |
| `id` | yes | unique; retries with the same id are de-duplicated |
| `type` | yes | one of the 15 types below |
| `ts` | yes | RFC 3339, UTC |
| `workspace`, `run_id` | yes | |
| `agent_id`, `team_id`, `parent_id` | yes (nullable) | `parent_id` is the enclosing step |
| `tokens_in`, `tokens_out` | | `llm.call`; `tokens_in` includes cached tokens |
| `tokens_cache_read`, `tokens_cache_write` | | the cached part of `tokens_in` |
| `cost_usd`, `cost_source` | | `reported` or `estimated` ([Costs](costs)) |
| `model`, `summary`, `attributes` | | `summary` is short and always safe to show |
| `data` | yes | depends on `type` |

## Types

`agent.registered`, `agent.status`, `run.started`, `run.finished`, `run.control`, `step.started`, `step.finished`, `llm.call`, `tool.call`, `tool.result`, `message`, `handoff`, `approval.requested`, `approval.resolved`, `error`, and `anomaly.detected` (sent only by the collector's [detectors](detectors)). What each one means is in [Concepts](concepts); the schema has every `data` field.

Content fields (`input`, `output`, `arguments`, `result`, `text`, `payload`) are only filled when the SDK runs with `capture_content=True`. `tool.call` also carries `arguments_hash`, a keyed hash of the arguments that reveals nothing about them; see [Detectors](detectors).

## OpenTelemetry

The spec maps to the OpenTelemetry GenAI semantic conventions: runs are traces, steps are spans, and `llm.call` is a `chat` span, for example. See [OpenTelemetry](opentelemetry) and [`spec/README.md`](https://github.com/KTECeline/agentspace/blob/main/spec/README.md).

## Versioning

The spec follows semantic versioning. Minor versions only add optional fields and types. Changes are listed in [`spec/CHANGELOG.md`](https://github.com/KTECeline/agentspace/blob/main/spec/CHANGELOG.md).
