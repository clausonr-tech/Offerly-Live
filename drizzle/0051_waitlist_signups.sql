-- The pre-launch waitlist: the only thing the public site writes until launch.
--
-- Hand-written, not as drizzle-kit generated it. The generated file opened with
-- a bare CREATE TYPE and bare CREATE TABLEs for rate_events, feature_usage and
-- stt_usage - tables 0041-0043 already created - because the meta snapshots in
-- this repo lag the hand-edited SQL. Everything from 0006 onward is replayed
-- against a database that already has it (see scripts/test/helpers/test-db.ts),
-- and drizzle wraps the batch in ONE transaction, so a statement that cannot
-- survive a second run takes every migration queued behind it down with it.
--
-- So: every statement here is re-runnable. ADDITIVE ONLY. Nothing is dropped,
-- renamed, rewritten or backfilled.

-- Postgres has no CREATE TYPE IF NOT EXISTS, so the guard is an exception
-- handler. duplicate_object is the only thing swallowed - any other failure
-- still aborts the migration.
DO $$ BEGIN
  CREATE TYPE "public"."waitlist_kind" AS ENUM('student', 'firm');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- TWO EMAIL COLUMNS. "email" is as typed, and is what a launch email is sent
-- to. "email_canonical" is canonicalMailbox() of it - +tags folded away, dots
-- removed at dot-blind hosts - and exists only to be the unique key, so one
-- person cannot take six places in the queue. It is NOT deliverable:
-- 'a.b+x@gmail.com' canonicalises to 'ab@gmail.com', which may be somebody
-- else's mailbox entirely. Key on one, mail the other.
CREATE TABLE IF NOT EXISTS "waitlist_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "waitlist_kind" NOT NULL,
	"email" text NOT NULL,
	"email_canonical" text NOT NULL,
	"name" text NOT NULL,
	"school" text,
	"grad_year" integer,
	"firm_name" text,
	"title" text,
	"invite_token" text NOT NULL,
	"email_consent" boolean NOT NULL,
	"policy_version" text NOT NULL,
	"source" text,
	"converted_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_signups_email_canonical_unique" UNIQUE("email_canonical"),
	CONSTRAINT "waitlist_signups_invite_token_unique" UNIQUE("invite_token")
);--> statement-breakpoint

-- A row is wholly a student's or wholly a firm's. Enforced here and not only in
-- the zod union, because the union guards one code path and this guards the
-- table: an import, a console fix or a future action cannot write a half-row.
DO $$ BEGIN
  ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_kind_fields_check" CHECK (
    ("kind" = 'student' AND "school" IS NOT NULL AND "grad_year" IS NOT NULL
       AND "firm_name" IS NULL AND "title" IS NULL)
    OR
    ("kind" = 'firm' AND "firm_name" IS NOT NULL AND "title" IS NOT NULL
       AND "school" IS NULL AND "grad_year" IS NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_converted_user_id_users_id_fk" FOREIGN KEY ("converted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Supabase: close the PostgREST side, as 0026-0035 do per table and 0044 does
-- for the rest. The app reaches Postgres through postgres-js as the table
-- owner, which bypasses RLS, so this changes nothing for the app; it is
-- decisive for the Data API, where a table with RLS on and NO policy is a
-- table PostgREST cannot read.
--
-- Doing it here rather than leaving it to 0044's sweep is not belt-and-braces,
-- it is the only correct place: 0044 runs at position 44 and this table is
-- created at 51, so on the run that first creates it the sweep has already
-- happened and the table would sit unprotected until some later replay. Every
-- row in it is somebody's name, address and school, and the invite token is a
-- credential - a window is not acceptable, and scripts/test/rls-coverage.test.ts
-- is the gate that says so.
--
-- No policy is defined, deliberately. RLS with no policy denies everyone the
-- table does not exempt, which is the boundary we want; a policy here could
-- only widen it.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY on a table that already has it is a
-- no-op, which replay from 0006 onward requires.
ALTER TABLE "waitlist_signups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "waitlist_signups_created_idx" ON "waitlist_signups" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_signups_kind_idx" ON "waitlist_signups" ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_signups_school_idx" ON "waitlist_signups" ("school","grad_year");
