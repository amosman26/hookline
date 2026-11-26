import { EVENT_TYPE_RULE, isEventType } from "../endpoints/endpoint-input";

export interface CreateEventInput {
  type: string;
  payload: Record<string, unknown>;
}

/** Thrown for a request body that does not describe a valid event. */
export class EventInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "EventInputError";
  }
}

const ALLOWED_FIELDS = new Set(["type", "payload"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a POST /v1/events body. The payload is delivered exactly as sent,
 * so it only has to be a JSON object; its size is bounded by the body parser.
 */
export function parseCreateEvent(value: unknown): CreateEventInput {
  if (!isObject(value)) throw new EventInputError(["body must be a JSON object"]);

  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) problems.push(`${key} is not a known field`);
  }
  if (!isEventType(value.type)) problems.push(`type must be ${EVENT_TYPE_RULE}`);
  if (!isObject(value.payload)) problems.push("payload must be a JSON object");

  if (problems.length > 0) throw new EventInputError(problems);
  return { type: value.type as string, payload: value.payload as Record<string, unknown> };
}

/** The rule an Idempotency-Key header must follow, as shown in error messages. */
export const IDEMPOTENCY_KEY_RULE = "1-255 printable ASCII characters";

const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,255}$/;

/**
 * Validates the optional Idempotency-Key header. Node has already trimmed
 * surrounding whitespace and joined repeated headers with ", ", so a client
 * sending the header twice gets a key that will not match either value alone.
 */
export function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new EventInputError([`Idempotency-Key must be ${IDEMPOTENCY_KEY_RULE}`]);
  }
  return value;
}
