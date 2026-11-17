import { createHash } from "node:crypto";
import { extractBearerKey, generateApiKey, hashApiKey, isWellFormedApiKey } from "./api-key";

describe("generateApiKey", () => {
  it("issues hl_live_ keys with a visible prefix and a SHA-256 hash", () => {
    const { key, prefix, hash } = generateApiKey();

    expect(key).toMatch(/^hl_live_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(isWellFormedApiKey(key)).toBe(true);
  });

  it("never issues the same key twice", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().key));
    expect(keys.size).toBe(100);
  });
});

describe("hashApiKey", () => {
  it("is deterministic and hex encoded", () => {
    expect(hashApiKey("hl_live_x")).toBe(hashApiKey("hl_live_x"));
    expect(hashApiKey("hl_live_x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractBearerKey", () => {
  const { key } = generateApiKey();

  it.each([
    [`Bearer ${key}`, key],
    [`bearer ${key}`, key],
    [`Bearer  ${key} `, key],
    [undefined, null],
    ["", null],
    [key, null],
    [`Basic ${key}`, null],
    ["Bearer ", null],
    ["Bearer hl_live_tooShort", null],
    [`Bearer ${key}x`, null],
    [`Bearer ${key} extra`, null],
  ])("%p -> %p", (header, expected) => {
    expect(extractBearerKey(header)).toBe(expected);
  });
});
