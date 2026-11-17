import { Inject, Injectable } from "@nestjs/common";
import { apiKeys } from "@hookline/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { DB, type Database } from "../database/database.module";
import type { AuthenticatedProject } from "./authenticated-project";
import { hashApiKey } from "./api-key";

/** last_used_at is informational; writing it on every request is wasted I/O. */
const LAST_USED_RESOLUTION = sql`interval '1 minute'`;

@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Resolves a presented key to its project, or null if unknown or revoked. */
  async authenticate(key: string): Promise<AuthenticatedProject | null> {
    const [row] = await this.db
      .select({ apiKeyId: apiKeys.id, projectId: apiKeys.projectId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) return null;

    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiKeys.id, row.apiKeyId),
          or(
            isNull(apiKeys.lastUsedAt),
            lt(apiKeys.lastUsedAt, sql`now() - ${LAST_USED_RESOLUTION}`),
          ),
        ),
      );
    return row;
  }
}
