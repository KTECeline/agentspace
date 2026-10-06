# Replay and the Costs page

## Replay

Any run the collector has stored can be played back in the office: click **Replay** next to the latest run in the office header, or on any run in the Costs page's runs table. The address is `/replay?run=<run id>` (plus the office's `?collector=` and `?workspace=` if you use them).

- **Play and pause, at 1x, 4x or 16x.** Pauses longer than 3 seconds are shortened, so a ten-minute wait for an approval plays in three seconds. The event's real time is shown next to the scrubber.
- **The scrubber marks the key moments:** errors and failed runs, handoffs, approvals, and pause or cancel. Click a marker, or use **Next error**, **Next handoff** and the arrows, to jump.
- **The office is exactly as it was** at that moment: statuses, the event log, pending approvals. Agents keep their desks while you scrub.
- Operator actions are off in a replay: it's history, not a live run.
- The side panel's **Trace** tab shows the run as a tree, and **Compare** puts it next to a successful run. See [Debugging a run](debugging).

Replay shows up to 50,000 events of a run. The collector keeps events for `AGENTSPACE_RETENTION_DAYS` (default 7).

The `/demo` page plays bundled recordings of every example the same way, with no collector.

## The Costs page

`/dashboard` (the **Costs** button in the office header) summarizes a workspace over the last 24 hours, 7 days, 30 days, or everything. It refreshes every 15 seconds.

- **Totals:** cost (with the estimated share), runs, the error rate (failed ÷ finished, ignoring cancelled runs), median and p95 model latency, and model calls and tokens.
- **Cost per day**, with a tooltip per day and a table view.
- **Cost by agent and by model**, with calls and latency.
- **Runs**: status, duration, calls, tokens, errors and cost, with a **Replay** link.
- **Slowest tools** by 95th-percentile duration, with error rates.

The page reads `GET /v1/workspaces/:ws/stats`, which returns aggregates only. See the [Collector API](rest-api).
