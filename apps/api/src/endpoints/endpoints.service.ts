import { Inject, Injectable } from "@nestjs/common";
import { endpoints, type Endpoint } from "@hookline/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { DB, type Database } from "../database/database.module";
import {
  generateEndpointSecret,
  type CreateEndpointInput,
  type RotateSecretInput,
  type UpdateEndpointInput,
} from "./endpoint-input";

/**
 * Every query is scoped by project id, so one project can never read or
 * change another project's endpoints, even by guessing an id.
 */
@Injectable()
export class EndpointsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(projectId: string, input: CreateEndpointInput): Promise<Endpoint> {
    const [row] = await this.db
      .insert(endpoints)
      .values({ projectId, ...input, secret: generateEndpointSecret() })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  list(projectId: string): Promise<Endpoint[]> {
    return this.db
      .select()
      .from(endpoints)
      .where(eq(endpoints.projectId, projectId))
      .orderBy(asc(endpoints.createdAt), asc(endpoints.id));
  }

  async find(projectId: string, id: string): Promise<Endpoint | null> {
    const [row] = await this.db
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.projectId, projectId), eq(endpoints.id, id)))
      .limit(1);
    return row ?? null;
  }

  async update(
    projectId: string,
    id: string,
    input: UpdateEndpointInput,
  ): Promise<Endpoint | null> {
    const [row] = await this.db
      .update(endpoints)
      .set({ ...input, updatedAt: sql`now()` })
      .where(and(eq(endpoints.projectId, projectId), eq(endpoints.id, id)))
      .returning();
    return row ?? null;
  }

  /**
   * Swaps in a new signing secret. With an overlap the old secret becomes the
   * previous one and keeps signing deliveries until it expires; with none it
   * is dropped at once. Rotating again during an overlap retires the oldest
   * secret, so at most two are ever active. One UPDATE, so concurrent
   * rotations can't interleave: the right-hand sides all see the old row.
   */
  async rotateSecret(
    projectId: string,
    id: string,
    input: RotateSecretInput,
  ): Promise<Endpoint | null> {
    const keepPrevious = input.overlapSeconds > 0;
    const [row] = await this.db
      .update(endpoints)
      .set({
        secret: generateEndpointSecret(),
        previousSecret: keepPrevious ? sql`${endpoints.secret}` : null,
        previousSecretExpiresAt: keepPrevious
          ? sql`now() + ${input.overlapSeconds} * interval '1 second'`
          : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(endpoints.projectId, projectId), eq(endpoints.id, id)))
      .returning();
    return row ?? null;
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(endpoints)
      .where(and(eq(endpoints.projectId, projectId), eq(endpoints.id, id)))
      .returning({ id: endpoints.id });
    return rows.length > 0;
  }
}
