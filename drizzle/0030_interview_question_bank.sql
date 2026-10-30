-- The interview question bank in the database - the video coach's runtime
-- source of truth - and the upload lifecycle for training recordings, which
-- now live in private object storage rather than in this database.
-- Rows are seeded by scripts/seed-interview-questions.ts, not here: 8,000+
-- authored questions do not belong in a migration, and the seed is an
-- idempotent upsert keyed by the authored stable id.
-- Every statement is re-runnable (see scripts/test/helpers/test-db.ts).

CREATE TABLE IF NOT EXISTS "interview_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL CONSTRAINT "interview_questions_kind_check" CHECK ("kind" IN ('behavioral', 'technical')),
	"prompt" text NOT NULL,
	"topic" text NOT NULL,
	"category" text,
	"specialty" text,
	"difficulty" text NOT NULL CONSTRAINT "interview_questions_difficulty_check" CHECK ("difficulty" IN ('foundational', 'intermediate', 'advanced')),
	"expected_points" jsonb NOT NULL CONSTRAINT "interview_questions_expected_points_check" CHECK (jsonb_typeof("expected_points") = 'array'),
	"is_behavioral_core" boolean DEFAULT false NOT NULL,
	"rotation_priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'authored' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interview_questions_serving_idx" ON "interview_questions" ("kind","category","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interview_questions_core_idx" ON "interview_questions" ("is_behavioral_core","rotation_priority");--> statement-breakpoint

-- Training recordings: pending (uploading through a signed URL) -> stored
-- (checked by the server) -> deleting (object being removed). Existing rows,
-- if any, were written complete, so they default to stored.
ALTER TABLE "video_interview_recordings" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'stored' NOT NULL CONSTRAINT "video_interview_recordings_status_check" CHECK ("status" IN ('pending', 'stored', 'deleting'));--> statement-breakpoint
ALTER TABLE "video_interview_recordings" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "video_interview_recordings" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp;--> statement-breakpoint

-- Supabase: close the PostgREST side, as 0027 and 0029 do.
ALTER TABLE "interview_questions" ENABLE ROW LEVEL SECURITY;
