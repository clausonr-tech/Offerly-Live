-- The firm portal: firm sign-in codes, the click log behind firm analytics,
-- and the columns that let a firm post its own internships and events. See
-- lib/firm-auth.ts, lib/firm-posting.ts and lib/firm-analytics.ts.
--
-- Written to be re-runnable like 0010-0013: IF NOT EXISTS where Postgres has
-- it, drop-then-add for constraints, and a DO block for the new enum type.
-- Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. Two new tables and new columns with defaults; every existing
-- row keeps its meaning (every posting and event is "crawler", every account
-- and firm is not a demo).

DO $$ BEGIN
	CREATE TYPE "public"."firm_role" AS ENUM('owner', 'member');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'firm_posting';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'firm_event';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "firm_engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"posting_id" uuid,
	"event_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "firm_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp,
	"pending" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'crawler' NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "posted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "school_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "format" text;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "rsvp_url" text;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'crawler' NOT NULL;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "posted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "extra_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "internship_postings" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firm_role" "firm_role";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "firm_engagement" DROP CONSTRAINT IF EXISTS "firm_engagement_firm_id_firms_id_fk";--> statement-breakpoint
ALTER TABLE "firm_engagement" ADD CONSTRAINT "firm_engagement_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_engagement" DROP CONSTRAINT IF EXISTS "firm_engagement_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "firm_engagement" ADD CONSTRAINT "firm_engagement_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_engagement" DROP CONSTRAINT IF EXISTS "firm_engagement_posting_id_internship_postings_id_fk";--> statement-breakpoint
ALTER TABLE "firm_engagement" ADD CONSTRAINT "firm_engagement_posting_id_internship_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."internship_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_engagement" DROP CONSTRAINT IF EXISTS "firm_engagement_event_id_firm_recruiting_events_id_fk";--> statement-breakpoint
ALTER TABLE "firm_engagement" ADD CONSTRAINT "firm_engagement_event_id_firm_recruiting_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."firm_recruiting_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" DROP CONSTRAINT IF EXISTS "firm_recruiting_events_posted_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "firm_recruiting_events" ADD CONSTRAINT "firm_recruiting_events_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internship_postings" DROP CONSTRAINT IF EXISTS "internship_postings_posted_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "internship_postings" ADD CONSTRAINT "internship_postings_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "firm_engagement_firm_idx" ON "firm_engagement" USING btree ("firm_id","kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "firm_login_codes_email_idx" ON "firm_login_codes" USING btree ("email","created_at");
