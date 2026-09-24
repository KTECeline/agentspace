# Event spec changelog

The spec follows semantic versioning. Minor versions may add optional fields and event types; removing or renaming anything needs a new major version (or, while pre-1.0, a new minor version with a migration note).

## v0.1 (2026-09-23)

Initial draft.

- 2026-09-24 (additive, pre-release): `run.control` with `data.action` = `pause | resume | cancel` (and optional `by`). The collector emits it when an operator controls a run. See DECISIONS D-030.
- 2026-09-24 (additive, pre-release): envelope fields `tokens_cache_read` and `tokens_cache_write` (the cached part of `tokens_in`) and `cost_source` = `reported | estimated`. The collector estimates a cost for an `llm.call` that has tokens but neither `cost_usd` nor `cost_source`. See DECISIONS D-037.

- Envelope: `spec_version`, `id`, `type`, `ts`, `workspace`, `run_id`, `agent_id`, `team_id`, `parent_id`, plus optional `tokens_in`, `tokens_out`, `cost_usd`, `model`, `summary`, `attributes`.
- 14 event types: `agent.registered`, `agent.status`, `run.started`, `run.finished`, `step.started`, `step.finished`, `llm.call`, `tool.call`, `tool.result`, `message`, `handoff`, `approval.requested`, `approval.resolved`, `error`.
- `step.started` / `step.finished` were added on top of the brief's list so steps (≈ OTel spans) have explicit boundaries. See DECISIONS D-009.
- Content fields (`input`, `output`, `arguments`, `result`, `text`, `payload`) are only filled when the SDK runs with `capture_content=True`.
