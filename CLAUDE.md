# CLAUDE.md

AgentSpace: an open-source, framework-agnostic live office for AI agent teams.
Full brief: `docs/BRIEF.md`. Status: `docs/PROGRESS.md`. Why things are the way they are: `docs/DECISIONS.md` (D-NNN).

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
| `packages/sdk-python` | SDK: distribution `agentspace-sdk`, import `agentspace`; `adapters/` | Python ≥3.10, uv, hatchling |
| `server/` | Collector: ingest, SQLite store, WS fan-out | Node 22, Fastify 5, better-sqlite3, Ajv |
| `web/` | Office UI (3D + 2D), `/demo` | Next.js 16 (App Router), React 19, Tailwind v4, react-three-fiber 9, drei 10, zustand 5 |
| `examples/langgraph-dev-team` | Example + `--fake` scripted model | uv project, path-dep on the SDK |
| `placeholders/` | 0.0.1 name-reservation packages (published; see D-019) | — |
| `brand.md` | Brand (style A, cozy low-poly): palette, type, motion, voice | — |

## Commands
```bash
make install | dev | test | lint | typecheck | gen-types | check-generated | up | down | demo | demo-check
cd packages/sdk-python && uv run pytest -q          # Python tests (~12 s)
pnpm --filter @agentspace/server test                # collector tests
pnpm --filter @agentspace/web test                   # web unit tests
```

## Architecture notes
- **Event flow:** SDK `emit()` → bounded deque → background thread → `POST /v1/events` (≤100/batch) → Ajv validation per event → SQLite `events` log + `agents`/`runs` projections in one transaction → WebSocket deltas (`events`, `agents`, `runs`). New browsers get a `snapshot`.
- **Context:** `contextvars` for run, agent and step (`agentspace/_context.py`). `parent_id` = the enclosing `step_id`.
- **LangGraph adapter:** registered globally via `langchain_core.tracers.context.register_configure_hook`. Node = a chain whose `name == metadata["langgraph_node"]`. End callbacks carry no name or metadata, so state is tracked by LangChain `run_id` (`_nodes` dict). Its golden fixture is `tests/fixtures/langgraph_dev_team.golden.json`: delete it, re-run the tests, review the diff.
- **Web data flow:** a source (`lib/sources/`: live WS, recorded file, stress generator) → `enqueue()` → applied once per animation frame → zustand `useOffice` store (pure reducer in `lib/state.ts`). Recordings and stress use `Projector` (`lib/projector.ts`), which must match the collector's SQL projections: both sides are tested against `spec/v0.1/examples/projection.expected.json`. If you change projection rules, change both sides and regenerate the fixture.
- **3D office** (`components/office/`): `layoutOffice()` is pure. Desks are assigned in first-seen order and never move; rooms have 6 desks. Static furniture is instanced (`Furniture.tsx`); `Workstation.tsx` holds only per-agent dynamic parts. Labels are one DOM layer (`Labels.tsx`) positioned by a single `useFrame` projector. Don't use drei `<Html>` (D-022). Per-status motion lives in `statusStyle.ts` (pure, tested).
- **Performance budget:** `/demo?stress=50` must stay at about 60 fps in a production build. Measure with the Docker image (`docker compose build web`); dev mode reads about 25% lower. Throttle DOM-heavy views with `useThrottled`; never subscribe a big component to `s.agents` without throttling.
- **Totals rule:** tokens and cost are summed over `llm.call` events only.
- **Privacy:** content fields are only filled when `capture_content=True`, via `Client.content(field, value)`, which applies redaction.
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
- `scripts/demo_check.sh` uses a fresh workspace per run; checks against `default` can pass on old data.
