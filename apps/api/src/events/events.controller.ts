import { BadRequestException, Body, Controller, HttpCode, Post } from "@nestjs/common";
import type { DeliveryStatus } from "@hookline/db";
import { CurrentProject, type AuthenticatedProject } from "../auth/authenticated-project";
import { EventInputError, parseCreateEvent, type CreateEventInput } from "./event-input";
import { EventsService } from "./events.service";

export interface AcceptedEventResponse {
  id: string;
  type: string;
  createdAt: string;
  deliveries: { id: string; endpointId: string; status: DeliveryStatus }[];
}

function parse(body: unknown): CreateEventInput {
  try {
    return parseCreateEvent(body);
  } catch (error) {
    if (error instanceof EventInputError) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: error.problems,
      });
    }
    throw error;
  }
}

@Controller("v1/events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * 202, not 201: the event is stored, but delivery happens later. An event
   * no endpoint subscribes to is still accepted and stored, with no deliveries.
   */
  @Post()
  @HttpCode(202)
  async create(
    @CurrentProject() auth: AuthenticatedProject,
    @Body() body: unknown,
  ): Promise<AcceptedEventResponse> {
    const { event, deliveries } = await this.events.accept(auth.projectId, parse(body));
    return {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt.toISOString(),
      deliveries: deliveries.map((d) => ({ id: d.id, endpointId: d.endpointId, status: d.status })),
    };
  }
}
