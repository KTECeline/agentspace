# LangGraph

```python
import agentspace
agentspace.init()      # that's all: every graph and runnable is traced
```

`init()` registers AgentSpace's callback handler globally through LangChain's `register_configure_hook`, the same public hook LangSmith uses, so no code changes are needed. To use it for one call only, pass it yourself: `graph.invoke(x, config={"callbacks": [AgentSpaceCallbackHandler()]})` (from `agentspace.adapters.langgraph`).

## What you'll see

| LangGraph | In the office |
|---|---|
| the root invocation | a run (unless you're inside `agentspace.run()`) |
| each graph node | an agent at a desk, with a step per visit and a handoff from the previous node |
| chat model calls | "thinking", then an `llm.call` with tokens, cache tokens and model |
| tools | "using tool", then the call and its result |

## Teams and names

```python
graph.invoke(state, config={"metadata": {
    "agentspace_team": "Engineering",                 # the room; defaults to the graph's name
    "agentspace_agents": {"qa": "QA Engineer"},       # display names for nodes
}})
```

## Approvals and controls

Cancel and pause act automatically at every node, model and tool start (async graphs pause at `await agentspace.acheckpoint()` inside a node). To ask for approval inside a node or tool, use the adapter's version, which attaches the request to the calling node:

```python
from agentspace.adapters.langgraph import request_approval_sync

decision = request_approval_sync(f"Write {path}?", {"path": path}, timeout=600)
if decision.approved:
    write(path)
```

**Python 3.10 with async graphs:** LangGraph doesn't propagate callbacks into calls inside nodes there, so model and tool events inside nodes are missed. Use Python 3.11+ for async graphs.

Example: [`examples/langgraph-dev-team`](https://github.com/KTECeline/agentspace/tree/main/examples/langgraph-dev-team).
