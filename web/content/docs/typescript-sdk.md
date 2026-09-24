# TypeScript SDK

```bash
npm i agentspace-sdk     # Node 20+, no runtime dependencies; ESM and CommonJS
```

The same model as the [Python SDK](python-sdk): scopes, events, approvals, the same guarantees. Scopes take a callback, and context follows `await` through `AsyncLocalStorage`.

```ts
import * as agentspace from "agentspace-sdk";

agentspace.init({ url: "http://localhost:4800", workspace: "default" }); // or AGENTSPACE_URL / AGENTSPACE_WORKSPACE

await agentspace.run("weekly-report", async () => {
  await agentspace.agent({ name: "Researcher", team: "research" }, async () => {
    await agentspace.step("gather", async () => {
      agentspace.emit("llm.call", { provider: "openai" }, { model: "gpt-5-mini", tokens_in: 900, tokens_out: 40 });
    });
    agentspace.setStatus("waiting", "rate limited");
    agentspace.handoff("writer", "draft is ready");
  });
});

const research = agentspace.wrapAgent({ name: "Researcher" }, async (q: string) => { /* ... */ });
```

## init options

`url`, `workspace`, `apiKey`, `captureContent`, `redact`, `enabled` (or `AGENTSPACE_DISABLED=1`), `cancelMode` (`"raise"` or `"flag"`), and the transport settings `maxQueue`, `maxBatch`, `flushIntervalMs`, `timeoutMs`, `maxContentChars`.

## Approvals and controls

```ts
const result = await agentspace.requestApproval("Deploy v1.2?", { version: "1.2" }, { timeoutMs: 300_000 });
if (result.approved) await deploy();

await agentspace.checkpoint();               // waits while paused; throws Cancelled once cancelled
try { /* ... */ } catch (err) {
  if (agentspace.isCancelled(err)) throw err; // rethrow from catch-all blocks
}
```

JavaScript has no `BaseException`, so use `isCancelled(err)` to rethrow from catch-all blocks. Scopes check for cancel as they start; pausing needs `await checkpoint()`. Approvals fail closed, as in Python.

## Lifecycle

`await flush()`, `stats()`, `await shutdown()`.

The SDK never throws into your code or blocks it: `emit()` is under 5 µs at p99 with a collector ([benchmarks](benchmarks)).
