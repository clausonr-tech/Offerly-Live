-- Notifications, flashes, and an 'interview' event type.
--
-- The net effect of the eight migrations this branch originally carried. Half
-- of those cancelled out - outreach_nudge_dismissals and outreach_flashes_shown
-- were each created and then dropped - so what remains is what a fresh database
-- actually needs.
--
-- WRITTEN TO BE RE-RUNNABLE, which is what drizzle-kit's own output is not.
-- scripts/test/helpers/test-db.ts applies drizzle/*.sql TWICE on purpose and
-- migration-0008.test.ts asserts the second pass is a no-op: the guarantee
-- that a re-run, a resumed deploy or a replay against a partially-migrated
-- database cannot fail halfway. The generated version opened with a bare
-- CREATE TYPE, whose second attempt raises `type "notification_kind" already
-- exists`. Same hand-editing, and same reason, as 0008 above.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed, rewritten or backfilled.

-- Postgres has no CREATE TYPE IF NOT EXISTS, so the guard is an exception
-- handler. duplicate_object is the only thing swallowed - any other failure
-- still aborts the migration.
DO $$ BEGIN
  CREATE TYPE "public"."notification_kind" AS ENUM('outreach', 'interview_prep');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'interview';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "flashes_shown" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flash_key" text NOT NULL,
	"shown_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject_key" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"bumped_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp,
	"done_at" timestamp,
	"done_source" text
);--> statement-breakpoint

-- A constraint has no IF NOT EXISTS either. Dropping first is exact here
-- because the name is ours and the definition below is the only one it ever
-- has - there is no earlier version of these keys to preserve.
ALTER TABLE "flashes_shown" DROP CONSTRAINT IF EXISTS "flashes_shown_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "flashes_shown" ADD CONSTRAINT "flashes_shown_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "flashes_shown_user_key_idx" ON "flashes_shown" USING btree ("user_id","flash_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_user_key_idx" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_bumped_idx" ON "notifications" USING btree ("user_id","bumped_at");
