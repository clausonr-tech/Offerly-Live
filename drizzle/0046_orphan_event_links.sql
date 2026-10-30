-- Unlink schedule events from another student's contact or application.
--
-- createEvent and updateEvent took contactId and applicationId from the form
-- as arbitrary strings and stored them with no ownership check; the Schedule
-- page then joins both on id alone. The write side is fixed in code, but rows
-- written before that fix still carry whatever id was posted, so the read
-- would keep serving another student's contact name - and the joined row
-- carries their email, phone and notes too.
--
-- Clearing the link rather than deleting the event: the event is the student's
-- own and they asked for it; only the reference to someone else's row is
-- wrong. A legitimate link (the two rows share an owner) is left exactly as
-- it is, which is what the two user_id comparisons below assert.
--
-- Replay-safe: migrations from 0006 on run against the shared database (see
-- scripts/test/migration-replay.test.ts). Re-running this finds nothing the
-- second time, because the first run removed every mismatch.
UPDATE "events" e
   SET "contact_id" = NULL
  FROM "contacts" c
 WHERE e."contact_id" = c."id"
   AND c."user_id" <> e."user_id";--> statement-breakpoint
UPDATE "events" e
   SET "application_id" = NULL
  FROM "applications" a
 WHERE e."application_id" = a."id"
   AND a."user_id" <> e."user_id";
