# Debugging a run

When a run goes wrong, two views help you find out why: the **trace** of the run, and a **comparison** with a run that went right. Both work on stored runs, so they need a collector (they aren't in the public demo, except the trace of the bundled recordings).

## The trace

Open a run in replay (the **Replay** button next to the latest run in the office, or **Replay** in the Costs page's runs table). The side panel opens on **Trace**: the run as a tree.

- **Steps** (`step.started` to `step.finished`) contain what happened inside them: model calls, tool calls, handoffs, approvals and errors. Nesting comes from `parent_id`.
- A **tool call** and its result are one row, with the call's duration and whether it failed.
- An **approval** is one row from request to decision.
- If an event has no parent (some adapters send approvals that way), it's placed under the step or tool call its agent had open at that moment, and marked with `~`.

The trace and the scrubber are tied together. While the run plays, the row for the current moment is marked and its parents open. Select a row (click, or arrow keys and Enter) to pause the replay and jump the office to that moment.

**First error** jumps to the earliest thing that failed (the first failure to finish, then the most deeply nested one) and highlights the path to it. A small red dot on a collapsed row means something inside it failed.

The details below the tree show timing, tokens, cost (with **est.** when it came from the price table), the model, and the error. Inputs, outputs, tool arguments and results appear only if the SDK runs with `capture_content=True`, after your redaction hook. Otherwise AgentSpace records metadata only.

## Comparing two runs

**Compare** (in a replay's header, or next to a run in the Costs page's runs table) opens `/compare`. It puts the run next to a **baseline**: by default the latest successful run with the same name that started before it. You can pick either run from the lists.

- **What changed** lists only the differences: the outcome, the order in which agents took steps, duration, cost, tokens, model and tool calls, failed tool calls, errors, handoffs, approvals and model latency, and per-model and per-tool call counts.
- **First difference** is where the two runs stopped doing the same thing. Each run is reduced to a sequence of actions (which agent started which step, called which tool or model, handed off to whom, failed, or asked for approval), without ids, times or content. The first position where the sequences differ is shown for both runs. **Open in replay** opens that run paused on that event, with its trace row selected.
- **All metrics** and **Tools** show the full numbers.

Agents working in parallel can interleave differently from run to run. Then the first difference may be an ordering change rather than a real change in behaviour, so check the trace.

The address takes `?run=` (the run to look at; default: the latest failed run) and `?base=` (the baseline), plus `?collector=` and `?workspace=` like the office:

```text
/compare?run=<run id>&base=<run id>&collector=http://localhost:4800&workspace=default
/replay?run=<run id>&event=<event id>     # open a replay paused on one event
```
