# AgentSpace — Project Brief

> The original kickoff brief. Claude Code re-reads this at the start of every phase.
> "AgentSpace" is a placeholder name.

## Role & goal

You are the lead engineer on **AgentSpace**: an open-source, framework-agnostic **live office for AI agent teams**. Developers add two lines of code to their existing multi-agent app (LangGraph, CrewAI, Claude Agent SDK, OpenAI Agents SDK, or any OpenTelemetry source). AgentSpace then shows every agent working in a **3D office**: who is thinking, which tool is running, who handed work to whom, what it cost, and where a human needs to approve something. Every run can be replayed.

This is a portfolio project for an AI engineer, and a real dev tool meant to earn users and GitHub stars. Optimize for:
1. **Two-minute setup.** `pip install`, one `init()` call, one `docker compose up` (or `npx`), and the office is live.
2. **Framework-agnostic.** One open event spec, thin adapters, built on OpenTelemetry GenAI conventions where possible.
3. **Two-way, not just a viewer.** Humans can approve, reject, or pause agents from the office, and the decision flows back into the running agent.
4. **Low overhead and reliable.** Instrumentation never crashes or slows the host app. Measure it and publish the numbers.
5. **A great first impression.** The README GIF, live demo site, and docs should make a developer want to try it.

## How to work with me

- Before writing code, give me a short plan for the current phase and wait for my OK.
- Work **one phase at a time**. At the end of each phase: run the tests, update the README and `docs/PROGRESS.md`, and give me a short summary and a demo command. Then stop.
- Create and keep up to date a `CLAUDE.md` with conventions, commands, and architecture notes.
- **Framework APIs change often.** Before writing each adapter, check that framework's current docs and use its official callback/hook/tracing extension points. Never monkey-patch internals if an official hook exists.
- Prefer simple, well-known tools. Don't add a dependency without a reason.
- If something is ambiguous, ask. Don't guess on architecture decisions.
- Commit after each working step, using clear conventional commit messages.

## Architecture

```
 user's agent app                      AgentSpace
┌──────────────────────┐   events   ┌──────────────────┐  websocket  ┌────────────────┐
│ LangGraph / CrewAI / │──(HTTP or──▶│ Collector server │────────────▶│ Web: 3D office │
│ Claude SDK / OpenAI  │   OTLP)    │ store + fan-out  │◀────────────│ panels, replay │
│ + agentspace SDK     │◀───────────│ approvals API    │  approvals  └────────────────┘
└──────────────────────┘ approvals  └──────────────────┘
```

### 1. Event spec (the core of the product)

- Define it in **JSON Schema** in `spec/`, versioned (`v0.1`). Generate the Python (pydantic) and TypeScript types from it. The schema is the single source of truth.
- Core entities: `workspace` → `team` (becomes a department zone in the office) → `agent` → `run` → `step`.
- Event types: `agent.registered`, `agent.status` (`idle | thinking | using_tool | waiting | blocked | waiting_human | done | error`), `llm.call`, `tool.call`, `tool.result`, `message`, `handoff`, `approval.requested`, `approval.resolved`, `run.started`, `run.finished`, `error`.
- Every event carries: `run_id`, `agent_id`, `team_id`, `ts`, `parent_id`, and optional `tokens_in`, `tokens_out`, `cost_usd`, `model`, `summary` (short, human-readable).
- **Map to the OpenTelemetry GenAI semantic conventions.** Check the current spec. The collector must also accept plain OTLP traces from any OTel-instrumented agent and convert them.
- **Privacy:** by default, record summaries and metadata but not full prompts and outputs. Add a `capture_content=True` opt-in and a redaction hook.

### 2. SDKs

- **Python** (`packages/sdk-python`, published as `agentspace`):
  - `agentspace.init(url=..., workspace=...)`, which auto-detects installed frameworks and turns on their adapters.
  - Manual API: `@agentspace.agent(team="research")`, `with agentspace.step("..."):`, `agentspace.emit(...)`.
  - `await agentspace.request_approval(reason, payload, timeout=...)` blocks the agent until a human decides in the office.
  - Non-blocking: a background batching queue, bounded memory, drops with a warning if the collector is down, **never raises into user code**.
- **TypeScript** (`packages/sdk-ts`, Phase 3): same API shape.
- **Adapters** (one module each, using official extension points): LangGraph/LangChain callbacks, Claude Agent SDK hooks, CrewAI event listeners, OpenAI Agents SDK tracing processor, Claude Code hooks (fun bonus: watch your own coding sessions).

### 3. Collector server (`server/`)

- **TypeScript (Node, Fastify)**, sharing generated types with the web app.
- Ingest: `POST /v1/events` (batch) and an OTLP/HTTP endpoint.
- Storage: **SQLite by default** (no setup), **Postgres** optional via env var. Retention settings.
- WebSocket fan-out per workspace. REST for runs, replay, cost, and approvals.
- Auth: an API key per workspace, and a read-only public mode for demo sites.

