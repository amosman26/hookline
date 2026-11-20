import { Global, Module } from "@nestjs/common";
import { DeliveryQueue } from "./delivery-queue";

@Global()
@Module({
  providers: [DeliveryQueue],
  exports: [DeliveryQueue],
})
export class QueueModule {}
