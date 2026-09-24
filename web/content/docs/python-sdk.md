# Python SDK

```bash
pip install agentspace-sdk     # import agentspace; Python 3.10+, no runtime dependencies
```

## init

```python
import agentspace

agentspace.init(
    url="http://localhost:4800",   # or AGENTSPACE_URL
    workspace="default",           # or AGENTSPACE_WORKSPACE
    api_key=None,                  # or AGENTSPACE_API_KEY, when the collector requires keys
    capture_content=False,         # send prompts, outputs and tool arguments?
    redact=None,                   # redact(field, value) -> value, applied to every content value
    auto_instrument=True,          # turn on the adapters for installed frameworks
    enabled=None,                  # False (or AGENTSPACE_DISABLED=1) makes every call a no-op
    cancel_mode="raise",           # or "flag": see Approvals, pause and cancel
)
```

Advanced transport options: `max_queue` (default 10,000 events), `max_batch` (100), `flush_interval`, `timeout` (2 s), `max_content_chars`.

## Scopes

```python
@agentspace.agent(team="research", role="finds sources")
def researcher(query): ...                     # sync or async

with agentspace.run("weekly-report"):          # one task; everything inside shares its run id
    with agentspace.step("gather"):            # a unit of work (start + finish events)
        researcher("agent observability")
    with agentspace.agent("Reviewer", team="qa"):
        review()
```

`run`, `agent` and `step` work as sync and async context managers (`async with`), and `agent` also works as a decorator. The agent's id is the slug of its name. When one agent runs inside another, a handoff is recorded. Context is kept in `contextvars`, so asyncio tasks started inside a scope inherit it. New threads don't: run their work with `contextvars.copy_context().run(...)` to keep the run and agent.

## Events

```python
agentspace.set_status("waiting", "rate limited")          # the current agent's status
agentspace.handoff("writer", "draft is ready")            # from the current agent
agentspace.emit("message", {"text": "hi"}, summary="said hi")
agentspace.emit("llm.call", {"provider": "anthropic"}, model="claude-haiku-4-5",
                tokens_in=1200, tokens_out=80)            # priced by the collector (est.)
```

`emit()` sends any event from the [spec](event-spec). Envelope fields default to the current context. Keyword fields: `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`, `cost_usd`, `cost_source`, `model`, `summary`, `attributes`.

## Approvals and controls

`request_approval_sync()`, `await request_approval()`, `checkpoint()`, `await acheckpoint()`, `is_cancelled()` and `agentspace.Cancelled`: see [Approvals, pause and cancel](approvals-and-controls).

## Lifecycle

```python
agentspace.flush(timeout=2.0)     # wait until the queue is sent; True if it drained
agentspace.stats()                # {"sent", "dropped", "rejected", "pending"}
agentspace.shutdown()             # flush and stop (also runs at interpreter exit)
```

## Guarantees

- **It never raises into your code.** Every public call catches its own errors and logs them once. Your own exceptions pass through scopes unchanged. The one deliberate exception is `Cancelled`.
- **It never blocks you.** `emit()` appends to an in-memory queue; a background thread sends batches. p99 is under 250 µs per call with a collector ([benchmarks](benchmarks)).
- **Memory is bounded.** If the collector is down, the newest `max_queue` events are kept and the oldest dropped, with one warning. Sending resumes with backoff when it's back.
