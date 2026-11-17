import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDb, type Database, type DbHandle } from "@hookline/db";

/** Injection token for the Drizzle database. */
export const DB = Symbol("DB");
/** Injection token for the handle that owns the connection pool. */
export const DB_HANDLE = Symbol("DB_HANDLE");

export type { Database };

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}

/**
 * One Postgres pool for the whole API. The pool connects lazily, so the app
 * starts (and /health answers) before the database is reachable.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      useFactory: (): DbHandle => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is not set");
        return createDb(url);
      },
    },
    { provide: DB, useFactory: (handle: DbHandle): Database => handle.db, inject: [DB_HANDLE] },
    PoolCloser,
  ],
  exports: [DB],
})
export class DatabaseModule {}
