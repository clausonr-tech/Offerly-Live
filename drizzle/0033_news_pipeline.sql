-- The news pipeline: sources, stories, labels, events, desk picks, AI job
-- usage, the student digest and takedowns (hide + reports).
--
-- Written to be re-runnable. Supabase already has most of this, applied ahead
-- of the merge by scripts/apply-news-schema.ts while the pipeline ran from a
-- branch; every statement here is IF NOT EXISTS or guarded, so replaying it on
-- that database is a no-op and on a fresh one builds everything. It was three
-- migrations on the branch (pipeline, digest, takedown), folded into one when
-- main took 0029-0032.

CREATE TABLE IF NOT EXISTS "ai_job_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"engine" text NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_item_id" uuid NOT NULL,
	"story_type" text,
	"primary_sector" text,
	"sectors" text[] NOT NULL,
	"publisher_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"scores" jsonb NOT NULL,
	"ranked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_item_firms" (
	"item_id" uuid NOT NULL,
	"firm_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "news_item_firms_item_id_firm_id_pk" PRIMARY KEY("item_id","firm_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"url_hash" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"publisher" text NOT NULL,
	"publisher_domain" text,
	"image_url" text,
	"published_at" timestamp NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"title_key" text NOT NULL,
	"also_published_by" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text NOT NULL,
	"filing_form" text,
	"status" text DEFAULT 'new' NOT NULL,
	"classify_attempts" integer DEFAULT 0 NOT NULL,
	"cluster_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_labels" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"classifier_version" text NOT NULL,
	"model" text NOT NULL,
	"relevant" boolean NOT NULL,
	"abstain" text,
	"primary_sector" text,
	"sectors" text[] NOT NULL,
	"story_type" text,
	"worthiness" integer,
	"entities" jsonb NOT NULL,
	"amount_usd" double precision,
	"region" text,
	"labeled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_sector_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector" text NOT NULL,
	"run_id" text NOT NULL,
	"cluster_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"question" text,
	"reason" text,
	"picked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"tier" text NOT NULL,
	"sectors" text[] NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"paywall" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"metrics" jsonb,
	"notes" text,
	"last_fetched_at" timestamp,
	"last_item_at" timestamp,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_item_firms" ADD CONSTRAINT "news_item_firms_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_item_firms" ADD CONSTRAINT "news_item_firms_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_items" ADD CONSTRAINT "news_items_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_labels" ADD CONSTRAINT "news_labels_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_job_usage_feature_created_idx" ON "ai_job_usage" USING btree ("feature","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_clusters_last_seen_idx" ON "news_clusters" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_item_firms_firm_idx" ON "news_item_firms" USING btree ("firm_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_items_url_hash_key" ON "news_items" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_status_idx" ON "news_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_published_idx" ON "news_items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_title_key_idx" ON "news_items" USING btree ("title_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_sector_picks_sector_idx" ON "news_sector_picks" USING btree ("sector","picked_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_digests" (
	"user_id" uuid NOT NULL,
	"edition_date" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_digests_user_id_edition_date_pk" PRIMARY KEY("user_id","edition_date")
);
--> statement-breakpoint
ALTER TABLE "news_clusters" ADD COLUMN IF NOT EXISTS "specialties" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "news_labels" ADD COLUMN IF NOT EXISTS "specialties" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_digests" ADD CONSTRAINT "news_digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "hidden_at" timestamp;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "hidden_reason" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "news_reports" (
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_reports_item_id_user_id_pk" PRIMARY KEY("item_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_reports" ADD CONSTRAINT "news_reports_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "news_reports" ADD CONSTRAINT "news_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Supabase: close the PostgREST side, as 0026-0032 do. The app connects as the
-- table owner and is unaffected; the public API sees nothing. news_digests and
-- news_reports hold per-student rows.
ALTER TABLE "news_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_item_firms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_clusters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_sector_picks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_job_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_digests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "news_reports" ENABLE ROW LEVEL SECURITY;
