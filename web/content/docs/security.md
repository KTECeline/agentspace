# Security and auth

With no settings, the collector is **open**: that's the local, two-minute default. Configure it before it's reachable by anyone else.

## The three settings

| Setting | Effect |
|---|---|
| `AGENTSPACE_API_KEYS=ws:key,…` | SDKs must send a key for their workspace (`AGENTSPACE_API_KEY`). `*:key` works for every workspace. |
| `AGENTSPACE_OPERATOR_TOKEN` | needed to watch, approve, pause and cancel. The office asks for it (the key button). |
| `AGENTSPACE_PUBLIC_READONLY=true` | anyone can watch. Approval details are hidden, and every operator action is refused, even with a token. |

As soon as any of these is set, reading a workspace needs a token (the operator token, or that workspace's key). A workspace key may also operate its own workspace, for automation. Tokens are compared in constant time.

**Browsers:** the WebSocket is authenticated by its first message, not the URL (URLs end up in logs). The operator token is kept in `localStorage` and only sent to the configured collector. Serve the office over HTTPS, to people you trust.

## What leaves your app

- **By default, metadata only:** agent names and statuses, token counts, model and tool names, durations, and short summaries.
- **Content** (prompts, outputs, tool arguments and results) only with `capture_content=True`, and always through your `redact(field, value)` hook.
- **Approval payloads** skip `capture_content`, because a person has to see them, but still go through `redact`, and public mode never shows them.

## Public read-only mode

Payloads are stripped on every read path: REST, the WebSocket, and the event log. The stats API returns aggregates only. Use it for a wall display or a demo.

## Reporting a vulnerability

Please report privately: see `SECURITY.md` in the repository.
