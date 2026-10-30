-- Contact generation's record of how each contact was chosen, so the two-stage
-- pool (lib/contact-pool) can be evaluated against outcomes beyond the logs:
-- the algorithm version and redacted run metrics on the run, a link from each
-- generated contact to its run with its rank, score breakdown and retrieval
-- categories, and a snapshot of a deleted contact's outcomes.
--
-- Everything added is nullable or new, so existing rows are untouched. No
-- personal data: numbers, kinds and categories only (see SourcingRecord).
--
-- Every statement is guarded: migrations from 0006 on replay against the
-- shared database (see scripts/test/migration-replay.test.ts).
CREATE TABLE IF NOT EXISTS "contact_sourcing_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sourcing_rank" integer,
	"event" text NOT NULL,
	"had_draft" boolean DEFAULT false NOT NULL,
	"marked_sent" boolean DEFAULT false NOT NULL,
	"got_reply" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD COLUMN IF NOT EXISTS "algorithm_version" text;--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD COLUMN IF NOT EXISTS "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "sourcing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "sourcing_rank" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "sourcing_score" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "sourcing_retrieval" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_sourcing_outcomes_run_id_contact_sourcing_runs_id_fk') THEN
    ALTER TABLE "contact_sourcing_outcomes" ADD CONSTRAINT "contact_sourcing_outcomes_run_id_contact_sourcing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."contact_sourcing_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_sourcing_outcomes_run_idx" ON "contact_sourcing_outcomes" USING btree ("run_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_sourcing_run_id_contact_sourcing_runs_id_fk') THEN
    ALTER TABLE "contacts" ADD CONSTRAINT "contacts_sourcing_run_id_contact_sourcing_runs_id_fk" FOREIGN KEY ("sourcing_run_id") REFERENCES "public"."contact_sourcing_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_sourcing_run_idx" ON "contacts" USING btree ("sourcing_run_id");
