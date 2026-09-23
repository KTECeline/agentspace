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
- [x] Placeholder `agentspace@0.0.1` for PyPI and npm (the maintainer publishes them; see `placeholders/README.md`)

**Test counts:** Python 34 (on 3.10 and 3.12 locally, 3.10/3.13 in CI) · collector 9 · web 6.

### Deferred or known gaps
- **Cost is always $0.** No SDK emits `cost_usd` yet; model price tables come with the cost dashboard (Phase 4).
- The web view hasn't been checked visually at phone width (the layout uses responsive grids).
- Status after a run ends is `done` for every agent in that run. When a new run starts, agents stay `done` until they act again.
- Docker images are about 400 MB each; slim them in Phase 5.
- No auth yet: the collector is open (Phase 4). Don't expose it to the internet.
- Python 3.10 + async LangGraph misses model and tool events inside nodes (D-013).

## Phase 2: The 3D office (next)
r3f scene, auto-layout per team, avatars and status animations, handoff visuals, agent panel, recorded demo mode.
