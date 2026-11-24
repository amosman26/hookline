import { classifyAttempt, MAX_RETRY_DELAY_MS, nextRetryDelay, parseRetryAfter } from "./retry";

describe("classifyAttempt", () => {
  it.each([200, 201, 204, 299])("treats %i as delivered", (code) => {
    expect(classifyAttempt(code)).toBe("success");
  });

  it.each([408, 429, 500, 502, 503, 504, 599])("retries %i", (code) => {
    expect(classifyAttempt(code)).toBe("retry");
  });

  it("retries when no response arrived (network error or timeout)", () => {
    expect(classifyAttempt(null)).toBe("retry");
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 413, 422, 301, 307])(
    "gives up at once on %i",
    (code) => {
      expect(classifyAttempt(code)).toBe("permanent");
    },
  );
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");

  it("reads a number of seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter("Tue, 24 Nov 2026 12:01:30 GMT", now)).toBe(90_000);
  });

  it("treats a date in the past as no wait", () => {
    expect(parseRetryAfter("Tue, 24 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it.each([null, "", "soon", "-5", "1.5", "2026-11-24"])("ignores %p", (value) => {
    expect(parseRetryAfter(value, now)).toBeNull();
  });
});

describe("nextRetryDelay", () => {
  it("uses the policy delay when the endpoint asks for nothing or less", () => {
    expect(nextRetryDelay(5_000, null)).toBe(5_000);
    expect(nextRetryDelay(5_000, 1_000)).toBe(5_000);
  });

  it("waits as long as Retry-After asks when that is longer", () => {
    expect(nextRetryDelay(5_000, 60_000)).toBe(60_000);
  });

  it("never waits longer than the cap", () => {
    expect(nextRetryDelay(5_000, 7 * 24 * 60 * 60 * 1000)).toBe(MAX_RETRY_DELAY_MS);
  });
});
