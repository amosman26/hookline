/** Ingestion limit per API key: at most `limit` requests per window. */
export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export const DEFAULT_INGEST_RATE_LIMIT = 600;
export const DEFAULT_INGEST_RATE_WINDOW_SECONDS = 60;

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  return Number(value);
}

/**
 * Reads `INGEST_RATE_LIMIT` (requests per window, default 600) and
 * `INGEST_RATE_WINDOW_SECONDS` (default 60). `INGEST_RATE_LIMIT=0` turns the
 * limit off and returns null. Anything that isn't a whole number throws, so a
 * typo fails at start-up instead of silently disabling the limit.
 */
export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig | null {
  const limit = positiveInteger(
    "INGEST_RATE_LIMIT",
    env.INGEST_RATE_LIMIT,
    DEFAULT_INGEST_RATE_LIMIT,
  );
  const windowSeconds = positiveInteger(
    "INGEST_RATE_WINDOW_SECONDS",
    env.INGEST_RATE_WINDOW_SECONDS,
    DEFAULT_INGEST_RATE_WINDOW_SECONDS,
  );
  if (windowSeconds === 0) throw new Error("INGEST_RATE_WINDOW_SECONDS must be at least 1");
  if (limit === 0) return null;
  return { limit, windowSeconds };
}

/** What one counted request learned about its window. */
export interface WindowState {
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Milliseconds until the window resets. */
  resetInMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until the window resets, at least 1. */
  resetSeconds: number;
}

/** Turns a counter reading into an allow/deny decision and header values. */
export function decide(config: RateLimitConfig, state: WindowState): RateLimitDecision {
  return {
    allowed: state.count <= config.limit,
    limit: config.limit,
    remaining: Math.max(0, config.limit - state.count),
    resetSeconds: Math.max(1, Math.ceil(state.resetInMs / 1000)),
  };
}
