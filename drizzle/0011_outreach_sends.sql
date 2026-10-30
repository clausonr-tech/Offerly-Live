-- The cold-email ladder, thank-you prompts, and a record of which drafts went.
--
--   - outreach_sends: one row per cold email a student sends one contact - the
--     first and up to two follow-ups. See lib/outreach-ladder.ts.
--   - email_drafts.sent_at: when the student sent a draft, by copying it out
--     of the composer or ticking "I sent this". Null until then.
--   - notification kinds 'follow_up' (a cold email a week unanswered) and
--     'thank_you' (a coffee chat or call a couple of hours over).
--
-- WRITTEN TO BE RE-RUNNABLE, like 0008 and 0010: scripts/test/helpers/test-db.ts
-- applies drizzle/*.sql twice on purpose, and a replay against a
-- partially-migrated database must not fail halfway. The statements are what
-- drizzle-kit generated from src/db/schema.ts, with IF NOT EXISTS and the
-- drop-then-add constraint guard added by hand.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed, rewritten or backfilled.
-- Contacts already marked "reached out" before this existed are read as having
-- had their first email on their last-contact date (lib/outreach-ladder.ts),
-- rather than being written into this table.

ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'follow_up';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'thank_you';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "outreach_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"draft_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "sent_at" timestamp;--> statement-breakpoint

-- A constraint has no IF NOT EXISTS. Dropping first is exact: the names are
-- ours and these definitions are the only ones they have ever had.
ALTER TABLE "outreach_sends" DROP CONSTRAINT IF EXISTS "outreach_sends_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sends" DROP CONSTRAINT IF EXISTS "outreach_sends_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_sends" DROP CONSTRAINT IF EXISTS "outreach_sends_draft_id_email_drafts_id_fk";--> statement-breakpoint
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_draft_id_email_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "outreach_sends_contact_step_idx" ON "outreach_sends" USING btree ("contact_id","step");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_sends_user_idx" ON "outreach_sends" USING btree ("user_id");
