# Detectors

The collector watches every run as it happens and flags behaviour worth a look: an agent stuck retrying, two agents passing work back and forth, a run far more expensive than usual. Each finding says what it saw, with the numbers, so you don't have to dig through logs to see why.

Detectors don't use an LLM and never read prompts or outputs. They work from names, counts, outcomes and a keyed hash of tool arguments.

## Where findings show up

- **The office:** an amber badge with the count over the agent's desk (3D) and on its card (2D). Click the agent: **Findings in this run** lists each one with its evidence.
- **The event log**, as `anomaly.detected` events.
- **Replay:** amber markers on the scrubber and **Next finding**.
- **Trace:** a row under the step it came from, with the detector and evidence in the details. A finding isn't a failure, so **First error** ignores it.
- **Compare** and the Costs page's runs table count them.

## The detectors

| Detector | Fires when | Severity |
|---|---|---|
| `repeated_tool_call` | the same agent calls the same tool with the same arguments 3 times in a run | warning |
| `failure_loop` | one agent's tool fails 3 times in a row, with no success in between | warning |
| `handoff_loop` | two agents hand work back and forth 3 round trips in a row (A→B→A is one) | warning |
| `tool_call_outlier` | an agent's tool calls in this run pass 2× its median over the last 50 successful runs of the same workflow, and at least 5 more | warning; critical at 5× |
| `usage_outlier` | the run's tokens or cost pass 2× the median of those runs | warning; critical at 5× |

Each finding is sent once (per tool, agent pair, or streak), the moment its threshold is crossed. Findings are only ever an extra signal: nothing here approves or skips anything for you.

**Baselines.** The two outlier detectors compare a run with earlier successful runs that have the same name (the `run.started` name, e.g. the LangGraph graph name). They stay quiet until there are at least 5 such runs, and when an agent has never appeared in them. Agent ids must stay the same from run to run, which they do with every built-in adapter.

**Arrival order.** "In a row" means in the order events reach the collector. CrewAI sends events from a thread pool, so its order can be slightly off.

## Repeated calls and the arguments hash

`repeated_tool_call` needs `tool.call.data.arguments_hash`: a keyed hash (HMAC-SHA256) of the tool's arguments, which every adapter sends even when content capture is off. Its key is random per process, so it reveals nothing about the arguments (you can't confirm a guess like `user_id=18291`), and equal hashes only mean "same arguments" within one process. Key order doesn't matter, and a JSON string hashes like the object it holds.

- **Python:** on by default. `agentspace.init(hash_arguments=False)` turns it off. If you emit `tool.call` yourself, add `"arguments_hash": agentspace.hash_arguments(args)`.
- **TypeScript:** `agentspace.hashArguments(args)` (needs `node:crypto`).
- **OpenTelemetry:** the collector hashes `gen_ai.tool.call.arguments` itself, before dropping the content.
- **Claude Code hook:** sends no hash. The hook runs as a new process for every event, so a per-process key couldn't link two calls.

Hashing cost is bounded whatever the size: long strings are reduced to a digest of their first 256K characters, and nested structures are read up to 500 values. Typical arguments take a few microseconds; the worst case is about half a millisecond.

## Settings

| Variable | What it does |
|---|---|
| `AGENTSPACE_DETECTORS=off` | turn detection off |
| `AGENTSPACE_DETECTORS_FILE` | a JSON file that changes thresholds or turns single detectors off |

```json
{
  "failure_loop": { "min_count": 5 },
  "tool_call_outlier": { "factor": 3, "min_runs": 10 },
  "usage_outlier": false
}
```

Settings per detector: `repeated_tool_call.min_count`, `failure_loop.min_count`, `handoff_loop.min_round_trips`, `tool_call_outlier.min_runs | factor | min_extra`, `usage_outlier.min_runs | factor`. An unknown detector or setting stops the collector at startup with a message.

Clients can't send `anomaly.detected` events: the collector rejects them, so a finding always comes from the collector.
