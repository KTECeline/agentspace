# Phase 4 handoff

For the next Claude Code session. Read this file, then `CLAUDE.md`, `docs/PROGRESS.md`, and `docs/DECISIONS.md` from D-030 on.

## Status as of 2026-09-24

| | Status |
|---|---|
| Phases 1–3 | Done and approved |
| Phase 4a (store interface, auth, approvals, pause/cancel) | **Built and pushed, CI green. Waiting for the user's review.** Don't start 4b until the user says so. |
| Postgres backend (part of 4a) | **Deferred** by the user (2026-09-24) until npm is reachable |
| Phase 4b (pricing + cost dashboard, replay, examples, docs) | **Built and pushed 2026-09-24; waiting for the user's review.** Decisions D-037 to D-040; the next entry is D-041. See PROGRESS.md. |

## Working agreement (from the user; applies every phase)

- One phase at a time. **Propose a plan, wait for OK**, build, then stop with tests passing, docs updated and a demo command.
- Conventional commits, one per working step, **push after each**. End each commit message with the attribution line your session gives you.
- Update `docs/PROGRESS.md`, `docs/DECISIONS.md` (the next entry is **D-037**) and `CLAUDE.md`.
- Before writing adapter code, read the framework's *current* docs or installed source, and use its official hooks. Never monkeypatch.
- **Ask about architecture decisions** instead of guessing.

## The user's Phase 4 requirements (verbatim, still binding)

> All A (long-poll HTTP controls, cancel raises at safe points, collector-side price table, API keys + operator token + public read-only mode), with these changes:
> 1. agentspace.Cancelled must subclass BaseException (like asyncio.CancelledError) so `except Exception` can't swallow it. Add init(cancel_mode="raise"|"flag"), default "raise".
> 2. Approvals fail closed: if the collector is unreachable or it times out, return rejected/timeout, never hang or approve. Resolve is idempotent (second resolve = 409, no duplicate event).
> 3. Public read-only mode hides approval payloads (show reason only).
> 4. Costs carry source: "estimated" (price table) vs "reported" (framework). Price table has an as_of date + source URL per model; UI shows "est." for estimated.
> 5. Do not commit any corporate CA cert. If needed, make it an optional local build arg, documented in CONTRIBUTING, off by default.
>
> Split Phase 4: stop after 4a (store refactor/Postgres interface, auth, approvals, pause/cancel) for my review, then 4b (pricing + dashboard, replay, examples, docs).

Items 1, 2, 3 and 5 are done in 4a. **Item 4 is 4b work.**

## Hard constraints

- **Secrets:** API keys live in the repo root `.env` (gitignored): an OpenRouter key and an Anthropic key. Never print, paste, log or commit them.
- **Budget:** the user has about $10 on OpenRouter and $5 on Anthropic. **Test with fakes first.** Only make a real call when it's truly needed, keep it minimal, and prefer OpenRouter:
  - `ANTHROPIC_BASE_URL=https://openrouter.ai/api`
  - `ANTHROPIC_AUTH_TOKEN=<openrouter key>`
  - `ANTHROPIC_API_KEY=""`
  - model `claude-haiku-4-5`
  - Report the cost of any real run.
- **Never disable TLS verification.** Never commit a certificate (`.gitignore` ignores `*.pem`, `*.crt` and `*.key`).
- **Approvals must always fail closed.** The Python SDK has zero runtime dependencies. SDK calls never raise into user code, except `Cancelled`, which is raised on purpose.
- **Browser automation must not type tokens or passwords into fields.** To check the operator UI by hand, run a collector without auth (see "Verify").

## What 4a delivered (with file pointers)

**Spec**
- `run.control` event (`action`: pause | resume | cancel, optional `by`), D-030. See `spec/v0.1/event.schema.json` and `spec/CHANGELOG.md`.

