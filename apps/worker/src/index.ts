// Library entry point, so other packages (the API's end-to-end tests) can run
// a real delivery worker in-process. `main.ts` remains the executable.
export { deliver, statusAfter, webhookBody, webhookRequest, USER_AGENT } from "./deliver";
export type { DeliverOptions, DeliveryOutcome, DeliveryResult } from "./deliver";
export { backoffDelay, classifyAttempt, MAX_ATTEMPTS, parseRetryAfter } from "./retry";
export type { AttemptVerdict } from "./retry";
export { enqueuePending } from "./sweep";
export { createDeliveryWorker } from "./worker";
export type { DeliveryWorkerOptions } from "./worker";
