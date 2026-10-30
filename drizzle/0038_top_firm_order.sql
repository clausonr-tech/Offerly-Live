-- The order a student puts their top firms in, by dragging them on External
-- Network (5 October 2026). Nullable: a firm never moved has no position and
-- keeps the old order - added by the student first, newest first, then the
-- matched ones (lib/discovery-matches, orderTopFirms). Additive only.
-- Re-runnable.

ALTER TABLE "user_top_firms" ADD COLUMN IF NOT EXISTS "position" integer;
