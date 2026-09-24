# OpenAI Agents SDK support desk

**Triage** hands the customer off to **Billing** (which uses a `lookup_invoice` tool) or **Tech Support**. In AgentSpace you see the handoff packet fly from Triage to Billing, the tool call, and tokens per agent.

```bash
docker compose up -d                   # from the repo root
cd examples/openai-agents-handoffs
uv run python main.py --fake --runs 0  # scripted model, no API key; open http://localhost:4801
```

For real models, add `OPENAI_API_KEY` to `.env` and run `uv run python main.py`.

AgentSpace plugs into the SDK's official tracing processor (`agents.add_trace_processor`), so there are only two lines: `import agentspace` and `agentspace.init()`. `trace_metadata={"agentspace_team": ...}` names the room.
