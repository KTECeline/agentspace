# CLAUDE.md

AgentSpace: an open-source, framework-agnostic live office for AI agent teams.
Full brief: `docs/BRIEF.md`. Status: `docs/PROGRESS.md`. Why things are the way they are: `docs/DECISIONS.md` (D-NNN).
Current phase: **6, debug and oversee** (D-042): inspector, run comparison, deterministic detectors, escalate-only oversight policy, failure-story demo.

## Working agreement
- One phase at a time: propose a plan, wait for OK, build, then stop with tests passing, docs updated and a demo command.
- Conventional commits, one per working step, pushed after each commit (CI runs on push). The repo is private until launch.
- Log every non-obvious choice in `docs/DECISIONS.md`.
- Before writing an adapter, read the framework's *current* docs or installed source, and use its official hook/callback/tracing API. Never monkey-patch.
- Don't add a dependency without a reason. The Python SDK has **zero** runtime dependencies (D-008).

## Layout
| Path | What | Stack |
|---|---|---|
| `spec/v0.1/event.schema.json` | Event spec: **single source of truth** | JSON Schema 2020-12 |
| `packages/spec-types` | Generated TS types + hand-written API types (`src/api.ts`) + schema copy | TS source, no build |
| `packages/sdk-python` | SDK: distribution `agentspace-sdk`, import `agentspace`; `adapters/` (langgraph, openai_agents, crewai, claude_agent_sdk), `claude_code.py` (hook command) | Python ≥3.10, uv, hatchling |
| `packages/sdk-ts` | TS SDK, npm `agentspace-sdk` (same API, callback scopes) | TS, tsup, vitest; no runtime deps |
| `server/` | Collector: ingest, OTLP (`src/otlp/`), pricing (`src/pricing/`), `Store` interface (`src/store/`: SQLite; Postgres deferred; `stats.ts` aggregates), auth (`src/auth.ts`), approvals + run controls, WS fan-out | Node 22, Fastify 5, better-sqlite3, Ajv, protobufjs |
| `web/` | Office UI (3D + 2D), `/demo`, `/replay`, `/dashboard` (costs) | Next.js 16 (App Router), React 19, Tailwind v4, react-three-fiber 9, drei 10, zustand 5 |
| `examples/*` | langgraph-dev-team, crewai-research-desk, openai-agents-handoffs, claude-agent-sdk-support (`--replay`), otel-generic | one uv project each, path-dep on the SDK |
| `placeholders/` | 0.0.1 name-reservation packages (published; see D-019) | — |
| `brand.md` | Brand (style A, cozy low-poly): palette, type, motion, voice | — |
| `bench/` | SDK overhead benchmarks (`sdk_overhead.py`, `.mjs`) + results; UI load procedure | stdlib / Node only |
| `web/content/docs/` | Docs site pages (Markdown, rendered at `/docs` by `web/lib/docs/markdown.ts`) | — |
| `docs/LAUNCH.md`, `docs/launch/` | Launch checklist, draft posts, video storyboard, manual test | — |

## Commands
```bash
make install | dev | test | lint | typecheck | gen-types | check-generated | up | down | demo | demo-check
python3 scripts/version.py show|set|check   # one version for every package (release.yml checks it)
scripts/check_public_demo.sh <url>            # verify a public demo deployment
cd packages/sdk-python && uv run pytest -q          # Python tests (~15 s); add --group <framework> for adapters
pnpm --filter agentspace-sdk test                    # TS SDK tests
pnpm --filter @agentspace/server test                # collector tests
pnpm --filter @agentspace/web test                   # web unit tests
```

