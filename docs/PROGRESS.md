# Progress

## Phase 1: Spec + Python SDK + collector + simple view ✅ (2026-09-24)

**Done-check:** `make demo-check` passes. It runs `docker compose up`, starts the example, confirms Manager, Triage and Engineer appear live, kills the collector mid-run, and confirms the example still finishes all runs with exit code 0.

- [x] Monorepo scaffold (pnpm + uv), Makefile, CLAUDE.md, DECISIONS.md, CI (Python 3.10/3.13, TypeScript, generated-types freshness, example-without-collector)
- [x] Event spec v0.1 (14 event types), OTel GenAI mapping, changelog, valid/invalid fixtures shared by the Python and TS tests
- [x] Type generation: TS (json-schema-to-typescript), pydantic v2 (datamodel-code-generator)
- [x] Python SDK core: `init`, `run`, `agent`, `step`, `emit`, `set_status`, `handoff`, `flush`, `stats`; sync + async; zero runtime dependencies
- [x] Fail-safe transport: bounded queue, background batching, backoff, drop-oldest, never raises or blocks
- [x] Privacy: `capture_content` opt-in, redaction hook
- [x] LangGraph adapter via the official global callback hook, with a golden conformance fixture
- [x] Collector: Fastify, SQLite (WAL), per-event validation, id de-dup, agent/run projections, REST, WebSocket snapshot + deltas, retention
- [x] 2D web view: team groups, agent cards (status, summary, tokens, cost, activity), filterable/pausable event log, run summary, loading/empty/offline states, light/dark
- [x] `examples/langgraph-dev-team` (Manager + Triage + Engineer) with `--fake`
- [x] Docker images + `docker-compose.yml`
- [x] Name reserved: `agentspace-sdk@0.0.1` published on PyPI and npm (2026-09-24; see `placeholders/README.md`, D-019)

**Test counts:** Python 34 (on 3.10 and 3.12 locally, 3.10/3.13 in CI) · collector 9 · web 6.

### Deferred or known gaps
- **Cost is always $0.** No SDK emits `cost_usd` yet; model price tables come with the cost dashboard (Phase 4).
- The web view hasn't been checked visually at phone width (the layout uses responsive grids).
- Status after a run ends is `done` for every agent in that run. When a new run starts, agents stay `done` until they act again.
- Docker images are about 400 MB each; slim them in Phase 5.
- No auth yet: the collector is open (Phase 4). Don't expose it to the internet.
- Python 3.10 + async LangGraph misses model and tool events inside nodes (D-013).

## Phase 2: The 3D office ✅ (2026-09-24)

**Done-check:** `make demo-check` passes. It starts the stack, checks that `/`, `/demo` and the bundled recording are served, runs the example live into a fresh workspace, kills the collector mid-run, and confirms the example still exits 0. In the browser, the three agents appear at their desks in an Engineering room, animate by status, and hand off with packets. Clicking an avatar opens the panel. `/demo` plays with no collector.

- [x] Data layer: zustand store with frame-batched updates; live, recorded and stress sources; client-side `Projector` checked against the collector's projections with a shared fixture
- [x] Brand: cozy low-poly style A (`brand.md`), warm light and dark tokens (all ≥ 4.5:1), Fredoka display font
- [x] Office auto-layout: fixed-size team rooms (6 desks), overflow rooms, and desks that never move once assigned
- [x] 3D scene: isometric camera (pan, zoom, fit), rooms, instanced furniture, bean avatars, distinct body colors
- [x] Status animations: breathe, bob, type, still, cheer, shake; monitor and desk-lamp status lights; `waiting_human` halo; dimmed waiting/blocked
- [x] Handoff packets (pooled, arcing); reduced motion turns off movement but keeps colors
- [x] Labels: one DOM layer for room plates, speech bubbles and name tags (no drei `<Html>`, D-022)
- [x] Agent panel: current step, tool calls, tokens, cost, model, live activity; Esc closes; focus moves into the panel
- [x] 3D/2D toggle (remembered), automatic 2D when WebGL is missing, keyboard-accessible agent roster over the canvas
- [x] `/demo` recorded mode, `make record`, and a "Watch a recorded demo" button on the empty office
- [x] Stress mode `/demo?stress=50&rate=100` with an FPS meter: **59–60 fps** (production build, MacBook Air)
- [x] Fixed a layout bug from Phase 1: on wide screens the page grew with the event log instead of fitting the viewport

