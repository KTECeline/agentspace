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

## D-023 · OTLP ingest: embedded protos, span assembler with a parent hold (2026-09-24)
**Decision:**
- `POST /v1/traces` on the collector's normal port. It takes JSON or protobuf, optionally gzipped.
- The OTLP `.proto` files (v1.11.0) are embedded as strings and parsed with `protobufjs`, so there's no codegen step and no runtime files.
- Spans become events in `OtlpAssembler`. Non-agent spans wait up to 10 s for their parent so they inherit the right agent; agent spans are never held. Event ids are derived from span ids.
- Content attributes are dropped unless `AGENTSPACE_OTLP_CAPTURE_CONTENT=true`.
- It's tested with synthetic traces *and* with raw protobuf recorded from the real OpenTelemetry Python exporter.

**Why:**
- Exporters send spans when they *end*: children first, the root last, and often in separate batches. Without holding them, most tool and LLM spans would have no agent.
- Holding agent spans too would delay every agent until the whole workflow ended.
- The standard port 4318 isn't exposed yet, to keep the setup to one port. Users set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead.

## D-024 · TypeScript SDK shape (2026-09-24)
**Decision:**
- It's published as `agentspace-sdk` (the same name as on PyPI), ESM + CJS, with no runtime dependencies.
- Scopes take callbacks (`run(name, fn)`, `agent(opts, fn)`, `step(name, fn)`) instead of Python-style context managers, and work with both sync and async `fn`.
- Context uses `AsyncLocalStorage`, found at runtime via `process.getBuiltinModule` (Node ≥ 20) or a global (edge runtimes). If neither exists, it falls back to a sync stack.
- The transport is a fixed-size ring buffer plus `fetch` with `AbortSignal.timeout`. Timers are `unref`'d, and one `beforeExit` flush runs.
- Spec types are imported by relative path so the published `.d.ts` is self-contained.

**Why:**
- Callbacks are the idiomatic TS equivalent of context managers, and they carry async context correctly.
- A static `node:async_hooks` import would break browser and edge bundling.
- The private `@agentspace/spec-types` package can't be a dependency of a published package.
- Verified with `npm pack`: it imports from ESM and CJS and type-checks under strict TS.

