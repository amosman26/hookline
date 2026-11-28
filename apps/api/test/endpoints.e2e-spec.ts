import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, endpoints, projects } from "@hookline/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { generateApiKey } from "../src/auth/api-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";

describeWithDb("endpoints API", () => {
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

  const api = (as: string = key) => {
    const agent = request(app.getHttpServer());
    const auth = `Bearer ${as}`;
    return {
      get: (path: string) => agent.get(path).set("Authorization", auth),
      post: (path: string) => agent.post(path).set("Authorization", auth),
      patch: (path: string) => agent.patch(path).set("Authorization", auth),
      delete: (path: string) => agent.delete(path).set("Authorization", auth),
    };
  };

  async function createEndpoint(body: object = {}): Promise<{ id: string; secret: string }> {
    const res = await api()
      .post("/v1/endpoints")
      .send({ url: "https://example.com/hooks", eventTypes: ["invoice.paid"], ...body })
      .expect(201);
    return res.body;
  }

  it("registers an endpoint and returns its signing secret once", async () => {
    const res = await api()
      .post("/v1/endpoints")
      .send({
        url: "https://example.com/hooks",
        description: "billing",
        eventTypes: ["invoice.paid", "invoice.created"],
      })
      .expect(201);

    expect(res.body).toMatchObject({
      url: "https://example.com/hooks",
      description: "billing",
      eventTypes: ["invoice.created", "invoice.paid"],
      enabled: true,
    });
    expect(res.body.secret).toMatch(/^whsec_/);

    const [row] = await testDb.db.select().from(endpoints).where(eq(endpoints.id, res.body.id));
    expect(row?.secret).toBe(res.body.secret);

    const fetched = await api().get(`/v1/endpoints/${res.body.id}`).expect(200);
    expect(fetched.body).not.toHaveProperty("secret");
    expect(fetched.body.eventTypes).toEqual(["invoice.created", "invoice.paid"]);
  });

  it("lists only the caller's endpoints, without secrets", async () => {
    const mine = await createEndpoint();
    await api(otherKey)
      .post("/v1/endpoints")
      .send({ url: "https://globex.test/hooks", eventTypes: ["a"] })
      .expect(201);

    const res = await api().get("/v1/endpoints").expect(200);
    const ids = res.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(mine.id);
    expect(
      res.body.data.every((e: { url: string }) => e.url.startsWith("https://example.com")),
    ).toBe(true);
    expect(res.body.data.some((e: object) => "secret" in e)).toBe(false);
  });

  it("changes the subscribed event types and the enabled flag", async () => {
    const { id } = await createEndpoint();
    const res = await api()
      .patch(`/v1/endpoints/${id}`)
      .send({ eventTypes: ["user.created", "user.deleted"], enabled: false })
      .expect(200);

    expect(res.body).toMatchObject({
      eventTypes: ["user.created", "user.deleted"],
      enabled: false,
      url: "https://example.com/hooks",
    });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(res.body.createdAt));
  });

  it("deletes an endpoint", async () => {
    const { id } = await createEndpoint();
    await api().delete(`/v1/endpoints/${id}`).expect(204);
    await api().get(`/v1/endpoints/${id}`).expect(404);
    await api().delete(`/v1/endpoints/${id}`).expect(404);
  });

  it("hides another project's endpoint behind a 404", async () => {
    const { id } = await createEndpoint();
    await api(otherKey).get(`/v1/endpoints/${id}`).expect(404);
    await api(otherKey).patch(`/v1/endpoints/${id}`).send({ enabled: false }).expect(404);
    await api(otherKey).delete(`/v1/endpoints/${id}`).expect(404);
    await api().get(`/v1/endpoints/${id}`).expect(200);
  });

  it("lists every validation problem in a 400", async () => {
    const res = await api()
      .post("/v1/endpoints")
      .send({ url: "ftp://example.com", eventTypes: [] })
      .expect(400);
    expect(res.body.message).toEqual([
      "url must use http or https",
      "eventTypes must be a non-empty array",
    ]);
  });

  it("rejects an id that is not a UUID and 404s an unknown one", async () => {
    await api().get("/v1/endpoints/not-a-uuid").expect(400);
    await api().get(`/v1/endpoints/${randomUUID()}`).expect(404);
  });

  it("requires an API key", async () => {
    await request(app.getHttpServer()).get("/v1/endpoints").expect(401);
  });
  describe("secret rotation", () => {
    const HOUR_MS = 60 * 60 * 1000;

    async function stored(id: string) {
      const [row] = await testDb.db.select().from(endpoints).where(eq(endpoints.id, id));
      if (!row) throw new Error("endpoint not found");
      return row;
    }

    it("issues a new secret and keeps the old one signing for 24 hours by default", async () => {
      const created = await createEndpoint();
      const before = Date.now();

      const res = await api().post(`/v1/endpoints/${created.id}/rotate-secret`).expect(200);

      expect(res.body.id).toBe(created.id);
      expect(res.body.secret).toMatch(/^whsec_/);
      expect(res.body.secret).not.toBe(created.secret);
      const expiresAt = Date.parse(res.body.previousSecretExpiresAt);
      expect(expiresAt).toBeGreaterThan(before + 24 * HOUR_MS - 60_000);
      expect(expiresAt).toBeLessThan(Date.now() + 24 * HOUR_MS + 60_000);

      const row = await stored(created.id);
      expect(row.secret).toBe(res.body.secret);
      expect(row.previousSecret).toBe(created.secret);

      const fetched = await api().get(`/v1/endpoints/${created.id}`).expect(200);
      expect(fetched.body.previousSecretExpiresAt).toBe(res.body.previousSecretExpiresAt);
      expect(fetched.body).not.toHaveProperty("secret");
    });

    it("takes a custom overlap, and 0 retires the old secret at once", async () => {
      const created = await createEndpoint();

      const hour = await api()
        .post(`/v1/endpoints/${created.id}/rotate-secret`)
        .send({ overlapSeconds: 3600 })
        .expect(200);
      const expiresAt = Date.parse(hour.body.previousSecretExpiresAt);
      expect(Math.abs(expiresAt - (Date.now() + HOUR_MS))).toBeLessThan(60_000);

      const now = await api()
        .post(`/v1/endpoints/${created.id}/rotate-secret`)
        .send({ overlapSeconds: 0 })
        .expect(200);
      expect(now.body.previousSecretExpiresAt).toBeNull();
      const row = await stored(created.id);
      expect(row).toMatchObject({
        secret: now.body.secret,
        previousSecret: null,
        previousSecretExpiresAt: null,
      });
    });

    it("keeps at most two secrets: rotating again retires the oldest", async () => {
      const created = await createEndpoint();
      const first = await api().post(`/v1/endpoints/${created.id}/rotate-secret`).expect(200);
      const second = await api().post(`/v1/endpoints/${created.id}/rotate-secret`).expect(200);

      const row = await stored(created.id);
      expect(row.secret).toBe(second.body.secret);
      expect(row.previousSecret).toBe(first.body.secret);
      expect([row.secret, row.previousSecret]).not.toContain(created.secret);
    });

    it("reports no previous secret once the overlap has ended", async () => {
      const created = await createEndpoint();
      await api().post(`/v1/endpoints/${created.id}/rotate-secret`).expect(200);
      await testDb.db
        .update(endpoints)
        .set({ previousSecretExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(endpoints.id, created.id));

      const fetched = await api().get(`/v1/endpoints/${created.id}`).expect(200);
      expect(fetched.body.previousSecretExpiresAt).toBeNull();
    });

    it("validates the body and hides other projects' endpoints", async () => {
      const created = await createEndpoint();

      const bad = await api()
        .post(`/v1/endpoints/${created.id}/rotate-secret`)
        .send({ overlapSeconds: -5, secret: "whsec_mine" })
        .expect(400);
      expect(bad.body.message).toEqual([
        "secret is not a known field",
        "overlapSeconds must be an integer from 0 to 604800 (7 days)",
      ]);

      await api(otherKey).post(`/v1/endpoints/${created.id}/rotate-secret`).expect(404);
      await api().post(`/v1/endpoints/${randomUUID()}/rotate-secret`).expect(404);
      await api().post("/v1/endpoints/not-a-uuid/rotate-secret").expect(400);
      expect((await stored(created.id)).secret).toBe(created.secret);
    });
  });
});
