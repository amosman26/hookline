import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, deliveries, events, projects } from "@hookline/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";

describeWithDb("events API", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  let key: string;
  let otherKey: string;
  const originalUrl = process.env.DATABASE_URL;

  async function projectWithKey(name: string): Promise<string> {
    const [project] = await testDb.db.insert(projects).values({ name }).returning();
    if (!project) throw new Error("insert returned no row");
    const generated = generateApiKey();
    await testDb.db.insert(apiKeys).values({
      projectId: project.id,
      name: "test",
      prefix: generated.prefix,
      keyHash: generated.hash,
    });
    return generated.key;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    key = await projectWithKey("Acme");
    otherKey = await projectWithKey("Globex");

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env.DATABASE_URL = originalUrl;
    await testDb?.drop();
  });

  const post = (path: string, as: string = key) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${as}`);

  async function createEndpoint(eventTypes: string[], extra: object = {}, as = key) {
    const res = await post("/v1/endpoints", as)
      .send({ url: "https://example.com/hooks", eventTypes, ...extra })
      .expect(201);
    return res.body as { id: string };
  }

  it("requires an API key", async () => {
    await request(app.getHttpServer())
      .post("/v1/events")
      .send({ type: "invoice.paid", payload: {} })
      .expect(401);
  });

  it("stores the event and fans it out to every subscribed, enabled endpoint", async () => {
    const billing = await createEndpoint(["invoice.paid", "invoice.created"]);
    const audit = await createEndpoint(["invoice.paid", "user.created"]);
    await createEndpoint(["user.created"]);
    await createEndpoint(["invoice.paid"], { enabled: false });
    await createEndpoint(["invoice.paid"], {}, otherKey);

    const payload = { id: "inv_1", amount: 1200, currency: "AED" };
    const res = await post("/v1/events").send({ type: "invoice.paid", payload }).expect(202);

    expect(res.body).toEqual({
      id: expect.any(String),
      type: "invoice.paid",
      createdAt: expect.any(String),
      deliveries: [
        { id: expect.any(String), endpointId: billing.id, status: "pending" },
        { id: expect.any(String), endpointId: audit.id, status: "pending" },
      ],
    });

    const [stored] = await testDb.db.select().from(events).where(eq(events.id, res.body.id));
    expect(stored).toMatchObject({ type: "invoice.paid", payload, idempotencyKey: null });

    const rows = await testDb.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.eventId, res.body.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        projectId: stored?.projectId,
        status: "pending",
        attemptCount: 0,
      });
    }
  });

  it("accepts an event nobody subscribes to, with no deliveries", async () => {
    const res = await post("/v1/events")
      .send({ type: "nobody.listens", payload: { ok: true } })
      .expect(202);
    expect(res.body.deliveries).toEqual([]);

    const [stored] = await testDb.db.select().from(events).where(eq(events.id, res.body.id));
    expect(stored?.type).toBe("nobody.listens");
  });

  it("matches event types exactly, without prefixes or wildcards", async () => {
    await createEndpoint(["order.shipped"]);
    const res = await post("/v1/events").send({ type: "order", payload: {} }).expect(202);
    expect(res.body.deliveries).toEqual([]);
  });

  it("rejects an invalid body with every problem listed and stores nothing", async () => {
    const before = await testDb.db.$count(events);
    const res = await post("/v1/events").send({ type: "bad type", payload: [] }).expect(400);
    expect(res.body.message).toEqual([
      expect.stringMatching(/^type must be/),
      "payload must be a JSON object",
    ]);
    expect(await testDb.db.$count(events)).toBe(before);
  });
});
