-- A generic per-subject rate-limit ledger. One row per metered attempt, keyed
-- by (bucket, subject); the limiter counts rows in a time window the way
-- login_attempts does, so a parallel burst is counted rather than each request
-- seeing an empty table and all passing. Used by spend levers and
-- write-amplification guards (test SMS, provider enrichment, direct messages,
-- community writes, follows, in-session re-verify, the news image proxy).
--
-- Every statement is guarded: migrations from 0006 on replay against the
-- shared database (see scripts/test/migration-replay.test.ts), so each must
-- survive running over a database that already has it.
CREATE TABLE IF NOT EXISTS "rate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_events_bucket_subject_idx" ON "rate_events" ("bucket","subject","created_at");
