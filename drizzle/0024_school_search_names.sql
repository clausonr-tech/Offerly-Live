-- The exact names each school goes by on LinkedIn, for the contact search
-- (lib/school-search-names). Already applied to the live database, so
-- re-runnable like 0010-0023.
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "search_names" text[];--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "search_names_checked_at" timestamp with time zone;
