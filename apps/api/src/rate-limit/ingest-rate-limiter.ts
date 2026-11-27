import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { queuePrefix } from "@hookline/queue";
import { Redis } from "ioredis";
import { setTimeout as delay } from "node:timers/promises";
import {
  decide,
  rateLimitConfig,
  type RateLimitConfig,
  type RateLimitDecision,
} from "./rate-limit-config";

/** How long a request waits for Redis before it is let through uncounted. */
const REDIS_TIMEOUT_MS = 500;

/**
 * Fixed-window counter: INCR the key, start its expiry on the first request
 * of a window, and return the count with the time left. One round trip, and
 * atomic, so concurrent requests can't both see the same count. The PTTL < 0
 * branch repairs a key that somehow lost its expiry instead of blocking the
 * caller for ever.
 */
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * Per-API-key limit on event ingestion, counted in Redis so every API
 * instance shares it. A fixed window can let up to twice the limit through
 * around a window boundary; that is an accepted trade for one key and one
 * round trip per request.
 *
 * Fails open: if Redis is down or slow the request goes ahead uncounted, the
 * same choice the delivery queue makes. Ingestion stays available, and the
 * events are still stored in Postgres.
 */
@Injectable()
export class IngestRateLimiter implements OnApplicationShutdown {
  private readonly logger = new Logger(IngestRateLimiter.name);
  /** Read once at start-up, so a bad value stops the API from booting. */
  private readonly config: RateLimitConfig | null = rateLimitConfig();
  private readonly keyPrefix = `${queuePrefix() ?? "hookline"}:ratelimit:ingest:`;
  private redis: Redis | undefined;

  private client(): Redis {
    if (!this.redis) {
      const url = process.env.REDIS_URL;
      if (!url) throw new Error("REDIS_URL is not set");
      this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
      this.redis.on("error", (error: Error) => this.logger.warn(`Redis: ${error.message}`));
    }
    return this.redis;
  }

  /**
   * Counts one request for `apiKeyId`. Returns null when the limit is off or
   * Redis couldn't be reached in time; the caller then lets the request in.
   */
  async hit(apiKeyId: string): Promise<RateLimitDecision | null> {
    const config = this.config;
    if (!config) return null;

    const abort = new AbortController();
    try {
      const counted = this.client().eval(
        COUNT_SCRIPT,
        1,
        this.keyPrefix + apiKeyId,
        config.windowSeconds * 1000,
      ) as Promise<[number, number]>;
      counted.catch(() => undefined);
      const [count, resetInMs] = await Promise.race([
        counted,
        delay(REDIS_TIMEOUT_MS, undefined, { signal: abort.signal }).then(() => {
          throw new Error(`timed out after ${REDIS_TIMEOUT_MS} ms`);
        }),
      ]);
      return decide(config, { count, resetInMs });
    } catch (error) {
      this.logger.warn(
        `Rate limit not applied, Redis unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      abort.abort();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }
}
