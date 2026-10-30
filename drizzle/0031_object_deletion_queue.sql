-- A durable queue of private-storage objects still to be deleted, for when the
-- store is unreachable at the moment their owner is deleted. Deliberately no
-- foreign key to users: it must survive the account-deletion cascade, which is
-- the whole point. Holds no personal data - provider, random key, retry
-- bookkeeping. Re-runnable (see scripts/test/helpers/test-db.ts).

CREATE TABLE IF NOT EXISTS "object_deletion_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_category" text CONSTRAINT "object_deletion_queue_error_check" CHECK ("last_error_category" IS NULL OR "last_error_category" IN ('storage_unconfigured', 'storage_error')),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "object_deletion_queue_key_idx" ON "object_deletion_queue" ("provider","object_key");--> statement-breakpoint

-- Supabase: close the PostgREST side, as 0027-0030 do.
ALTER TABLE "object_deletion_queue" ENABLE ROW LEVEL SECURITY;
