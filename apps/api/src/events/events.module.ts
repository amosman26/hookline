import { Module } from "@nestjs/common";
import { RateLimitModule } from "../rate-limit/rate-limit.module";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";

@Module({
  imports: [RateLimitModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
