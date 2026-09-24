import type { Store } from "./types.js";

/** Postgres store. Implemented in Phase 4a once the `pg` driver can be installed. */
export const PostgresStore = {
  async connect(_url: string): Promise<Store> {
    throw new Error("Postgres support is not built yet (needs the `pg` driver). Unset AGENTSPACE_DATABASE_URL to use SQLite.");
  },
};
