-- Replay-safe by requirement, not by style: production's drizzle ledger stops
-- at 0005, so `migrate()` considers everything from 0006 onward outstanding and
-- runs it again over a database that already has it - inside ONE transaction,
-- so a statement that cannot survive a second run takes every migration queued
-- behind it down too. See scripts/test/helpers/test-db.ts.
ALTER TABLE "detected_listings" ADD COLUMN IF NOT EXISTS "enrichment_attempts" integer DEFAULT 0 NOT NULL;
