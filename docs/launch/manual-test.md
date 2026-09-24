# Manual test: 10 minutes before going public

Checks Phase 4 and 5 by hand: approve, reject, pause, resume, cancel, replay, the Costs page, the docs, and the public demo. Every step says what you should see. If something differs, note the step number.

Use a normal, focused browser window. Everything is offline: fake models, no API keys, no cost.

## 0. Setup (1 min)

Three terminals, from the repo root:

```bash
# A: a fresh collector, no auth
cd server && PORT=4810 AGENTSPACE_DB=/tmp/manual-test.db pnpm -s exec tsx src/index.ts

# B: the office
cd web && pnpm exec next dev -p 4811

# C: the examples (you'll run several commands here)
cd examples/langgraph-dev-team
```

Open **http://localhost:4811/?collector=http://localhost:4810**. The `?collector=` part matters: without it, the page talks to port 4800.

- [ ] **0.1** The header says **Live** (green), and the office is empty with a "Watch a recorded demo" button.

## 1. Approve (1.5 min)

```bash
# C
VIRTUAL_ENV= AGENTSPACE_URL=http://localhost:4810 uv run python main.py --fake --approve
```

- [ ] **1.1** Manager, Triage and Engineer appear at desks in an **Engineering** room, and packets fly between them.
- [ ] **1.2** The Engineer's desk glows purple with **needs you**, and the header shows **1 approval waiting**.
- [ ] **1.3** Click the pill (or the **Approvals** tab): the card reads **Write cart.py?** and shows the file content.
- [ ] **1.4** Type a comment, click **Approve**. The card shows approved, the glow stops, and the Engineer carries on.
- [ ] **1.5** Terminal C ends with `run 1: ... tests pass.` The run summary in the header shows **ok**.

## 2. Reject (1 min)

Run the same command again. When the Engineer glows:

- [ ] **2.1** Type a reason, click **Reject**. The card shows **rejected** with your reason.
- [ ] **2.2** Terminal C prints `cart.py was not written: rejected (your reason)`, and the run still finishes. It also prints the fake model's canned "tests pass" summary: the scripted model can't react to the rejection, so ignore that line.
- [ ] **2.3** (Optional) Run it once more and don't answer: nothing is approved by accident. It waits up to 10 minutes, then counts as a timeout. Stop it with Ctrl-C.

## 3. Pause, resume, cancel (2 min)

```bash
# C: a long, slow run
VIRTUAL_ENV= AGENTSPACE_URL=http://localhost:4810 uv run python main.py --fake --runs 0 --latency 2
```

- [ ] **3.1** Click **Pause** in the header. Within about 2 s, the working agent shows **Blocked · paused by an operator**, and the event log stops moving.
- [ ] **3.2** Wait 10 s: nothing new happens, and terminal C is quiet.
- [ ] **3.3** Click **Resume**. The agents carry on.
- [ ] **3.4** Click **Cancel**. It asks you to click again; do so. Terminal C prints `cancelled from the office` and exits, and the run shows **cancelled**.

## 4. Replay (1.5 min)

- [ ] **4.1** Click **Replay** next to the latest run (the cancelled one). The header shows **Replay** and **Back to live**, and a scrubber appears.
- [ ] **4.2** Press **16x**, then play: the run replays in a few seconds.
- [ ] **4.3** The scrubber has grey **Pause / cancel** markers. Click the first one: the office shows the agent blocked at that moment.
- [ ] **4.4** Go back to the office (**Back to live**) and replay the run from step 1 (open **Costs**, then **Replay** on that run): it has purple **Approvals** markers, and jumping to the first one shows the Engineer glowing.
- [ ] **4.5** Drag the scrubber back and forth quickly: the office keeps up, and desks never move.

## 5. Costs page (1.5 min)

Give it some priced calls first. This example uses real model names:

```bash
# C
cd ../otel-generic && VIRTUAL_ENV= AGENTSPACE_URL=http://localhost:4810 uv run python main.py
```

- [ ] **5.1** Click **Costs** in the office header. The tiles show a total cost with **est.**, runs by status, the error rate, model latency and calls.
- [ ] **5.2** **Cost by model** lists `claude-…` models with **est.**, and `scripted-fake` with **no price**.
- [ ] **5.3** Hover the total cost: the tooltip splits estimated vs reported, and counts calls with no price.
- [ ] **5.4** Hover a bar in **Cost per day**: a tooltip; **Show as table** shows the same numbers.
- [ ] **5.5** Switch between **24 hours** and **All**: the numbers update, and nothing errors.

## 6. Docs (30 s)

- [ ] **6.1** Open http://localhost:4811/docs: the sidebar lists 19 pages. Open **Approvals, pause and cancel** and **Collector API**: the code blocks and tables are readable, and the links work.

## 7. Public demo mode (1 min)

```bash
# stop B (Ctrl-C), then:
cd web && AGENTSPACE_PUBLIC_DEMO=1 pnpm build && AGENTSPACE_PUBLIC_DEMO=1 pnpm exec next start -p 4812
# another terminal, from the repo root:
scripts/check_public_demo.sh http://localhost:4812
```

- [ ] **7.1** The check ends with **PASS**.
- [ ] **7.2** Open http://localhost:4812/?collector=http://localhost:4810: you land on **/demo**, a recording plays, and there are no Approve, Pause or Cancel buttons anywhere.

## Done

If every box is ticked, Phases 4 and 5 work on your machine. Clean up: stop A and B, then `rm /tmp/manual-test.db*`.
