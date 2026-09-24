# Claude Agent SDK

The Claude Agent SDK takes hooks per session, so wiring it up is two calls:

```python
from claude_agent_sdk import ClaudeAgentOptions, query
from agentspace.adapters.claude_agent_sdk import instrument_options, track
import agentspace

agentspace.init()
options = instrument_options(ClaudeAgentOptions(...), name="Support", team="Support Desk")
async for message in track(query(prompt="...", options=options)):
    ...
```

- `instrument_options()` adds AgentSpace's hooks and keeps yours; they run after your own hooks and never change a decision.
- `track()` passes every message through unchanged, and records model usage and the session's billed cost.

## What you'll see

| Claude Agent SDK | In the office |
|---|---|
| a prompt and its turns | a run, and the main agent's status |
| tool hooks | tool calls and results |
| subagents (the Task/Agent tool) | their own desks, with a handoff |
| permission requests | "needs you" |
| assistant messages | `llm.call` with model, tokens and cache tokens |
| `ResultMessage` | the session's **billed** cost (`total_cost_usd`), marked as reported |

**Costs:** the SDK bills a whole session at the end, so per-message calls are marked `cost_source: "reported"` and the collector never adds an estimate on top. See [Costs and pricing](costs).

## Approvals from the office

Use the adapter's permission callback. It asks in the office and **fails closed**: a rejection, a timeout or an unreachable collector denies the tool.

```python
from agentspace.adapters.claude_agent_sdk import approval_callback

ClaudeAgentOptions(..., can_use_tool=approval_callback({"mcp__billing__refund"}))
```

Tools not in the set are allowed without asking (`None` asks for every tool). Claude only consults `can_use_tool` for calls your permission settings don't already allow.

## Pause and cancel

The PreToolUse hook is the safe point. While a run is paused, the hook waits (its timeout is 3,600 s, so a pause can outlast the SDK's 60 s default). Once it's cancelled, the hook denies the tool and stops the session. Later prompts in the same session are stopped too.

Example: [`examples/claude-agent-sdk-support`](https://github.com/KTECeline/agentspace/tree/main/examples/claude-agent-sdk-support) (`--replay --approve` works offline).
