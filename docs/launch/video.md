# Recording the README GIF and the launch video

Two pieces: a **60-second GIF** for the top of the README (no sound, loops), and a **2-minute video** with narration for the launch posts. Both come from the same setup and shots.

## Setup (10 minutes, once)

Record from a **production build** in a normal, focused window. Dev mode shows the Next.js "N" badge, and background windows throttle animation.

```bash
# 1. A fresh collector with auth off, and the production web build
cd server && PORT=4810 AGENTSPACE_DB=/tmp/launch.db pnpm -s exec tsx src/index.ts
cd web && pnpm build && pnpm exec next start -p 4812

# 2. Browser: 1440x900 window, 100% zoom, dark mode (the office's best look), no extensions
#    or bookmarks bar visible. Open http://localhost:4812/?collector=http://localhost:4810
```

Tools: macOS screen recording (Cmd-Shift-5) or Kap, and [Gifski](https://gif.ski) to turn the clip into a GIF. Keep the GIF under 8 MB, 1200 px wide, 20 fps.

Before recording, run each shot once, so every example's dependencies are installed and first runs aren't slow.

## The 60-second GIF: shot list

| Time | Shot | How |
|---|---|---|
| 0–8 s | An empty office fills: Manager, Triage and Engineer appear at their desks and start working | `cd examples/langgraph-dev-team && VIRTUAL_ENV= AGENTSPACE_URL=http://localhost:4810 uv run python main.py --fake --approve --latency 1.2` |
| 8–18 s | Handoff packets fly Manager → Triage → Engineer; statuses change (thinking, using a tool) | just let it run |
| 18–30 s | The Engineer glows "needs you". Open the **Approvals** tab, read "Write cart.py?", click **Approve** | move the pointer slowly; pause 1 s on the button |
| 30–38 s | The run finishes; everyone gets a green check | |
| 38–48 s | Click **Replay**, press **16x**, then click the purple approval marker | the office jumps back to the approval moment |
| 48–60 s | Click **Costs**: the tiles, cost per day, cost by agent and model | for real "est." numbers, run the OTLP example once (`examples/otel-generic`), which reports real model names |

Crop to the browser content (no window chrome). Save as `docs/assets/agentspace.gif` and put it at the top of the README, in place of `office-3d.jpg`.

**Also take two stills** in the same setup (for the README and posts; replace the dev-mode ones):
- `docs/assets/office-3d.jpg`: the dev team mid-run, 3D view.
- `docs/assets/office-stress-50.jpg`: `http://localhost:4812/demo?stress=50&rate=100&fps` after 10 s, with the FPS meter reading about 60.

## The 2-minute video: storyboard and script

Record the screen at 1440×900 and the voice separately, then edit. Each section's narration is short on purpose: leave the screen room to speak.

**0:00–0:12 · Hook.** *Screen:* the office full of agents, packets flying.
> "This is a live office for AI agent teams. Every desk is an agent, and you're watching them work right now."

**0:12–0:30 · Two lines.** *Screen:* an editor with a LangGraph app; add `import agentspace` and `agentspace.init()`; run it; agents appear.
> "You add two lines. AgentSpace hooks into LangGraph, CrewAI, the OpenAI Agents SDK, the Claude Agent SDK, Claude Code, or plain OpenTelemetry, using each framework's official hooks. Nothing is patched."

**0:30–0:50 · What you see.** *Screen:* click an agent; the panel shows its current step, tool calls with timings, tokens, cost and its own log. Toggle to 2D and back.
> "Click any agent to see what it's doing: the current step, its tool calls, tokens and cost. Handoffs fly between desks. There's a 2D view too."

**0:50–1:12 · Step in.** *Screen:* the Engineer glows; approve in the Approvals tab. Then start a long run, **Pause**: desks go still. **Resume**. **Cancel** (two clicks): the run ends as cancelled.
> "It's two-way. An agent can ask you before it does something risky, and it waits. If nobody answers, the answer is no. You can pause a run, or cancel it: the SDK stops at the next safe point, never mid-call."

**1:12–1:32 · Replay.** *Screen:* Replay the run at 16x; jump to the approval marker; jump to an error in another run.
> "Every run is stored. Replay it, and jump straight to the errors, handoffs and approvals."

**1:32–1:50 · Costs.** *Screen:* the Costs page; hover an "est." value to show its tooltip.
> "Costs: when your framework reports what it billed, that's what you see. Otherwise AgentSpace estimates from a dated price table, and says so."

**1:50–2:00 · Close.** *Screen:* the README top with the quickstart; the `docker compose up` line highlighted.
> "It's open source, it runs on your machine, and it never slows your agents down: we measured. `docker compose up`, two lines, done."

**Captions:** burn in the narration as subtitles (many people watch muted). **Music:** optional and quiet. **Thumbnail:** the full office still, with the title "A live office for your AI agents".

## Before you publish either

- No personal data on screen: terminal prompts show your username and paths, so use a neutral prompt (`PS1='$ '`) and a directory like `/tmp/demo`.
- No keys: the fake and replay modes need none, so don't open `.env`.
- Run `scripts/check_public_demo.sh` against the demo site you link.
