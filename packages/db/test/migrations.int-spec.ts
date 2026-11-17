import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import {
  apiKeys,
  createDb,
  endpoints,
  events,
  projects,
  runMigrations,
  type DbHandle,
} from "../src";

// Integration tests run against a real Postgres (CI provides one). Each run
// creates its own throwaway database so it never touches development data.
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl && process.env.CI) {
  throw new Error("DATABASE_URL must be set in CI");
}
const describeWithDb = baseUrl ? describe : describe.skip;

describeWithDb("migrations", () => {
  const dbName = `hookline_test_${randomUUID().replaceAll("-", "")}`;
  let url: string;
  let handle: DbHandle;

  async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: baseUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE "${dbName}"`));
    const parsed = new URL(baseUrl as string);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    await runMigrations(url);
    handle = createDb(url);
  });

  afterAll(async () => {
    await handle?.pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
  });

  async function newProject(): Promise<string> {
    const [row] = await handle.db.insert(projects).values({ name: "Acme" }).returning();
    if (!row) throw new Error("insert returned no row");
    return row.id;
  }

  it("creates the core tables", async () => {
    const { rows } = await handle.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["api_keys", "endpoints", "events", "projects"]);
  });

  it("is safe to run again", async () => {
    await expect(runMigrations(url)).resolves.toBeUndefined();
  });

  it("applies defaults to new endpoints", async () => {
    const projectId = await newProject();
    const [endpoint] = await handle.db
      .insert(endpoints)
      .values({ projectId, url: "https://example.com/hooks", secret: "whsec_test" })
      .returning();
    expect(endpoint).toMatchObject({ enabled: true, eventTypes: [], description: null });
  });

  it("rejects two API keys with the same hash", async () => {
    const projectId = await newProject();
    const key = { projectId, name: "ci", prefix: "hl_live_abcd", keyHash: "a".repeat(64) };
    await handle.db.insert(apiKeys).values(key);
    await expect(handle.db.insert(apiKeys).values(key)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505" }),
    });
  });

  it("scopes idempotency keys to a project and ignores events without one", async () => {
    const a = await newProject();
    const b = await newProject();
    const event = { type: "order.paid", payload: { id: 1 }, idempotencyKey: "k-1" };

    await handle.db.insert(events).values({ ...event, projectId: a });
    await handle.db.insert(events).values({ ...event, projectId: b });
    await expect(handle.db.insert(events).values({ ...event, projectId: a })).rejects.toMatchObject(
      {
        cause: expect.objectContaining({ code: "23505" }),
      },
    );

    const keyless = { projectId: a, type: "order.paid", payload: {} };
    await handle.db.insert(events).values([keyless, keyless]);
  });

  it("deletes a project's rows with the project", async () => {
    const projectId = await newProject();
    await handle.db.insert(events).values({ projectId, type: "user.created", payload: {} });
    await handle.db.delete(projects).where(eq(projects.id, projectId));
    const left = await handle.db.select().from(events).where(eq(events.projectId, projectId));
    expect(left).toHaveLength(0);
  });
});
