import { createDb } from "@hookline/db";
import {
  DELIVERY_QUEUE,
  queuePrefix,
  redisConnection,
  type DeliveryJobData,
} from "@hookline/queue";
import { Queue } from "bullmq";
import { enqueuePending } from "./sweep";
import { createDeliveryWorker } from "./worker";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function concurrencyFromEnv(): number {
  const raw = process.env.WORKER_CONCURRENCY ?? "10";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const { db, pool } = createDb(required("DATABASE_URL"));
  const connection = redisConnection(required("REDIS_URL"));
  const concurrency = concurrencyFromEnv();

  const prefix = queuePrefix();

  const queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
    connection,
    ...(prefix ? { prefix } : {}),
  });
  const worker = createDeliveryWorker({ db, connection, concurrency, prefix });

  worker.on("completed", (job, outcome) => {
    const line = `delivery ${job.data.deliveryId}: ${outcome}`;
    // Dead-lettered work needs a person (or a replay), so make it stand out.
    if (outcome === "dead") console.warn(`${line} (out of retries, dead-lettered)`);
    else console.log(line);
  });
  worker.on("failed", (job, error) => {
    console.error(`delivery ${job?.data.deliveryId ?? "?"}: job failed: ${error.message}`);
  });
  worker.on("error", (error) => console.error(`worker error: ${error.message}`));

  const pending = await enqueuePending(db, queue);
  console.log(`worker started (concurrency ${concurrency}); ${pending} pending deliveries queued`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, finishing in-flight deliveries`);
    // close() waits for running jobs, so no attempt is cut off half-recorded.
    await worker.close();
    await queue.close();
    await pool.end();
  };
  process.once("SIGINT", (s) => void stop(s));
  process.once("SIGTERM", (s) => void stop(s));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
