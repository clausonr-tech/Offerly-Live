-- One column for practice grading (lib/practice-seal.ts): when the newest
-- question a student had graded was served, so a question cannot be graded
-- twice. Re-runnable like 0010-0020.
--
-- ADDITIVE ONLY. The app runs unchanged before this is applied except that
-- practice grading needs it.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "practice_last_sealed_at" timestamp;
