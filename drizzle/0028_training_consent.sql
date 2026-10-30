-- Training Use and the consent ledger: whether each student has said yes or no
-- to Offerly training its models on their writing (users.training_choice), and
-- an append-only record of every consent decision (consent_events).
-- Every statement is re-runnable, and all of it is applied to the live
-- database before the schema that reads it (see feedback: database first).

-- Postgres has no CREATE TYPE IF NOT EXISTS, so the guard is an exception
-- handler. duplicate_object is the only thing swallowed - any other failure
-- still aborts the migration.
DO $$ BEGIN
  CREATE TYPE "public"."consent_event_kind" AS ENUM('policy_accepted', 'training_opted_in', 'training_opted_out', 'firm_sharing_on', 'firm_sharing_off');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."training_choice" AS ENUM('opted_in', 'opted_out');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Null means never asked, which the app treats as no.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "training_choice" "training_choice";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "training_choice_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "training_choice_policy_version" text;--> statement-breakpoint

-- user_id is set null on account deletion; email_hash keeps the record
-- matchable to a former student without keeping their address.
CREATE TABLE IF NOT EXISTS "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid CONSTRAINT "consent_events_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
	"email_hash" text NOT NULL,
	"kind" "consent_event_kind" NOT NULL,
	"policy_version" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_user_idx" ON "consent_events" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_kind_idx" ON "consent_events" ("kind","created_at");--> statement-breakpoint

-- Supabase: new tables arrive with no grants (default privileges) but RLS
-- off; the app connects as a role that bypasses RLS, so enabling it closes
-- the PostgREST side without touching the app.
ALTER TABLE "consent_events" ENABLE ROW LEVEL SECURITY;
