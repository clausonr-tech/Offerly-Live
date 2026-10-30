-- Per-interview training consent: the student is asked "contribute this
-- interview?" every time one starts, and the answer is recorded on the
-- session before recording begins. Additive only: every existing session
-- gets training_opt_in = false (opted out), which is the safe reading of a
-- session from before the question existed.
-- start_token makes "Start interview" idempotent: a double-click sends the
-- same token and gets the same session. NULLs never collide in a unique
-- index, so older sessions are unaffected.
-- Re-runnable (see scripts/test/helpers/test-db.ts).

ALTER TABLE "video_interview_sessions" ADD COLUMN IF NOT EXISTS "training_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "video_interview_sessions" ADD COLUMN IF NOT EXISTS "training_policy_version" text;--> statement-breakpoint
ALTER TABLE "video_interview_sessions" ADD COLUMN IF NOT EXISTS "training_decided_at" timestamp;--> statement-breakpoint
ALTER TABLE "video_interview_sessions" ADD COLUMN IF NOT EXISTS "training_withdrawn_at" timestamp;--> statement-breakpoint
ALTER TABLE "video_interview_sessions" ADD COLUMN IF NOT EXISTS "start_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_interview_sessions_start_token_idx" ON "video_interview_sessions" ("user_id","start_token");
