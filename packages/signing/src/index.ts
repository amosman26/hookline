import { createHmac, timingSafeEqual } from "node:crypto";

/** Unique per message; receivers can use it to drop duplicate deliveries. */
export const ID_HEADER = "Hookline-Id";
/** Unix time in whole seconds when the message was signed. */
export const TIMESTAMP_HEADER = "Hookline-Timestamp";
/** One or more space-separated `v1=<hex>` signatures. */
export const SIGNATURE_HEADER = "Hookline-Signature";

const VERSION = "v1";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const UNIX_SECONDS = /^\d{1,12}$/;

/** The raw request body. Sign and verify the exact bytes sent, never re-serialised JSON. */
export type Payload = string | Uint8Array;

export interface SignInput {
  /** Message id, sent as Hookline-Id. */
  id: string;
  /** The raw body that will be sent. */
  body: Payload;
  /**
   * The endpoint's signing secret, or several while a secret is being rotated.
   * Every secret produces its own signature so receivers on either secret
   * keep verifying during the overlap.
   */
  secret: string | readonly string[];
  /** Signing time in Unix seconds. Defaults to now; set it in tests. */
  timestamp?: number;
}

export type SignedHeaders = Record<
  typeof ID_HEADER | typeof TIMESTAMP_HEADER | typeof SIGNATURE_HEADER,
  string
>;

function assertId(id: string): void {
  // The id is part of the signed string; a "." in it would make
  // "{id}.{timestamp}.{body}" ambiguous.
  if (id.length === 0 || id.includes(".")) {
    throw new TypeError("id must be a non-empty string without '.'");
  }
}

/**
 * HMAC-SHA256 over `{id}.{timestamp}.{body}`, hex encoded. Binding the id and
 * timestamp into the MAC stops an attacker replaying a captured body under a
 * fresh id or timestamp.
 */
export function computeSignature(
  secret: string,
  id: string,
  timestamp: number | string,
  body: Payload,
): string {
  if (secret.length === 0) throw new TypeError("secret must not be empty");
  assertId(id);
  return createHmac("sha256", secret)
    .update(`${id}.${timestamp}.`, "utf8")
    .update(body)
    .digest("hex");
}

/** Headers to send with a delivery. */
export function sign(input: SignInput): SignedHeaders {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("timestamp must be a non-negative integer number of seconds");
  }
  const secrets = typeof input.secret === "string" ? [input.secret] : input.secret;
  if (secrets.length === 0) throw new TypeError("at least one secret is required");

  const signatures = secrets.map(
    (secret) => `${VERSION}=${computeSignature(secret, input.id, timestamp, input.body)}`,
  );
  return {
    [ID_HEADER]: input.id,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signatures.join(" "),
  };
}

export interface VerifyInput {
  /** Value of the Hookline-Id header. */
  id: string | undefined;
  /** Value of the Hookline-Timestamp header. */
  timestamp: string | undefined;
  /** Value of the Hookline-Signature header. */
  signature: string | undefined;
  /** The raw body exactly as received. */
  body: Payload;
  /** The endpoint's signing secret. */
  secret: string;
}

/**
 * True when any `v1=` signature in the header matches. Comparison is
 * constant-time so response timing leaks nothing about the expected MAC.
 * Unknown versions are ignored, so a future v2 can be sent alongside v1.
 *
 * This checks authenticity only. Checking that the timestamp is recent is a
 * separate policy decision; until the verifier enforces a window, callers
 * should reject old timestamps themselves.
 */
export function verify(input: VerifyInput): boolean {
  const { id, timestamp, signature, body, secret } = input;
  if (!id || id.includes(".") || !timestamp || !UNIX_SECONDS.test(timestamp) || !signature) {
    return false;
  }
  const expected = Buffer.from(computeSignature(secret, id, timestamp, body), "hex");

  let matched = false;
  for (const entry of signature.split(" ")) {
    const separator = entry.indexOf("=");
    if (separator === -1 || entry.slice(0, separator) !== VERSION) continue;
    const candidate = entry.slice(separator + 1);
    if (!HEX_SHA256.test(candidate)) continue;
    // Keep comparing after a match so the time taken does not depend on
    // which position the matching signature was in.
    if (timingSafeEqual(Buffer.from(candidate, "hex"), expected)) matched = true;
  }
  return matched;
}
