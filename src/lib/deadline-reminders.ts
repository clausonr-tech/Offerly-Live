import "server-only";

/**
 * This module used to manufacture deadlines. It no longer does, and nothing
 * has replaced it, which is the point.
 *
 * WHAT IT WAS
 * -----------
 * Two functions - createDeadlineRemindersForFirms and
 * createDeadlineReminderForApplication - that took a firm off the student's
 * list, read `firm_programs.timing_guidance` (PROSE: "typically open in the
 * summer before junior year"), mapped it to one of three month anchors, and
 * wrote a dated `events` row titled "<Firm> - <Role> (estimated window)".
 * Those rows were then pushed to the student's real Google Calendar with a
 * week-and-a-day of reminders on them.
 *
 * WHY IT IS GONE
 * --------------
 * Measured on the live database before removal: the three accounts held 331,
 * 144 and 50 deadline events, and every single one of the 525 was an
 * estimated window. Not most - all. The Schedule page's "Upcoming" list, the
 * one place a student looks to find out what is due, contained zero real
 * dates and no way to tell.
 *
 * The date itself was the 1st of a month derived from a graduation year. It
 * was never a deadline any firm published, and `firm_programs` holds no date
 * that could make it one - so there is no honest version of this function to
 * keep. Deleting it is the fix, not a regression to work around.
 *
 * WHAT HAPPENS INSTEAD
 * --------------------
 * Real deadlines already reach the calendar without this. Tracked postings
 * that carry a published date are rendered onto the grid by
 * src/app/(app)/schedule/page.tsx, derived live from
 * lib/upcoming-applications.ts on every load - deliberately a VIEW of the
 * postings rather than copied `events` rows, so a date that moves moves here
 * too. See the comment above `applicationEvents` in that file.
 *
 * The consequence worth knowing: deadlines are no longer auto-pushed to
 * Google Calendar, because only stored `events` rows sync and these are
 * derived. Students still export everything they create with the button on
 * Schedule. Pushing a guessed date into someone's real calendar was the worst
 * thing this module did, and it is not something to restore by other means.
 *
 * If a reminder should sync to Google again, it has to be anchored to a
 * posting's own confirmed deadlineDate - never to timing_guidance, and never
 * to a skeleton row (see isRealPosting in lib/internship-postings.ts).
 *
 * The rows this module already wrote are removed by
 * scripts/purge-unreal-rows.ts.
 */

export {};
