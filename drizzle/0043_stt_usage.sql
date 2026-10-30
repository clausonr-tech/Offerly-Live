-- Speech-to-text spend, in audio seconds actually billed.
--
-- The video coach's limits (lib/video-interview/limits) cap how many answers a
-- student may upload, and upload-validation caps the BYTES. Neither bounds the
-- audio MINUTES the provider bills for: durationMs is the browser's claim, and
-- a low-bitrate file of a few hundred kilobytes can be an hour long. This
-- table records the duration the provider itself reports, so a rolling budget
-- can bound the spend no matter what the client claimed.
--
-- Seconds rather than minutes so no rounding is needed at the write; the
-- budget does the arithmetic.
--
-- Cascades with the user: an account deletion takes its usage history too.
--
-- Every statement is guarded: migrations from 0006 on replay against the
-- shared database (see scripts/test/migration-replay.test.ts), so each must
-- survive running over a database that already has it.
CREATE TABLE IF NOT EXISTS "stt_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stt_usage_user_id_users_id_fk') THEN
    ALTER TABLE "stt_usage" ADD CONSTRAINT "stt_usage_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stt_usage_user_created_idx" ON "stt_usage" ("user_id","created_at");
