import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A tenant. Every other row belongs to exactly one project. */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

/**
 * Project API keys (`hl_live_<random>`). Only the SHA-256 hash of the full key
 * is stored, so a leaked database cannot be used to call the API. The prefix
 * is kept so people can tell their keys apart in the dashboard.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_key").on(t.keyHash),
    index("api_keys_project_id_idx").on(t.projectId),
  ],
);

/**
 * A URL that receives signed deliveries for the event types it subscribes to.
 * The signing secret has to be readable (we sign with it), so unlike API keys
 * it is stored as is; protect the database accordingly.
 */
export const endpoints = pgTable(
  "endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    secret: text("secret").notNull(),
    eventTypes: text("event_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("endpoints_project_id_idx").on(t.projectId),
    // Fan-out asks "which enabled endpoints want this type?"; GIN answers it.
    index("endpoints_event_types_idx").using("gin", t.eventTypes),
  ],
);

/** An event as the producer sent it. Deliveries are created from it later. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLs never collide, so events sent without a key are unaffected.
    uniqueIndex("events_project_id_idempotency_key_key").on(t.projectId, t.idempotencyKey),
    index("events_project_id_created_at_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

/**
 * Where one event stands with one endpoint. `pending` until it is delivered
 * (`succeeded`), refused for good (`failed`) or out of retries (`dead`).
 */
export const deliveryStatus = pgEnum("delivery_status", ["pending", "succeeded", "failed", "dead"]);

/**
 * One row per (event, endpoint) pair, created when the event is accepted.
 * Postgres is the source of truth for what still has to be delivered; the
 * queue only says when to try. Deleting an endpoint deletes its deliveries.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    status: deliveryStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An event is delivered to each endpoint once; this also serves lookups by event.
    uniqueIndex("deliveries_event_id_endpoint_id_key").on(t.eventId, t.endpointId),
    index("deliveries_endpoint_id_created_at_idx").on(t.endpointId, t.createdAt.desc()),
  ],
);

/**
 * One HTTP request made for a delivery. Kept even when it succeeds, so the
 * full history of a delivery can be shown. `statusCode` is null when no
 * response arrived (network error, timeout); `error` says why. The response
 * body is truncated to 4 KB before it is stored.
 */
export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms").notNull(),
    responseBody: text("response_body"),
    error: text("error"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Attempts are numbered per delivery; the worker relies on this to never
    // record the same attempt twice.
    uniqueIndex("delivery_attempts_delivery_id_attempt_number_key").on(
      t.deliveryId,
      t.attemptNumber,
    ),
  ],
);

export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Endpoint = typeof endpoints.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type DeliveryStatus = (typeof deliveryStatus.enumValues)[number];
