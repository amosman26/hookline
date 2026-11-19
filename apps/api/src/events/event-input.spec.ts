import { EventInputError, parseCreateEvent } from "./event-input";

function problemsOf(body: unknown): string[] {
  try {
    parseCreateEvent(body);
  } catch (error) {
    if (error instanceof EventInputError) return error.problems;
    throw error;
  }
  throw new Error("expected an EventInputError");
}

describe("parseCreateEvent", () => {
  it("accepts a type and an object payload", () => {
    const payload = { id: "inv_1", amount: 1200, lines: [{ sku: "a" }] };
    expect(parseCreateEvent({ type: "invoice.paid", payload })).toEqual({
      type: "invoice.paid",
      payload,
    });
  });

  it("accepts an empty payload object", () => {
    expect(parseCreateEvent({ type: "ping", payload: {} })).toEqual({ type: "ping", payload: {} });
  });

  it.each([null, [], "invoice.paid", 42])("rejects a %p body", (body) => {
    expect(problemsOf(body)).toEqual(["body must be a JSON object"]);
  });

  it.each(["", ".paid", "invoice paid", "a".repeat(101), 7, undefined])(
    "rejects the type %p",
    (type) => {
      expect(problemsOf({ type, payload: {} })).toEqual([
        expect.stringMatching(/^type must be 1-100 characters/),
      ]);
    },
  );

  it.each([null, [], "text", 1, undefined])("rejects the payload %p", (payload) => {
    expect(problemsOf({ type: "invoice.paid", payload })).toEqual([
      "payload must be a JSON object",
    ]);
  });

  it("lists every problem at once, including unknown fields", () => {
    expect(problemsOf({ type: "", payload: 1, idempotencyKey: "k" })).toEqual([
      "idempotencyKey is not a known field",
      expect.stringMatching(/^type must be/),
      "payload must be a JSON object",
    ]);
  });
});
