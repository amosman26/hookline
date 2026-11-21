// Library entry point, so other packages (the API's end-to-end tests) can run
// a real delivery worker in-process. `main.ts` remains the executable.
export { deliver, webhookBody, webhookRequest, USER_AGENT } from "./deliver";
export type { DeliverOptions, DeliveryOutcome } from "./deliver";
export { enqueuePending } from "./sweep";
export { createDeliveryWorker } from "./worker";
export type { DeliveryWorkerOptions } from "./worker";
