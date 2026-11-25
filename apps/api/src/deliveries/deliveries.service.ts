import { Inject, Injectable } from "@nestjs/common";
import { deliveries, endpoints, type Delivery } from "@hookline/db";
import { and, eq, inArray } from "drizzle-orm";
import { DB, type Database } from "../database/database.module";
import { DeliveryQueue } from "../queue/delivery-queue";

/** Only finished, unsuccessful deliveries can be replayed. */
export const REPLAYABLE = ["failed", "dead"] as const;

export type ReplayResult =
  | { outcome: "replayed"; delivery: Delivery }
  | { outcome: "not_found" }
  | { outcome: "not_replayable"; reason: string };

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly queue: DeliveryQueue,
  ) {}

  /**
   * Makes a `failed` or `dead` delivery `pending` again and queues it. The
   * replay starts a new attempt chain: chain_start moves to the current
   * attempt count, so the worker gives it a full retry budget and backs off
   * from the base delay, while attempt numbers keep counting up and the
   * earlier attempts stay in the history.
   *
   * The event and its Hookline-Id are unchanged, so a receiver that already
   * processed it can still drop the duplicate.
   */
  async replay(projectId: string, deliveryId: string): Promise<ReplayResult> {
    const [row] = await this.db
      .select({ delivery: deliveries, enabled: endpoints.enabled })
      .from(deliveries)
      .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.projectId, projectId)));
    if (!row) return { outcome: "not_found" };

    const { delivery } = row;
    if (!(REPLAYABLE as readonly string[]).includes(delivery.status)) {
      return {
        outcome: "not_replayable",
        reason: `delivery is ${delivery.status}; only failed or dead deliveries can be replayed`,
      };
    }
    // It would only fail again at once without a request being made.
    if (!row.enabled) {
      return { outcome: "not_replayable", reason: "endpoint is disabled; enable it first" };
    }

    // Compare-and-set, so two replays at once start one chain, not two.
    const [updated] = await this.db
      .update(deliveries)
      .set({ status: "pending", chainStart: delivery.attemptCount, updatedAt: new Date() })
      .where(
        and(
          eq(deliveries.id, deliveryId),
          inArray(deliveries.status, [...REPLAYABLE]),
          eq(deliveries.attemptCount, delivery.attemptCount),
        ),
      )
      .returning();
    if (!updated) {
      return { outcome: "not_replayable", reason: "delivery changed while replaying; try again" };
    }

    // Finished jobs are removed from the queue, so the delivery id is free to
    // be queued again. If this enqueue fails, the worker's sweep picks it up.
    await this.queue.enqueue([updated.id]);
    return { outcome: "replayed", delivery: updated };
  }
}
