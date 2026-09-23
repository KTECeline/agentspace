export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Delete events older than this many days. 0 disables pruning. */
  retentionDays: number;
  corsOrigin: string;
  /** Max request body in bytes (a 1000-event batch with content can be large). */
  bodyLimit: number;
  logLevel: string;
  /** OTLP: forward prompt/response content found in gen_ai.* attributes (off = privacy by default). */
  otlpCaptureContent: boolean;
  /** OTLP: how long to hold a span waiting for its parent (ms). */
  otlpHoldMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 4800),
    dbPath: env.AGENTSPACE_DB ?? "./data/agentspace.db",
    retentionDays: Number(env.AGENTSPACE_RETENTION_DAYS ?? 7),
    corsOrigin: env.AGENTSPACE_CORS_ORIGIN ?? "*",
    bodyLimit: Number(env.AGENTSPACE_BODY_LIMIT ?? 10 * 1024 * 1024),
    logLevel: env.LOG_LEVEL ?? "info",
    otlpCaptureContent: ["1", "true", "yes"].includes((env.AGENTSPACE_OTLP_CAPTURE_CONTENT ?? "").toLowerCase()),
    otlpHoldMs: Number(env.AGENTSPACE_OTLP_HOLD_MS ?? 10_000),
  };
}
