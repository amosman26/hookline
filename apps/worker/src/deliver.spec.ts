import { statusAfter } from "./deliver";
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
