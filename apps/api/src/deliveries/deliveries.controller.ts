import {
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import type { DeliveryStatus } from "@hookline/db";
import { CurrentProject, type AuthenticatedProject } from "../auth/authenticated-project";
import { DeliveriesService } from "./deliveries.service";

export interface ReplayedDeliveryResponse {
  id: string;
  eventId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
}

@Controller("v1/deliveries")
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  /**
   * 202 like event ingestion: the delivery is queued, not yet sent. 404 for a
   * delivery of another project; 409 when it is not failed or dead, or its
   * endpoint is disabled.
   */
  @Post(":id/replay")
  @HttpCode(202)
  async replay(
    @CurrentProject() auth: AuthenticatedProject,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<ReplayedDeliveryResponse> {
    const result = await this.deliveries.replay(auth.projectId, id);
    if (result.outcome === "not_found") throw new NotFoundException("Delivery not found");
    if (result.outcome === "not_replayable") throw new ConflictException(result.reason);
    const { delivery } = result;
    return {
      id: delivery.id,
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
    };
  }
}
