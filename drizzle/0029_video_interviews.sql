-- The video interview coach (Interview Prep > Video interview): sessions, the
-- questions asked and their answers, audio kept for training by explicit
-- opt-in only, and an append-only log of consent decisions.
-- New tables only - nothing existing is altered, so the rest of the app runs
-- the same before and after this. Every statement is re-runnable (see
-- scripts/test/helpers/test-db.ts on why replay-safety is required).

CREATE TABLE IF NOT EXISTS "video_interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL CONSTRAINT "video_interview_sessions_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"mode" text NOT NULL CONSTRAINT "video_interview_sessions_mode_check" CHECK ("mode" IN ('behavioral', 'technical', 'both')),
	"difficulty" text NOT NULL,
	"think_seconds" integer NOT NULL,
	"answer_seconds" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL CONSTRAINT "video_interview_sessions_status_check" CHECK ("status" IN ('in_progress', 'complete', 'abandoned')),
	"tailored_to" text DEFAULT '' NOT NULL,
	"analysis_policy_version" text NOT NULL,
	"report" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_interview_sessions_user_idx" ON "video_interview_sessions" ("user_id","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "video_interview_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL CONSTRAINT "video_interview_questions_session_id_video_interview_sessions_id_fk" REFERENCES "video_interview_sessions"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL CONSTRAINT "video_interview_questions_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	"kind" text NOT NULL CONSTRAINT "video_interview_questions_kind_check" CHECK ("kind" IN ('behavioral', 'technical')),
	"bank_id" text NOT NULL,
	"category" text,
	"topic" text NOT NULL,
	"difficulty" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL CONSTRAINT "video_interview_questions_status_check" CHECK ("status" IN ('pending', 'processing', 'complete', 'failed', 'skipped')),
	"asked_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp,
	"duration_ms" integer,
	"audio_content_type" text,
	"audio_bytes" integer,
	"transcript" text,
	"transcription_status" text,
	"grading_status" text,
	"feedback" jsonb,
	"overall_score" integer,
	"last_error" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_interview_questions_session_position_idx" ON "video_interview_questions" ("session_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_interview_questions_user_idx" ON "video_interview_questions" ("user_id","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "video_interview_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL CONSTRAINT "video_interview_recordings_question_id_video_interview_questions_id_fk" REFERENCES "video_interview_questions"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL CONSTRAINT "video_interview_recordings_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"training_policy_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_interview_recordings_question_idx" ON "video_interview_recordings" ("question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_interview_recordings_user_idx" ON "video_interview_recordings" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "video_interview_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL CONSTRAINT "video_interview_consent_events_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" text NOT NULL CONSTRAINT "video_interview_consent_events_kind_check" CHECK ("kind" IN ('analysis_granted', 'training_granted', 'training_revoked')),
	"policy_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_interview_consent_user_idx" ON "video_interview_consent_events" ("user_id","created_at");--> statement-breakpoint

-- Supabase: new tables arrive with RLS off; the app connects as a role that
-- bypasses RLS, so enabling it closes the PostgREST side without touching the
-- app (see 0027).
ALTER TABLE "video_interview_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_interview_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_interview_recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_interview_consent_events" ENABLE ROW LEVEL SECURITY;
