import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
}

/** Opens a pool for `connectionString`. Callers own the pool and must end it. */
export function createDb(connectionString: string, options: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, ...options });
  return { db: drizzle(pool, { schema }), pool };
}
