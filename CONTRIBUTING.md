# Contributing to AgentSpace

Thanks for helping. This page covers the dev setup, how changes are made, pull requests, and
one network workaround. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Found a security problem? Don't open an issue: see [SECURITY.md](SECURITY.md).

**Where to start.** Issues labelled
[`good first issue`](https://github.com/KTECeline/agentspace/labels/good%20first%20issue) are
small and self-contained. New framework adapters are very welcome: open an issue with the
"Adapter request" template first, so we can agree on the framework's official hook.

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

## Pull requests

1. For anything bigger than a small fix, open an issue first, so we agree on the approach.
2. Branch from `main`. Keep the PR to one change, split into conventional commits.
3. Before pushing: `make test && make lint typecheck`, and `make gen-types` if you touched
   `spec/`. CI also runs every example without a collector, a secret scan, and a Docker build.
4. Fill in the PR template. Include a screenshot or GIF for UI changes, and the benchmark
   numbers (`bench/`) if you touched the SDK's hot path.

What reviewers look for:
- tests for new behaviour, including the failure paths;
- no new runtime dependency in the Python SDK (it has none, D-008), and a stated reason for
  any other new dependency;
- UI colors from the tokens in `web/app/globals.css`, with light and dark mode, real
  `<button>`s, visible focus, and loading, empty and error states;
- docs updated: README, `docs/`, and the example READMEs.

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
