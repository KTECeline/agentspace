# Launch

Everything needed to take AgentSpace public: a checklist in order, draft posts, and good first issues to open on day one. Nothing here has been posted, published or deployed.

## Pre-launch checklist

Do these in order. The ones marked **(you)** need your accounts or a decision.

**Before the repo goes public**

1. [ ] **(you)** Run the [manual test](launch/manual-test.md) (10 min) and fix anything that fails.
2. [ ] **(you)** Decide what to do about the email in the commit history. All commits carry your personal email as author and committer. Options:
   - (a) keep it;
   - (b) rewrite it to your GitHub no-reply address with `git filter-repo --mailmap` and force-push (safe only while private and nobody else has a clone);
   - (c) publish a fresh single-commit history.

   Then `git config user.email <id>+KTECeline@users.noreply.github.com` for this repo, and turn on GitHub's "Block command line pushes that expose my email".
3. [ ] **(you)** Replace `CONDUCT_CONTACT` in `CODE_OF_CONDUCT.md` with the address reports should go to.
4. [ ] Re-run the secret scan: `gitleaks git . --redact` (CI also runs it on every push). It must report no leaks.
5. [ ] **(you)** Record the GIF and the two stills ([video.md](launch/video.md)), and put the GIF at the top of the README.
6. [ ] **(you)** Run the UI benchmark in a focused window (`/demo?stress=50&rate=100&bench=20` on a production build) and fill in the row in [bench/ui_load.md](../bench/ui_load.md).

