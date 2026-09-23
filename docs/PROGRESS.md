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

## Phase 3: More adapters + OTLP + TS SDK (next)
Adapters for the Claude Agent SDK, CrewAI, the OpenAI Agents SDK and Claude Code hooks; OTLP ingest; TypeScript SDK; the remaining examples; per-adapter conformance tests.
