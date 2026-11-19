import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { EndpointsModule } from "./endpoints/endpoints.module";
import { EventsModule } from "./events/events.module";
import { HealthController } from "./health/health.controller";
import { ProjectsController } from "./projects/projects.controller";

@Module({
  imports: [DatabaseModule, AuthModule, EndpointsModule, EventsModule],
  controllers: [HealthController, ProjectsController],
})
export class AppModule {}
