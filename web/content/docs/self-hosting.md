# Self-hosting and configuration

AgentSpace is two services: the **collector** (Node, port 4800) and the **office** (Next.js, port 4801). Events are kept in SQLite.

## Docker Compose

```bash
docker compose up -d
```

Collector data lives in the `agentspace-data` volume. Released images are published as `ghcr.io/ktececline/agentspace-collector` and `ghcr.io/ktececline/agentspace-web` for amd64 and arm64.

## Collector settings

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `4800`, `0.0.0.0` | where it listens |
| `AGENTSPACE_DB` | `./data/agentspace.db` | the SQLite file |
| `AGENTSPACE_RETENTION_DAYS` | `7` | delete events older than this (`0` keeps everything) |
| `AGENTSPACE_API_KEYS` | (none) | `workspace:key,…` that SDKs must send (`*` = every workspace); see [Security](security) |
| `AGENTSPACE_OPERATOR_TOKEN` | (none) | token for watching and operating from the browser |
| `AGENTSPACE_PUBLIC_READONLY` | `false` | anyone can watch; no payloads, no operator actions |
| `AGENTSPACE_PRICES_FILE` | (none) | extra or corrected model prices ([Costs](costs)) |
| `AGENTSPACE_CORS_ORIGIN` | `*` | allowed browser origins, comma-separated |
| `AGENTSPACE_BODY_LIMIT` | 10 MB | the largest request body |
| `AGENTSPACE_OTLP_CAPTURE_CONTENT` | `false` | keep prompt and output content from OTLP spans |
| `AGENTSPACE_OTLP_HOLD_MS` | `10000` | how long a span waits for its parent |
| `AGENTSPACE_DETECTORS` | on | `off` turns the [detectors](detectors) off |
| `AGENTSPACE_DETECTORS_FILE` | (none) | JSON that tunes or turns off single detectors ([Detectors](detectors)) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

`AGENTSPACE_DATABASE_URL=postgres://…` is reserved for the upcoming Postgres store and isn't supported yet.

## Office settings

| Variable | Default | What it does |
|---|---|---|
| `AGENTSPACE_PUBLIC_URL` | `http://localhost:4800` | the collector URL **as the browser sees it** |
| `AGENTSPACE_WORKSPACE` | `default` | the workspace shown first |

Any page also accepts `?collector=<url>&workspace=<name>`.

## SDK settings

`AGENTSPACE_URL`, `AGENTSPACE_WORKSPACE`, `AGENTSPACE_API_KEY`, and `AGENTSPACE_DISABLED=1` to turn the SDK off.

## Behind a proxy

Serve the office over HTTPS. Put the collector behind the same proxy or its own host, and point `AGENTSPACE_PUBLIC_URL` at it. The office uses a WebSocket (`/v1/ws`), so the proxy must allow upgrades. The approval and control long-polls hold requests for up to 30 s, so give the proxy's read timeout some room above that.

## Building behind a TLS-intercepting network

Pass your company's CA as a build argument: `AGENTSPACE_EXTRA_CA_CERT="$(cat ca.pem)" docker compose build`. It's used only while installing dependencies and never ends up in the images. Details are in `CONTRIBUTING.md`.
