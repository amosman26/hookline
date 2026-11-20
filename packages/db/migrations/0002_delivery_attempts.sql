CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"response_body" text,
	"error" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_number_key" ON "delivery_attempts" USING btree ("delivery_id","attempt_number");