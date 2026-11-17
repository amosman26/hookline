import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "hookline:isPublic";

/** Opts a route or controller out of API-key authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
