import { Inject, Injectable } from "@nestjs/common";
import { deliveries, endpoints, events, type Delivery, type Event } from "@hookline/db";
import { and, arrayContains, asc, eq, sql } from "drizzle-orm";
import { DB, type Database } from "../database/database.module";
import { DeliveryQueue } from "../queue/delivery-queue";
import type { CreateEventInput } from "./event-input";

export interface AcceptedEvent {
  event: Event;
  deliveries: Delivery[];
  /** True when the Idempotency-Key matched an earlier event, which is returned instead. */
  replayed: boolean;
}

/** Thrown when an Idempotency-Key is reused for an event with a different type or payload. */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super("Idempotency-Key was already used for an event with a different type or payload");
    this.name = "IdempotencyKeyReusedError";
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
   *
   * With an idempotency key, a retry of the same request (same key, type and
   * payload within the project) stores nothing and enqueues nothing: it gets
   * the original event and its deliveries back, with their current status. The
   * same key with a different type or payload is a client bug and is refused.
   * Keys do not expire yet; they live as long as the event does.
   */
  async accept(
    projectId: string,
    input: CreateEventInput,
    idempotencyKey?: string,
  ): Promise<AcceptedEvent> {
    const accepted = await this.store(projectId, input, idempotencyKey ?? null);
    if (!accepted.replayed) await this.queue.enqueue(accepted.deliveries.map((d) => d.id));
    return accepted;
  }

  private store(
    projectId: string,
    input: CreateEventInput,
    idempotencyKey: string | null,
  ): Promise<AcceptedEvent> {
    return this.db.transaction(async (tx) => {
      // Two requests racing with one key both reach this insert. The unique
      // index on (project_id, idempotency_key) makes the second wait for the
      // first to commit and then insert nothing, so exactly one event exists.
      // Keyless events never conflict: NULLs are distinct in a unique index.
      const [event] = await tx
        .insert(events)
        .values({ projectId, type: input.type, payload: input.payload, idempotencyKey })
        .onConflictDoNothing({ target: [events.projectId, events.idempotencyKey] })
        .returning();
      if (!event) {
        if (idempotencyKey === null) throw new Error("insert returned no row");
        return this.original(tx, projectId, input, idempotencyKey);
      }

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

      if (subscribed.length === 0) return { event, deliveries: [], replayed: false };

      const created = await tx
        .insert(deliveries)
        .values(subscribed.map(({ id }) => ({ projectId, eventId: event.id, endpointId: id })))
        .returning();
      return { event, deliveries: created, replayed: false };
    });
  }

  /**
   * Loads the event an idempotency key already belongs to. The payload is
   * compared as jsonb, so key order and whitespace in the request body don't
   * make an honest retry look like a different event.
   */
  private async original(
    tx: Transaction,
    projectId: string,
    input: CreateEventInput,
    idempotencyKey: string,
  ): Promise<AcceptedEvent> {
    const [found] = await tx
      .select({
        event: events,
        samePayload: sql<boolean>`${events.payload} = ${JSON.stringify(input.payload)}::jsonb`,
      })
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.idempotencyKey, idempotencyKey)));
    if (!found) throw new Error("idempotency key conflicted but no event was found");
    if (found.event.type !== input.type || !found.samePayload) {
      throw new IdempotencyKeyReusedError();
    }

    // Same order as the original response: by endpoint creation.
    const rows = await tx
      .select({ delivery: deliveries })
      .from(deliveries)
      .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
      .where(eq(deliveries.eventId, found.event.id))
      .orderBy(asc(endpoints.createdAt), asc(endpoints.id));
    return { event: found.event, deliveries: rows.map((r) => r.delivery), replayed: true };
  }
}
