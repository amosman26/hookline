import { randomUUID } from "node:crypto";
import { createDb, runMigrations, type DbHandle } from "@hookline/db";
import { Client } from "pg";

// Integration tests run against a real Postgres (CI provides one). Each suite
// creates its own throwaway database so it never touches development data.
export const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI");
}

/** `describe` when a database is available, `describe.skip` otherwise. */
export const describeWithDb = baseDatabaseUrl ? describe : describe.skip;

export interface TestDatabase extends DbHandle {
  url: string;
  drop(): Promise<void>;
}

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseDatabaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Creates and migrates a fresh database. Call `drop()` in afterAll. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL is not set");
  const name = `hookline_test_${randomUUID().replaceAll("-", "")}`;
  await admin(`CREATE DATABASE "${name}"`);

  const parsed = new URL(baseDatabaseUrl);
  parsed.pathname = `/${name}`;
  const url = parsed.toString();
  await runMigrations(url);

  const handle = createDb(url);
  return {
    ...handle,
    url,
    async drop() {
      await handle.pool.end();
      await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
