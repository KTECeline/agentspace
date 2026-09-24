import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createStore } from "./store/index.js";

const config = loadConfig();
const store = await createStore(config);
const app = await buildApp({ config, store });

const prune = async () => {
  if (config.retentionDays <= 0) return;
  const removed = await store.prune(config.retentionDays);
  if (removed) app.log.info({ removed, retentionDays: config.retentionDays }, "pruned old events");
};
await prune();
const pruneTimer = setInterval(() => void prune(), 60 * 60 * 1000);
pruneTimer.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(`AgentSpace collector ready: POST http://localhost:${config.port}/v1/events`);
