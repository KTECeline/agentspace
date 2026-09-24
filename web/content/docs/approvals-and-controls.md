# Approvals, pause and cancel

AgentSpace is two-way: agents can ask a person before doing something, and operators can pause, resume or cancel a run from the office.

## Asking for approval

```python
result = agentspace.request_approval_sync(
    "Deploy v1.2 to prod?",          # the reason, shown to everyone who can watch
    {"version": "1.2"},              # the payload, shown to operators only
    timeout=300,                     # seconds
)
if result.approved:
    deploy()
else:
    print(result.decision, result.comment)   # "rejected" or "timeout"
```

In async code, use `await agentspace.request_approval(...)`. While it waits, the agent's desk glows and the request appears in the office's **Approvals** tab (and in the agent's panel). An operator approves or rejects it, optionally with a comment.

**Approvals fail closed.** The result is never "approved" unless a person approved it in time. If the SDK isn't initialized, the collector can't be reached, or the token is refused, the result is `rejected`, with the reason in `result.error`. After the timeout it's `timeout`. A request never hangs past its timeout.

The payload skips the `capture_content` switch, because a person has to see it, but it still passes through your `redact` hook. Public read-only mode never shows it.

**Resolving is idempotent.** Once an approval is decided, a second decision gets `409 Conflict` and records nothing.

## Pause, resume and cancel

The run summary in the office header has **Pause**, **Resume** and **Cancel** (cancel needs a second click). The SDK learns about them within about two seconds, and acts only at **safe points**, never in the middle of a model or tool call:

- entering an `agent()` or `step()` scope;
- `agentspace.checkpoint()` (sync) or `await agentspace.acheckpoint()` (async), which you can call anywhere;
- the adapters' own hooks (see below).

**Pause** blocks at the next safe point until someone resumes. It never blocks the event loop: async code waits in `acheckpoint()`.

**Cancel** raises `agentspace.Cancelled` at the next safe point. It subclasses `BaseException`, like `asyncio.CancelledError`, so `except Exception` can't swallow it by accident. The run finishes with status `cancelled`. If you'd rather check yourself, use `init(cancel_mode="flag")` and poll `agentspace.is_cancelled()`. Cancelling is final for that run.

```python
try:
    with agentspace.run("nightly"):
        for item in items:
            agentspace.checkpoint()      # pause here; raises Cancelled once cancelled
            process(item)
except agentspace.Cancelled:
    print("stopped from the office")
```

## Adapters

| Framework | Safe points | Approvals |
|---|---|---|
| LangGraph | automatic: node, model and tool starts | `adapters.langgraph.request_approval_sync` (attaches it to the calling node) |
| OpenAI Agents SDK | cancel automatic; pause needs `hooks=ControlHooks()` | `request_approval` |
| CrewAI | `Crew(..., step_callback=step_checkpoint)` | `request_approval_sync` |
| Claude Agent SDK | its PreToolUse hook (automatic with `instrument_options`) | `can_use_tool=approval_callback({...})` |
| TypeScript SDK | scopes check for cancel; `await checkpoint()` to pause | `await requestApproval(...)` |

## Who can do this

Operator actions need the operator token when auth is configured, and are refused in public read-only mode. See [Security and auth](security).
