import { deliveries, deliveryAttempts, endpoints, events, projects } from "@hookline/db";
import { verify } from "@hookline/signing";
import { asc, eq } from "drizzle-orm";
import { deliver, USER_AGENT } from "../src/deliver";
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
  async function pendingDelivery(endpoint: { url?: string; enabled?: boolean } = {}) {
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
      .values({ projectId: project.id, eventId: event.id, endpointId: ep.id })
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

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("succeeded");

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

  it("records a non-2xx response as a failed attempt with its body", async () => {
    const { delivery } = await pendingDelivery();
    receiver.respond = () => ({ status: 500, body: "x".repeat(RESPONSE_BODY_LIMIT + 100) });

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("failed");

    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ statusCode: 500, error: null });
    expect(attempts[0]?.responseBody).toHaveLength(RESPONSE_BODY_LIMIT);
  });

  it("records a connection error with no status code", async () => {
    // A port that was just free; fetch refuses well-known ones like 1 outright.
    const closed = new Receiver();
    await closed.start();
    await closed.stop();
    const { delivery } = await pendingDelivery({ url: closed.url });

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("failed");

    const { attempts } = await state(delivery.id);
    expect(attempts[0]).toMatchObject({ statusCode: null, responseBody: null });
    expect(attempts[0]?.error).toMatch(/ECONNREFUSED/);
  });

  it("does not call a disabled endpoint and fails the delivery", async () => {
    const { delivery } = await pendingDelivery({ enabled: false });

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("failed");

    expect(receiver.received).toHaveLength(0);
    const { attempts } = await state(delivery.id);
    expect(attempts[0]).toMatchObject({ statusCode: null, error: "endpoint is disabled" });
  });

  it("skips a delivery that is no longer pending, so a duplicate job sends nothing", async () => {
    const { delivery } = await pendingDelivery();
    await deliver(testDb.db, delivery.id);

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("skipped");

    expect(receiver.received).toHaveLength(1);
    expect((await state(delivery.id)).attempts).toHaveLength(1);
  });

  it("skips a delivery that no longer exists", async () => {
    const { delivery } = await pendingDelivery();
    await testDb.db.delete(deliveries).where(eq(deliveries.id, delivery.id));

    await expect(deliver(testDb.db, delivery.id)).resolves.toBe("skipped");
    expect(receiver.received).toHaveLength(0);
  });

  it("keeps the first result when two runs race on the same delivery", async () => {
    const { delivery } = await pendingDelivery();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Both runs read the delivery as pending, then both send.
    const slowSend = async () => {
      await gate;
      return { statusCode: 200, durationMs: 1, responseBody: "ok", error: null };
    };

    const runs = Promise.all([
      deliver(testDb.db, delivery.id, { send: slowSend }),
      deliver(testDb.db, delivery.id, { send: slowSend }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    expect((await runs).sort()).toEqual(["skipped", "succeeded"]);
    const { delivery: after, attempts } = await state(delivery.id);
    expect(after).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect(attempts).toHaveLength(1);
  });
});
