import { Controller, Get } from "@nestjs/common";

export interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
}

@Controller("health")
export class HealthController {
  /**
   * Liveness probe. Deliberately has no dependencies: readiness checks for
   * Postgres and Redis arrive with those services.
   */
  @Get()
  check(): HealthResponse {
    return { status: "ok", uptimeSeconds: Math.floor(process.uptime()) };
  }
}