**Repository settings (right after it's public)**

7. [ ] **(you)** Make the repository public.
8. [ ] **(you)** Settings → Code security: turn on **private vulnerability reporting** (SECURITY.md links to it), secret scanning and push protection, and Dependabot alerts.
9. [ ] **(you)** Settings → General: turn on **Discussions** (the issue chooser links to it).
10. [ ] **(you)** Settings → Branches: protect `main`: require the CI checks and a pull request, and no force-pushes.
11. [ ] **(you)** Add the topics `ai-agents`, `observability`, `multi-agent`, `langgraph`, `crewai`, `opentelemetry`, `llm`, and a description with the demo link.

**Demo and docs site**

12. [ ] **(you)** Create a Vercel project from the repo with **root directory `web`**, and **no environment variables**. `web/vercel.json` sets the build, the redirects and the headers.
13. [ ] Run `scripts/check_public_demo.sh https://<your-demo>.vercel.app`. It must end with PASS.
14. [ ] Point the README's top links (Docs, Demo) at the deployed `/docs` and `/demo`.

**First release**

15. [ ] **(you)** One-time setup from [RELEASING.md](RELEASING.md): the `pypi` and `npm` environments (with you as a required reviewer), and trusted publishers on PyPI and npm.
16. [ ] Release 0.1.0: `python3 scripts/version.py set 0.1.0`, re-lock the examples, commit, tag `v0.1.0`, push. Then approve the two deployments in Actions.
17. [ ] **(you)** Make the two GHCR packages public.
18. [ ] Check: `pip install agentspace-sdk==0.1.0`, `npm view agentspace-sdk version`, and `docker pull ghcr.io/ktececline/agentspace-collector:0.1.0`.

**Announce**

19. [ ] **(you)** Open the five good first issues below and label them.
20. [ ] **(you)** Post, in this order: Show HN (a weekday morning, US Eastern), then r/LocalLLaMA, then X and LinkedIn with the video. Stay around for the first hours to answer.

## Draft posts

### Show HN

**Title:** Show HN: AgentSpace – a live 3D office for your AI agent teams (open source)

> Hi HN! I built AgentSpace because debugging multi-agent apps from log lines is painful. You can't *see* who is doing what, who handed off to whom, or which agent is stuck.
>
> AgentSpace shows your agents as people in an office. Each team gets a room and each agent a desk. You see them think, call tools and hand off work in real time. It's also two-way: an agent can ask you to approve a risky action (and if nobody answers, the answer is no), and you can pause or cancel a run from the office. Every run can be replayed, and there's a cost page that keeps a framework's billed cost separate from list-price estimates.
>
> It works with LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK and Claude Code, using each framework's official hooks (no monkey-patching), and with anything that exports OpenTelemetry GenAI spans. For most frameworks it's two lines: `import agentspace; agentspace.init()`.
>
> Some design choices HN might care about:
> - The Python SDK has zero dependencies and never raises into or blocks your app. p99 is under 250 µs per event, and memory is bounded when the collector is down. Benchmarks, with the commands to reproduce them, are in the repo.
> - Private by default: only metadata leaves your process unless you opt in, with a redaction hook.
> - Self-hosted: `docker compose up`, SQLite, Apache 2.0.
>
> Demo (recorded runs, no signup): <DEMO URL>. Repo: https://github.com/KTECeline/agentspace
>
> I'd love feedback, especially on which frameworks to support next, and whether the "office" metaphor helps or gets in the way once you have 50 agents.

### r/LocalLLaMA

**Title:** I made an open-source "office" view for local agent teams: watch them work, approve their actions, replay runs (self-hosted, no cloud)

> If you run agent teams on local models (LangGraph or CrewAI with Ollama or llama.cpp, anything that emits OpenTelemetry), AgentSpace gives you a live office view: each agent at a desk, animating as it thinks and calls tools, and handoffs flying between desks.
>
> - **Runs entirely on your machine:** `docker compose up`, SQLite, no account, no telemetry. Prompts and outputs don't leave your process unless you turn that on.
> - **Human in the loop:** agents can ask you before doing something ("write cart.py?"). Deny, or no answer, means no. You can also pause or cancel a run.
> - **Replay** any run and jump to its errors.
> - **Costs:** local models show as "no price" rather than a made-up number. API models are estimated from a dated price table, and marked as estimates.
>
> Two lines to add: `import agentspace; agentspace.init()`. Apache 2.0. Repo: https://github.com/KTECeline/agentspace. Demo: <DEMO URL>
>
> What would make this more useful for local setups?

*(Check the subreddit's self-promotion rules on the day. Lead with the local, no-cloud angle, and reply to comments.)*

### X

> Your AI agents, as a live office. 🏢
>
> AgentSpace shows every agent at a desk: thinking, calling tools, handing off work. Approve risky actions, pause or cancel runs, replay them, see what they cost.
>
> LangGraph · CrewAI · OpenAI Agents · Claude Agent SDK · Claude Code · OpenTelemetry
> Two lines to add. Open source, self-hosted.
>
> [video] <REPO URL>

### LinkedIn

> Multi-agent systems are hard to reason about from logs. Which agent is doing what, who is waiting on whom, and what did this run cost?
>
> I've open-sourced **AgentSpace**, a live office view for AI agent teams. Each agent gets a desk. You watch them work in real time, approve actions before they happen, pause or cancel runs, replay them, and see costs, with a framework's billed cost kept separate from estimates.
>
> It plugs into LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK, Claude Code, and anything that speaks OpenTelemetry, through each framework's official hooks. It's self-hosted and Apache 2.0, and it's built to never slow your agents down (benchmarks included).
>
> [video] Repo and demo: <REPO URL>

## Good first issues (drafts: open these on launch day)

**1. Expose OTLP on the standard port 4318** · `good first issue`, `collector`
OpenTelemetry exporters default to port 4318, but the collector serves `POST /v1/traces` on 4800. Add an optional second listener: `AGENTSPACE_OTLP_PORT` (off by default, `4318` in `docker-compose.yml`) that serves only `/v1/traces`. Update the OpenTelemetry docs page.
*Done when:* an exporter with no endpoint configured reaches a compose install; a test covers the second listener.
*Start at:* `server/src/index.ts`, `server/src/app.ts` (the `/v1/traces` route).

**2. Keyboard shortcuts for replay** · `good first issue`, `web`
Space for play/pause, ← and → to jump to the previous or next key moment, 1/4/16 for the speed, but only when focus isn't in a text field. Show them in a tooltip on the replay bar.
*Done when:* the shortcuts work, don't fire while typing, and have a unit test for the key handling.
*Start at:* `web/components/replay/ReplayBar.tsx`, `web/lib/replay.ts` (`findMarker`).

**3. Copy button on docs code blocks** · `good first issue`, `docs`, `web`
Add a small "Copy" button to every code block on `/docs`. Say "Copied" for 2 s, keep it keyboard accessible, and avoid layout shift.
*Done when:* it works with the keyboard and in both themes, and there are no dependencies added.
*Start at:* `web/components/docs/Markdown.tsx` (the `code` case).

**4. `python -m agentspace doctor`** · `good first issue`, `sdk-python`
A command that prints the SDK version, the configured URL and workspace, whether the collector answers (`GET /v1/info`), whether auth is required and the key is accepted, and which framework adapters are installed. It must use no new dependencies and never print the key.
*Done when:* it works with the collector up, down, and with a wrong key, with tests for each.
*Start at:* `packages/sdk-python/agentspace/claude_code.py` (a similar `python -m` entry point), `agentspace/_api.py`.

**5. Fix agent labels bunching in the corner while the 3D office loads** · `good first issue`, `web`, `bug`
For about a second after the 3D scene mounts, all agent labels sit in the top-left corner before jumping to their desks. Hide each label until its first projected position is known.
*Done when:* no labels are visible in the corner on load (check `/demo` with a throttled CPU), with no extra React renders per frame.
*Start at:* `web/components/office/Labels.tsx` (`LabelProjector`, `LabelLayer`).
