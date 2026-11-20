import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import {
  DELIVER_JOB,
  DELIVERY_QUEUE,
  deliveryJobOptions,
  type DeliveryJobData,
} from "@hookline/queue";
import { Queue } from "bullmq";
import { setTimeout as delay } from "node:timers/promises";

/** How long a request waits for Redis before giving up on enqueueing. */
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * Producer side of the delivery queue. The BullMQ queue (and its Redis
 * connection) is created on first use, so the API starts and /health answers
 * without Redis, and routes that never enqueue never connect.
 */
@Injectable()
export class DeliveryQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryQueue.name);
  private queue: Queue<DeliveryJobData> | undefined;

  private get(): Queue<DeliveryJobData> {
    if (!this.queue) {
      const url = process.env.REDIS_URL;
      if (!url) throw new Error("REDIS_URL is not set");
      // The default per-request retry limit (unlike the worker's `null`) makes
      // commands fail instead of waiting forever while Redis is down.
      this.queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, { connection: { url } });
      this.queue.on("error", (error) => this.logger.warn(`Redis: ${error.message}`));
    }
    return this.queue;
  }

  /**
   * Adds one job per delivery. Never throws: the deliveries are already
   * committed as `pending`, so a failure here only delays them until the
   * worker's start-up sweep enqueues every pending delivery again. Failing
   * the request instead would invite the producer to resend the event.
   */
  async enqueue(deliveryIds: readonly string[]): Promise<void> {
    if (deliveryIds.length === 0) return;
    const abort = new AbortController();
    try {
      const added = this.get().addBulk(
        deliveryIds.map((deliveryId) => ({
          name: DELIVER_JOB,
          data: { deliveryId },
          opts: deliveryJobOptions(deliveryId),
        })),
      );
      // If the timeout wins, the add may still land later; job ids are the
      // delivery ids, so that can never create a duplicate.
      added.catch(() => undefined);
      await Promise.race([
        added,
        delay(ENQUEUE_TIMEOUT_MS, undefined, { signal: abort.signal }).then(() => {
          throw new Error(`timed out after ${ENQUEUE_TIMEOUT_MS} ms`);
        }),
      ]);
    } catch (error) {
      this.logger.error(
        `Could not enqueue ${deliveryIds.length} deliveries; they stay pending until the worker sweep`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      abort.abort();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
