-- One column for editing a sent message (lib/people.ts editMessage): when the
-- sender last changed it, so the other person sees it was edited. Re-runnable
-- like 0010-0022.
--
-- ADDITIVE ONLY. Existing messages keep NULL, which reads as "never edited".

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp;
