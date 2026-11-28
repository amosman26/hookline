ALTER TABLE "endpoints" ADD COLUMN "previous_secret" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "previous_secret_expires_at" timestamp with time zone;