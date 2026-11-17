import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "hl_live_";

/** How much of a key is kept in clear so people can tell keys apart. */
const VISIBLE_LENGTH = API_KEY_PREFIX.length + 4;

/** `hl_live_` followed by 32 random bytes in base64url (43 characters). */
const API_KEY_PATTERN = /^hl_live_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  /** The full key. Show it once; it cannot be recovered afterwards. */
  key: string;
  /** Safe to store and display, e.g. `hl_live_x7Qa`. */
  prefix: string;
  /** SHA-256 of the full key, hex encoded. This is what the database holds. */
  hash: string;
}

/**
 * A plain SHA-256 is enough here: the key carries 256 bits of entropy, so
 * there is nothing for a slow password hash to protect against, and lookups
 * stay a single indexed equality match.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, prefix: key.slice(0, VISIBLE_LENGTH), hash: hashApiKey(key) };
}

export function isWellFormedApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

/**
 * Pulls the key out of an `Authorization: Bearer <key>` header. Returns null
 * for anything else, including well-formed headers carrying a malformed key,
 * so obvious junk never reaches the database.
 */
export function extractBearerKey(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  const key = match?.[1];
  return key && isWellFormedApiKey(key) ? key : null;
}
