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
| `--story` | The failure story (below). Scripted, no API key. |
| `--baseline N` | With `--story`: how many good runs come first (default 5, the detectors' minimum). |
| `--baseline-latency S` | With `--story`: the fake model's delay in the good runs (default 0.05 s, so they're quick). |

## The failure story (`--story`)

The same team, but this time something goes wrong, and AgentSpace catches it. From the repo root:

```bash
make demo-story    # the collector with policy.json, then: uv run python main.py --story
```

1. **Five good runs** build a baseline (a few seconds).
2. **The regression:** the Engineer's fix is wrong (it now skips the *last* item), and it keeps re-running the tests. On the third failure in a row the `failure_loop` [detector](../../web/content/docs/detectors.md) fires, and the collector's policy pauses the run. The run bar says so.
3. **Look into it:** open **Replay** (the Trace tab, **First error**), then **Compare** it with a good run: the same agent path, but 6 tool calls instead of 4, and 3 failed `run_tests`.
4. **Resume.** The Engineer tries another `write_file`. Normally that's allowed, but this run has findings, so [`policy.json`](policy.json) asks a person first. The card shows why: the rule, the findings, and this run against the usual.
5. **Reject** it with a comment: the Engineer reports back and the run ends as failed. (**Approve** instead and the right fix goes in.)

`policy.json` is a collector policy (pausing on findings only works there). `make demo-story` starts Docker Compose with [`compose.story.yml`](compose.story.yml), which sets `AGENTSPACE_POLICY_FILE`. Running the collector yourself: `AGENTSPACE_POLICY_FILE=examples/langgraph-dev-team/policy.json`. Without a collector policy the story still runs, but nothing pauses or asks.

In story mode the example's tool loop checks each call with `agentspace.adapters.langgraph.guard_tool()` and flushes events after each result, so a finding lands before the Engineer's next step. Those lines are marked "story" in `main.py`.

## The AgentSpace part

These are the only two lines, both in `main.py`:

```python
import agentspace
agentspace.init()   # LangGraph is instrumented automatically
```

Each graph node becomes an agent. The optional `config={"metadata": {"agentspace_team": "Engineering"}}` puts all three at the same desk cluster (by default, the team is the graph's name).

If the collector isn't running, the example still works normally. The SDK logs one warning and buffers a bounded number of events.