**Collector** (`server/src/`)
- `store/types.ts`: the async `Store` interface.
- `store/sqlite.ts`: `SqliteStore`, with an `approvals` table, a `runs.control` column, and approval expiry.
- `store/index.ts`: `createStore()` picks Postgres for `postgres://` URLs.
- `store/postgres.ts`: **a placeholder that throws.**
- Contract suite: `tests/store.test.ts`. It runs against Postgres when `TEST_DATABASE_URL` is set and calls `reset()`.
- `auth.ts` (D-032):
  - `AGENTSPACE_API_KEYS=ws:key,…`, where `*` means every workspace;
  - `AGENTSPACE_OPERATOR_TOKEN`;
  - `AGENTSPACE_PUBLIC_READONLY`;
  - constant-time token comparison.
- `app.ts`:
  - `GET /v1/info`;
  - approvals: list, get with `?wait=` long-poll, and `POST …/resolve` (200/404/409/400);
  - `POST …/runs/:id/control` and `GET …/controls?runs=&wait=`;
  - WebSocket auth via the first message `{"type":"auth","token"}`, closing with 4401 when it fails;
  - in public mode, `redactEvent`/`redactApproval` strip payloads on every read path;
  - the ingest response carries `controls`.

**Python SDK** (`packages/sdk-python/agentspace/_control.py`, D-033)
- `request_approval` / `request_approval_sync`, which fail closed.
- `Cancelled(BaseException)`, `init(cancel_mode=)`.
- `checkpoint`, `acheckpoint`, `is_cancelled`, `adapter_checkpoint`, `adapter_acheckpoint`, `raise_if_cancelled`.
- Scope safe points: `step` checkpoints before it starts. `agent` checkpoints just after registering, so a pause shows on its own desk.
- A cancelled run finishes as `"cancelled"` with no error event.
- Controls reach the SDK in the ingest response, through a 2 s poll of recently active runs, and through a long-poll while paused.

**Adapters** (D-034)
- **LangGraph:** safe points at node, model and tool start. `adapters.langgraph.request_approval_sync` binds the approval to the calling node, found through LangChain's `var_child_runnable_config`.
- **OpenAI Agents:** cancel is raised in `on_span_start`. Pausing needs `hooks=ControlHooks()`.
- **CrewAI:** `step_callback=step_checkpoint`, which closes the run itself on cancel.
- **Claude Agent SDK:**
  - the PreToolUse gate has a 3600 s matcher timeout; on cancel it denies the tool with `continue_=False`;
  - `approval_callback()` is a fail-closed `can_use_tool`.

**TypeScript SDK** (`packages/sdk-ts/src/control.ts`)
- `requestApproval`, `checkpoint`, `Cancelled`/`isCancelled`, `cancelMode`, `runCancelled`.
- Also fixed an older transport bug: after draining an empty queue it never sent again.

**Web** (D-035)
- `lib/collector.ts` (REST client plus the token in localStorage).
- `components/operator/`: `Approvals.tsx`, `RunControls.tsx`, `TokenDialog.tsx`.
- Approvals tab and header pill, pending approvals in the agent panel, pause/resume/cancel with a two-step cancel, a private-office screen on 4401, and a read-only badge.
- The live source goes "live" on the first message, and retry detaches the old socket.

**Example and checks**
- `examples/langgraph-dev-team`: `--approve` makes the Engineer ask before writing files.
- `scripts/controls_check.sh`: approve over REST, a 409 on the second resolve, then pause, resume and cancel. `demo_check.sh` runs it.

**Build**
- Optional `EXTRA_CA_CERT` build arg, taken from compose's `AGENTSPACE_EXTRA_CA_CERT`. It's used only by the build stage's install/build steps. Documented in `CONTRIBUTING.md` (D-036).

**Test counts:** Python 60 core, plus 8–12 per adapter group · TS SDK 26 · collector 30 · web 41. All 12 CI jobs are green.

## Open decisions (ask the user)

