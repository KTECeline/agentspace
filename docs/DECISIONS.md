# Decisions

Short records of why each choice was made. Newest at the bottom. Format: context → decision → why.

## D-001 · Project name `agentspace` (2026-09-23)
`agentspace` is free on both PyPI and npm (`agent-space` is taken on both).
**Decision:** keep `agentspace`. Reserve it early with a placeholder `0.0.1` on both registries (see D-006). *Superseded for the package names by D-019.*

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
**Decision:** `placeholders/` holds a minimal PyPI and npm package, both at `0.0.1` (names per D-019). The maintainer publishes them by hand with their own credentials (commands in `placeholders/README.md`). The real SDK starts at `0.1.0`.
**Why:** stops name squatting before the repo goes public, without shipping unfinished code.

## D-007 · Monorepo tooling: pnpm workspaces + uv (2026-09-23)
**Decision:** pnpm workspace for `server/`, `web/`, `packages/spec-types`; uv project for `packages/sdk-python`. A top-level `Makefile` wraps both.
**Why:** both are fast, standard, and already installed. No Turborepo/Nx; the graph is tiny.

## D-008 · Python SDK has zero runtime dependencies; pydantic models are an extra (2026-09-23)
The brief asks for pydantic types generated from the schema. They are generated (`agentspace.models`), but the SDK's hot path builds plain dicts and sends them with the stdlib (`urllib`, `threading`).
**Decision:** `dependencies = []`. `pip install 'agentspace-sdk[models]'` adds pydantic for people who want typed models. The tests validate every event the SDK emits against both the JSON Schema and the pydantic models.
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

## D-014 · Collector storage: better-sqlite3, event log + projections in one transaction (2026-09-24)
**Decision:**
- `better-sqlite3` in WAL mode. The `events` table is an append-only log, and `seq` gives arrival order for live views and pagination.
- `agents` and `runs` projections are updated in the same transaction as each insert.
- Validation is per event with Ajv against the shared schema, so partial acceptance works.
- `(workspace, id)` is unique for idempotent retries.
- Retention (`AGENTSPACE_RETENTION_DAYS`, default 7) deletes old events and finished runs but keeps agents.

**Why:**
- It's synchronous and very fast for this write pattern.
- better-sqlite3 v13 ships prebuilt binaries for linux, macOS and Windows (glibc and musl), so there's no compiler in Docker.
- Projections make the snapshot sent to new browsers O(agents), not O(events).
- `node:sqlite` is still experimental on Node 22.

## D-015 · WebSocket protocol: snapshot then deltas (2026-09-24)
**Decision:** `GET /v1/ws?workspace=` sends one `snapshot` (agents, the 50 most recent runs, the last 200 events), then `events`, `agents` and `runs` deltas after each ingest. Clients with more than 8 MB of buffered data are skipped rather than buffered for.
**Why:** a browser can join mid-run and render at once. Sending the updated projection rows means the web app doesn't have to re-derive state from events.

## D-016 · Phase 1 web: plain Tailwind tokens, no component library yet (2026-09-24)
**Decision:** the 2D view uses Tailwind v4 with CSS-variable design tokens (light and dark via `prefers-color-scheme`) and `lucide-react` icons. It doesn't use shadcn/ui yet. The collector URL is read at request time (`AGENTSPACE_PUBLIC_URL`) and can be overridden with `?collector=` / `?workspace=`. It's not `NEXT_PUBLIC_*`, because Next.js freezes those at build time.
**Why:**
- The view has a handful of components, so a component library adds weight without payoff yet.
- One Docker image has to work behind any URL.
- Brand and visual identity are deferred to Phase 2 (the 3D office), where they matter.

## D-017 · Default ports 4800 (collector) and 4801 (web) (2026-09-24)
**Decision:** the collector listens on `4800` and the office on `4801`. Both can be overridden (`AGENTSPACE_COLLECTOR_PORT`, `AGENTSPACE_WEB_PORT`).
**Why:** `3000` is usually taken by the developer's own app (it was on the dev machine). `4317/4318` belong to OTLP, which we'll accept on its standard port later. A pair of adjacent ports is easy to remember.

