-- Provenance for an event's type, suggested answers for the drafter, and a
-- record of what students did with them. See lib/interview-prep.ts and
-- lib/draft-suggestions.ts.
--
-- Written to be re-runnable like 0010-0013: IF NOT EXISTS where Postgres has
-- it, drop-then-add for the constraint.
--
-- ADDITIVE ONLY. Three nullable columns on events, one on email_drafts, one
-- enum value, one new table; nothing existing is changed or removed.

ALTER TYPE "public"."ai_feature" ADD VALUE IF NOT EXISTS 'draftSuggestions';--> statement-breakpoint

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "type_source" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "type_detected_at" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "type_detected_from" text;--> statement-breakpoint

ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "suggestions" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "draft_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipient_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"connections" jsonb NOT NULL,
	"fields" jsonb NOT NULL,
	"model" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "draft_suggestions" DROP CONSTRAINT IF EXISTS "draft_suggestions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "draft_suggestions" ADD CONSTRAINT "draft_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "draft_suggestions_user_recipient_idx" ON "draft_suggestions" USING btree ("user_id","recipient_key");
