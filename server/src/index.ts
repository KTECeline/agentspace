import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.dbPath);
const app = await buildApp({ config, store });

const prune = () => {
  if (config.retentionDays <= 0) return;
  const removed = store.prune(config.retentionDays);
  if (removed) app.log.info({ removed, retentionDays: config.retentionDays }, "pruned old events");
};
prune();
const pruneTimer = setInterval(prune, 60 * 60 * 1000);
pruneTimer.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(`AgentSpace collector ready: POST http://localhost:${config.port}/v1/events`);
