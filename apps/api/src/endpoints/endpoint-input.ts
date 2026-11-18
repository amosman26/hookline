import { randomBytes } from "node:crypto";

/** Longest URL we accept; anything longer is almost certainly a mistake. */
export const MAX_URL_LENGTH = 2048;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_EVENT_TYPES = 50;

/**
 * Event types look like `invoice.paid` or `user:created`: letters, digits and
 * `._:-`, starting with a letter or digit, at most 100 characters.
 */
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export const ENDPOINT_SECRET_PREFIX = "whsec_";

/** `whsec_` followed by 32 random bytes in base64url. */
export function generateEndpointSecret(): string {
  return ENDPOINT_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

export interface CreateEndpointInput {
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
}

export type UpdateEndpointInput = Partial<CreateEndpointInput>;

/** Thrown for a request body that does not describe a valid endpoint. */
export class EndpointInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "EndpointInputError";
  }
}

type Body = Record<string, unknown>;

const ALLOWED_FIELDS = new Set(["url", "description", "eventTypes", "enabled"]);

function asBody(value: unknown): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EndpointInputError(["body must be a JSON object"]);
  }
  return value as Body;
}

function checkUnknownFields(body: Body, problems: string[]): void {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) problems.push(`${key} is not a known field`);
  }
}

function parseUrl(value: unknown, problems: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    problems.push("url must be a non-empty string");
    return undefined;
  }
  if (value.length > MAX_URL_LENGTH) {
    problems.push(`url must be at most ${MAX_URL_LENGTH} characters`);
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push("url must be an absolute URL");
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push("url must use http or https");
    return undefined;
  }
  // Credentials in the URL would be logged and shown in the dashboard; the
  // signature is how receivers authenticate us.
  if (parsed.username || parsed.password) {
    problems.push("url must not contain credentials");
    return undefined;
  }
  return parsed.toString();
}

function parseDescription(value: unknown, problems: string[]): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") {
    problems.push("description must be a string or null");
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    return undefined;
  }
  return trimmed === "" ? null : trimmed;
}

function parseEventTypes(value: unknown, problems: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("eventTypes must be a non-empty array");
    return undefined;
  }
  const bad = value.filter((t) => typeof t !== "string" || !EVENT_TYPE_PATTERN.test(t));
  if (bad.length > 0) {
    problems.push(
      "eventTypes entries must be 1-100 characters of letters, digits and ._:- " +
        "starting with a letter or digit",
    );
    return undefined;
  }
  // Order is irrelevant to matching, so store a stable, de-duplicated list.
  const unique = [...new Set(value as string[])].sort();
  if (unique.length > MAX_EVENT_TYPES) {
    problems.push(`eventTypes must have at most ${MAX_EVENT_TYPES} entries`);
    return undefined;
  }
  return unique;
}

function parseEnabled(value: unknown, problems: string[]): boolean | undefined {
  if (typeof value !== "boolean") {
    problems.push("enabled must be a boolean");
    return undefined;
  }
  return value;
}

/** Validates a POST /v1/endpoints body. Throws EndpointInputError listing every problem. */
export function parseCreateEndpoint(value: unknown): CreateEndpointInput {
  const body = asBody(value);
  const problems: string[] = [];
  checkUnknownFields(body, problems);

  const url = parseUrl(body.url, problems);
  const description =
    body.description === undefined ? null : parseDescription(body.description, problems);
  const eventTypes = parseEventTypes(body.eventTypes, problems);
  const enabled = body.enabled === undefined ? true : parseEnabled(body.enabled, problems);

  if (
    problems.length > 0 ||
    url === undefined ||
    description === undefined ||
    eventTypes === undefined ||
    enabled === undefined
  ) {
    throw new EndpointInputError(problems);
  }
  return { url, description, eventTypes, enabled };
}

/** Validates a PATCH /v1/endpoints/:id body. Only fields present are changed. */
export function parseUpdateEndpoint(value: unknown): UpdateEndpointInput {
  const body = asBody(value);
  const problems: string[] = [];
  checkUnknownFields(body, problems);

  const update: UpdateEndpointInput = {};
  if (body.url !== undefined) update.url = parseUrl(body.url, problems);
  if (body.description !== undefined) {
    update.description = parseDescription(body.description, problems);
  }
  if (body.eventTypes !== undefined) {
    update.eventTypes = parseEventTypes(body.eventTypes, problems);
  }
  if (body.enabled !== undefined) update.enabled = parseEnabled(body.enabled, problems);

  if (problems.length > 0) throw new EndpointInputError(problems);
  if (Object.keys(update).length === 0) {
    throw new EndpointInputError(["body must change at least one field"]);
  }
  return update;
}
