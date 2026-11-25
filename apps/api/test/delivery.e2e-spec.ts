import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, deliveries, deliveryAttempts, projects } from "@hookline/db";
import { redisConnection } from "@hookline/queue";
import { verify } from "@hookline/signing";
import { createDeliveryWorker } from "@hookline/worker";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { Receiver } from "./support/receiver";
import { createTestDatabase, type TestDatabase } from "./support/test-database";
import { redisUrl } from "./support/test-redis";

const describeWithServices = process.env.DATABASE_URL && redisUrl ? describe : describe.skip;

// The whole path a customer relies on: POST /v1/events on the real API, a
// real BullMQ queue in Redis, the real worker, and an HTTP receiver that
// checks the signature the way a customer would. Only the receiver is ours.
describeWithServices("event delivery, end to end", () => {
  // Jest runs suites in parallel against one Redis. A prefix of our own keeps
  // this suite's worker away from jobs other suites inspect, and vice versa.
  const prefix = `hookline-test-${randomUUID()}`;
  const receiver = new Receiver();
  const originalEnv = { ...process.env };
  let testDb: TestDatabase;
  let app: INestApplication;
  let worker: ReturnType<typeof createDeliveryWorker>;
  let key: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    process.env.QUEUE_PREFIX = prefix;
    await receiver.start();

    const [project] = await testDb.db.insert(projects).values({ name: "Acme" }).returning();
    if (!project) throw new Error("insert returned no row");
    const generated = generateApiKey();
    await testDb.db.insert(apiKeys).values({
      projectId: project.id,
      name: "test",
      prefix: generated.prefix,
      keyHash: generated.hash,
    });
    key = generated.key;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    worker = createDeliveryWorker({
      db: testDb.db,
      connection: redisConnection(redisUrl as string),
      prefix,
      retryDelay: () => 100,
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await receiver.stop();
    // Assigning undefined to process.env stores the string "undefined".
    process.env = originalEnv;
    await testDb?.drop();
  });

  beforeEach(() => {
    receiver.received.length = 0;
    receiver.respond = () => ({ status: 200, body: "ok" });
  });

  const post = (path: string) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${key}`);

  async function createEndpoint(eventTypes: string[]): Promise<{ id: string; secret: string }> {
    const res = await post("/v1/endpoints").send({ url: receiver.url, eventTypes }).expect(201);
    return res.body as { id: string; secret: string };
  }

  async function settled(deliveryId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await testDb.db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
      if (row && row.status !== "pending") return row;
      if (Date.now() > deadline) throw new Error(`delivery ${deliveryId} still pending`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const attemptsOf = (deliveryId: string) =>
    testDb.db.select().from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, deliveryId));

  it("delivers an accepted event to the endpoint with a valid signature", async () => {
    const endpoint = await createEndpoint(["invoice.paid"]);
    const payload = { id: "inv_42", amount: 1200, currency: "AED" };

    const res = await post("/v1/events").send({ type: "invoice.paid", payload }).expect(202);
    const event = res.body as { id: string; createdAt: string; deliveries: { id: string }[] };
    expect(event.deliveries).toHaveLength(1);
    const deliveryId = event.deliveries[0]?.id as string;

    expect(await settled(deliveryId)).toMatchObject({ status: "succeeded", attemptCount: 1 });

    expect(receiver.received).toHaveLength(1);
    const [received] = receiver.received;
    if (!received) throw new Error("nothing received");
    expect(JSON.parse(received.body)).toEqual({
      id: event.id,
      type: "invoice.paid",
      createdAt: event.createdAt,
      data: payload,
    });
    expect(received.headers["content-type"]).toBe("application/json");
    expect(received.headers["hookline-id"]).toBe(event.id);

    // Check it exactly as a customer would: raw body, headers, their secret.
    const header = (name: string) => received.headers[name] as string | undefined;
    const valid = (secret: string) =>
      verify({
        id: header("hookline-id"),
        timestamp: header("hookline-timestamp"),
        signature: header("hookline-signature"),
        body: received.body,
        secret,
      });
    expect(valid(endpoint.secret)).toBe(true);
    expect(valid(`${endpoint.secret}x`)).toBe(false);

    expect(await attemptsOf(deliveryId)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        statusCode: 200,
        responseBody: "ok",
        error: null,
      }),
    ]);
  });

  it("retries after a 503 and delivers when the endpoint recovers", async () => {
    await createEndpoint(["payout.failed"]);
    let calls = 0;
    receiver.respond = () => {
      calls += 1;
      return calls === 1 ? { status: 503, body: "maintenance" } : { status: 200, body: "ok" };
    };

    const res = await post("/v1/events")
      .send({ type: "payout.failed", payload: { id: "po_7" } })
      .expect(202);
    const deliveryId = (res.body as { deliveries: { id: string }[] }).deliveries[0]?.id as string;

    expect(await settled(deliveryId)).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(receiver.received).toHaveLength(2);
    const attempts = await attemptsOf(deliveryId);
    expect(attempts.sort((x, y) => x.attemptNumber - y.attemptNumber)).toEqual([
      expect.objectContaining({ attemptNumber: 1, statusCode: 503, responseBody: "maintenance" }),
      expect.objectContaining({ attemptNumber: 2, statusCode: 200, responseBody: "ok" }),
    ]);
  });

  it("fails at once when the endpoint rejects the event with a 4xx", async () => {
    await createEndpoint(["refund.failed"]);
    receiver.respond = () => ({ status: 422, body: "unknown payout" });

    const res = await post("/v1/events")
      .send({ type: "refund.failed", payload: { id: "re_8" } })
      .expect(202);
    const deliveryId = (res.body as { deliveries: { id: string }[] }).deliveries[0]?.id as string;

    expect(await settled(deliveryId)).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(receiver.received).toHaveLength(1);
    expect(await attemptsOf(deliveryId)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        statusCode: 422,
        responseBody: "unknown payout",
      }),
    ]);
  });

  async function deliveryFor(type: string): Promise<string> {
    const res = await post("/v1/events")
      .send({ type, payload: { id: "x_1" } })
      .expect(202);
    return (res.body as { deliveries: { id: string }[] }).deliveries[0]?.id as string;
  }

  it("replays a failed delivery with the same event id once the endpoint is fixed", async () => {
    await createEndpoint(["charge.failed"]);
    receiver.respond = () => ({ status: 400, body: "bad schema" });
    const deliveryId = await deliveryFor("charge.failed");
    expect(await settled(deliveryId)).toMatchObject({ status: "failed", attemptCount: 1 });

    receiver.respond = () => ({ status: 200, body: "ok" });
    const res = await post(`/v1/deliveries/${deliveryId}/replay`).expect(202);
    expect(res.body).toMatchObject({ id: deliveryId, status: "pending", attemptCount: 1 });

    expect(await settled(deliveryId)).toMatchObject({ status: "succeeded", attemptCount: 2 });
    const ids = receiver.received.map((r) => r.headers["hookline-id"]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    const attempts = await attemptsOf(deliveryId);
    expect(attempts.sort((x, y) => x.attemptNumber - y.attemptNumber)).toEqual([
      expect.objectContaining({ attemptNumber: 1, statusCode: 400 }),
      expect.objectContaining({ attemptNumber: 2, statusCode: 200 }),
    ]);
  });

  it("gives a replayed dead delivery a fresh set of attempts", async () => {
    await createEndpoint(["sync.stalled"]);
    receiver.respond = () => ({ status: 503 });
    const deliveryId = await deliveryFor("sync.stalled");
    expect(await settled(deliveryId)).toMatchObject({ status: "dead", attemptCount: 12 });

    // Still down after the replay: the new chain retries instead of dying at once.
    let calls = 0;
    receiver.respond = () => {
      calls += 1;
      return calls === 1 ? { status: 503 } : { status: 200, body: "ok" };
    };
    await post(`/v1/deliveries/${deliveryId}/replay`).expect(202);

    expect(await settled(deliveryId)).toMatchObject({
      status: "succeeded",
      attemptCount: 14,
      chainStart: 12,
    });
  });

  it("refuses to replay a delivery that has not failed, or one it cannot find", async () => {
    await createEndpoint(["seat.added"]);
    const deliveryId = await deliveryFor("seat.added");
    expect(await settled(deliveryId)).toMatchObject({ status: "succeeded" });

    const conflict = await post(`/v1/deliveries/${deliveryId}/replay`).expect(409);
    expect(conflict.body.message).toMatch(/delivery is succeeded/);
    await post(`/v1/deliveries/${randomUUID()}/replay`).expect(404);
    await post("/v1/deliveries/not-a-uuid/replay").expect(400);
  });

  it("refuses to replay to a disabled endpoint", async () => {
    const endpoint = await createEndpoint(["seat.removed"]);
    receiver.respond = () => ({ status: 410 });
    const deliveryId = await deliveryFor("seat.removed");
    expect(await settled(deliveryId)).toMatchObject({ status: "failed" });
    await request(app.getHttpServer())
      .patch(`/v1/endpoints/${endpoint.id}`)
      .set("Authorization", `Bearer ${key}`)
      .send({ enabled: false })
      .expect(200);

    const res = await post(`/v1/deliveries/${deliveryId}/replay`).expect(409);
    expect(res.body.message).toMatch(/endpoint is disabled/);
    const [row] = await testDb.db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(row?.status).toBe("failed");
  });

  it("fans one event out to every subscribed endpoint and delivers each once", async () => {
    await createEndpoint(["user.created"]);
    await createEndpoint(["user.created", "user.deleted"]);
    await createEndpoint(["user.deleted"]);

    const res = await post("/v1/events")
      .send({ type: "user.created", payload: { id: "usr_1" } })
      .expect(202);
    const ids = (res.body as { deliveries: { id: string }[] }).deliveries.map((d) => d.id);
    expect(ids).toHaveLength(2);

    for (const id of ids) {
      expect(await settled(id)).toMatchObject({ status: "succeeded", attemptCount: 1 });
    }
    expect(receiver.received).toHaveLength(2);
    expect(new Set(receiver.received.map((r) => r.headers["hookline-id"]))).toEqual(
      new Set([res.body.id]),
    );
  });
});
