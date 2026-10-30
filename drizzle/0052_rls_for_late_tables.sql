-- Row-level security for tables created AFTER 0044 ran.
--
-- 0044 closed the gap for the 58 tables that predated per-migration RLS, and
-- it was deliberately written as a loop over pg_class rather than a list of
-- names, so that - in its own words - "a table added later without its own RLS
-- line is picked up by a re-run".
--
-- It cannot pick up a table created later in the SAME replay. Migrations from
-- 0006 on replay in order against the shared database, so when 0044's loop
-- runs, a table created by 0051 does not exist yet. That is not a defect in
-- 0044; it is what ordering means.
--
-- `waitlist_signups` (0051) is the first table to land in that gap, and it
-- holds an email address, a consent record with its policy version, and an
-- invite token for people who do not yet have accounts. Found by
-- scripts/test/rls-coverage.test.ts, which failed naming exactly that table.
--
-- So this is the same loop again, placed after the latest table-creating
-- migration. Re-running it is the point: it covers waitlist_signups today and
-- any table a future migration adds after 0044 without its own RLS line,
-- rather than naming one table and leaving the next one to fail the same way.
--
-- Safe for the app, for the reason 0044 gives: the app connects as a role that
-- bypasses RLS, and RLS with no policies closes the PostgREST path, not the
-- app's. Deliberately NOT "FORCE ROW LEVEL SECURITY", which binds the owner
-- too and would cut the app off from its own data - asserted by the second
-- test in rls-coverage.
--
-- Idempotent, because migrations from 0006 on replay over a database that
-- already has them: the loop only selects tables where relrowsecurity is
-- false, so a second run finds nothing to do. The ownership guard and the
-- per-table EXCEPTION are carried over from 0044 unchanged - a table this role
-- does not own would otherwise abort the whole loop and block the deploy over
-- a table that is not ours to protect.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = false
      AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipped RLS on public.% (not owned by %)', t.relname, current_user;
    END;
  END LOOP;
END $$;--> statement-breakpoint
-- Belt as well as braces, exactly as 0044 does: with RLS on and no policies
-- these roles already see nothing, but a future policy should not accidentally
-- hand them a table. Guarded on the roles existing, since they are Supabase's
-- and are absent in local PGlite and in tests.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
  END IF;
END $$;
