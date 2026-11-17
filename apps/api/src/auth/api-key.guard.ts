import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { extractBearerKey } from "./api-key";
import { ApiKeysService } from "./api-keys.service";
import type { AuthenticatedRequest } from "./authenticated-project";
import { IS_PUBLIC } from "./public.decorator";

/**
 * Global guard: every route needs `Authorization: Bearer hl_live_...` unless
 * it is marked @Public(). Failures share one message so callers cannot tell a
 * malformed key from an unknown or revoked one.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const key = extractBearerKey(request.headers.authorization);
    const auth = key ? await this.apiKeys.authenticate(key) : null;
    if (!auth) {
      http.getResponse<Response>().setHeader("WWW-Authenticate", 'Bearer realm="hookline"');
      throw new UnauthorizedException("Missing or invalid API key");
    }

    request.auth = auth;
    return true;
  }
}
