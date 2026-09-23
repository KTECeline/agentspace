# CLAUDE.md

AgentSpace: an open-source, framework-agnostic live office for AI agent teams.
Full brief: `docs/BRIEF.md`. Status: `docs/PROGRESS.md`. Why things are the way they are: `docs/DECISIONS.md`.

## Working agreement
- One phase at a time. Propose a plan, wait for OK, build, then stop with tests passing, docs updated, a demo command.
- Conventional commits, one per working step, push after each commit (CI runs on push).
- Log every non-obvious choice in `docs/DECISIONS.md` (D-NNN).
- Before writing an adapter, read the framework's *current* docs and use its official hook/callback/tracing API.
