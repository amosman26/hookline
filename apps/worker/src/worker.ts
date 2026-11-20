import type { Database } from "@hookline/db";
import { DELIVERY_QUEUE, type DeliveryJobData } from "@hookline/queue";
import { Worker, type ConnectionOptions } from "bullmq";
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
 * A BullMQ worker that makes one attempt per job. The job's return value is
 * the outcome, which is handy in logs; the record of truth is Postgres.
 */
export function createDeliveryWorker(
  options: DeliveryWorkerOptions,
): Worker<DeliveryJobData, DeliveryOutcome> {
  const { db, connection, concurrency = 10, prefix, ...deliverOptions } = options;
  return new Worker<DeliveryJobData, DeliveryOutcome>(
    DELIVERY_QUEUE,
    (job) => deliver(db, job.data.deliveryId, deliverOptions),
    { connection, concurrency, ...(prefix ? { prefix } : {}) },
  );
}
