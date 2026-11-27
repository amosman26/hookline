import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, events, projects } from "@hookline/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";
import { itWithRedis } from "./support/test-redis";

async function projectWithKey(testDb: TestDatabase, name: string) {
  const [project] = await testDb.db.insert(projects).values({ name }).returning();
  if (!project) throw new Error("insert returned no row");
  const generated = generateApiKey();
  await testDb.db.insert(apiKeys).values({
    projectId: project.id,
    name: "test",
    prefix: generated.prefix,
    keyHash: generated.hash,
  });
  return { projectId: project.id, key: generated.key };
}

async function startApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** A port nothing listens on: bind one, then close it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

describeWithDb("ingestion rate limit", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.QUEUE_PREFIX = `test-rate-limit-${randomUUID()}`;
    process.env.INGEST_RATE_LIMIT = "3";
    process.env.INGEST_RATE_WINDOW_SECONDS = "2";
    app = await startApp();
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
    await testDb?.drop();
  });

  const send = (key: string, type = "invoice.paid") =>
    request(app.getHttpServer())
      .post("/v1/events")
      .set("Authorization", `Bearer ${key}`)
      .send({ type, payload: { n: 1 } });

  const storedEvents = async (projectId: string) =>
    (await testDb.db.select().from(events).where(eq(events.projectId, projectId))).length;

  itWithRedis("lets each key send up to the limit, then answers 429", async () => {
    const { projectId, key } = await projectWithKey(testDb, "Acme");

    for (const remaining of [2, 1, 0]) {
      const res = await send(key).expect(202);
      expect(res.headers["ratelimit-limit"]).toBe("3");
      expect(res.headers["ratelimit-remaining"]).toBe(String(remaining));
      expect(Number(res.headers["ratelimit-reset"])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers["ratelimit-reset"])).toBeLessThanOrEqual(2);
    }

    const refused = await send(key).expect(429);
    expect(refused.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.body).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
    expect(await storedEvents(projectId)).toBe(3);
  });

  itWithRedis("counts each API key separately", async () => {
    const acme = await projectWithKey(testDb, "Acme 2");
    const globex = await projectWithKey(testDb, "Globex");

    for (let i = 0; i < 3; i++) await send(acme.key).expect(202);
    await send(acme.key).expect(429);
    await send(globex.key).expect(202);
  });

  itWithRedis("starts a fresh window once the old one expires", async () => {
    const { key } = await projectWithKey(testDb, "Initech");

    for (let i = 0; i < 3; i++) await send(key).expect(202);
    const refused = await send(key).expect(429);
    await sleep(Number(refused.headers["retry-after"]) * 1000 + 100);

    const res = await send(key).expect(202);
    expect(res.headers["ratelimit-remaining"]).toBe("2");
  });

  itWithRedis("stays exact under concurrent requests", async () => {
    const { projectId, key } = await projectWithKey(testDb, "Hooli");

    const statuses = (await Promise.all(Array.from({ length: 8 }, () => send(key)))).map(
      (res) => res.status,
    );
    expect(statuses.filter((s) => s === 202)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(await storedEvents(projectId)).toBe(3);
  });

  itWithRedis("limits ingestion only", async () => {
    const { key } = await projectWithKey(testDb, "Umbrella");

    for (let i = 0; i < 4; i++) await send(key);
    const res = await request(app.getHttpServer())
      .get("/v1/project")
      .set("Authorization", `Bearer ${key}`)
      .expect(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });

  itWithRedis("checks the API key before counting", async () => {
    const res = await send("hl_live_not-a-real-key").expect(401);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});

describeWithDb("ingestion rate limit without Redis", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = `redis://127.0.0.1:${await freePort()}`;
    process.env.INGEST_RATE_LIMIT = "1";
    app = await startApp();
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
    await testDb?.drop();
  });

  it("fails open: events are still accepted, uncounted", async () => {
    const { projectId, key } = await projectWithKey(testDb, "Acme");

    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer())
        .post("/v1/events")
        .set("Authorization", `Bearer ${key}`)
        .send({ type: "invoice.paid", payload: {} })
        .expect(202);
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
    }
    const stored = await testDb.db.select().from(events).where(eq(events.projectId, projectId));
    expect(stored).toHaveLength(2);
  }, 15_000);
});

describeWithDb("ingestion rate limit switched off", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.QUEUE_PREFIX = `test-rate-limit-off-${randomUUID()}`;
    process.env.INGEST_RATE_LIMIT = "0";
    app = await startApp();
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
    await testDb?.drop();
  });

  itWithRedis("sends no rate-limit headers and never refuses", async () => {
    const { key } = await projectWithKey(testDb, "Acme");
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post("/v1/events")
        .set("Authorization", `Bearer ${key}`)
        .send({ type: "invoice.paid", payload: {} })
        .expect(202);
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
    }
  });
});
