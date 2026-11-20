// Tests that need Redis read REDIS_URL, like the API does. CI provides one;
// locally they are skipped when it is unset.
export const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) {
  throw new Error("REDIS_URL must be set in CI");
}

/** `it` when Redis is available, `it.skip` otherwise. */
export const itWithRedis = redisUrl ? it : it.skip;
