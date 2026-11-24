/** Attempts a delivery gets in total before it stops being retried. */
export const MAX_ATTEMPTS = 12;

/** The longest wait between two attempts, whatever an endpoint asks for. */
export const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

/** Wait before the next attempt. A fixed delay for now; backoff comes next. */
export const RETRY_DELAY_MS = 5_000;

/** What one attempt's result means for the delivery. */
export type AttemptVerdict = "success" | "retry" | "permanent";

/**
 * Sorts an attempt by its status code (null when no response arrived).
 *
 * - 2xx: delivered.
 * - No response (network error or timeout), 408, 429 and 5xx: the endpoint
 *   is down, slow or busy, and may well accept the same request later.
 * - Anything else, chiefly the other 4xx (and a 3xx, which is not
 *   followed): the endpoint understood the request and refused it, so
 *   sending it again would only get the same answer.
 */
export function classifyAttempt(statusCode: number | null): AttemptVerdict {
  if (statusCode === null) return "retry";
  if (statusCode >= 200 && statusCode < 300) return "success";
  if (statusCode === 408 || statusCode === 429) return "retry";
  if (statusCode >= 500 && statusCode < 600) return "retry";
  return "permanent";
}

/**
 * Reads a Retry-After header (RFC 9110 section 10.2.3): either a number of
 * seconds or an HTTP date. Returns the wait in milliseconds, 0 for a date
 * already past, or null when the header is missing or malformed.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Date.parse would also take "2026" or "1.5"; insist on something date-like.
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * How long to wait before the next attempt: the policy's delay, or longer if
 * the endpoint asked for longer with Retry-After, but never more than
 * MAX_RETRY_DELAY_MS.
 */
export function nextRetryDelay(policyDelayMs: number, retryAfterMs: number | null): number {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(policyDelayMs, retryAfterMs ?? 0));
}
