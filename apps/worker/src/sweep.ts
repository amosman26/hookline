import { deliveries, type Database } from "@hookline/db";
import { DELIVER_JOB, deliveryJobOptions, type DeliveryJobData } from "@hookline/queue";
import type { Queue } from "bullmq";
import { and, asc, eq, gt } from "drizzle-orm";

const BATCH_SIZE = 500;

/**
 * Enqueues every delivery that is still `pending`. The API enqueues right
 * after it commits, but if Redis was down then, or lost its data, Postgres
 * still knows what is owed; running this at start-up recovers those
 * deliveries. Job ids are delivery ids, so deliveries already queued are
 * left alone. Returns how many pending deliveries were found.
 */
export async function enqueuePending(db: Database, queue: Queue<DeliveryJobData>): Promise<number> {
  let after: string | undefined;
  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.status, "pending"), after ? gt(deliveries.id, after) : undefined))
      .orderBy(asc(deliveries.id))
      .limit(BATCH_SIZE);
    if (batch.length === 0) return total;

    await queue.addBulk(
      batch.map(({ id }) => ({
        name: DELIVER_JOB,
        data: { deliveryId: id },
        opts: deliveryJobOptions(id),
      })),
    );
    total += batch.length;
    after = batch.at(-1)?.id;
  }
}
