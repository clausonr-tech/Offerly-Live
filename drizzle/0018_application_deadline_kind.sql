-- A job under the bell for an open application the student has not applied
-- to, as its deadline nears. See lib/application-reminders.ts.
--
-- Re-runnable like 0010-0015: IF NOT EXISTS. ADDITIVE ONLY - one enum value.

ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'application_deadline';
