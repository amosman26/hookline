import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { apiKeys, projects } from "@hookline/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { hashApiKey, isWellFormedApiKey } from "../src/auth/api-key";
import { createProjectWithKey } from "../src/cli/project-key";
import { createTestDatabase, describeWithDb, type TestDatabase } from "./support/test-database";

describeWithDb("creating a project and API key", () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    process.env.DATABASE_URL = testDb.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
    await testDb?.drop();
  });

  it("mints a key the API accepts, storing only its hash", async () => {
    const created = await createProjectWithKey(testDb.db, { projectName: "  Acme  " });
    expect(isWellFormedApiKey(created.key)).toBe(true);
    expect(created.key.startsWith(created.prefix)).toBe(true);

    const [stored] = await testDb.db.select().from(apiKeys).where(eq(apiKeys.id, created.apiKeyId));
    expect(stored).toMatchObject({ name: "default", keyHash: hashApiKey(created.key) });

    const res = await request(app.getHttpServer())
      .get("/v1/project")
      .set("Authorization", `Bearer ${created.key}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: created.projectId, name: "Acme" });
  });

  it("rejects blank or overlong names and creates nothing", async () => {
    const before = await testDb.db.$count(projects);
    await expect(createProjectWithKey(testDb.db, { projectName: "   " })).rejects.toThrow(
      "project name must be 1-100 characters",
    );
    await expect(
      createProjectWithKey(testDb.db, { projectName: "Acme", keyName: "k".repeat(101) }),
    ).rejects.toThrow("key name must be 1-100 characters");
    expect(await testDb.db.$count(projects)).toBe(before);
  });
});
