-- Row-level security on every remaining public table, and no grants for the
-- Supabase API roles.
--
-- RLS was added per-migration from 0026 onward, so the 58 tables created
-- before it never got any - including users (password hashes), sessions,
-- firm_login_codes, email_connections, email_archive, stored_files, messages,
-- contacts and applications. The app reaches Postgres through postgres-js and
-- never uses the Supabase Data API, so the gap only matters if that API is on
-- and the anon/authenticated roles hold privileges on the older tables, which
-- were created under older Supabase default privileges. That is exactly the
-- state this migration stops depending on: the database tier gets a
-- deny-by-default boundary instead of relying on a project setting.
--
-- Safe for the app: as 0027 records, the app connects as a role that bypasses
-- RLS, and migrations 0026-0035 have had RLS enabled on 24 tables the app
-- reads on every page since they shipped. Enabling it on the rest changes
-- nothing for the app and everything for PostgREST, which has no policy to
-- match and therefore sees nothing.
--
-- Deliberately NOT done here: FORCE ROW LEVEL SECURITY. That binds the table
-- owner too, which would cut the app off from its own data. The point is to
-- close the API role's path, not the app's.
--
-- Written as a loop over pg_class rather than 58 table names so it cannot
-- drift from the schema, and so a table added later without its own RLS line
-- is picked up by a re-run.
--
-- Every statement is guarded or idempotent: migrations from 0006 on replay
-- against the shared database (see scripts/test/migration-replay.test.ts), so
-- each must survive running over a database that already has it.
--
-- Two tables are skipped, both for the same reason: ALTER TABLE needs
-- ownership, and a table this role does not own would abort the whole loop and
-- block the deploy over a table that is not ours to protect.
--   - a table belonging to an extension (PostGIS's spatial_ref_sys is the
--     classic one), which is owned by the extension's installer;
--   - any other table whose owner this role is not a member of.
-- The per-table EXCEPTION is the last guard: if one is refused anyway, it is
-- raised as a notice and the remaining tables still get their RLS.
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
-- Belt as well as braces: with RLS on and no policies these roles already see
-- nothing, but a future policy should not accidentally hand them a table.
-- Guarded on the roles existing, since they are Supabase's and are absent in
-- local PGlite and in tests.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
  END IF;
END $$;
