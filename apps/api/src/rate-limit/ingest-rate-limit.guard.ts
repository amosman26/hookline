import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../auth/authenticated-project";
import { IngestRateLimiter } from "./ingest-rate-limiter";

/**
 * Route guard for ingestion. Runs after the global ApiKeyGuard, so the
 * caller's API key is known. Every counted response carries the
 * `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers
 * (seconds); a refused request is 429 with `Retry-After`.
 */
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: IngestRateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const auth = http.getRequest<AuthenticatedRequest>().auth;
    if (!auth) throw new Error("IngestRateLimitGuard used on an unauthenticated route");

    const decision = await this.limiter.hit(auth.apiKeyId);
    if (!decision) return true;

    const res = http.getResponse<Response>();
    res.setHeader("RateLimit-Limit", String(decision.limit));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));
    res.setHeader("RateLimit-Reset", String(decision.resetSeconds));
    if (decision.allowed) return true;

    res.setHeader("Retry-After", String(decision.resetSeconds));
    throw new HttpException(
      {
        statusCode: 429,
        error: "Too Many Requests",
        message: [
          `Rate limit of ${decision.limit} events per API key exceeded; retry in ${decision.resetSeconds} s`,
        ],
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
