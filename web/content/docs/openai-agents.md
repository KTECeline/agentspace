# OpenAI Agents SDK

```python
import agentspace
agentspace.init()      # traced automatically
```

The adapter is a `TracingProcessor` registered with the SDK's `add_trace_processor`, its official tracing extension point. It receives every trace and span live.

## What you'll see

| Agents SDK | In the office |
|---|---|
| a trace | a run; the workflow name is the room |
| `agent` spans | an agent at a desk |
| `handoff` spans, and an agent running inside another (agent-as-tool) | a handoff |
| `generation` / `response` spans | an `llm.call` with tokens, cached tokens and model |
| `function` spans | a tool call and its result |
| `custom` / `guardrail` spans | a step |

Name the room with trace metadata: `RunConfig(trace_metadata={"agentspace_team": "Support Desk"})`.

## Pause and cancel

Cancel works with no extra code: `Cancelled` is raised at the next agent, model or tool span. Pausing needs an async hook, because a tracing processor must never block the event loop:

```python
from agentspace.adapters.openai_agents import ControlHooks

result = await Runner.run(agent, "Was invoice 42 paid?", hooks=ControlHooks())
```

Subclass `ControlHooks` to add your own hooks (call `super()`). Controls act at safe points only: a cancel that arrives during the run's last model call lets that run finish.

Example: [`examples/openai-agents-handoffs`](https://github.com/KTECeline/agentspace/tree/main/examples/openai-agents-handoffs).
