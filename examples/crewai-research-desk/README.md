# CrewAI research desk

Three CrewAI agents work in sequence: **Researcher** (searches notes with a tool), **Fact Checker**, and **Writer**. In AgentSpace they share the "Research Desk" room. You'll see handoff packets between them, tool calls, and token counts.

```bash
docker compose up -d                  # from the repo root
cd examples/crewai-research-desk
uv run python main.py --fake --runs 0 # scripted LLM, no API key; open http://localhost:4801
```

For a real model, `cp .env.example .env`, add `ANTHROPIC_API_KEY`, then run `uv run python main.py`. The model is any LiteLLM id (`AGENTSPACE_EXAMPLE_MODEL`).

The only AgentSpace code is two lines, `import agentspace` and `agentspace.init()`: the CrewAI adapter turns on automatically. The example switches CrewAI's own telemetry off.
