-- A short summary of each story a student can open on /news: its key points
-- and the takeaway, written by the news pipeline. Additive and re-runnable,
-- like 0033 and 0034.

CREATE TABLE IF NOT EXISTS "news_summaries" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb,
	"model" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_summaries_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Supabase: close the PostgREST side, as 0033 does for the other news tables.
ALTER TABLE "news_summaries" ENABLE ROW LEVEL SECURITY;
