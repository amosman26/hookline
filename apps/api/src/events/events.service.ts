import { Inject, Injectable } from "@nestjs/common";
import { deliveries, endpoints, events, type Delivery, type Event } from "@hookline/db";
import { and, arrayContains, asc, eq } from "drizzle-orm";
import { DB, type Database } from "../database/database.module";
import { DeliveryQueue } from "../queue/delivery-queue";
import type { CreateEventInput } from "./event-input";

export interface AcceptedEvent {
  event: Event;
  deliveries: Delivery[];
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly queue: DeliveryQueue,
  ) {}

  /**
   * Stores the event and one pending delivery per enabled endpoint of the
   * project that subscribes to its type, in a single transaction: once the
   * caller gets a 202, every delivery owed for the event exists. Endpoints
   * created or enabled later do not receive events accepted before them.
   *
   * Jobs are enqueued only after the transaction commits, so the worker never
   * picks up a delivery it cannot see yet.
   */
  async accept(projectId: string, input: CreateEventInput): Promise<AcceptedEvent> {
    const accepted = await this.store(projectId, input);
    await this.queue.enqueue(accepted.deliveries.map((d) => d.id));
    return accepted;
  }

  private store(projectId: string, input: CreateEventInput): Promise<AcceptedEvent> {
    return this.db.transaction(async (tx) => {
      const [event] = await tx
        .insert(events)
        .values({ projectId, type: input.type, payload: input.payload })
        .returning();
      if (!event) throw new Error("insert returned no row");

      // `event_types @> ARRAY[type]` can use the GIN index on event_types.
      const subscribed = await tx
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.projectId, projectId),
            eq(endpoints.enabled, true),
            arrayContains(endpoints.eventTypes, [input.type]),
          ),
        )
        .orderBy(asc(endpoints.createdAt), asc(endpoints.id));

      if (subscribed.length === 0) return { event, deliveries: [] };

      const created = await tx
        .insert(deliveries)
        .values(subscribed.map(({ id }) => ({ projectId, eventId: event.id, endpointId: id })))
        .returning();
      return { event, deliveries: created };
    });
  }
}
