import { Module } from "@nestjs/common";
import { IngestRateLimitGuard } from "./ingest-rate-limit.guard";
import { IngestRateLimiter } from "./ingest-rate-limiter";

@Module({
  providers: [IngestRateLimiter, IngestRateLimitGuard],
  exports: [IngestRateLimiter, IngestRateLimitGuard],
})
export class RateLimitModule {}
