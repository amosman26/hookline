import { decide, rateLimitConfig } from "./rate-limit-config";

describe("rateLimitConfig", () => {
  it("defaults to 600 requests a minute", () => {
    expect(rateLimitConfig({})).toEqual({ limit: 600, windowSeconds: 60 });
  });

  it("reads both variables", () => {
    expect(rateLimitConfig({ INGEST_RATE_LIMIT: "5", INGEST_RATE_WINDOW_SECONDS: "2" })).toEqual({
      limit: 5,
      windowSeconds: 2,
    });
  });

  it("treats blank values as unset", () => {
    expect(rateLimitConfig({ INGEST_RATE_LIMIT: " ", INGEST_RATE_WINDOW_SECONDS: "" })).toEqual({
      limit: 600,
      windowSeconds: 60,
    });
  });

  it("turns the limit off with INGEST_RATE_LIMIT=0", () => {
    expect(rateLimitConfig({ INGEST_RATE_LIMIT: "0" })).toBeNull();
  });

  it.each(["-1", "1.5", "ten", "1e3"])("refuses INGEST_RATE_LIMIT=%s", (value) => {
    expect(() => rateLimitConfig({ INGEST_RATE_LIMIT: value })).toThrow(/INGEST_RATE_LIMIT/);
  });

  it("refuses a zero window", () => {
    expect(() => rateLimitConfig({ INGEST_RATE_WINDOW_SECONDS: "0" })).toThrow(/at least 1/);
  });
});

describe("decide", () => {
  const config = { limit: 3, windowSeconds: 60 };

  it("allows requests up to the limit and counts down what is left", () => {
    expect(decide(config, { count: 1, resetInMs: 60_000 })).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetSeconds: 60,
    });
    expect(decide(config, { count: 3, resetInMs: 1_000 })).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("refuses the request after the limit", () => {
    expect(decide(config, { count: 4, resetInMs: 12_300 })).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetSeconds: 13,
    });
  });

  it("never reports a reset below one second", () => {
    expect(decide(config, { count: 9, resetInMs: 0 }).resetSeconds).toBe(1);
    expect(decide(config, { count: 9, resetInMs: -1 }).resetSeconds).toBe(1);
  });
});
