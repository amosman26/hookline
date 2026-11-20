import { deliveryJobOptions, redisConnection } from "./index";

describe("deliveryJobOptions", () => {
  it("uses the delivery id as the job id so re-enqueueing is a no-op", () => {
    expect(deliveryJobOptions("4b0c6d7e-0d1f-4f5e-9a3c-2b7d8e9f0a1b")).toMatchObject({
      jobId: "4b0c6d7e-0d1f-4f5e-9a3c-2b7d8e9f0a1b",
    });
  });

  it("removes finished jobs, since Postgres keeps the outcome", () => {
    expect(deliveryJobOptions("d")).toMatchObject({ removeOnComplete: true, removeOnFail: true });
  });
});

describe("redisConnection", () => {
  it("disables per-request retries, as BullMQ workers require", () => {
    expect(redisConnection("redis://localhost:6379")).toEqual({
      url: "redis://localhost:6379",
      maxRetriesPerRequest: null,
    });
  });
});