## D-018 · Docker images: pnpm deploy (collector), Next standalone (web) (2026-09-24)
**Decision:** both are multi-stage `node:22-slim` images that run as the `node` user. The collector uses `pnpm deploy --prod` plus the tsup bundle. The web image uses Next's `output: "standalone"`. `better-sqlite3`'s install script is skipped (`ignoredBuiltDependencies`) because v13 ships prebuilt binaries, so no Python or compiler is needed. Current sizes are about 400 MB each; slimming them is a Phase 5 task.

## D-019 · Published names: `agentspace-sdk` on both PyPI and npm (2026-09-24)
PyPI rejected `agentspace` with "too similar to an existing project": it matches `agent-space` once punctuation is removed. npm applies a similar rule, and `agent-space` exists there too. The earlier check (D-001) only looked for exact names.
**Decision:** keep the AgentSpace brand and the import name `agentspace`. The PyPI distribution is `agentspace-sdk`, the same pattern as `beautifulsoup4` → `bs4`. The npm TypeScript SDK is **`agentspace-sdk`** too, unscoped. The npm org `agentspace` was already taken, so a scoped `@agentspace/sdk` isn't possible. The private workspace packages (`@agentspace/spec-types`, `/server`, `/web`) are never published, so their scope doesn't matter. Placeholders are updated to match.
**Why:** it's the smallest change: code, docs and the brand stay the same. And one name on both registries (`pip install agentspace-sdk`, `npm i agentspace-sdk`) is easy to remember.

## D-020 · Web data layer: zustand store, frame-batched, pluggable sources (2026-09-24)
**Decision:**
- Office state lives in a `zustand` store fed by a pure reducer (`lib/state.ts`).
- Sources (`live` WebSocket, `recorded` file playback, `stress` generator) push collector-shaped messages into a queue. The queue is applied at most once per animation frame, or every 100 ms in hidden tabs.
- Recordings and stress runs are turned into collector messages by a client-side `Projector`. It must match the collector's SQL projections exactly: both sides are tested against `spec/v0.1/examples/projection.expected.json`.

**Why:**
- The 3D scene needs per-object subscriptions, so an agent's avatar re-renders only when that agent changes.
- 100 events/s must not mean 100 React renders/s.
- The public demo (Phase 5) has to run on static hosting with no collector, and still look exactly like a live run.

## D-021 · Brand: cozy low-poly office (style A) (2026-09-24)
**Decision:** a warm cream and pastel palette with a terracotta accent, and warm dark mode as "the office after hours". Fredoka is the display face; Geist is used for the UI. Documented in `brand.md`. All token pairs are checked to be ≥ 4.5:1 in both themes.
**Why:** chosen by the maintainer. It stands out from dark "mission control" AI tools and reads well in a README GIF.

## D-022 · 3D office rendering choices (2026-09-24)
**Decision:**
- An orthographic isometric camera with `MapControls`: pan and zoom, no rotation.
- Avatars and furniture are built in code from low-poly primitives, so there are no model files or asset licenses. Static furniture is drawn with one `InstancedMesh` per part (9 draw calls for any number of desks).
- Labels and speech bubbles are **one DOM layer** positioned by a single projector in `useFrame`, not drei `<Html>`. It only writes a transform when a label actually moves.
- DOM-heavy panels (event log, roster) are throttled to 4 or 2 updates per second.
- Body colors are assigned in first-seen order, so teammates don't share a color.

**Why:**
- drei `<Html>` creates one React root per label. Under React 19 StrictMode those roots get unmounted mid-render, so rarely-updated labels stayed blank, and 50+ roots is expensive.
- Measured on the dev MacBook Air, production build, `/demo?stress=50` (50 agents, 100 events/s): **58–60 fps**. Before the optimizations it was 36 fps in dev mode.
