# Claude Agent SDK support desk

A **Support** lead delegates an invoice lookup to a **billing-specialist** subagent. Then it wants to issue a refund, which needs **your** approval. While it waits, its desk glows purple with "needs you".

```bash
docker compose up -d                    # from the repo root
cd examples/claude-agent-sdk-support
uv run python main.py --replay --runs 0 # recorded session, no key or CLI; open http://localhost:4801
```

For a real run you need the Claude Code CLI, and a key in `.env`: either `OPENROUTER_API_KEY` (preferred; OpenRouter exposes an Anthropic-compatible API that Claude Code calls directly) or `ANTHROPIC_API_KEY`. Then run `uv run python main.py` and answer the refund prompt in the terminal.

Add `--approve` (with or without `--replay`) to decide the refund in the office instead: it waits in the **Approvals** tab until you approve or reject it. It uses the adapter's `approval_callback()`, which fails closed, so a rejection, a timeout or an unreachable collector means no refund. A rejected refund shows up as a failed tool call.

Real runs are capped: Haiku by default, at most 6 turns, and `--budget 0.10` USD.

## The AgentSpace part

The Claude Agent SDK takes hooks per session, so wiring it up is two calls:

```python
from agentspace.adapters.claude_agent_sdk import instrument_options, track

options = instrument_options(ClaudeAgentOptions(...), name="Support", team="Support Desk")
async for message in track(query(prompt=..., options=options)):   # adds tokens + billed cost
    ...
```

Your own hooks keep working, since AgentSpace's run after them and never change a decision.

To approve tool calls from the office, pass the adapter's permission callback:

```python
from agentspace.adapters.claude_agent_sdk import approval_callback

ClaudeAgentOptions(..., can_use_tool=approval_callback({"mcp__billing__refund"}))
```

**Costs.** The SDK reports the session's billed cost (`total_cost_usd`), so AgentSpace shows that number as reported and never adds a price-table estimate on top of it.

> **Note:** `recording.json` is a *synthetic* session built from the SDK's hook and message schemas. It isn't a capture of a live run, because making one needs an API key. The real mode hasn't been run end-to-end yet for the same reason.
