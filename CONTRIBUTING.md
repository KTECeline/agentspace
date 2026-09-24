# Contributing to AgentSpace

Thanks for helping. This page covers the dev setup, how changes are made, and one network
workaround.

## Setup

You need Node 22+, pnpm (via `corepack enable`), [uv](https://docs.astral.sh/uv/), and Docker
for the done-check.

```bash
make install        # JS + Python deps
make dev            # collector (:4800) + web (:4801) with hot reload
make test           # pytest + vitest
make lint typecheck # ruff, mypy, eslint, tsc
make demo-check     # the end-to-end done-check (Docker)
```

Framework adapters are tested one framework at a time, because their dependencies conflict:

```bash
cd packages/sdk-python
uv run --group crewai pytest tests/test_crewai_adapter.py
```

## How changes are made

- **The spec comes first.** `spec/v0.1/event.schema.json` is the source of truth. After editing
  it, run `make gen-types` and commit the generated types with it. Additive changes only within
  a spec version; note them in `spec/CHANGELOG.md`.
- **Adapters use each framework's official extension points** (callbacks, tracing processors,
  event listeners, hooks). Check the framework's current docs first, and never monkeypatch.
- **The SDKs must never break the host app.** Every public call catches its own errors, memory
  is bounded, and nothing blocks the caller, except `request_approval` and `checkpoint`, which
  block on purpose. Approvals fail closed. Add a reliability test for anything that talks to the
  network.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(server): ...`, `fix(sdk-ts): ...`), one working step per commit.
- Record design decisions in `docs/DECISIONS.md` (the next `D-NNN`).

## Building behind a TLS-intercepting proxy

Some corporate networks intercept TLS with their own certificate authority, so `pnpm install`
inside `docker build` fails with certificate errors. Don't disable TLS verification. Instead,
give the build your company's CA certificate:

```bash
export AGENTSPACE_EXTRA_CA_CERT="$(cat ~/certs/company-root-ca.pem)"
docker compose build
```

What this does:

- It's **off by default**. When `AGENTSPACE_EXTRA_CA_CERT` is unset, the build is unchanged.
- Compose passes it as the `EXTRA_CA_CERT` build arg. The build stage writes it to a temporary
  file and sets `NODE_EXTRA_CA_CERTS` for the install and build steps only. The runtime images
  never contain it.
- Without compose: `docker build --build-arg EXTRA_CA_CERT="$(cat ca.pem)" -f server/Dockerfile .`

**Never commit a certificate.** Keep it outside the repo. `.gitignore` ignores `*.pem`, `*.crt`
and `*.key` as a safety net. Get the certificate from your IT team, or export it from your OS
trust store.
