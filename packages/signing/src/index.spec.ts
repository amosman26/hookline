import {
  computeSignature,
  DEFAULT_TOLERANCE_SECONDS,
  ID_HEADER,
  sign,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
  type VerifyInput,
} from "./index";

const body = '{"type":"invoice.paid"}';
const secret = "whsec_test";
// Computed independently with:
//   printf '%s' 'msg_1.1700000000.{"type":"invoice.paid"}' | openssl dgst -sha256 -hmac <secret>
const VECTOR_TEST = "179bcf35bd20c53c84b29ab4040885de1c129c98c1f0353c169ab7c38c89d961";
const VECTOR_NEXT = "d1389991c754a9a9756c09d911c6a39a07a790731d90c1c3f6159e6d516b382e";

describe("computeSignature", () => {
  it("matches an HMAC-SHA256 of {id}.{timestamp}.{body} computed by openssl", () => {
    expect(computeSignature(secret, "msg_1", 1700000000, body)).toBe(VECTOR_TEST);
  });

  it("signs bytes and the equivalent string identically", () => {
    expect(computeSignature(secret, "msg_1", 1700000000, Buffer.from(body))).toBe(VECTOR_TEST);
  });

  it.each(["", "a.b"])("rejects the id %p", (id) => {
    expect(() => computeSignature(secret, id, 1, body)).toThrow(TypeError);
  });

  it("rejects an empty secret", () => {
    expect(() => computeSignature("", "msg_1", 1, body)).toThrow(TypeError);
  });
});

describe("sign", () => {
  it("produces the three Hookline headers", () => {
    expect(sign({ id: "msg_1", body, secret, timestamp: 1700000000 })).toEqual({
      [ID_HEADER]: "msg_1",
      [TIMESTAMP_HEADER]: "1700000000",
      [SIGNATURE_HEADER]: `v1=${VECTOR_TEST}`,
    });
  });

  it("sends one signature per secret while a secret is rotated", () => {
    const headers = sign({
      id: "msg_1",
      body,
      secret: [secret, "whsec_next"],
      timestamp: 1700000000,
    });
    expect(headers[SIGNATURE_HEADER]).toBe(`v1=${VECTOR_TEST} v1=${VECTOR_NEXT}`);
  });

  it("defaults the timestamp to the current Unix second", () => {
    jest.useFakeTimers({ now: new Date("2026-11-18T12:00:00.999Z") });
    try {
      expect(sign({ id: "msg_1", body, secret })[TIMESTAMP_HEADER]).toBe("1795003200");
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([-1, 1.5, Number.NaN])("rejects the timestamp %p", (timestamp) => {
    expect(() => sign({ id: "msg_1", body, secret, timestamp })).toThrow(TypeError);
  });

  it("requires at least one secret", () => {
    expect(() => sign({ id: "msg_1", body, secret: [] })).toThrow(TypeError);
  });
});

describe("verify", () => {
  const headers = sign({ id: "msg_1", body, secret, timestamp: 1700000000 });
  const valid: VerifyInput = {
    id: headers[ID_HEADER],
    timestamp: headers[TIMESTAMP_HEADER],
    signature: headers[SIGNATURE_HEADER],
    body,
    secret,
    now: 1700000000,
  };

  it("accepts what sign produced", () => {
    expect(verify(valid)).toBe(true);
    expect(verify({ ...valid, body: Buffer.from(body) })).toBe(true);
  });

  it.each<[string, Partial<VerifyInput>]>([
    ["a changed body", { body: '{"type":"invoice.paid" }' }],
    ["a different secret", { secret: "whsec_other" }],
    ["a different id", { id: "msg_2" }],
    ["a different timestamp", { timestamp: "1700000001" }],
    ["a missing id", { id: undefined }],
    ["a missing timestamp", { timestamp: undefined }],
    ["a missing signature", { signature: undefined }],
    ["a non-numeric timestamp", { timestamp: "17e8" }],
    ["an id containing '.'", { id: "msg.1" }],
    ["an unknown version", { signature: `v2=${VECTOR_TEST}` }],
    ["a truncated signature", { signature: `v1=${VECTOR_TEST.slice(0, 63)}` }],
    ["upper-case hex", { signature: `v1=${VECTOR_TEST.toUpperCase()}` }],
    ["a bare signature", { signature: VECTOR_TEST }],
  ])("rejects %s", (_label, change) => {
    expect(verify({ ...valid, ...change })).toBe(false);
  });

  it("accepts a header carrying signatures for an old and a new secret", () => {
    const rotated = sign({
      id: "msg_1",
      body,
      secret: ["whsec_old", secret],
      timestamp: 1700000000,
    })[SIGNATURE_HEADER];
    expect(verify({ ...valid, signature: rotated })).toBe(true);
    expect(verify({ ...valid, signature: rotated, secret: "whsec_old" })).toBe(true);
  });

  it("skips unknown versions and junk next to a valid signature", () => {
    expect(verify({ ...valid, signature: `v2=abc junk v1=${VECTOR_TEST}` })).toBe(true);
  });

  describe("timestamp tolerance", () => {
    const signedAt = 1700000000;

    it("defaults to five minutes", () => {
      expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    });

    it.each([0, 1, 299, 300, -1, -300])(
      "accepts a timestamp %p seconds from the verifier's clock",
      (offset) => {
        expect(verify({ ...valid, now: signedAt + offset })).toBe(true);
      },
    );

    it.each([
      ["older than five minutes", 301],
      ["an hour old", 3600],
      ["more than five minutes in the future", -301],
    ])("rejects a valid signature %s", (_label, offset) => {
      expect(verify({ ...valid, now: signedAt + offset })).toBe(false);
    });

    it("uses the system clock when now is not given", () => {
      const fresh = sign({ id: "msg_1", body, secret });
      const input = {
        id: fresh[ID_HEADER],
        timestamp: fresh[TIMESTAMP_HEADER],
        signature: fresh[SIGNATURE_HEADER],
        body,
        secret,
      };
      expect(verify(input)).toBe(true);
      expect(verify({ ...valid, now: undefined })).toBe(false);
    });

    it("takes a custom tolerance", () => {
      expect(verify({ ...valid, now: signedAt + 30, toleranceSeconds: 10 })).toBe(false);
      expect(verify({ ...valid, now: signedAt + 30, toleranceSeconds: 30 })).toBe(true);
      expect(verify({ ...valid, now: signedAt + 1e9, toleranceSeconds: Infinity })).toBe(true);
    });

    it("still rejects a bad signature inside the window", () => {
      expect(verify({ ...valid, secret: "whsec_other", toleranceSeconds: Infinity })).toBe(false);
    });

    it.each([-1, NaN])("refuses the tolerance %p", (toleranceSeconds) => {
      expect(() => verify({ ...valid, toleranceSeconds })).toThrow(TypeError);
    });
  });
});
