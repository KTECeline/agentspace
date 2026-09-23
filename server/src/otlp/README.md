# OTLP ingest

`POST /v1/traces` accepts OTLP/HTTP traces as JSON or protobuf (optionally gzipped). Spans that follow the OpenTelemetry GenAI semantic conventions are turned into AgentSpace events. The mapping is documented in `spec/README.md`.

- `protoSources.ts`: the OTLP `.proto` files embedded as strings (opentelemetry-proto v1.11.0). To update them, fetch `common`, `resource`, `trace` and `collector/trace/v1/trace_service` from the upstream repo and re-embed them.
- `decode.ts`: JSON and protobuf are both normalized to a single `OtlpSpan` shape.
- `assembler.ts`: spans are turned into events. It holds child spans briefly until their parent span arrives, because exporters send spans when they *end*, so children usually arrive before their parents.
