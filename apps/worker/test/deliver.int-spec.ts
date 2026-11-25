import { deliveries, deliveryAttempts, endpoints, events, projects } from "@hookline/db";
import { verify } from "@hookline/signing";
import { asc, eq } from "drizzle-orm";
import { deliver, USER_AGENT } from "../src/deliver";
import { MAX_ATTEMPTS, RETRY_BASE_DELAY_MS } from "../src/retry";
import { RESPONSE_BODY_LIMIT } from "../src/send";
import { Receiver } from "./support/receiver";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";

const SECRET = "whsec_test-secret";

describeWithDb("deliver", () => {
  let testDb: TestDatabase;
  const receiver = new Receiver();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await receiver.start();
  });

  afterAll(async () => {
    await receiver.stop();
    await testDb?.drop();
  });

  beforeEach(() => {
    receiver.received.length = 0;
    receiver.respond = () => ({ status: 200, body: "ok" });
  });

  /** A pending delivery of one `invoice.paid` event to one endpoint. */
  async function pendingDelivery(
    endpoint: { url?: string; enabled?: boolean } = {},
    attemptCount = 0,
  ) {
    const [project] = await testDb.db.insert(projects).values({ name: "Acme" }).returning();
    if (!project) throw new Error("insert returned no row");
    const [ep] = await testDb.db
      .insert(endpoints)
      .values({
        projectId: project.id,
        url: endpoint.url ?? receiver.url,
        secret: SECRET,
        eventTypes: ["invoice.paid"],
        enabled: endpoint.enabled ?? true,
      })
      .returning();
    const [event] = await testDb.db
      .insert(events)
      .values({ projectId: project.id, type: "invoice.paid", payload: { id: "inv_1", total: 42 } })
      .returning();
    if (!ep || !event) throw new Error("insert returned no row");
    const [delivery] = await testDb.db
      .insert(deliveries)
      .values({ projectId: project.id, eventId: event.id, endpointId: ep.id, attemptCount })
      .returning();
    if (!delivery) throw new Error("insert returned no row");
    return { delivery, event };
  }

  async function state(deliveryId: string) {
    const [delivery] = await testDb.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId));
    const attempts = await testDb.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttempts.attemptNumber));
    return { delivery, attempts };
  }

  it("sends a signed JSON body and records the success", async () => {
    const { delivery, event } = await pendingDelivery();
    receiver.respond = () => ({ status: 204 });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "succeeded" });

    expect(receiver.received).toHaveLength(1);
    const [req] = receiver.received;
    expect(JSON.parse(req?.body ?? "")).toEqual({
      id: event.id,
      type: "invoice.paid",
      createdAt: event.createdAt.toISOString(),
      data: { id: "inv_1", total: 42 },
    });
    expect(req?.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "hookline-id": event.id,
    });
    const signed = {
      id: req?.headers["hookline-id"] as string,
      timestamp: req?.headers["hookline-timestamp"] as string,
      signature: req?.headers["hookline-signature"] as string,
      body: req?.body ?? "",
    };
    expect(verify({ ...signed, secret: SECRET })).toBe(true);
    expect(verify({ ...signed, secret: "whsec_other" })).toBe(false);

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        statusCode: 204,
        responseBody: "",
        error: null,
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("keeps the delivery pending after a 5xx and asks for a retry", async () => {
    const { delivery } = await pendingDelivery();
    receiver.respond = () => ({ status: 500, body: "x".repeat(RESPONSE_BODY_LIMIT + 100) });

    const result = await deliver(testDb.db, delivery.id);

    // First retry: full jitter below the base delay.
    expect(result.outcome).toBe("retrying");
    const retryInMs = result.outcome === "retrying" ? result.retryInMs : -1;
    expect(retryInMs).toBeGreaterThanOrEqual(0);
    expect(retryInMs).toBeLessThan(RETRY_BASE_DELAY_MS);

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ statusCode: 500, error: null });
    expect(attempts[0]?.responseBody).toHaveLength(RESPONSE_BODY_LIMIT);
  });

  it.each([408, 429, 503])("retries a %i", async (code) => {
    const { delivery } = await pendingDelivery();
    receiver.respond = () => ({ status: code });

    const result = await deliver(testDb.db, delivery.id);

    expect(result.outcome).toBe("retrying");
    expect((await state(delivery.id)).delivery?.status).toBe("pending");
  });

  it("records the next attempt with the next number", async () => {
    const { delivery } = await pendingDelivery();
    receiver.respond = () => ({ status: 503 });
    await deliver(testDb.db, delivery.id);
    receiver.respond = () => ({ status: 200, body: "ok" });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "succeeded" });

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(attempts.map((a) => [a.attemptNumber, a.statusCode])).toEqual([
      [1, 503],
      [2, 200],
    ]);
  });

  it("uses the retry delay it is given", async () => {
    const { delivery } = await pendingDelivery({}, 2);
    receiver.respond = () => ({ status: 502 });
    const seen: number[] = [];

    const result = await deliver(testDb.db, delivery.id, {
      retryDelay: (attempt) => {
        seen.push(attempt);
        return 250;
      },
    });

    expect(result).toEqual({ outcome: "retrying", retryInMs: 250 });
    expect(seen).toEqual([3]);
  });

  it("waits as long as a 429's Retry-After asks", async () => {
    const { delivery } = await pendingDelivery();
    const send = async () => ({
      statusCode: 429,
      durationMs: 1,
      responseBody: "slow down",
      error: null,
      retryAfter: "120",
    });

    await expect(deliver(testDb.db, delivery.id, { send })).resolves.toEqual({
      outcome: "retrying",
      retryInMs: 120_000,
    });
  });

  it("fails at once on a 4xx that is not 408 or 429", async () => {
    const { delivery } = await pendingDelivery();
    receiver.respond = () => ({ status: 410, body: "gone" });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "failed" });

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(attempts[0]).toMatchObject({ statusCode: 410, responseBody: "gone" });
  });

  it("dead-letters a delivery whose last allowed attempt is still retryable", async () => {
    const { delivery } = await pendingDelivery({}, MAX_ATTEMPTS - 1);
    receiver.respond = () => ({ status: 503 });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "dead" });

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "dead", attemptCount: MAX_ATTEMPTS });
    expect(attempts).toEqual([
      expect.objectContaining({ attemptNumber: MAX_ATTEMPTS, statusCode: 503 }),
    ]);
  });

  it("still fails, not dead-letters, a permanent refusal on the last attempt", async () => {
    const { delivery } = await pendingDelivery({}, MAX_ATTEMPTS - 1);
    receiver.respond = () => ({ status: 404 });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "failed" });

    const { delivery: after } = await state(delivery.id);
    expect(after).toMatchObject({ status: "failed", attemptCount: MAX_ATTEMPTS });
  });

  it("leaves a dead delivery alone if its job runs again", async () => {
    const { delivery } = await pendingDelivery({}, MAX_ATTEMPTS - 1);
    receiver.respond = () => ({ status: 500 });
    await deliver(testDb.db, delivery.id);
    receiver.received.length = 0;

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "skipped" });

    expect(receiver.received).toHaveLength(0);
    const { delivery: after, attempts } = await state(delivery.id);
    expect(after?.status).toBe("dead");
    expect(attempts).toHaveLength(1);
  });

  it("retries a connection error, recorded with no status code", async () => {
    // A port that was just free; fetch refuses well-known ones like 1 outright.
    const closed = new Receiver();
    await closed.start();
    await closed.stop();
    const { delivery } = await pendingDelivery({ url: closed.url });

    const result = await deliver(testDb.db, delivery.id);

    expect(result.outcome).toBe("retrying");
    const { attempts } = await state(delivery.id);
    expect(attempts[0]).toMatchObject({ statusCode: null, responseBody: null });
    expect(attempts[0]?.error).toMatch(/ECONNREFUSED/);
  });

  it("does not call a disabled endpoint and fails the delivery without retrying", async () => {
    const { delivery } = await pendingDelivery({ enabled: false });

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "failed" });

    expect(receiver.received).toHaveLength(0);
    const { delivery: after, attempts } = await state(delivery.id);
    expect(after?.status).toBe("failed");
    expect(attempts[0]).toMatchObject({ statusCode: null, error: "endpoint is disabled" });
  });

  it("skips a delivery that is no longer pending, so a duplicate job sends nothing", async () => {
    const { delivery } = await pendingDelivery();
    await deliver(testDb.db, delivery.id);

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "skipped" });

    expect(receiver.received).toHaveLength(1);
    expect((await state(delivery.id)).attempts).toHaveLength(1);
  });

  it("skips a delivery that no longer exists", async () => {
    const { delivery } = await pendingDelivery();
    await testDb.db.delete(deliveries).where(eq(deliveries.id, delivery.id));

    await expect(deliver(testDb.db, delivery.id)).resolves.toEqual({ outcome: "skipped" });
    expect(receiver.received).toHaveLength(0);
  });

  it("keeps the first result when two runs race on the same delivery", async () => {
    const { delivery } = await pendingDelivery();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Both runs read the delivery as pending, then both send.
    const slowSend = async () => {
      await gate;
      return { statusCode: 200, durationMs: 1, responseBody: "ok", error: null, retryAfter: null };
    };

    const runs = Promise.all([
      deliver(testDb.db, delivery.id, { send: slowSend }),
      deliver(testDb.db, delivery.id, { send: slowSend }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    expect((await runs).map((r) => r.outcome).sort()).toEqual(["skipped", "succeeded"]);
    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect(attempts).toHaveLength(1);
  });
});
