import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, projects } from "@hookline/db";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";

describeWithDb("API key authentication", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  const originalUrl = process.env.DATABASE_URL;

  async function insertKey(revoked = false): Promise<{ key: string; id: string }> {
    const generated = generateApiKey();
    const [row] = await testDb.db
      .insert(apiKeys)
      .values({
        projectId,
        name: "test",
        prefix: generated.prefix,
        keyHash: generated.hash,
        revokedAt: revoked ? new Date() : null,
      })
      .returning({ id: apiKeys.id });
    if (!row) throw new Error("insert returned no row");
    return { key: generated.key, id: row.id };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;

    const [project] = await testDb.db.insert(projects).values({ name: "Acme" }).returning();
    if (!project) throw new Error("insert returned no row");
    projectId = project.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env.DATABASE_URL = originalUrl;
    await testDb?.drop();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it("returns the key's project for a valid key", async () => {
    const { key } = await insertKey();
    const res = await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(200);
    expect(res.body).toMatchObject({ id: projectId, name: "Acme" });
  });

  it("rejects a request without an Authorization header", async () => {
    const res = await get("/v1/project").expect(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="hookline"');
    expect(res.body.message).toBe("Missing or invalid API key");
  });

  it.each([
    ["a non-Bearer scheme", (key: string) => `Basic ${key}`],
    ["a malformed key", () => "Bearer hl_live_short"],
    ["a key from another service", () => `Bearer sk_live_${"a".repeat(43)}`],
  ])("rejects %s", async (_label, header) => {
    const { key } = await insertKey();
    await get("/v1/project").set("Authorization", header(key)).expect(401);
  });

  it("rejects a well-formed key that was never issued", async () => {
    const { key } = generateApiKey();
    await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(401);
  });

  it("rejects a revoked key", async () => {
    const { key } = await insertKey(true);
    await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(401);
  });

  it("records when a key was last used, at most once a minute", async () => {
    const { key, id } = await insertKey();
    const lastUsed = async () => {
      const [row] = await testDb.db
        .select({ at: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, id));
      return row?.at ?? null;
    };

    expect(await lastUsed()).toBeNull();
    await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(200);
    const first = await lastUsed();
    expect(first).toBeInstanceOf(Date);

    await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(200);
    expect(await lastUsed()).toEqual(first);

    await testDb.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now() - interval '2 minutes'` })
      .where(eq(apiKeys.id, id));
    const stale = await lastUsed();
    await get("/v1/project").set("Authorization", `Bearer ${key}`).expect(200);
    expect((await lastUsed())?.getTime()).toBeGreaterThan(stale?.getTime() ?? 0);
  });

  it("keeps /health public", async () => {
    await get("/health").expect(200);
  });
});
