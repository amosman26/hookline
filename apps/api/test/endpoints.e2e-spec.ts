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
});
