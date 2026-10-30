ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "crustdata_company_id" bigint;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "verified_domain" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "aliases" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "identity_confidence" real;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "identity_status" text DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "identity_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_top_firms" ADD COLUMN IF NOT EXISTS "match_score" integer;--> statement-breakpoint
ALTER TABLE "user_top_firms" ADD COLUMN IF NOT EXISTS "matched_preferences" text[] DEFAULT '{}' NOT NULL;