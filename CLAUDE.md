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
| `web/` | Office UI | Next.js 16 (App Router), React 19, Tailwind v4 |
| `examples/langgraph-dev-team` | Example + `--fake` scripted model | uv project, path-dep on the SDK |
| `placeholders/` | 0.0.1 name-reservation packages (published by hand) | — |

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
