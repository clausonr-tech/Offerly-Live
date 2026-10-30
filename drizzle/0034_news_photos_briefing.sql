-- News photos, the daily briefing, and the paid news sources each student can
-- read. Additive and re-runnable, like 0033.

ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "image_candidate" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "resolved_url" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "image_source" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "image_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "image_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "news_access" text[];--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_briefings" (
	"edition_date" text NOT NULL,
	"scope" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_briefings_edition_date_scope_pk" PRIMARY KEY("edition_date","scope")
);
--> statement-breakpoint
-- Supabase: close the PostgREST side, as 0033 does for the other news tables.
ALTER TABLE "news_briefings" ENABLE ROW LEVEL SECURITY;
