import type { Database } from "@hookline/db";
import { DELIVERY_QUEUE, type DeliveryJobData } from "@hookline/queue";
import { DelayedError, Worker, type ConnectionOptions } from "bullmq";
import { deliver, type DeliverOptions, type DeliveryOutcome } from "./deliver";

export interface DeliveryWorkerOptions extends DeliverOptions {
  db: Database;
  connection: ConnectionOptions;
  /** Deliveries in flight at once. Each one is mostly waiting on the network. */
  concurrency?: number;
  /** BullMQ key prefix; tests use their own so they never share a queue. */
  prefix?: string;
}

/**
 * A BullMQ worker that makes one attempt per run of a job. When the attempt
 * should be retried, the same job is moved to the delayed set instead of
 * completing; its id stays taken meanwhile, so the API and the start-up sweep
 * cannot queue a second copy. Retries are decided by deliver() from what
 * Postgres records, not by BullMQ's own attempts, so a job that runs twice
 * can never earn a delivery extra tries.
 *
 * The job's return value is the final outcome, which is handy in logs; the
 * record of truth is Postgres.
 */
export function createDeliveryWorker(
  options: DeliveryWorkerOptions,
): Worker<DeliveryJobData, DeliveryOutcome> {
  const { db, connection, concurrency = 10, prefix, ...deliverOptions } = options;
  return new Worker<DeliveryJobData, DeliveryOutcome>(
    DELIVERY_QUEUE,
    async (job, token) => {
      const result = await deliver(db, job.data.deliveryId, deliverOptions);
      if (result.outcome !== "retrying") return result.outcome;
      await job.moveToDelayed(Date.now() + result.retryInMs, token);
      // Tells BullMQ the job was rescheduled, not finished or failed.
      throw new DelayedError();
    },
    { connection, concurrency, ...(prefix ? { prefix } : {}) },
  );
}
