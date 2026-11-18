import {
  EndpointInputError,
  generateEndpointSecret,
  parseCreateEndpoint,
  parseUpdateEndpoint,
} from "./endpoint-input";

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof EndpointInputError) return error.problems;
    throw error;
  }
  throw new Error("expected an EndpointInputError");
}

describe("generateEndpointSecret", () => {
  it("issues whsec_ secrets with 256 bits of randomness", () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateEndpointSecret()).not.toBe(secret);
  });
});

describe("parseCreateEndpoint", () => {
  it("accepts a minimal body and fills in defaults", () => {
    expect(
      parseCreateEndpoint({ url: "https://example.com/hooks", eventTypes: ["invoice.paid"] }),
    ).toEqual({
      url: "https://example.com/hooks",
      description: null,
      eventTypes: ["invoice.paid"],
      enabled: true,
    });
  });

  it("sorts and de-duplicates event types and trims the description", () => {
    const input = parseCreateEndpoint({
      url: "http://localhost:4000/in",
      description: "  staging receiver ",
      eventTypes: ["user:created", "invoice.paid", "user:created"],
      enabled: false,
    });
    expect(input).toMatchObject({
      description: "staging receiver",
      eventTypes: ["invoice.paid", "user:created"],
      enabled: false,
    });
  });

  it("stores a blank description as null", () => {
    const input = parseCreateEndpoint({
      url: "https://example.com",
      description: "   ",
      eventTypes: ["a"],
    });
    expect(input.description).toBeNull();
  });

  it.each([
    ["not a URL", "url must be an absolute URL"],
    ["/relative", "url must be an absolute URL"],
    ["ftp://example.com/x", "url must use http or https"],
    ["https://user:pass@example.com/x", "url must not contain credentials"],
    [`https://example.com/${"a".repeat(2048)}`, "url must be at most 2048 characters"],
    ["", "url must be a non-empty string"],
    [42, "url must be a non-empty string"],
  ])("rejects url %p", (url, problem) => {
    expect(problemsOf(() => parseCreateEndpoint({ url, eventTypes: ["a"] }))).toEqual([problem]);
  });

  it.each([[[]], ["invoice.paid"], [[""]], [["has space"]], [[".leading-dot"]], [[1]]])(
    "rejects eventTypes %p",
    (eventTypes) => {
      const problems = problemsOf(() =>
        parseCreateEndpoint({ url: "https://example.com", eventTypes }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^eventTypes/);
    },
  );

  it("rejects more than 50 distinct event types", () => {
    const eventTypes = Array.from({ length: 51 }, (_, i) => `type.${i}`);
    expect(
      problemsOf(() => parseCreateEndpoint({ url: "https://example.com", eventTypes })),
    ).toEqual(["eventTypes must have at most 50 entries"]);
  });

  it("reports every problem at once, including unknown fields", () => {
    const problems = problemsOf(() =>
      parseCreateEndpoint({ url: "nope", enabled: "yes", secret: "mine" }),
    );
    expect(problems).toEqual([
      "secret is not a known field",
      "url must be an absolute URL",
      "eventTypes must be a non-empty array",
      "enabled must be a boolean",
    ]);
  });

  it.each([null, [], "body"])("rejects a non-object body %p", (body) => {
    expect(problemsOf(() => parseCreateEndpoint(body))).toEqual(["body must be a JSON object"]);
  });
});

describe("parseUpdateEndpoint", () => {
  it("returns only the fields that were sent", () => {
    expect(parseUpdateEndpoint({ enabled: false })).toEqual({ enabled: false });
    expect(parseUpdateEndpoint({ description: null })).toEqual({ description: null });
  });

  it("rejects an empty update", () => {
    expect(problemsOf(() => parseUpdateEndpoint({}))).toEqual([
      "body must change at least one field",
    ]);
  });

  it("validates fields the same way as create", () => {
    expect(problemsOf(() => parseUpdateEndpoint({ url: "ftp://x", eventTypes: [] }))).toEqual([
      "url must use http or https",
      "eventTypes must be a non-empty array",
    ]);
  });
});
