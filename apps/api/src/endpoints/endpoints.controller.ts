import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import type { Endpoint } from "@hookline/db";
import { CurrentProject, type AuthenticatedProject } from "../auth/authenticated-project";
import {
  EndpointInputError,
  parseCreateEndpoint,
  parseRotateSecret,
  parseUpdateEndpoint,
  type CreateEndpointInput,
  type UpdateEndpointInput,
} from "./endpoint-input";
import { EndpointsService } from "./endpoints.service";

export interface EndpointResponse {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  /**
   * When the secret replaced by the latest rotation stops signing deliveries;
   * null when only the current secret is in use.
   */
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned on creation and rotation: the only times the signing secret is shown. */
export interface CreatedEndpointResponse extends EndpointResponse {
  secret: string;
}

function toResponse(endpoint: Endpoint): EndpointResponse {
  const expiresAt = endpoint.previousSecretExpiresAt;
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    enabled: endpoint.enabled,
    previousSecretExpiresAt:
      endpoint.previousSecret !== null && expiresAt !== null && expiresAt.getTime() > Date.now()
        ? expiresAt.toISOString()
        : null,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  };
}

function validate<T>(parse: (body: unknown) => T, body: unknown): T {
  try {
    return parse(body);
  } catch (error) {
    if (error instanceof EndpointInputError) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: error.problems,
      });
    }
    throw error;
  }
}

const uuid = new ParseUUIDPipe({ version: "4" });

@Controller("v1/endpoints")
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Post()
  async create(
    @CurrentProject() auth: AuthenticatedProject,
    @Body() body: unknown,
  ): Promise<CreatedEndpointResponse> {
    const input: CreateEndpointInput = validate(parseCreateEndpoint, body);
    const endpoint = await this.endpoints.create(auth.projectId, input);
    return { ...toResponse(endpoint), secret: endpoint.secret };
  }

  @Get()
  async list(@CurrentProject() auth: AuthenticatedProject): Promise<{ data: EndpointResponse[] }> {
    const rows = await this.endpoints.list(auth.projectId);
    return { data: rows.map(toResponse) };
  }

  @Get(":id")
  async get(
    @CurrentProject() auth: AuthenticatedProject,
    @Param("id", uuid) id: string,
  ): Promise<EndpointResponse> {
    const endpoint = await this.endpoints.find(auth.projectId, id);
    if (!endpoint) throw new NotFoundException("Endpoint not found");
    return toResponse(endpoint);
  }

  @Patch(":id")
  async update(
    @CurrentProject() auth: AuthenticatedProject,
    @Param("id", uuid) id: string,
    @Body() body: unknown,
  ): Promise<EndpointResponse> {
    const input: UpdateEndpointInput = validate(parseUpdateEndpoint, body);
    const endpoint = await this.endpoints.update(auth.projectId, id, input);
    if (!endpoint) throw new NotFoundException("Endpoint not found");
    return toResponse(endpoint);
  }

  /**
   * Issues a new signing secret and returns it (the only time it is shown).
   * The old one keeps signing alongside it for `overlapSeconds` (default 24
   * hours), so receivers can accept either while they switch over.
   */
  @Post(":id/rotate-secret")
  @HttpCode(200)
  async rotateSecret(
    @CurrentProject() auth: AuthenticatedProject,
    @Param("id", uuid) id: string,
    @Body() body: unknown,
  ): Promise<CreatedEndpointResponse> {
    const input = validate(parseRotateSecret, body);
    const endpoint = await this.endpoints.rotateSecret(auth.projectId, id, input);
    if (!endpoint) throw new NotFoundException("Endpoint not found");
    return { ...toResponse(endpoint), secret: endpoint.secret };
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentProject() auth: AuthenticatedProject,
    @Param("id", uuid) id: string,
  ): Promise<void> {
    if (!(await this.endpoints.remove(auth.projectId, id))) {
      throw new NotFoundException("Endpoint not found");
    }
  }
}