## Architecture notes
- **Event flow:** SDK `emit()` → bounded deque → background thread → `POST /v1/events` (≤100/batch) → Ajv validation per event → SQLite `events` log + `agents`/`runs` projections in one transaction → WebSocket deltas (`events`, `agents`, `runs`). New browsers get a `snapshot`.
- **Context:** `contextvars` for run, agent and step (`agentspace/_context.py`). `parent_id` = the enclosing `step_id`.
- **LangGraph adapter:** registered globally via `langchain_core.tracers.context.register_configure_hook`. Node = a chain whose `name == metadata["langgraph_node"]`. End callbacks carry no name or metadata, so state is tracked by LangChain `run_id` (`_nodes` dict). Its golden fixture is `tests/fixtures/langgraph_dev_team.golden.json`: delete it, re-run the tests, review the diff.
- **Web data flow:** a source (`lib/sources/`: live WS, `ReplayPlayer` for recordings and stored runs, stress generator) → `enqueue()` → applied once per animation frame → zustand `useOffice` store (pure reducer in `lib/state.ts`). Replays, recordings and stress use `Projector` (`lib/projector.ts`), which must match the collector's SQL projections: both sides are tested against `spec/v0.1/examples/projection.expected.json`. If you change projection rules, change both sides and regenerate the fixture.
- **3D office** (`components/office/`): `layoutOffice()` is pure. Desks are assigned in first-seen order and never move; rooms have 6 desks. Static furniture is instanced (`Furniture.tsx`); `Workstation.tsx` holds only per-agent dynamic parts. Labels are one DOM layer (`Labels.tsx`) positioned by a single `useFrame` projector. Don't use drei `<Html>` (D-022). Per-status motion lives in `statusStyle.ts` (pure, tested).
- **Performance budget:** `/demo?stress=50` must stay at about 60 fps in a production build. Measure with the Docker image (`docker compose build web`); dev mode reads about 25% lower. Throttle DOM-heavy views with `useThrottled`; never subscribe a big component to `s.agents` without throttling.
- **Adapters:** one module per framework, each using that framework's official hook: LangChain `register_configure_hook`, the OpenAI Agents `add_trace_processor`, the CrewAI `BaseEventListener`, and Claude Agent SDK `hooks=` (opt-in). `adapters/__init__.py:ADAPTERS` lists the ones `init()` auto-enables. Every handler catches its own errors. Each adapter has a scripted/replayed conformance test (`tests/test_*_adapter.py`) that skips when its framework isn't installed.
- **OTLP:** `server/src/otlp/` (decode → assembler). Spans become events on span end; non-agent spans wait for their parent (hold). Event ids come from span ids.
- **Totals rule:** tokens and cost are summed over `llm.call` events only. `cost_estimated_usd` and `unpriced_calls` come from the same events (`usageOf` in `server/src/store/sqlite.ts` and `web/lib/projector.ts`).
- **Pricing (D-037/038):** the collector prices an `llm.call` at ingest only when it has tokens and neither `cost_usd` nor `cost_source`. The table is `server/src/pricing/prices.json` (`as_of` + official `source` per model). Copy prices from the source page, never guess. `cost_source: "reported"` with no cost means "billed on another event" (the Claude Agent SDK's per-message calls).
- **Replay (D-040):** `lib/replay.ts` is pure (timeline, markers, `snapshotAt`). Seeking re-projects from the start and sends one snapshot; agents are ordered by first appearance so desks never move. The player is in the store (`player`) and drives `components/replay/ReplayBar.tsx`.
- **Dashboard (D-039):** `/dashboard` reads `GET …/stats`. Stores return raw rows; `computeStats()` (`server/src/store/stats.ts`) groups them, so every backend matches. Chart colors are the `--chart-*` tokens (validated with the dataviz palette checker against both surfaces).
- **Public demo (D-041):** `AGENTSPACE_PUBLIC_DEMO=1` (or `web/vercel.json` on Vercel) redirects `/`, `/dashboard` and `/replay` to `/demo` and sets a CSP with `connect-src 'self'`. The web app must never gain API routes or server actions: the public demo relies on there being nothing to call.
- **Docs:** add a page by writing `web/content/docs/<slug>.md` and listing it in `web/lib/docs/nav.ts`. The parser never passes raw HTML through; keep it that way.
- **Releases:** only on `v*` tags (`.github/workflows/release.yml`, `docs/RELEASING.md`). CI runs gitleaks over the full history; never commit keys, `.env` files or personal data (recordings too).
- **Privacy:** content fields are only filled when `capture_content=True`, via `Client.content(field, value)`, which applies redaction.
- **Two-way control (D-033/034):** approvals and pause/cancel go SDK → `approval.requested` event → the collector's `approvals` table → an operator resolves (REST) → the SDK long-polls `GET …/approvals/:id?wait=`. Controls reach the SDK via the ingest response's `controls` field plus a 2 s poll; while paused, it long-polls `…/controls`. Python logic is in `agentspace/_control.py`, TS in `src/control.ts`. `Cancelled` is a `BaseException`, raised only at safe points. Approvals must always fail closed. Resolve/control run as single store transactions with a deterministic event id.
- **Auth (D-032):** `server/src/auth.ts`. Nothing configured means open. Public read-only mode strips approval payloads on every read path (`redactEvent`/`redactApproval` in `app.ts`); new read paths must use them too.
- **SDK safety rule:** every public entry point catches its own exceptions (`internal_error()`), but user exceptions always propagate unchanged. New code on the hot path must stay O(1) and non-blocking. `tests/test_reliability.py` enforces this.

## Conventions
- Python: ruff (line length 100), mypy strict, `from __future__ import annotations`, no 3.11+ syntax.
- TS: strict with `noUncheckedIndexedAccess`, ESM, shared root `eslint.config.js`.
- Web: every color comes from CSS tokens in `app/globals.css` (light and dark). Status colors are set via `data-status`. Use real `<button>`s with visible focus rings, provide loading/empty/error states, and wrap animation in `prefers-reduced-motion`.
- Generated files (`packages/spec-types/src/generated.ts`, `schema.json`, `agentspace/models/_generated.py`) are never hand-edited. Run `make gen-types`.

## Gotchas
- The dev shell exports `VIRTUAL_ENV` for another toolchain. The Makefile runs uv with `VIRTUAL_ENV=` so it uses the project `.venv`.
- Port 3000 is often taken on the dev machine. The web app uses **4801**, the collector **4800**.
- `web` typecheck needs `next typegen` first (it provides the global `PageProps`/`LayoutProps`). The `typecheck` script does this.
- pnpm: `better-sqlite3` is in `ignoredBuiltDependencies` on purpose. v13 ships prebuilt binaries, and running its install script needs python and node-gyp (it broke the Docker build).
- `web/AGENTS.md` is re-created by `next dev`; keep it committed.
- Python 3.10 + `ainvoke`: LangGraph doesn't propagate callbacks into calls inside nodes (D-013).
- `docker compose up` holds port 4801. Stop the web container (`docker compose stop web`) before `pnpm dev` in `web/`.
- ESLint runs the React Compiler rules (`eslint-plugin-react-hooks` v7): no `performance.now()` or ref reads during render, no setState in effects. For r3f, read the camera via `useThree(s => s.get)().camera` inside effects instead of mutating a hook value.
- zustand selectors must return stable values: `useShallow` over arrays of *new* tuples or objects loops forever. Select the record, then `useMemo`.
- `scripts/demo_check.sh` uses a fresh workspace per run; checks against `default` can pass on old data. `SKIP_BUILD=1` reuses existing images.
- Python framework work: `uv sync --group openai-agents|crewai|claude-agent-sdk` (one at a time; the groups conflict on purpose). The CrewAI group has a `python_version < '3.14'` marker. After changing the SDK's `pyproject.toml`, re-lock each example (`uv lock` in `examples/*`) or the CI example jobs fail on `--locked`.
- CrewAI calls handlers on a thread pool, so tests must `crewai_event_bus.flush()` and must not assume order.
- The dev network may intercept TLS to registry.npmjs.org (Fortinet). Docker `pnpm install` then fails; never work around it by disabling TLS verification.
- Browser automation can't type tokens. To check the web operator UI by hand, run a collector without auth (`PORT=4810 AGENTSPACE_DB=/tmp/x.db pnpm -s exec tsx src/index.ts` in `server/`) and open `/?collector=http://localhost:4810`. `scripts/controls_check.sh` covers the token path.
- Don't coalesce UI work with `requestAnimationFrame` alone: it doesn't run in background tabs (and runs rarely in the browser-automation window). The store's frame queue falls back to a timer; replay seeks use a timer.
- `pg` (Postgres store) isn't installed yet: npm is blocked by the TLS intercept. `src/store/postgres.ts` is a placeholder that throws.
