# Claude Agent SDK support desk

A **Support** lead delegates an invoice lookup to a **billing-specialist** subagent. Then it wants to issue a refund, which needs **your** approval. While it waits, its desk glows purple with "needs you".

```bash
docker compose up -d                    # from the repo root
cd examples/claude-agent-sdk-support
uv run python main.py --replay --runs 0 # recorded session, no key or CLI; open http://localhost:4801
```

For a real run you need `ANTHROPIC_API_KEY` in `.env` and the Claude Code CLI installed. Then run `uv run python main.py` and answer the refund prompt in the terminal.

## The AgentSpace part

The Claude Agent SDK takes hooks per session, so wiring it up is two calls:

```python
from agentspace.adapters.claude_agent_sdk import instrument_options, track

options = instrument_options(ClaudeAgentOptions(...), name="Support", team="Support Desk")
async for message in track(query(prompt=..., options=options)):   # adds tokens + billed cost
    ...
```

Your own hooks keep working, since AgentSpace's run after them and never change a decision.

> **Note:** `recording.json` is a *synthetic* session built from the SDK's hook and message schemas. It isn't a capture of a live run, because making one needs an API key. The real mode hasn't been run end-to-end yet for the same reason. Actual approvals from the office (instead of the terminal) arrive in Phase 4.
