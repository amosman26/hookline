import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** Who is calling: set on the request by ApiKeyGuard. */
export interface AuthenticatedProject {
  projectId: string;
  apiKeyId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthenticatedProject;
}

/** Injects the caller's project into a handler parameter. */
export const CurrentProject = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedProject => {
    const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    // Only reachable if a handler that uses this decorator is marked @Public().
    if (!auth) throw new Error("CurrentProject used on an unauthenticated route");
    return auth;
  },
);
