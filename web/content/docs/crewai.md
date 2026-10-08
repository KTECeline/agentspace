# CrewAI

```python
import agentspace
agentspace.init()      # CrewAI crews are traced automatically
```

The adapter is a `BaseEventListener` on CrewAI's official event bus. CrewAI delivers events on a thread pool, out of order, so the adapter orders them by CrewAI's own timestamps and never lets a late "thinking" overwrite "done".

## What you'll see

| CrewAI | In the office |
|---|---|
| a crew kickoff | a run; the crew's name is the room |
| each agent's execution | an agent at a desk, with a handoff from the previous agent |
| "Delegate work" / "Ask question" to a coworker | a handoff to that coworker |
| LLM calls | "thinking", then an `llm.call` with tokens, cache tokens and model |
| tool usage | "using tool", then the call and its result |

## Pause and cancel

CrewAI's event handlers can't stop a crew, so add the adapter's step callback. Every agent step then becomes a safe point:

```python
from agentspace.adapters.crewai import step_checkpoint

crew = Crew(agents=[...], tasks=[...], step_callback=step_checkpoint)
try:
    crew.kickoff()
except agentspace.Cancelled:
    print("cancelled from the office")
```

If you already have a step callback, call `step_checkpoint(step_output)` from it.

**Good to know:** each crew kickoff is its own run, even inside `agentspace.run()`, because CrewAI's handlers run on its own threads. The adapter needs Python 3.13 or earlier while CrewAI does.

Example: [`examples/crewai-research-desk`](https://github.com/KTECeline/agentspace/tree/main/examples/crewai-research-desk).

## Policy

The [oversight policy](policy) is applied automatically through CrewAI's tool-call hooks. A blocked or refused call doesn't run, and the agent is told why.
