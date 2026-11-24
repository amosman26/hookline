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
});
