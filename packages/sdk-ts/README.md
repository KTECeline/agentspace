# agentspace-sdk (TypeScript)

Watch your TypeScript agents work in the [AgentSpace](https://github.com/KTECeline/agentspace) office.

```bash
npm i agentspace-sdk
```

```ts
import * as agentspace from "agentspace-sdk";

agentspace.init(); // AGENTSPACE_URL, default http://localhost:4800

await agentspace.run("weekly-report", async () => {
  await agentspace.agent({ name: "Researcher", team: "research" }, async () => {
    agentspace.setStatus("using_tool", "web_search");
    const hits = await search("agent observability");
    agentspace.emit("llm.call", { provider: "anthropic" }, { model: "claude-sonnet-5", tokens_in: 1200, tokens_out: 90 });
    await agentspace.agent({ name: "Writer", team: "research" }, () => write(hits)); // records a handoff
  });
});
```

| API | What it does |
|---|---|
| `init(options?)` | Start sending. Options: `url`, `workspace`, `apiKey`, `captureContent`, `redact`, `enabled` |
| `run(name, fn)` / `agent(opts, fn)` / `step(name, fn)` | Run `fn` (sync or async) in a scope. Results and errors pass through unchanged |
| `wrapAgent(opts, fn)` | Make a function that always runs as that agent |
| `setStatus(status, detail?)`, `handoff(to, reason?)`, `emit(type, data, fields?)` | Record events in the current scope |
| `flush()`, `shutdown()`, `stats()` | Lifecycle and counters |

The same guarantees as the Python SDK apply:
- `emit()` is an O(1) in-memory push, and sending happens in the background with `fetch`.
- Memory is bounded: when the queue is full, the oldest events are dropped.
- The SDK never throws into your code.
- If the collector is down, your app keeps running and you get one warning.
- Content (prompts, outputs) is only sent with `captureContent: true`.

Context flows through `AsyncLocalStorage` (Node 20+ and edge runtimes that provide it), so concurrent agents don't mix up their events.

It has no runtime dependencies and ships as ESM + CJS with types.

**Already using OpenTelemetry?** (For example, the Vercel AI SDK with `experimental_telemetry`.) You may not need this SDK at all: point your OTLP exporter at `http://localhost:4800/v1/traces`.
