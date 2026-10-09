# Recording the README GIF and the launch video

The story is one loop (D-042): **a run fails → you find where → inspect it → compare it with a good run → the next risky step is paused for you → you reject it → replay**. The office is where it all shows up.

Two pieces: a **60-second GIF** for the top of the README (no sound, loops), and a **2-minute video** with narration for the launch posts. Both come from the same setup: the failure story in `examples/langgraph-dev-team` (`--story`), driven by hand.

## Setup (10 minutes, once)

Record from a **production build** in a normal, focused window. Dev mode shows the Next.js "N" badge, and background windows throttle animation.

```bash
# 1. A fresh collector with the story's policy and auth off, and the production web build
cd server && PORT=4810 AGENTSPACE_DB=/tmp/launch.db \
  AGENTSPACE_POLICY_FILE=../examples/langgraph-dev-team/policy.json pnpm -s exec tsx src/index.ts
cd web && pnpm build && pnpm exec next start -p 4812

# 2. Browser: 1440x900 window, 100% zoom, dark mode (the office's best look), no extensions
#    or bookmarks bar visible. Open http://localhost:4812/?collector=http://localhost:4810

# 3. The run (in a terminal off screen). Five quick good runs, then the one that goes wrong.
cd examples/langgraph-dev-team
VIRTUAL_ENV= AGENTSPACE_URL=http://localhost:4810 uv run python main.py --story --latency 1.2
```

The good runs take about 5 seconds and flash by: start the screen recording before step 3 and trim them. Use a fresh database (`/tmp/launch.db`) for every take, or the baseline grows and the numbers on the approval card change.

Tools: macOS screen recording (Cmd-Shift-5) or Kap, and [Gifski](https://gif.ski) to turn the clip into a GIF. Keep the GIF under 8 MB, 1200 px wide, 20 fps.

**Rehearse without a collector:** `/demo` plays the same story from a recording (`?speed=4` to skim it), and `/demo/compare` has the comparison. The live take should look like that.

## The 60-second GIF: shot list

| Time | Shot | How |
|---|---|---|
| 0–8 s | The regression run starts: Manager → Triage → Engineer, handoff packets flying | trim the five good runs before it |
| 8–16 s | The Engineer runs the tests: they fail, three times. Amber badges appear over its desk | let it run |
| 16–22 s | The Engineer goes still. The run bar: "Paused by the failure_loop detector: run_tests failed 3 times in a row" | hold 2 s on the run bar |
| 22–32 s | Click **Replay**, then **Trace** → **First error**: the failing `run_tests`, "expected 8.0, got 5.0" | the replay opens on the trace |
| 32–42 s | Click **Compare**: *What changed* (ok → error, 3 failed `run_tests`), then *First difference* | scroll slowly |
| 42–52 s | Back in the office: **Resume**. The Engineer glows "needs you". Open **Approvals**: the card's evidence (the rule, both findings, "4 · usually 2"). Type a comment, click **Reject** | pause 1 s on the evidence |
| 52–60 s | The run ends as failed; the Engineer's panel shows the rejection reached it | |

Crop to the browser content (no window chrome). Save as `docs/assets/agentspace.gif` and put it at the top of the README, in place of `office-3d.jpg`.

**Also take three stills** in the same setup (for the README and posts):
- `docs/assets/office-3d.jpg`: the dev team mid-run, 3D view, with the findings badge over the Engineer.
- `docs/assets/approval-evidence.jpg`: the approval card with its evidence, next to the paused office.
- `docs/assets/office-stress-50.jpg`: `http://localhost:4812/demo?stress=50&rate=100&fps` after 10 s, with the FPS meter reading about 60.

## The 2-minute video: storyboard and script

Record the screen at 1440×900 and the voice separately, then edit. Each section's narration is short on purpose: leave the screen room to speak.

**0:00–0:12 · Hook.** *Screen:* the office mid-run, agents at their desks, packets flying.
> "Multi-agent systems fail in ways that are hard to see. This is AgentSpace: every agent at a desk, and every run on the record."

**0:12–0:25 · Two lines.** *Screen:* an editor with a LangGraph app; add `import agentspace` and `agentspace.init()`; run it; agents appear.
> "You add two lines. It hooks into LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK, Claude Code, or plain OpenTelemetry, through each framework's official hooks."

**0:25–0:45 · It goes wrong.** *Screen:* the regression run. The Engineer's tests fail three times; amber badges; the run pauses itself; the run bar.
> "This run has gone wrong. The Engineer's fix broke something, and it keeps re-running the tests. A detector notices the loop, and our policy says: pause the run. No LLM is judging here. It's counting."

**0:45–1:05 · Find where.** *Screen:* Replay → Trace → First error; then Compare: What changed, First difference.
> "Where did it go wrong? The trace jumps to the first error. And compared with the last good run, it's the same team doing the same steps, until this test failed."

**1:05–1:30 · Decide.** *Screen:* Resume; the Engineer glows; the approval card: the rule, the findings, "4, usually 2"; type a comment; Reject. The agent reads the comment and stops.
> "When it resumes, the Engineer wants to write code again. Normally that's fine, but this run looks wrong, so it asks first, and the card says why. I reject it, with a note. The agent gets the note and hands back."

**1:30–1:45 · Replay.** *Screen:* Replay the run at 4x; click the finding, pause and approval markers.
> "Every run is kept. Replay it, and jump to the findings, the pause and the decision."

**1:45–2:00 · Close.** *Screen:* the README top with the quickstart; `docker compose up` and `make demo-story` highlighted.
> "Rules you write, checks you can read, and you in the loop when it matters. It's open source and runs on your machine. Try the story with `make demo-story`."

**Captions:** burn in the narration as subtitles (many people watch muted). **Music:** optional and quiet. **Thumbnail:** the paused office with the approval card, titled "Debug and control your agent teams".

## Before you publish either

- No personal data on screen: terminal prompts show your username and paths, so use a neutral prompt (`PS1='$ '`) and a directory like `/tmp/demo`.
- No keys: the story is scripted and needs none, so don't open `.env`.
- Decisions made in the office are shown as "by operator", so no name appears.
- Run `scripts/check_public_demo.sh` against the demo site you link.
