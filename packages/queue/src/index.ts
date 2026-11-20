import type { JobsOptions, RedisOptions } from "bullmq";

/** BullMQ queue that holds one job per delivery still to be attempted. */
export const DELIVERY_QUEUE = "deliveries";

/** Job name used for every delivery job. */
export const DELIVER_JOB = "deliver";

/**
 * A job carries only the delivery id. Postgres is the source of truth: the
 * worker loads the event, endpoint and current status when the job runs, so
 * a stale or duplicated job can never send outdated data.
 */
export interface DeliveryJobData {
  deliveryId: string;
}

/**
 * Options for a delivery job. The job id is the delivery id, so adding the
 * same delivery twice while its job exists is a no-op: the API and the
 * worker's start-up sweep can both enqueue without creating duplicates.
 * Finished jobs are removed because the outcome lives in Postgres; that also
 * frees the id so a pending delivery can be enqueued again later.
 */
export function deliveryJobOptions(deliveryId: string): JobsOptions {
  return { jobId: deliveryId, removeOnComplete: true, removeOnFail: true };
}

/**
 * Connection options for `REDIS_URL`. BullMQ workers need
 * `maxRetriesPerRequest: null` so blocking commands survive reconnects.
 */
export function redisConnection(url: string): RedisOptions {
  return { url, maxRetriesPerRequest: null };
}
