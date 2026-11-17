import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The pool connects lazily and /health never queries, so any URL will do.
    process.env.DATABASE_URL ??= "postgres://localhost:5432/unused";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports the service as up", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);

    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });
});
