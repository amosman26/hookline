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
  createdAt: string;
  updatedAt: string;
}

/** Returned once, on creation: the only time the signing secret is shown. */
export interface CreatedEndpointResponse extends EndpointResponse {
  secret: string;
}

function toResponse(endpoint: Endpoint): EndpointResponse {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    enabled: endpoint.enabled,
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
