-- Idempotency, caching and credit accounting for contact sourcing.
--
-- WHAT THIS FIXES
-- ---------------
-- Every press of "Generate contacts" inserted a new run row. Two presses a few
-- hundred milliseconds apart - a double-click, a reload mid-flight, two tabs -
-- produced two rows, two provider workflows and two charges, and the only
-- thing standing between a student and that was a disabled button in the
-- browser, which does not survive any of the three.
--
-- The key is (user, firm, mode) rather than a token minted per press, because
-- two clicks of the same button ARE the same intent. `fill` deliberately
-- shares its key with the `generate` it completes, which is what makes a
-- top-up free. Successive refreshes carry a sequence number, because those
-- genuinely are separate requests for different people.
--
-- The first five statements are exactly what `drizzle-kit generate` emitted
-- from src/db/schema.ts, so the schema, this file and 0008_snapshot.json all
-- describe the same table. The two CHECK constraints are appended by hand
-- because they must be added NOT VALID, which drizzle-kit cannot express.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed, rewritten or backfilled.
ALTER TABLE "contact_sourcing_runs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'generate' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_sourcing_runs" ADD COLUMN IF NOT EXISTS "refresh_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- The allowance check reads a user's runs for the current month on every
-- click, and now also has to find the in-flight run for one firm.
CREATE INDEX IF NOT EXISTS "contact_sourcing_user_firm_status_idx" ON "contact_sourcing_runs" USING btree ("user_id","firm_id","status");--> statement-breakpoint

-- THE LOCK.
--
-- This is what makes the second concurrent click lose. The action inserts with
-- ON CONFLICT DO NOTHING and reads back whoever won; there is no read-then-
-- write window for two requests to pass through, which a SELECT-first check
-- would have left wide open.
--
-- Every row written before this migration has a null key - they predate the
-- concept and there is no honest key to backfill them with. They are safe
-- here: Postgres indexes nulls as DISTINCT by default, so any number of them
-- coexist under this index. (An earlier draft made the index partial to
-- "protect" them, which was solving a problem that does not exist and put the
-- deployed SQL out of step with the schema snapshot.)
CREATE UNIQUE INDEX IF NOT EXISTS "contact_sourcing_idempotency_uq" ON "contact_sourcing_runs" USING btree ("idempotency_key");--> statement-breakpoint

-- A CHARGE WITHOUT CONTACTS CANNOT BE WRITTEN.
--
-- The rule already lives in application code; this is the same rule where it
-- cannot be forgotten. A run that returned nobody, failed, or re-read a cached
-- set costs the student nothing, so credits_spent > 0 with contacts_created =
-- 0 is not a state this table may hold.
--
-- NOT VALID on purpose. Rows written before today may include empty runs that
-- were charged under the old behaviour, and rewriting billing history to
-- satisfy a constraint would be worse than leaving it visible. New and updated
-- rows are enforced from this moment; historical rows are audited separately
-- and VALIDATE CONSTRAINT is a later, reviewed step.
--
-- NOT VALID also keeps this statement cheap: Postgres skips the full table
-- scan it would otherwise need, so the lock is held for microseconds.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_sourcing_charge_needs_contacts'
  ) THEN
    ALTER TABLE "contact_sourcing_runs"
      ADD CONSTRAINT "contact_sourcing_charge_needs_contacts"
      CHECK ("credits_spent" = 0 OR "contacts_created" > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- Negative credits and negative contact counts are not states this table may
-- hold either. Same NOT VALID reasoning.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_sourcing_credits_nonnegative'
  ) THEN
    ALTER TABLE "contact_sourcing_runs"
      ADD CONSTRAINT "contact_sourcing_credits_nonnegative"
      CHECK ("credits_spent" >= 0 AND "contacts_created" >= 0) NOT VALID;
  END IF;
END $$;
