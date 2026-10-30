-- The firm portal's notification center: one table of firm-level news, and a
-- per-account "last opened" time for unread counts. See lib/firm-insights.ts.
--
-- Written to be re-runnable like 0010-0015: IF NOT EXISTS where Postgres has
-- it, drop-then-add for the constraint. Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. One new table and one nullable column.

CREATE TABLE IF NOT EXISTS "firm_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firm_notifications_seen_at" timestamp;--> statement-breakpoint

ALTER TABLE "firm_notifications" DROP CONSTRAINT IF EXISTS "firm_notifications_firm_id_firms_id_fk";--> statement-breakpoint
ALTER TABLE "firm_notifications" ADD CONSTRAINT "firm_notifications_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "firm_notifications_firm_key_idx" ON "firm_notifications" USING btree ("firm_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "firm_notifications_firm_created_idx" ON "firm_notifications" USING btree ("firm_id","created_at");
