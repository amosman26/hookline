import type { Endpoint } from "@hookline/db";
import { signingSecrets, statusAfter } from "./deliver";
import { MAX_ATTEMPTS } from "./retry";

describe("statusAfter", () => {
  it("marks a success as succeeded on any attempt", () => {
    expect(statusAfter("success", 1)).toBe("succeeded");
    expect(statusAfter("success", MAX_ATTEMPTS)).toBe("succeeded");
  });

  it("fails a permanent refusal at once, even on the last attempt", () => {
    expect(statusAfter("permanent", 1)).toBe("failed");
    expect(statusAfter("permanent", MAX_ATTEMPTS)).toBe("failed");
  });

  it("keeps a retryable failure pending until the last attempt", () => {
    for (let n = 1; n < MAX_ATTEMPTS; n += 1) expect(statusAfter("retry", n)).toBe("pending");
  });

  it("dead-letters a retryable failure on the last attempt", () => {
    expect(statusAfter("retry", MAX_ATTEMPTS)).toBe("dead");
  });
});

describe("signingSecrets", () => {
  const endpoint = (previousSecret: string | null) =>
    ({ secret: "whsec_new", previousSecret }) as Endpoint;

  it("puts the current secret first and adds the previous one during the overlap", () => {
    expect(signingSecrets(endpoint("whsec_old"), true)).toEqual(["whsec_new", "whsec_old"]);
  });

  it("uses only the current secret once the overlap is over or when there is none", () => {
    expect(signingSecrets(endpoint("whsec_old"), false)).toEqual(["whsec_new"]);
    expect(signingSecrets(endpoint(null), true)).toEqual(["whsec_new"]);
  });
});
