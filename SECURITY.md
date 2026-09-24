# Security policy

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/KTECeline/agentspace/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within 5 working days. We'll agree on a fix and a disclosure date with you, and credit you in the advisory unless you'd rather we didn't.

## Supported versions

AgentSpace is pre-1.0. Security fixes go into the latest release only.

## What's in scope

- **The collector** (`server/`): authentication and authorization (API keys, the operator token, public read-only mode), anything that leaks approval payloads or event content in public mode, ingest validation, and denial of service from a single request.
- **The SDKs** (`packages/`): anything that sends content when `capture_content` is off, that bypasses the redaction hook, that makes an approval pass when it should fail closed, or that raises into or blocks the host app.
- **The web app** (`web/`): XSS from event data, and the operator token leaking to anywhere but the configured collector.
- **The release pipeline:** GitHub Actions workflows and the published packages and images.

## Things to know when you deploy it

- With no auth settings, the collector is **open**. That's the intended local default. Set `AGENTSPACE_API_KEYS` and `AGENTSPACE_OPERATOR_TOKEN` (or `AGENTSPACE_PUBLIC_READONLY=true`) before exposing it anywhere (README → "Securing the collector").
- The operator token is kept in the browser's `localStorage` (D-035). Serve the office over HTTPS and only to people you trust.
- Prompts, outputs and tool arguments leave your process only with `capture_content=True`, and go through your `redact` hook. Approval payloads are the one exception, because a person has to see them. They still go through `redact`, and public mode never shows them.
