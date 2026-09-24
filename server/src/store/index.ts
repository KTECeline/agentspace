import type { Config } from "../config.js";
import { SqliteStore } from "./sqlite.js";
import type { Store } from "./types.js";

export type { Store } from "./types.js";
export { SqliteStore } from "./sqlite.js";

/** SQLite by default; Postgres when AGENTSPACE_DATABASE_URL is a postgres:// URL. */
export async function createStore(config: Config): Promise<Store> {
  if (config.databaseUrl && /^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    const { PostgresStore } = await import("./postgres.js");
    return PostgresStore.connect(config.databaseUrl);
  }
  return new SqliteStore(config.dbPath);
}
