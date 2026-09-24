# LangGraph dev team

Three LangGraph agents fix a seeded bug in a tiny cart module (`demo_app/cart.py`) while you watch them in AgentSpace:

- **Manager** decides who works next.
- **Triage** reproduces the bug and finds the root cause (`run_tests`, `read_file`).
- **Engineer** patches the file and checks that the tests pass (`write_file`, `run_tests`).

Each run works on a fresh temporary copy of `demo_app/`, so you can run it as many times as you like.

## Run it

```bash
docker compose up -d          # from the repo root: collector on :4800, office on :4801
cd examples/langgraph-dev-team
uv run python main.py --fake  # scripted model: no API key, no network
```

Open http://localhost:4801 and watch the agents hand work to each other.

To use real Claude:

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY
uv run python main.py
```

| Flag | Meaning |
|---|---|
| `--fake` | Use the scripted model in `scripted.py`. It's deterministic and free. |
| `--approve` | The Engineer asks you in the office (Approvals tab) before writing a file. Rejected or timed out means the file isn't written. |
| `--runs N` | Run N times (`0` = forever, handy for a live demo). |
| `--latency S` | Delay per fake model call, so the office has time to animate (default 0.8 s). |

## The AgentSpace part

These are the only two lines, both in `main.py`:

```python
import agentspace
agentspace.init()   # LangGraph is instrumented automatically
```

Each graph node becomes an agent. The optional `config={"metadata": {"agentspace_team": "Engineering"}}` puts all three at the same desk cluster (by default, the team is the graph's name).

If the collector isn't running, the example still works normally. The SDK logs one warning and buffers a bounded number of events.
