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
