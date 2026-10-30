-- Replay-safe by requirement, not by style: production's drizzle ledger stops
-- at 0005, so `migrate()` considers everything from 0006 onward outstanding and
-- runs it again over a database that already has it - inside ONE transaction,
-- so a statement that cannot survive a second run takes every migration queued
-- behind it down too. See scripts/test/helpers/test-db.ts.
--
-- Three statements, so three drizzle breakpoints: the driver sends each
-- migration file as a prepared statement, which takes exactly one command.
-- Without these the file fails with "cannot insert multiple commands into a
-- prepared statement" and, because every migration from 0006 replays in one
-- transaction, it takes all of them down with it.
ALTER TABLE "monitoring_check_runs" ADD COLUMN IF NOT EXISTS "static_ms" integer;--> statement-breakpoint
ALTER TABLE "monitoring_check_runs" ADD COLUMN IF NOT EXISTS "render_ms" integer;--> statement-breakpoint
ALTER TABLE "monitoring_check_runs" ADD COLUMN IF NOT EXISTS "enrich_ms" integer;