**Test counts:** Python 34 · collector 10 · web 27.

### Deferred or known gaps
- **No README GIF yet.** Exporting a GIF from the browser needs a file download, which I didn't do without asking. The brief puts the 60-second GIF and the video in Phase 5, so for now the README uses screenshots.
- **Light mode hasn't been checked in the browser.** The dev machine is in dark mode. The light tokens pass the contrast checks, but I haven't seen the light 3D scene rendered.
- **Phone-width layout isn't visually checked** (the window resize didn't take effect in the automation browser).
- In live mode, a fresh page load orders desks by the collector's snapshot order (team, then id), not by when each agent actually first appeared. After that, desks are stable.
- Cost is still $0 (Phase 4).

## Phase 3: More adapters + OTLP + TS SDK ✅ (2026-09-24)

**Done-check:** `make demo-check` passes. It adds a step where an OpenTelemetry-only agent appears via OTLP. CI (12 jobs) is green: Python 3.10/3.13, one job per adapter, TypeScript, generated types, and every example running offline with no collector.

- [x] **OTLP ingest** `POST /v1/traces`:
  - JSON or protobuf (embedded protos), gzip;
  - GenAI spans become agents, LLM calls, tools, runs and handoffs;
  - child spans are held until their parent arrives;
  - idempotent, and content is dropped by default.
  - Tested against payloads recorded from the real OTel Python exporter.
- [x] **TypeScript SDK** `agentspace-sdk`:
  - same API as Python, using AsyncLocalStorage, a ring buffer and fetch;
  - never throws or blocks;
  - self-contained ESM + CJS with inlined types, verified with `npm pack`.
- [x] **OpenAI Agents SDK adapter** (TracingProcessor), with a golden conformance test using a scripted `Model`.
- [x] **CrewAI adapter** (event bus listener):
  - correct under CrewAI's thread-pool (out-of-order) delivery;
  - shuffled-replay test; golden test.
- [x] **Claude Agent SDK adapter**:
  - `instrument_options()` + `track()`: tools, subagents, permission waits, per-message usage, billed session cost;
  - `replay()` for recordings.
- [x] **Claude Code hooks**: `python -m agentspace.claude_code install` (stateless, silent, fail-open; metadata-only).
- [x] **Examples:** `crewai-research-desk`, `openai-agents-handoffs`, `claude-agent-sdk-support`, `otel-generic` (each with a README, `.env.example`, one command, and an offline mode).
- [x] **`/demo` scenario picker** with recordings of every example; the recorder sorts events by time.
- [x] **Per-framework uv dependency groups** (declared conflicting) and one CI job per adapter. The framework extras were removed, because CrewAI and the OpenAI Agents SDK need incompatible `openai` versions (D-026).

**Test counts:** Python 43 core, plus 5–9 per adapter group · TS SDK 14 · collector 18 · web 33.

### Deferred or known gaps
- **The Claude Agent SDK fixture and replay are synthetic.** They're built from the SDK's typed schemas, not captured from a live CLI. The real mode of that example hasn't been run end-to-end yet (no API key).
- **The Claude Code hooks haven't been tried in a live Claude Code session yet.** Unit and subprocess tests cover them. To try: `python -m agentspace.claude_code install`.
- **The Docker web image wasn't rebuilt at the end of this phase.** The network started intercepting TLS to registry.npmjs.org (a Fortinet certificate), so `pnpm install` inside Docker fails. The done-check passed with `SKIP_BUILD=1` on the existing images; CI isn't affected. Rebuild when you're on a network without TLS inspection, or add the Fortinet CA to the build.
- CrewAI crews always get their own run (their handlers run on CrewAI's threads, so an enclosing `agentspace.run()` isn't visible to them).
- The OTLP endpoint is on the collector's port 4800; the standard port 4318 isn't exposed yet.
- Cost is still mostly $0. Only the Claude Agent SDK reports billed cost; price tables come in Phase 4.

## Phase 4: Two-way control + replay + cost (next)
`request_approval` end to end (approve or reject from the office), pause/cancel, the replay timeline, the cost dashboard with model price tables, the Postgres option, and auth.
