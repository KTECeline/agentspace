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

## Phase 4a: Store interface, auth, approvals, pause/cancel ✅ (2026-09-24; cleared to continue, hands-on test pending)

**Done-check:** `scripts/controls_check.sh` passed against a local collector, both open and with an operator token. It covers:
- the example's Engineer asks for approval, which is approved over REST, and the run finishes;
- a second resolve returns 409 with no duplicate event;
- pause shows the agent blocked, resume clears it;
- cancel stops the example cleanly, with run status "cancelled".

`demo_check.sh` now runs it. The full Docker done-check wasn't re-run, because Docker can't rebuild the images while npm is TLS-intercepted (see below).

I also checked by hand in the browser against a live collector:
- inbox → approve with comment → agent continues;
- pause → resume → cancel;
- private-office screen on 4401;
- public mode hides the payload and all controls.

- [x] **Spec:** `run.control` event (D-030).
- [x] **Collector:**
  - async `Store` interface plus a contract suite (D-031); `SqliteStore`;
  - `approvals` table and `runs.control`;
  - atomic, idempotent resolve (409; deterministic event id);
  - approvals expire into `timeout`.
- [x] **Auth** (D-032): workspace API keys, operator token, public read-only mode (payloads stripped everywhere), WebSocket first-message auth, `GET /v1/info`.
- [x] **REST:**
  - approvals list, get, and long-poll (`?wait=`), resolve;
  - run control (pause/resume/cancel);
  - controls long-poll for SDKs.
- [x] **Python SDK** (D-033):
  - `request_approval` / `request_approval_sync` (fail closed);
  - `Cancelled(BaseException)`, `init(cancel_mode=)`;
  - `checkpoint` / `acheckpoint` / `is_cancelled`; scope safe points.
- [x] **Adapters** (D-034):
  - LangGraph (auto, plus `request_approval_sync` bound to the node);
  - OpenAI Agents (auto cancel, plus `ControlHooks` for pause);
  - CrewAI (`step_checkpoint`);
  - Claude Agent SDK (PreToolUse gate, plus `approval_callback()`).
- [x] **TypeScript SDK:** `requestApproval`, `checkpoint`, `Cancelled`/`isCancelled`, `cancelMode`. Also **fixed a transport bug**: after a drain found an empty queue, the SDK never sent again.
- [x] **Web** (D-035): Approvals tab and header pill, approve/reject with comment, pending approvals in the agent panel, pause/resume/cancel, operator token dialog, private-office screen, read-only badge.
- [x] **Example:** `langgraph-dev-team --approve` (the Engineer asks before writing files).
- [x] **Optional CA build arg** + CONTRIBUTING.md (D-036).

**Test counts:**
- Python 60 core, plus 8–12 per adapter group
- TS SDK 26
- collector 30
- web 41

