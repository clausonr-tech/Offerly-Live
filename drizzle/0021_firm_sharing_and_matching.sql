-- Student opt-in to sharing with firms, each firm's Student matching
-- requirements, and a firm's own name for an "Other event". See
-- lib/firm-sharing.ts, lib/firm-matching.ts and lib/firm-posting-rules.ts.
--
-- Written to be re-runnable like 0010-0019: IF NOT EXISTS where Postgres has
-- it, drop-then-add for constraints. Otherwise what drizzle-kit generated.
--
-- ADDITIVE ONLY. Three nullable columns (null = not shared, which is every
-- existing account; null kind_label = the standard label) and one new table.

CREATE TABLE IF NOT EXISTS "firm_match_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"grad_years" integer[] DEFAULT '{}' NOT NULL,
	"school_ids" uuid[] DEFAULT '{}' NOT NULL,
	"majors" text[] DEFAULT '{}' NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"locations" text[] DEFAULT '{}' NOT NULL,
	"degree_levels" text[] DEFAULT '{}' NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "firm_recruiting_events" ADD COLUMN IF NOT EXISTS "kind_label" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firm_sharing_opted_in_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firm_sharing_policy_version" text;--> statement-breakpoint

ALTER TABLE "firm_match_criteria" DROP CONSTRAINT IF EXISTS "firm_match_criteria_firm_id_firms_id_fk";--> statement-breakpoint
ALTER TABLE "firm_match_criteria" ADD CONSTRAINT "firm_match_criteria_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_match_criteria" DROP CONSTRAINT IF EXISTS "firm_match_criteria_updated_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "firm_match_criteria" ADD CONSTRAINT "firm_match_criteria_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "firm_match_criteria_firm_idx" ON "firm_match_criteria" USING btree ("firm_id");