### 4. Web app (`web/`)

- **Next.js + TypeScript + Tailwind**, **react-three-fiber** for the office.
- **Office auto-layout:** each `team` gets a room or desk cluster, generated automatically from the agents that register. No manual config.
- **Avatars:** original, low-poly, stylized. Animation and status bubble follow `agent.status`. On `handoff`, an avatar walks over or a visible "packet" flies between desks. Agents waiting on a human glow.
- **Agent panel:** click an avatar to see its current step, a live log, tool calls, tokens, cost, and model.
- **Approvals inbox and in-scene prompts:** approve or reject with a comment, and the decision goes back to the SDK.
- **Replay:** timeline scrubber at 1x/4x/16x speed. Jump to errors or handoffs.
- **Dashboard:** cost per run/agent/model, latency, error rate, slowest tools.
- **Performance:** smooth at 50 agents and 100 events/sec. Add a low-power 2D fallback view.

### 5. Examples (these prove the tool works)

- `examples/langgraph-dev-team`: a Manager + Triage + Engineer + QA team fixing seeded bugs in a small demo app.
- `examples/crewai-research-desk`: a research crew writing a report.
- `examples/claude-agent-sdk-support`: a support-desk team with a human approval step.
- `examples/otel-generic`: any OTel-instrumented agent showing up in the office.
- Each example: a README, a `.env.example`, and one run command. Also a **recorded mode** that replays saved events with no API key, for the public demo.

## Repo structure

```
agentspace/
├── CLAUDE.md
├── README.md                  # GIF first, then 2-line quickstart, then features
├── docker-compose.yml         # server + web (SQLite); optional postgres profile
├── Makefile                   # dev, test, gen-types, bench, demo
├── spec/                      # JSON Schema event spec + changelog
├── packages/
│   ├── sdk-python/
│   │   ├── agentspace/        # core client, queue, approvals, adapters/
│   │   └── tests/             # incl. per-adapter conformance tests
│   └── sdk-ts/
├── server/
│   ├── src/                   # ingest, otlp, store, ws, approvals, auth
│   └── tests/
├── web/
│   ├── app/                   # office, runs, replay, dashboard
│   ├── components/office/     # r3f scene, layout engine, avatars
│   └── components/panels/
├── examples/
├── bench/                     # SDK overhead + UI load benchmarks
├── docs/                      # docs site content (quickstart, spec, adapters)
│   ├── BRIEF.md               # this file
│   ├── PROGRESS.md
│   └── DECISIONS.md           # short records of why each choice was made
└── .github/workflows/         # CI, release to PyPI/npm, docker image
```

## Phases

**Phase 1: Spec + Python SDK + collector + a simple view**
- Monorepo scaffold, CI, `CLAUDE.md`, JSON Schema `v0.1` and type generation.
- Python SDK core (manual API, batching queue, fail-safe) and the **LangGraph adapter**.
- Collector with SQLite, batch ingest, and WebSocket fan-out.
- A **simple 2D web view**: agent cards grouped by team, with live status and an event log. This is the debug view and later the low-power fallback.
- `examples/langgraph-dev-team`, minimal version (Manager + 2 agents).
- **Done when:** `docker compose up` plus running the example shows the agents updating live, and killing the collector doesn't crash the example.

**Phase 2: The 3D office**
- r3f scene, auto-layout, avatars, status animations, handoff visuals, agent panel. Recorded demo mode.

**Phase 3: More adapters + OTLP + TS SDK**
- Claude Agent SDK, CrewAI, OpenAI Agents SDK, Claude Code hooks, OTLP ingest, TypeScript SDK, the remaining examples, and per-adapter conformance tests.

**Phase 4: Two-way control + replay + cost**
- `request_approval` end to end, pause/cancel, replay timeline, cost dashboard, Postgres option, auth.

**Phase 5: Benchmarks + launch**
- `bench/`: SDK overhead per event (target < 1 ms at p99, non-blocking) and UI load (50 agents, 100 events/sec). Publish the results in the README.
- Publish to PyPI and npm, docker image, docs site, a public demo site in read-only replay mode, and a 60-second GIF plus a 2-minute video.
- Write `docs/LAUNCH.md` with draft posts for Show HN, r/LocalLLaMA, and X/LinkedIn.

## Quality bar

- Python: type hints, `ruff`, `mypy`, `pytest`. TypeScript: strict mode, ESLint, Vitest.
- Adapters are tested with recorded fixtures (no live LLM calls in CI).
- The SDK must never throw into user code or block the event loop. Test this explicitly.
- Semantic versioning. The spec changelog is kept up to date. No secrets in git.

## "Next phase" prompt (reuse for each phase)

> Read `CLAUDE.md`, `docs/BRIEF.md`, and `docs/PROGRESS.md`. Phase N is next. Propose a plan for Phase N, wait for my OK, then build it. Finish with tests passing, docs updated, a demo command, and a short summary.