## D-025 · OpenAI Agents SDK adapter: TracingProcessor (2026-09-24)
**Decision:**
- An `AgentSpaceTracingProcessor` registered with `agents.add_trace_processor` (the official extension point). It gets live start/end callbacks, so the office updates in real time.
- `agent` spans become agents, `handoff` spans become handoffs (emitted at span *end*, because that's when from/to are filled in), `generation`/`response` spans become LLM calls with usage, and `function` spans become tool calls.
- With `capture_content`, `tool.call` is sent at span end, because the SDK fills in the arguments while the span runs.
- Each framework lives in its own uv dependency group, with a CI job per adapter.
- The tests use a scripted `Model` that opens `generation_span`s like the real models.

**Why:** this is the SDK's documented hook, it's live, and it needs no monkey-patching. Separate groups keep heavy frameworks from constraining each other or the core SDK.

## D-026 · CrewAI adapter: event listener, built for out-of-order delivery (2026-09-24)
**Decision:**
- A `BaseEventListener` on `crewai_event_bus` (the official extension point), covering crew kickoff, agent execution, LLM call and tool usage events.
- CrewAI runs sync handlers on a **thread pool**, so the adapter stamps events with CrewAI's own timestamps (via a new `ts=` override on `Client.emit`), processes them under a lock, and ignores agent statuses older than one already applied.
- Handoffs come from the next agent in a crew, or from the "Delegate work to coworker" / "Ask question to coworker" tools.
- The framework extras (`agentspace-sdk[crewai]` etc.) are removed; only `[models]` remains. CrewAI pins `openai<3` and the OpenAI Agents SDK needs `openai>=3`, so the extras made the package unresolvable, and adapters only need the framework the app already has.
- The dependency groups are declared as conflicting, and the CrewAI group has a `python_version < '3.14'` marker, so uv picks current CrewAI (1.15) instead of an old one.

**Why:** the official hook, correct behavior even when handlers race, and each framework tested at its current version.

## D-027 · Claude Agent SDK adapter: opt-in hooks + stream tracker (2026-09-24)
**Decision:**
- The Claude Agent SDK has no global registry. Its extension point is `ClaudeAgentOptions(hooks=...)`, which is per session.
- So the adapter is opt-in: `instrument_options(options, name=, team=)` merges our hooks after the user's, without mutating their options, and `track(stream)` wraps the message iterator to get model and token usage per assistant message.
- The session's real billed cost comes from `ResultMessage.total_cost_usd`. It's attached as one `llm.call` that carries only `cost_usd`, so run and agent cost totals are right without double-counting tokens.
- Subagents (Task/Agent tool, `SubagentStart`) get a desk per agent type, plus a handoff. `PermissionRequest` and permission notifications become `waiting_human`.
- Hook callbacks always return `{}`: observing must never change what the agent does.

**Honesty note:** the conformance fixture is **synthetic**, built from the SDK's typed hook and message schemas, because capturing a real session needs the Claude Code CLI and an API key. Swap in a real capture once a key is available.

## D-028 · Claude Code hooks: one stateless, silent, fail-open command (2026-09-24)
**Decision:**
- `python -m agentspace.claude_code hook` is the command in Claude Code's `hooks` settings. It maps one hook payload to events and sends them with a single POST with a **300 ms timeout**. It keeps no state, prints nothing, and always exits 0.
- `install` / `uninstall [--user]` merge into or remove from `.claude/settings.json`. They're idempotent and only touch entries containing `agentspace.claude_code`.
- The project directory name is the team (room); subagents get desks by agent type.
- Tool summaries contain only a file *name* or subagent type. Prompts, file contents, full paths, search patterns, URLs and commands are never sent.

**Why:**
- Claude Code runs PreToolUse hooks synchronously before every tool call, so the command must be cheap and must not be able to fail the session.
- Hook stdout can be fed back into Claude's context, which is why it prints nothing.
- The installer writes the absolute path of the current Python so the hook works outside any virtualenv.

## D-029 · Findings from the first live runs, via OpenRouter (2026-09-24)
These are the first real (non-fake) runs of the Claude Agent SDK example and of a Claude Code hook session. Both went through OpenRouter's Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`, key in `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`). Total spend was **$0.2151** of OpenRouter credit, measured from the key's usage before and after; Anthropic spend was $0.

What broke and what changed:
- **Model ids:** Claude Code can't price OpenRouter's `~anthropic/…` ids, so its `max_budget_usd` guard tripped early: it estimated $0.25 when $0.06 was actually billed. **Decision:** default to Anthropic's native `claude-haiku-4-5`, which OpenRouter also accepts and Claude Code can price.
- **Hang after a budget stop:** the subagent kept running and the CLI never exited. **Decision:** the example has a 2-minute overall timeout, and the adapter now finishes the turn and the run on the `ResultMessage` when no Stop hook arrives (regression test added).
- **Prompt size:** Claude Code's full built-in toolset adds about 35k input tokens per call. `tools=["Agent"]` plus `setting_sources=[]` cut it to about 3.7k, making a full run about 5× cheaper ($0.0186).
- **Output tokens undercounted:** one API response arrives as several `AssistantMessage`s with the same id, and the early ones carry partial usage. **Decision:** merge by message id and emit once the message is complete (on a new id, PreToolUse, SubagentStart, Stop, or the result).
- **The "reported" cost from Claude Code is only an estimate** when a gateway is in front of it. Phase 4b's cost `source` should distinguish "reported by the framework" from "billed by the provider", and not treat a gateway-routed framework cost as authoritative.
- **Verified live:** handoff to the subagent, the subagent's tool call, the "needs you" status during the permission request, and completion. For Claude Code: hooks for SessionStart through SessionEnd, with metadata-only tool summaries.

## D-030 · `run.control` event (additive change to the v0.1 draft) (2026-09-24)
**Decision:** a new event type `run.control` with `data.action = pause | resume | cancel` (and optional `by`). The collector emits it when an operator controls a run, in the same transaction as the state change. v0.1 hasn't been released, so this is an additive change and all existing events stay valid.
**Why:** pauses and cancels have to appear in the log and in replays (Phase 4b), and so far the spec had no way to express them.

## D-031 · Async `Store` interface with a shared contract test suite (2026-09-24)
**Decision:**
- `server/src/store/types.ts` defines an async interface covering events, projections, approvals and run controls.
- `SqliteStore` implements it, and `PostgresStore` implements the same interface.
- `tests/store.test.ts` is the contract. It runs against every backend: SQLite always, and Postgres when `TEST_DATABASE_URL` is set.
- Approval resolution and control changes are single transactions that also insert their event. The resolved-event id is deterministic (`approval-resolved-<id>`), so a double resolve can't produce two events even under a race. A decision that arrives after the deadline records a timeout and returns 409.

## D-032 · Auth model (2026-09-24)
**Decision:**
- Workspace API keys (`AGENTSPACE_API_KEYS=ws:key,…`, where `*` means all workspaces) cover ingest and the SDK's own polling.
- The operator token (`AGENTSPACE_OPERATOR_TOKEN`) covers approve/reject/pause/cancel and all reads. A workspace key may also operate its own workspace, for automation.
- As soon as anything is configured, reads need a token.
- Public read-only mode (`AGENTSPACE_PUBLIC_READONLY=true`) allows open reads, strips approval payloads from every read path (REST, WebSocket, the event log), and returns 403 for all operator actions, even with a token.
- WebSocket auth is the first message (`{"type":"auth","token"}`), because browsers can't set headers on WebSockets and tokens in URLs end up in logs.
- Tokens are compared in constant time.
- With nothing configured, everything stays open: the local two-minute setup is unchanged.

## D-033 · SDK control semantics: safe points, fail-closed approvals (2026-09-24)
**Decision:**
- **Delivery.** Controls reach the SDKs two ways: piggybacked on ingest responses (`controls`), and through a 2 s poll of `GET …/controls` for runs active in the last minute, so idle runs still learn about them. While paused, the SDK long-polls that endpoint.
- **Cancel.** Python `Cancelled` subclasses `BaseException`, so `except Exception` can't swallow it. It's raised at safe points only: agent/step scope entry, `checkpoint()`, and adapter hooks. `init(cancel_mode="flag")` never raises; code polls `is_cancelled()`.
- **Cancelled runs** finish with status `"cancelled"` and no `error` event. Agents end `done` with detail "cancelled by an operator".
- **Pause.** Pausing blocks at the same safe points and never blocks an event loop. Async code pauses at `await acheckpoint()` or async adapter hooks, which wait in a thread. Sync callbacks on a loop only warn.
- **Agent scopes** checkpoint just after registering, so the pause shows on the agent's own desk.
- **Approvals** fail closed:
  - `rejected` when not initialized, when the collector is unreachable (the flush fails, or 3 network failures in a row), or on 401/403;
  - `timeout` at the deadline;
  - never approved by accident, and never hangs past its timeout.
  - The payload bypasses `capture_content` (a person has to see it) but still goes through `redact`.
- **TypeScript** has the same API (`requestApproval`, `checkpoint`, `Cancelled`, `cancelMode`). JS has no BaseException, so `isCancelled(err)` exists for rethrowing from catch-all blocks. Scopes check for cancel synchronously; pausing needs `await checkpoint()`.

**Why:** cancel must be hard to swallow but never kill work mid-call (hence safe points only). A pause must not freeze unrelated async work. An approval that silently approves on error would be a security bug.

## D-034 · Adapter control points (2026-09-24)
**Decision:** each adapter uses its framework's own hook for pause and cancel:
- **LangGraph:** node, model and tool start callbacks. `Cancelled` propagates because LangChain's `handle_event` only catches `Exception`. `adapters.langgraph.request_approval_sync` attaches the approval to the calling node, using LangChain's active-config contextvar.
- **OpenAI Agents:**
  - cancel is raised from `on_span_start` (the processor provider only catches `Exception`);
  - pausing needs `hooks=ControlHooks()` (async `RunHooks`), because a tracing processor must never block the loop.
- **CrewAI:** handlers run on a thread pool and can't stop a crew, so `step_callback=step_checkpoint` is the safe point. On cancel it closes the run itself, because CrewAI emits no "completed" or "failed" event for a `BaseException`.
- **Claude Agent SDK:**
  - the PreToolUse hook is the safe point. Its matcher timeout is 3600 s so a pause can outlast the SDK's 60 s default.
  - On cancel it denies the tool with `continue: false` and never raises into the SDK.
  - `approval_callback()` is a fail-closed `can_use_tool`.

**Why:** only framework-supported extension points (no monkeypatching). Where a framework can't be stopped from a callback, we provide the one opt-in hook that can.

## D-035 · Web operator UI and the browser token (2026-09-24)
**Decision:**
- `GET /v1/info` decides what the page shows. Operator controls appear only for a live collector that isn't in public mode.
- **Token.** The operator token is kept in `localStorage`, sent as `Authorization: Bearer` to REST and as the first WebSocket message, and only to the configured collector. A 4401 close shows a "private office" screen instead of a reconnect loop.
- **Cancel** needs a second click within 5 s. No browser dialogs.
- **Approvals** live in an Approvals tab and a header pill. Pending approvals also show in the agent panel. Public mode shows "details hidden".
- **Connection state.** "Live" appears only after the collector's first message, because a protected collector accepts the socket but stays silent until the token checks out.

**Why:** browsers can't set WebSocket headers, and tokens in URLs leak into logs. `localStorage` is enough for a self-hosted operator console; a session login can come later if needed.

## D-036 · Corporate CA as an optional build arg (2026-09-24)
**Decision:**
- `EXTRA_CA_CERT` is a Docker build arg holding PEM text. Compose fills it from `AGENTSPACE_EXTRA_CA_CERT` and it's empty by default.
- It's written to `/tmp` in the build stage and exported as `NODE_EXTRA_CA_CERTS` only for the install/build steps. Runtime images never contain it.
- `.gitignore` ignores `*.pem`, `*.crt` and `*.key`. It's documented in CONTRIBUTING.md.

**Why:** some networks intercept TLS. Trusting their CA explicitly is safe; disabling verification isn't, and committing a company certificate would leak it into a public repo.

## D-037 · Cost sources and cache tokens on the event envelope (2026-09-24)
**Decision:** three new optional envelope fields (an additive change to the v0.1 draft):
- `cost_source`: `"reported"` or `"estimated"`.
  - `"reported"` means the framework or provider gave the cost. It's assumed whenever an SDK sets `cost_usd`, and the collector never overwrites it.
  - `"reported"` **without** `cost_usd` means "this call's cost is reported on another event; don't estimate it". The Claude Agent SDK adapter uses it on each message, because the SDK bills the whole session on `ResultMessage`.
  - `"estimated"` is set only by the collector, when it prices an `llm.call` that has tokens but neither `cost_usd` nor `cost_source`.
- `tokens_cache_read` / `tokens_cache_write`: the part of `tokens_in` read from or written to the provider's prompt cache (OTel `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens`, which are also counted in input tokens). Adapters fill them from each framework's usage data.

**Why:** estimating every call that has tokens but no cost would double count the Claude Agent SDK's billed sessions, and pricing cache reads at the full input rate overcharges them by up to 10×. A field on the event keeps estimated cost auditable in the log, in recordings and in replays, instead of hiding it in a projection.

## D-038 · Collector price table (2026-09-24)
**Decision:**
- `server/src/pricing/prices.json` is the built-in table: USD per 1M tokens, standard tier, text. Every model has an `as_of` date (when the price was checked) and the official `source` page (Anthropic, OpenAI, Google). Prices are copied from those pages, never guessed.
- A model has one or more price **periods** (`from` = first day). The event's own timestamp picks the period, so a scheduled change (Gemini Flash doubles on 2027-01-01) prices each call correctly without editing the table on the day.
- **Long-context tiers** (`long_context.above_input_tokens`) are applied only where the page states the threshold (OpenAI gpt-5.5/5.4: 272K; Gemini Pro: 200K). OpenAI's gpt-6 and gpt-5.6 list long-context prices but no threshold, so they are priced at the short-context rate.
- **Cache pricing:** cached tokens are part of `tokens_in`. Cache reads and writes use their own price; a missing cache price falls back to the input price. Anthropic cache writes use the 5-minute rate, because the usage data doesn't say which TTL was written. Gemini caching is billed as storage time, which we can't see, so only its cache reads are priced.
- **Matching:** an exact id or alias first (so `gpt-4o-2024-05-13` keeps its own price), then a normalized id that drops provider prefixes (`anthropic/`, `models/`, Bedrock `us.anthropic.`), version and date suffixes, `@`/`:` tags, and treats `.` as `-`. There is no prefix or fuzzy matching: an unknown model stays unpriced instead of borrowing a wrong price.
- **Overrides:** `AGENTSPACE_PRICES_FILE` points at a local JSON file of the same shape. Its models replace built-in ones by id. A bad file stops the collector at startup rather than pricing wrong. `GET /v1/pricing` serves the merged table without a token (it's server config, not workspace data).
- Each estimated event also gets `attributes["agentspace.price_model"]` and `["agentspace.price_as_of"]`, so a stored estimate says which price produced it.
- Not modelled: batch discounts, fast mode, data-residency multipliers, per-search tool fees, image/audio tokens. An estimate is a floor for those.

**Why:** estimates must be auditable and must never overwrite what a framework reported (requirement 4). Pricing at ingest keeps the SQL projection, the web `Projector`, recordings and replays consistent, because they all just sum `cost_usd`.
