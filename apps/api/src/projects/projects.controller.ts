import { Controller, Get, Inject, NotFoundException } from "@nestjs/common";
import { projects } from "@hookline/db";
import { eq } from "drizzle-orm";
import { CurrentProject, type AuthenticatedProject } from "../auth/authenticated-project";
import { DB, type Database } from "../database/database.module";

export interface CurrentProjectResponse {
  id: string;
  name: string;
  createdAt: string;
}

@Controller("v1/project")
export class ProjectsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The project the presented API key belongs to. Handy for checking a key. */
  @Get()
  async current(@CurrentProject() auth: AuthenticatedProject): Promise<CurrentProjectResponse> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, auth.projectId))
      .limit(1);
    // The key cascades away with its project, so this only happens in a race.
    if (!project) throw new NotFoundException("Project not found");
    return { id: project.id, name: project.name, createdAt: project.createdAt.toISOString() };
  }
}