1. **Postgres.** npm is TLS-intercepted by Fortinet (`registry.npmjs.org`), so the `pg` driver can't be installed on the host or in Docker. The proxy doesn't send its CA in the chain, and the CA isn't in the macOS keychain. Options:
   - (a) build on another network;
   - (b) the user provides the Fortinet root CA as a local file outside the repo, used via `NODE_EXTRA_CA_CERTS`;
   - (c) defer.

   Once unblocked, three pieces of work remain:
   - `PostgresStore`, which must pass the existing contract suite;
   - a compose `postgres` profile;
   - a CI job with a Postgres service and `TEST_DATABASE_URL`.
2. Anything the user raises when reviewing 4a.

## Known gaps carried forward

- The Docker images couldn't be rebuilt (npm blocked), so the full `make demo-check` wasn't re-run with 4a images. `SKIP_BUILD=1` reuses old images, which lack 4a.
- The CA build arg hasn't been tested end to end (both Dockerfiles pass `docker build --check`).
- For about a second while the 3D scene mounts, the labels bunch up in the top-left corner. This predates Phase 4.
- The OTLP endpoint is on port 4800; port 4318 isn't exposed yet.
- CrewAI crews always get their own run.

## Phase 4b scope (plan this and get the user's OK first)

From `docs/BRIEF.md` plus requirement 4:

1. **Pricing (collector side).**
   - A versioned price table per model: input and output price per million tokens, plus cache read/write where relevant, **`as_of` date and `source` URL per model**. Check current official pricing pages; don't guess.
   - Pricing happens at ingest for `llm.call` events that have tokens but no cost.
   - **Every cost carries `source: "estimated" | "reported"`.** Reported means the framework gave it (e.g. Claude Agent SDK `total_cost_usd`), and it's never overwritten.
   - This needs an additive spec change (e.g. a `cost_source` envelope field) or a projection-only field. That's a D-037 decision; propose it. If the spec changes, run `make gen-types`.
   - Totals must stay correct when estimated and reported costs are mixed. The totals rule is: sum over `llm.call` only.
   - Also update the web `Projector` and `projection.expected.json` (the SQL projection and the web projector must match).
2. **UI shows "est."** wherever an estimated cost appears: run summary, agent panel, dashboard.
3. **Cost dashboard:**
   - cost per run, agent and model; latency; error rate; slowest tools;
   - REST aggregate endpoints;
   - public mode must not leak payloads.
4. **Replay:**
   - a timeline scrubber at 1x/4x/16x, with jump to errors and handoffs;
   - uses the stored run events (`GET …/runs/:id/events` exists) through the existing `Projector`/recorded-source path;
   - `run.control` and approvals should show on the timeline.
5. **Examples:** approvals and controls in more examples (e.g. the Claude Agent SDK example with `approval_callback`, CrewAI with `step_checkpoint`). Keep every example runnable offline (`--fake`/`--replay`), and refresh the `/demo` recordings if needed (`make record`).
6. **Docs:** README sections for cost and replay, PROGRESS, DECISIONS, CLAUDE.md.

## Verify (commands)

```bash
make test && make lint typecheck
cd packages/sdk-python && VIRTUAL_ENV= uv run --group crewai pytest -q tests/test_crewai_adapter.py   # one group at a time
# Collector without auth, for UI checks by hand (don't use 4800; docker holds it):
cd server && PORT=4810 AGENTSPACE_DB=/tmp/x.db pnpm -s exec tsx src/index.ts
cd web && pnpm exec next dev -p 4811   # open http://localhost:4811/?collector=http://localhost:4810
AGENTSPACE_URL=http://localhost:4810 scripts/controls_check.sh
```

Environment gotchas: always run uv with `VIRTUAL_ENV=`. There's no `timeout` command on this Mac. The framework groups conflict, so sync them one at a time and run `VIRTUAL_ENV= uv sync` afterwards.
