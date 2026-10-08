# Oversight policy

A policy says which tool calls run freely, which wait for a person, and which never run. You write it as a small JSON document: in code, in the collector, or both. Detectors can make it stricter for a run that looks wrong, but nothing ever makes it looser.

```json
{
  "default": "allow",
  "tools": [
    { "match": "deploy*", "action": "review", "reason": "Deploys need a person." },
    { "match": "delete_*", "action": "block", "reason": "Nothing gets deleted by an agent." },
    { "match": "run_tests", "action": "allow", "on_findings": "review" },
    { "match": "send_email", "agents": ["support"], "action": "review", "show_arguments": false }
  ],
  "on_findings": { "pause": ["failure_loop", "tool_call_outlier"], "min_severity": "warning" }
}
```

## Rules

| Setting | What it does |
|---|---|
| `match` | the tool name, or a glob over the whole name (`*` any run of characters, `?` one). Case-sensitive. |
| `action` | `allow`, `review` (a person decides in the office) or `block` |
| `agents` | only for these agent ids (e.g. `"support"`); without it, every agent |
| `on_findings` | a stricter action for runs with [detector](detectors) findings, e.g. `allow` normally but `review` once the run looks unusual |
| `reason` | shown to the reviewer, and to the model when the call is blocked |
| `show_arguments` | `false` keeps the arguments off the approval card (the redaction hook still applies when it's `true`) |

`default` (normally `allow`) applies when no rule matches. When several rules match, the strictest wins (`block` over `review` over `allow`).

**Code and collector.** Pass a policy to `init(policy=...)` and/or start the collector with `AGENTSPACE_POLICY_FILE`. Both apply, and the stricter decision wins, so an application can't loosen what the collector requires. The SDK reads the collector's policy before its first guarded call and every 30 seconds after that.

**Invalid policies fail closed.** In code, an invalid policy is logged and replaced by `{"default": "review"}`, so every tool call then asks a person. In the collector, an invalid file stops startup with the path of the problem (e.g. `tools[0].action`).

## Pausing on findings

`on_findings.pause` lists detectors (or `"*"`) whose findings pause the run, from `min_severity` up (default `warning`). Only the collector can pause, so this setting only works in `AGENTSPACE_POLICY_FILE`; in code it's ignored with a warning. The run bar then says which detector paused the run and why. The agent stops at its next safe point (a node, model or tool start, or `checkpoint()`) until someone presses **Resume** or **Cancel run**.

## What a reviewer sees

A review shows up as an approval card (the **Approvals** tab, and the agent's panel) with **Why you're asked**:

- the rule that asked, where it came from (code or collector) and its reason;
- a note when the review is only because the run has findings;
- the asking agent's tool calls in this run against its usual number, the run's cost against the usual, and how many earlier successful runs of the same workflow that's based on. Values at 2× the usual or more are highlighted;
- the run's findings so far.

The collector works this out when the request arrives, from the run so far and the same baselines the [detectors](detectors) use. A rejection's comment goes back to the agent.

## Enforcing it

The SDK checks a call just before the tool runs. Allowed calls cost a local check. A blocked, rejected or timed-out call doesn't run: the agent gets an error whose message is written for the model, e.g. `deploy is blocked by policy (rule deploy*): Deploys need a person. Don't retry it; choose another way or report back.` Every refusal is also recorded as an `error` event (kind `PolicyDenied`), and the adapters record it as a failed tool call too. Reviews fail closed like every approval: no answer in time means no.

| Where | How |
|---|---|
| Your own code (Python) | `agentspace.guard_tool(name, args)` (or `await agentspace.aguard_tool(...)`) before the call; it raises `agentspace.PolicyDenied` |
| Your own code (TypeScript) | `await agentspace.guardTool(name, args)`; it throws `PolicyDenied` (`isPolicyDenied(err)`) |
| CrewAI | automatic, through CrewAI's tool-call hooks |
| Claude Agent SDK | automatic in the `PreToolUse` hook that `instrument_options()` adds; a refusal is a `deny` with the reason |
| LangGraph | `ToolNode(tools, wrap_tool_call=policy_wrapper, awrap_tool_call=apolicy_wrapper)`; a refusal becomes an error `ToolMessage`. In your own tool loop, call `agentspace.adapters.langgraph.guard_tool(name, args)` before the tool (it's attached to the node's agent) |
| OpenAI Agents SDK | `apply_policy(agent)` adds `policy_guardrail` to the function tools of the agent and the agents it hands off to; a refusal is the tool's output |

LangGraph callbacks and OpenAI Agents trace processors can watch a tool call but can't refuse it, which is why those two need the line above. If the policy has a say about a call that didn't go through it, the SDK logs a warning (once an hour per tool) instead of failing silently.

```python
from agentspace.adapters.langgraph import apolicy_wrapper, policy_wrapper
from langgraph.prebuilt import ToolNode

tools = ToolNode([deploy, run_tests], wrap_tool_call=policy_wrapper, awrap_tool_call=apolicy_wrapper)
```

```python
from agentspace.adapters.openai_agents import apply_policy

apply_policy(triage_agent)  # changes the tool objects, so shared tools are guarded everywhere
```
