-- An append-only record that a metered feature was used once.
--
-- The monthly allowances (lib/plan-quotas) counted rows in the feature's own
-- table - email_drafts, resume_reviews, video_interview_sessions - all of which
-- the student can delete, which returned the allowance with them. This ledger
-- holds the USE, not the content: a user id, which feature, and when. Deleting
-- a draft still deletes the draft; it no longer refunds the month.
--
-- Rows are also what a reservation is written to before a paid call starts, so
-- requests fired together queue on one lock instead of all passing the same
-- check (the shape lib/ai-runner already uses for the daily ceiling).
--
-- Cascades with the user: an account deletion takes its usage history too.
--
-- Every statement is guarded: migrations from 0006 on replay against the
-- shared database (see scripts/test/migration-replay.test.ts), so each must
-- survive running over a database that already has it.
CREATE TABLE IF NOT EXISTS "feature_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_usage_user_id_users_id_fk') THEN
    ALTER TABLE "feature_usage" ADD CONSTRAINT "feature_usage_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_usage_user_feature_idx" ON "feature_usage" ("user_id","feature","created_at");