### Deferred or known gaps
- **The Postgres store isn't implemented yet, and it's deferred** (the user's call, 2026-09-24; it comes back once npm is reachable). The interface and contract tests are ready (`TEST_DATABASE_URL`), but the `pg` driver can't be installed while npm is TLS-intercepted. `AGENTSPACE_DATABASE_URL=postgres://…` currently fails at startup with a clear message. The compose `postgres` profile and the CI Postgres job come with it.
- **The CA build arg hasn't been tested end to end.** The proxy doesn't send its CA in the chain, and it isn't in the local keychain. Both Dockerfiles pass `docker build --check`.
- **Pause needs an explicit hook in some cases:** in async code without an adapter hook (`await acheckpoint()`), for OpenAI Agents (`ControlHooks`) and for CrewAI (`step_checkpoint`). LangGraph async graphs pause at `acheckpoint()` inside nodes.
- **Cancelling is final** for the run id. With the Claude Agent SDK, later prompts in the same session are stopped too.
- **A small rendering glitch:** while the 3D scene mounts (about 1 s), the agent labels bunch up in the top-left corner. It isn't from this phase.

## Phase 4b: Costs, dashboard, replay, examples ✅ (2026-09-24; cleared to continue, hands-on test pending)

**Done-check:**
- `scripts/cost_check.sh` passed against a local collector. It checks that:
  - a call with tokens and no cost gets an estimate from the table (with `as_of`);
  - reported costs, and calls billed on another event, are never re-priced;
  - unknown models stay unpriced and are counted;
  - run totals and the stats API agree;
  - every model in the price table has a date and an official source;
  - stats carry no payloads.
- `scripts/controls_check.sh` passed again. `demo_check.sh` now runs both and also checks `/dashboard` and `/replay`.
- The full Docker done-check still can't rebuild images while npm is TLS-intercepted.

I also checked by hand in the browser, against a local collector with ten days of seeded runs:
- the dashboard: tiles, cost per day with tooltips, cost by agent and model with **est.** and "no price", the runs table and the slowest tools;
- replay of an approval run and of a paused, resumed and cancelled run: markers, jumping to them, and the office state at each point;
- `/demo` with the scrubber.

**One real paid run** (you approved it): the Claude Agent SDK example through OpenRouter, `claude-haiku-4-5`, `--approve --budget 0.05`. The refund was approved over REST and the run finished.
- The CLI reported **$0.0190** (3 turns). That's the whole cost of this phase's real calls.
- AgentSpace showed $0.0190 as reported, with $0 estimated and 0 unpriced calls.
- Pricing the per-message tokens with our table would have given only $0.0117: the CLI's bill includes usage the messages don't show. This confirms why a reported cost always wins over an estimate.

- [x] **Spec** (D-037): `cost_source` (`reported | estimated`), `tokens_cache_read`, `tokens_cache_write`. Both SDKs pass them through. Every adapter fills the cache counts from its framework's usage data. The Claude Agent SDK adapter marks per-message calls `cost_source: "reported"`, because the session is billed on `ResultMessage`.
- [x] **Price table** (D-038): `server/src/pricing/prices.json` covers 61 Anthropic, OpenAI and Google models.
  - Each price was copied from the official page on 2026-09-24, with its `as_of` date and `source`.
  - Price periods (Gemini Flash changes on 2027-01-01), long-context tiers where the threshold is published, and cache read/write rates.
  - Model id normalization (OpenRouter, Bedrock, Vertex, dated ids), with no fuzzy matching.
  - `AGENTSPACE_PRICES_FILE` overrides; `GET /v1/pricing`.
- [x] **Pricing at ingest** for `/v1/events` and OTLP (OTLP also maps the cache token attributes). Estimated events record which price was used (`agentspace.price_model`, `agentspace.price_as_of`).
- [x] **Projections:** `cost_estimated_usd` and `unpriced_calls` on agents and runs, the same on the SQL side and in the web `Projector` (the fixture was regenerated). Old SQLite databases get the columns on startup.
- [x] **"est." in the UI:** run summary, agent cards, agent panel (with the price date) and dashboard. A tooltip plus screen-reader text split estimated from reported cost and count unpriced calls.
- [x] **Stats API** (D-039): `GET /v1/workspaces/:ws/stats?since=&until=` returns cost per run, agent, model and day, LLM latency p50/p95, the error rate and the slowest tools. It's a store contract test, and public mode is safe.
- [x] **Cost dashboard** at `/dashboard` (linked from the office header): 24h/7d/30d/all, auto-refresh, loading, empty and error states, a table view for the chart, and the price sources in the footer.
- [x] **Replay** (D-040): `/replay?run=`, a scrubber at 1x/4x/16x with markers for errors, handoffs, approvals and pause/cancel, and jumps to the next error or handoff. Desks stay put. `/demo` uses the same player.
- [x] **Examples:**
  - `claude-agent-sdk-support --approve` uses `approval_callback()` for real runs and `--replay`. CI checks that it fails closed without a collector.
  - CrewAI with `step_checkpoint`, OpenAI Agents with `ControlHooks()`. Pause holding and cancel stopping were checked by hand in fake mode.
  - The `/demo` dev-team recording now includes a pause, a resume and an approval.

**Test counts:**
- Python 62 core, plus 9–12 per adapter group
- TS SDK 26
- collector 60
- web 52

### Deferred or known gaps
- **Postgres is deferred** (see above).
- **Estimates are list prices.** No batch, fast-mode, regional or negotiated pricing, and no per-search tool fees. OpenAI gpt-6 and gpt-5.6 long-context prices aren't applied, because the page gives no threshold. Anthropic cache writes use the 5-minute rate.
- **Prices go stale.** Update `prices.json` (and `as_of`) from the source pages. Gemini Flash's 2027 prices are already in the table as a second period.
- **Replay** of runs longer than 50,000 events shows only the first 50,000 (the page says so).
- **The browser check was in an unfocused automation window.** There, `requestAnimationFrame` runs rarely, so the 3D canvas and the store's frame flush lag behind (the state was correct). Worth a look in a normal window. The dashboard wasn't checked at phone width (the window resize didn't take effect).
- **A cancel that arrives during the last model call** lets that run finish (safe points only; seen with the OpenAI Agents example).

## Phase 5: Benchmarks + launch (in progress)

Plan approved 2026-09-25: Vercel for the docs and demo, docs as a `/docs` route in the Next app, and a video storyboard for the user to record. Additions from the user: a secret scan of the full history (and in CI), a personal-data audit of every recording, an explicitly verified read-only public demo, community files, a comparison table and an architecture diagram in the README, reproducible benchmarks, and a manual test script for Phases 4 and 5.

- [x] **Secret scan** (2026-09-25): `gitleaks` 8.30.1 over the full history (55 commits): **no findings**. No `.env` file, certificate or key file has ever been committed, and no `sk-or-`/`sk-ant-` key appears in any revision. In the working tree it flags only ignored files: the root `.env` and Next build caches. CI now runs the same scan on every push (`secrets` job).
- [x] **Personal-data audit** (2026-09-25). It covered every tracked recording and fixture (5 `/demo` recordings, the Claude example recording, 4 golden fixtures, the spec examples, 2 OTLP protobuf captures) and the committed screenshots:
  - **Clean.** There are only synthetic values (`/app`, `/tmp/t`, `cart.py`, `reviewer@example.com`, the names "Sam" and "done-check"). The OTLP captures carry only `service.name`, the SDK version and a random `service.instance.id`, with no host, user or path attributes. The screenshots have no EXIF/XMP metadata and show nothing personal.
  - **Needs a decision:** all commit metadata carries the owner's personal email (author and committer). See the launch checklist.
  - To fix before launch: both screenshots show the Next dev badge, and `office-stress-50.jpg` shows a dev-mode "38 fps". Replace them with production-build captures.
