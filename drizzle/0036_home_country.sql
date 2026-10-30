-- The country a student is from, picked from lib/countries under "Where are
-- you from?" in onboarding. Nullable: every existing account has none.
--
-- Applied by hand to the shared database on 2026-09-30, before schema.ts
-- gained the column, so the app never selected a column that was missing.
-- IF NOT EXISTS makes a later `db:migrate` a no-op there.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_country" text;
