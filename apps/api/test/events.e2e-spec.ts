import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, deliveries, events, projects } from "@hookline/db";
import { DELIVERY_QUEUE, type DeliveryJobData } from "@hookline/queue";
import { Queue } from "bullmq";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";
import { itWithRedis, redisUrl } from "./support/test-redis";

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

  itWithRedis("queues one job per delivery, keyed by the delivery id", async () => {
    await createEndpoint(["refund.issued"]);
    await createEndpoint(["refund.issued"]);
    const res = await post("/v1/events")
      .send({ type: "refund.issued", payload: { id: "re_1" } })
      .expect(202);
    const ids = (res.body.deliveries as { id: string }[]).map((d) => d.id);
    expect(ids).toHaveLength(2);

    const queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, { connection: { url: redisUrl } });
    try {
      for (const id of ids) {
        const job = await queue.getJob(id);
        expect(job?.data).toEqual({ deliveryId: id });
        await job?.remove();
      }
    } finally {
      await queue.close();
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
  describe("Idempotency-Key", () => {
    const send = (idempotencyKey: string, body: object, as: string = key) =>
      post("/v1/events", as).set("Idempotency-Key", idempotencyKey).send(body);

    it("stores the key with the event and marks a first request as not replayed", async () => {
      await createEndpoint(["idem.first"]);
      const res = await send("first-1", { type: "idem.first", payload: { n: 1 } }).expect(202);
      expect(res.headers["idempotent-replayed"]).toBeUndefined();

      const [stored] = await testDb.db.select().from(events).where(eq(events.id, res.body.id));
      expect(stored?.idempotencyKey).toBe("first-1");
    });

    it("returns the original event for a retry and creates no new event or delivery", async () => {
      const endpoint = await createEndpoint(["idem.retry"]);
      const body = { type: "idem.retry", payload: { id: "inv_9", amount: 5, tags: ["a"] } };
      const first = await send("retry-1", body).expect(202);
      const eventsBefore = await testDb.db.$count(events);
      const deliveriesBefore = await testDb.db.$count(deliveries);

      // Same payload with keys in a different order is the same event.
      const retry = await send("retry-1", {
        payload: { tags: ["a"], amount: 5, id: "inv_9" },
        type: "idem.retry",
      }).expect(202);

      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.body).toEqual(first.body);
      expect(retry.body.deliveries).toEqual([
        { id: expect.any(String), endpointId: endpoint.id, status: "pending" },
      ]);
      expect(await testDb.db.$count(events)).toBe(eventsBefore);
      expect(await testDb.db.$count(deliveries)).toBe(deliveriesBefore);
    });

    it("reports the deliveries' current status on a retry", async () => {
      await createEndpoint(["idem.status"]);
      const body = { type: "idem.status", payload: {} };
      const first = await send("status-1", body).expect(202);
      const deliveryId = first.body.deliveries[0].id as string;
      await testDb.db
        .update(deliveries)
        .set({ status: "succeeded", attemptCount: 1 })
        .where(eq(deliveries.id, deliveryId));

      const retry = await send("status-1", body).expect(202);
      expect(retry.body.deliveries).toEqual([
        { id: deliveryId, endpointId: expect.any(String), status: "succeeded" },
      ]);
    });

    itWithRedis("does not queue the deliveries again on a retry", async () => {
      await createEndpoint(["idem.queue"]);
      const body = { type: "idem.queue", payload: {} };
      const first = await send("queue-1", body).expect(202);
      const deliveryId = first.body.deliveries[0].id as string;

      const queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, { connection: { url: redisUrl } });
      try {
        await (await queue.getJob(deliveryId))?.remove();
        await send("queue-1", body).expect(202);
        expect(await queue.getJob(deliveryId)).toBeUndefined();
      } finally {
        await queue.close();
      }
    });

    it("refuses the same key with a different payload or type and stores nothing", async () => {
      await send("reuse-1", { type: "idem.reuse", payload: { amount: 1 } }).expect(202);
      const before = await testDb.db.$count(events);

      for (const body of [
        { type: "idem.reuse", payload: { amount: 2 } },
        { type: "idem.other", payload: { amount: 1 } },
      ]) {
        const res = await send("reuse-1", body).expect(422);
        expect(res.body.message).toEqual([
          "Idempotency-Key was already used for an event with a different type or payload",
        ]);
      }
      expect(await testDb.db.$count(events)).toBe(before);
    });

    it("scopes keys to the project", async () => {
      const body = { type: "idem.scope", payload: {} };
      const ours = await send("scope-1", body).expect(202);
      const theirs = await send("scope-1", body, otherKey).expect(202);
      expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
      expect(theirs.body.id).not.toBe(ours.body.id);
    });

    it("stores one event when two requests race with the same key", async () => {
      await createEndpoint(["idem.race"]);
      const body = { type: "idem.race", payload: { n: 1 } };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => send("race-1", body).expect(202)),
      );

      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(responses.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(4);
      const stored = await testDb.db
        .select()
        .from(events)
        .where(and(eq(events.type, "idem.race"), eq(events.idempotencyKey, "race-1")));
      expect(stored).toHaveLength(1);
      expect(
        await testDb.db.$count(deliveries, eq(deliveries.eventId, responses[0]?.body.id)),
      ).toBe(1);
    });

    it("rejects an invalid key and stores nothing", async () => {
      const before = await testDb.db.$count(events);
      const res = await send("x".repeat(256), { type: "idem.bad", payload: {} }).expect(400);
      expect(res.body.message).toEqual([
        "Idempotency-Key must be 1-255 printable ASCII characters",
      ]);
      expect(await testDb.db.$count(events)).toBe(before);
    });
  });
});
