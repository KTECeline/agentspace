# Decisions

Short records of why each choice was made. Newest at the bottom. Format: context → decision → why.

## D-001 · Project name `agentspace` (2026-09-23)
`agentspace` is free on both PyPI and npm (`agent-space` is taken on both).
**Decision:** keep `agentspace`. Reserve it early with a placeholder `0.0.1` on both registries (see D-006).

## D-002 · License: Apache-2.0 (2026-09-23)
**Decision:** Apache-2.0.
**Why:** permissive, has an explicit patent grant, and is common for dev tools that companies adopt.

## D-003 · Repo hosting: private GitHub repo now, public at launch (2026-09-23)
**Decision:** private repo `agentspace` created with `gh`, one conventional commit per working step, pushed after each commit so CI runs on every step. It becomes public at launch (Phase 5).

## D-004 · Example model: Anthropic via `langchain-anthropic`, plus `--fake` (2026-09-23)
**Decision:** `examples/langgraph-dev-team` uses `ChatAnthropic`. The model comes from `AGENTSPACE_EXAMPLE_MODEL` (default `claude-sonnet-5`). A `--fake` flag swaps in a scripted chat model with no network.
**Why:** real runs make a convincing demo; `--fake` keeps CI and the "kill the collector" check free, deterministic and key-less.

## D-005 · Python SDK supports Python >= 3.10 (2026-09-23)
**Decision:** `requires-python = ">=3.10"`; CI matrix runs 3.10 and 3.13. The dev machine has 3.14, so local dev and CI together cover the range.
**Why:** many teams running agents in production are still on 3.10/3.11. No 3.11+ syntax (`except*`, `Self`, `tomllib`) in the SDK.

## D-006 · Reserve the package names with placeholder 0.0.1 releases (2026-09-23)
**Decision:** `placeholders/` holds a minimal PyPI and npm package, both `agentspace@0.0.1`. The maintainer publishes them by hand with their own credentials (commands in `placeholders/README.md`). The real SDK starts at `0.1.0`.
**Why:** stops name squatting before the repo goes public, without shipping unfinished code.

## D-007 · Monorepo tooling: pnpm workspaces + uv (2026-09-23)
**Decision:** pnpm workspace for `server/`, `web/`, `packages/spec-types`; uv project for `packages/sdk-python`. A top-level `Makefile` wraps both.
**Why:** both are fast, standard, and already installed. No Turborepo/Nx; the graph is tiny.

## D-008 · Python SDK has zero runtime dependencies; pydantic models are an extra (2026-09-23)
The brief asks for pydantic types generated from the schema. They are generated (`agentspace.models`), but the SDK's hot path builds plain dicts and sends them with the stdlib (`urllib`, `threading`).
**Decision:** `dependencies = []`. `pip install agentspace[models]` adds pydantic for people who want typed models. The tests validate every event the SDK emits against both the JSON Schema and the pydantic models.
**Why:** a tracing SDK must never cause version conflicts in the host app (pydantic v1 vs v2, httpx pins). Building dicts is also cheaper than building models, which matters for the < 1 ms/event target.

## D-009 · Spec adds `step.started` / `step.finished` (2026-09-23)
The brief lists `step` as an entity but has no event type for it.
**Decision:** add `step.started` / `step.finished` with a `step_id`. Every other event's `parent_id` points at the enclosing `step_id`.
**Why:** this maps 1:1 to OTel span start/end, so OTLP import/export stays simple, and the UI can show nested timelines and per-step durations.

## D-010 · `agent_id`, `team_id`, `parent_id` are required-but-nullable (2026-09-23)
**Decision:** every event carries the keys (as the brief says). Run-level events set `agent_id: null`.
**Why:** consumers never have to special-case missing keys, and run-level events don't have to invent a fake agent.

## D-011 · Transport: bounded deque + one daemon thread, keep newest (2026-09-24)
**Decision:** `emit()` appends to a `deque(maxlen=10_000)`, which is O(1) and needs no lock on the hot path. A daemon thread sends batches (≤100 events, every 200 ms, or sooner once 100 are queued). When the collector is unreachable, failed batches go back in the queue. When the queue is full, the **oldest** events are dropped, with a rate-limited warning. Retries back off exponentially up to 10 s. `flush()` and `shutdown()` return right away if the collector is known to be down. HTTP 4xx (other than 429) drops the batch and doesn't retry.
**Why:** a live office cares most about recent events. Short outages lose nothing, and long outages have bounded memory. None of this can block or raise in the host. It's covered by `tests/test_reliability.py`: p99 `emit` < 2 ms with the collector down, and an asyncio loop that doesn't stall when the collector hangs.

## D-012 · LangGraph adapter: official callbacks, registered globally via `register_configure_hook` (2026-09-24)
**Decision:** `AgentSpaceCallbackHandler(BaseCallbackHandler)`. `init()` registers it with `langchain_core.tracers.context.register_configure_hook`, which is the public hook LangSmith uses, using a `ContextVar` whose default is the handler, so it's active in every thread and task. Graph node = agent, detected as a chain whose `name == metadata["langgraph_node"]`. A handoff is recorded when consecutive nodes differ. The team comes from `config.metadata.agentspace_team`, falling back to the graph's name. `run_inline = True` keeps event order, which is safe because the handler only enqueues.
**Why:** it's the "two lines of code" goal (`import agentspace; agentspace.init()`) with no monkey-patching. It was checked against langchain-core 1.6.4 / langgraph 1.2.12, and the event sequence is pinned by a golden fixture.

## D-013 · Known limitation: Python 3.10 + async LangGraph (2026-09-24)
On Python < 3.11, LangGraph can't propagate callback context into model or tool calls made inside nodes run with `ainvoke`, unless the node passes `config` on. This is a documented LangGraph limitation.
**Decision:** document it; don't work around it. On 3.10 async, node, agent and handoff events still work. The test asserts exactly that.
