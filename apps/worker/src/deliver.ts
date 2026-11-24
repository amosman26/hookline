import {
  deliveries,
  deliveryAttempts,
  endpoints,
  events,
  type Database,
  type Endpoint,
  type Event,
} from "@hookline/db";
import { sign } from "@hookline/signing";
import { and, eq } from "drizzle-orm";
import {
  backoffDelay,
  classifyAttempt,
  MAX_ATTEMPTS,
  nextRetryDelay,
  parseRetryAfter,
  type AttemptVerdict,
} from "./retry";
import { send as defaultSend, type SendResult, type WebhookRequest } from "./send";

export const USER_AGENT = "Hookline/0.1";

/**
 * What one run of a delivery job did. `retrying` means the attempt failed in
 * a way worth trying again: the delivery stays `pending` and the caller
 * should run it again after `retryInMs`.
 */
export type DeliveryResult =
  { outcome: "succeeded" | "failed" | "skipped" } | { outcome: "retrying"; retryInMs: number };

export type DeliveryOutcome = DeliveryResult["outcome"];

export interface DeliverOptions {
  /** Swappable for tests; defaults to a real HTTP POST. */
  send?: (request: WebhookRequest) => Promise<SendResult>;
  /** Signing time in Unix seconds; defaults to now. */
  now?: () => number;
  /**
   * Wait in milliseconds after the given failed attempt (1-based). Defaults
   * to exponential backoff with full jitter (backoffDelay); tests use a short
   * fixed one. Retry-After can still lengthen it.
   */
  retryDelay?: (attemptNumber: number) => number;
}

/** The JSON body every endpoint receives. */
export function webhookBody(event: Event): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    data: event.payload,
  });
}

/**
 * The signed request for one event and endpoint. Hookline-Id is the event id,
 * so it stays the same on every attempt and receivers can use it to drop
 * duplicates (delivery is at-least-once).
 */
export function webhookRequest(
  event: Event,
  endpoint: Endpoint,
  timestamp?: number,
): WebhookRequest {
  const body = webhookBody(event);
  const signed = sign({ id: event.id, body, secret: endpoint.secret, timestamp });
  return {
    url: endpoint.url,
    headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...signed },
    body,
  };
}

/**
 * Makes one attempt at a delivery and records it. Safe to run twice for the
 * same delivery: anything no longer `pending` is skipped, and the attempt is
 * only recorded if the delivery is still where it was when we read it.
 *
 * A 2xx is `succeeded`. A failure worth retrying (see classifyAttempt) keeps
 * the delivery `pending` and returns `retrying` with the wait, until the
 * delivery has had MAX_ATTEMPTS; then it is `failed`. Any other failure, and
 * a disabled endpoint, is `failed` straight away.
 */
export async function deliver(
  db: Database,
  deliveryId: string,
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const [row] = await db
    .select({ delivery: deliveries, event: events, endpoint: endpoints })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
    .where(eq(deliveries.id, deliveryId));

  // Deleted with its endpoint or project, or already finished.
  if (!row || row.delivery.status !== "pending") return { outcome: "skipped" };

  const enabled = row.endpoint.enabled;
  const result: SendResult = enabled
    ? await (options.send ?? defaultSend)(webhookRequest(row.event, row.endpoint, options.now?.()))
    : {
        statusCode: null,
        durationMs: 0,
        responseBody: null,
        error: "endpoint is disabled",
        retryAfter: null,
      };

  const attemptNumber = row.delivery.attemptCount + 1;
  // A disabled endpoint stays disabled until someone acts, so don't wait on it.
  const verdict: AttemptVerdict = enabled ? classifyAttempt(result.statusCode) : "permanent";
  const willRetry = verdict === "retry" && attemptNumber < MAX_ATTEMPTS;
  const status = verdict === "success" ? "succeeded" : willRetry ? "pending" : "failed";

  const recorded = await db.transaction(async (tx) => {
    // Compare-and-set on attempt_count: if another run got here first, its
    // result stands and this one is dropped.
    const updated = await tx
      .update(deliveries)
      .set({ status, attemptCount: attemptNumber, updatedAt: new Date() })
      .where(
        and(
          eq(deliveries.id, deliveryId),
          eq(deliveries.status, "pending"),
          eq(deliveries.attemptCount, row.delivery.attemptCount),
        ),
      )
      .returning({ id: deliveries.id });
    if (updated.length === 0) return false;

    await tx.insert(deliveryAttempts).values({
      deliveryId,
      attemptNumber,
      statusCode: result.statusCode,
      durationMs: result.durationMs,
      responseBody: result.responseBody,
      error: result.error,
    });
    return true;
  });

  if (!recorded) return { outcome: "skipped" };
  if (status !== "pending") return { outcome: status };

  const policyDelay = (options.retryDelay ?? backoffDelay)(attemptNumber);
  const retryAfter = parseRetryAfter(result.retryAfter, Date.now());
  return { outcome: "retrying", retryInMs: nextRetryDelay(policyDelay, retryAfter) };
}
