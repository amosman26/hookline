import { randomUUID } from "node:crypto";
import { deliveries, deliveryAttempts, endpoints, events, projects } from "@hookline/db";
import {
  DELIVER_JOB,
  DELIVERY_QUEUE,
  deliveryJobOptions,
  redisConnection,
  type DeliveryJobData,
} from "@hookline/queue";
import { Queue, type Worker } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import type { DeliveryOutcome } from "../src/deliver";
import { MAX_ATTEMPTS } from "../src/retry";
import { enqueuePending } from "../src/sweep";
import { createDeliveryWorker } from "../src/worker";
import { Receiver } from "./support/receiver";
import { createTestDatabase, type TestDatabase } from "./support/test-database";
import { redisUrl } from "./support/test-redis";

const describeWithServices = process.env.DATABASE_URL && redisUrl ? describe : describe.skip;

describeWithServices("delivery worker", () => {
  // A prefix of its own, so this suite never takes jobs from another one.
  const prefix = `hookline-test-${randomUUID()}`;
  let testDb: TestDatabase;
  let queue: Queue<DeliveryJobData>;
  let worker: Worker<DeliveryJobData, DeliveryOutcome>;
  const receiver = new Receiver();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await receiver.start();
    const connection = redisConnection(redisUrl as string);
    queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, { connection, prefix });
    worker = createDeliveryWorker({
      db: testDb.db,
      connection,
      prefix,
      concurrency: 4,
      retryDelay: () => 1_000,
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await receiver.stop();
    await testDb?.drop();
  });

  async function pendingDeliveries(count: number): Promise<string[]> {
    const [project] = await testDb.db.insert(projects).values({ name: "Acme" }).returning();
    if (!project) throw new Error("insert returned no row");
    const [endpoint] = await testDb.db
      .insert(endpoints)
      .values({ projectId: project.id, url: receiver.url, secret: "whsec_test" })
      .returning();
    if (!endpoint) throw new Error("insert returned no row");
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const [event] = await testDb.db
        .insert(events)
        .values({ projectId: project.id, type: "order.paid", payload: { n: i } })
        .returning();
      if (!event) throw new Error("insert returned no row");
      const [delivery] = await testDb.db
        .insert(deliveries)
        .values({ projectId: project.id, eventId: event.id, endpointId: endpoint.id })
        .returning();
      if (!delivery) throw new Error("insert returned no row");
      ids.push(delivery.id);
    }
    return ids;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(() => {
    receiver.received.length = 0;
    receiver.respond = () => ({ status: 200, body: "ok" });
  });

  it("sweeps pending deliveries into the queue and delivers each one once", async () => {
    const ids = await pendingDeliveries(5);

    // Sweeping twice must not queue anything twice.
    await worker.pause();
    expect(await enqueuePending(testDb.db, queue)).toBe(5);
    expect(await enqueuePending(testDb.db, queue)).toBe(5);
    expect(await queue.getWaitingCount()).toBe(5);
    worker.resume();

    await waitFor(async () => {
      const rows = await testDb.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(inArray(deliveries.id, ids));
      return rows.every((r) => r.status === "succeeded");
    });

    expect(receiver.received).toHaveLength(5);
    for (const id of ids) {
      const attempts = await testDb.db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, id));
      expect(attempts).toEqual([expect.objectContaining({ attemptNumber: 1, statusCode: 200 })]);
    }
  });

  it("delays the same job after a retryable failure and delivers on the next try", async () => {
    const [id] = await pendingDeliveries(1);
    let calls = 0;
    receiver.respond = () => {
      calls += 1;
      return calls === 1 ? { status: 503, body: "busy" } : { status: 200, body: "ok" };
    };

    await queue.add(DELIVER_JOB, { deliveryId: id as string }, deliveryJobOptions(id as string));

    // While it waits, the job keeps its id, so queueing it again is a no-op.
    await waitFor(async () => (await queue.getDelayedCount()) === 1);
    await enqueuePending(testDb.db, queue);
    expect(await queue.getDelayedCount()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(0);

    await waitFor(async () => {
      const [row] = await testDb.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(eq(deliveries.id, id as string));
      return row?.status === "succeeded";
    });
    const attempts = await testDb.db
      .select({ attemptNumber: deliveryAttempts.attemptNumber, code: deliveryAttempts.statusCode })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, id as string))
      .orderBy(deliveryAttempts.attemptNumber);
    expect(attempts).toEqual([
      { attemptNumber: 1, code: 503 },
      { attemptNumber: 2, code: 200 },
    ]);
    expect(receiver.received).toHaveLength(2);
  });
  async function statusOf(id: string) {
    const [row] = await testDb.db
      .select({ status: deliveries.status, attemptCount: deliveries.attemptCount })
      .from(deliveries)
      .where(eq(deliveries.id, id));
    return row;
  }

  it("does not deliver again when a finished delivery's job is queued a second time", async () => {
    const [id] = await pendingDeliveries(1);
    const deliveryId = id as string;

    await queue.add(DELIVER_JOB, { deliveryId }, deliveryJobOptions(deliveryId));
    await waitFor(async () => (await statusOf(deliveryId))?.status === "succeeded");
    // Finished jobs are removed, so the same job id is free and runs again,
    // as it would after a duplicate enqueue from the API or the sweep.
    await waitFor(async () => (await queue.getJob(deliveryId)) === undefined);
    await queue.add(DELIVER_JOB, { deliveryId }, deliveryJobOptions(deliveryId));
    await waitFor(async () => (await queue.getJob(deliveryId)) === undefined);

    expect(receiver.received).toHaveLength(1);
    expect(await statusOf(deliveryId)).toEqual({ status: "succeeded", attemptCount: 1 });
  });

  describe("retry schedule", () => {
    const schedulePrefix = `hookline-test-${randomUUID()}`;
    let scheduleQueue: Queue<DeliveryJobData>;
    let scheduleWorker: Worker<DeliveryJobData, DeliveryOutcome>;
    const delaysAsked: number[] = [];

    beforeAll(async () => {
      const connection = redisConnection(redisUrl as string);
      scheduleQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
        connection,
        prefix: schedulePrefix,
      });
      scheduleWorker = createDeliveryWorker({
        db: testDb.db,
        connection,
        prefix: schedulePrefix,
        retryDelay: (attempt) => {
          delaysAsked.push(attempt);
          return 20;
        },
      });
      await scheduleWorker.waitUntilReady();
    });

    afterAll(async () => {
      await scheduleWorker?.close();
      await scheduleQueue?.obliterate({ force: true });
      await scheduleQueue?.close();
    });

    beforeEach(() => {
      delaysAsked.length = 0;
    });

    it("retries a failing delivery after every attempt until it is dead-lettered", async () => {
      const [id] = await pendingDeliveries(1);
      const deliveryId = id as string;
      receiver.respond = () => ({ status: 500, body: "down" });

      await scheduleQueue.add(DELIVER_JOB, { deliveryId }, deliveryJobOptions(deliveryId));
      await waitFor(async () => (await statusOf(deliveryId))?.status === "dead", 20_000);
      await waitFor(async () => (await scheduleQueue.getJob(deliveryId)) === undefined);

      // One wait after each failed attempt except the last, numbered by attempt.
      expect(delaysAsked).toEqual(Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => i + 1));
      expect(await statusOf(deliveryId)).toEqual({ status: "dead", attemptCount: MAX_ATTEMPTS });

      const attempts = await testDb.db
        .select({ n: deliveryAttempts.attemptNumber, code: deliveryAttempts.statusCode })
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, deliveryId))
        .orderBy(deliveryAttempts.attemptNumber);
      expect(attempts).toEqual(
        Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({ n: i + 1, code: 500 })),
      );

      // Every attempt is the same message (same Hookline-Id), signed afresh.
      expect(receiver.received).toHaveLength(MAX_ATTEMPTS);
      const ids = new Set(receiver.received.map((r) => r.headers["hookline-id"]));
      expect(ids.size).toBe(1);
    }, 30_000);

    it("stops retrying as soon as an attempt is refused for good", async () => {
      const [id] = await pendingDeliveries(1);
      const deliveryId = id as string;
      let calls = 0;
      receiver.respond = () => {
        calls += 1;
        return calls < 3 ? { status: 502, body: "bad gateway" } : { status: 410, body: "gone" };
      };

      await scheduleQueue.add(DELIVER_JOB, { deliveryId }, deliveryJobOptions(deliveryId));
      await waitFor(async () => (await statusOf(deliveryId))?.status === "failed");
      await waitFor(async () => (await scheduleQueue.getJob(deliveryId)) === undefined);

      expect(delaysAsked).toEqual([1, 2]);
      expect(await statusOf(deliveryId)).toEqual({ status: "failed", attemptCount: 3 });
      expect(receiver.received).toHaveLength(3);
    });
  });
});
