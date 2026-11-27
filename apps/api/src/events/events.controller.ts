import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { DeliveryStatus } from "@hookline/db";
import type { Response } from "express";
import { CurrentProject, type AuthenticatedProject } from "../auth/authenticated-project";
import { IngestRateLimitGuard } from "../rate-limit/ingest-rate-limit.guard";
import {
  EventInputError,
  parseCreateEvent,
  parseIdempotencyKey,
  type CreateEventInput,
} from "./event-input";
import { EventsService, IdempotencyKeyReusedError } from "./events.service";

export interface AcceptedEventResponse {
  id: string;
  type: string;
  createdAt: string;
  deliveries: { id: string; endpointId: string; status: DeliveryStatus }[];
}

function parse<T>(validate: () => T): T {
  try {
    return validate();
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
   *
   * A repeat with the same Idempotency-Key gets the original event back, also
   * with 202, marked by `Idempotent-Replayed: true`. Reusing a key for a
   * different event is 422, as in the IETF Idempotency-Key header draft.
   *
   * Each API key may send INGEST_RATE_LIMIT requests per window (429 with
   * Retry-After beyond that). Idempotent replays count too: they still cost
   * a database round trip.
   */
  @Post()
  @UseGuards(IngestRateLimitGuard)
  @HttpCode(202)
  async create(
    @CurrentProject() auth: AuthenticatedProject,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcceptedEventResponse> {
    const idempotencyKey = parse(() => parseIdempotencyKey(idempotencyKeyHeader));
    const input = parse<CreateEventInput>(() => parseCreateEvent(body));

    let accepted;
    try {
      accepted = await this.events.accept(auth.projectId, input, idempotencyKey);
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: [error.message],
        });
      }
      throw error;
    }

    const { event, deliveries, replayed } = accepted;
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt.toISOString(),
      deliveries: deliveries.map((d) => ({ id: d.id, endpointId: d.endpointId, status: d.status })),
    };
  }
}
