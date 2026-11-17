import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { ProjectsController } from "./projects/projects.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [HealthController, ProjectsController],
})
export class AppModule {}
