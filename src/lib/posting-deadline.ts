/**
 * The application deadline a posting states in its own words.
 *
 * WHY THIS EXISTS
 * ---------------
 * A deadline could reach a student down two different paths, and for a long
 * time it only took one of them. `opening_signals` carries dates the monitoring
 * pipeline parsed off a board, and lib/upcoming-applications.ts reads it - so
 * the "Top applications" panel could say "Due in 54d · Nov 15, 2026 · 11:55 PM
 * EST" for an Evercore role. `internship_postings.deadlineDate` is what the
 * Internships tab reads, and promote-approved-listings.ts hard-coded every new
 * row to "tbd" because detected_listings never carried a closing date across.
 *
 * So the same posting said two different things two clicks apart: a precise
 * deadline on one screen, "Deadline TBD" on the other. Measured on Supabase,
 * 22 September 2026: 117 active postings state an application deadline in
 * their own description text and every single one of them was filed "tbd".
 *
 * That text is not a guess and not an inference. It is the firm's own sentence,
 * captured verbatim by the crawler:
 *
 *     Application Deadline:15 Nov 2026 11:55 PM EST
 *
 * Reading it is the difference between the product knowing something and
 * throwing it away.
 *
 * WHAT IT REFUSES TO ANSWER
 * -------------------------
 * Silence beats a guess, so this returns null rather than pick:
 *
 *   - a plural heading ("Application Deadlines (by school regions): Sunday 20
 *     September (France) Sunday 27 September (UK)..."), which is several
 *     deadlines and no way to know which is the student's
 *   - a date with no year ("Application Deadline: Sunday 4 October"), where
 *     inferring the year from the cycle is exactly the kind of derived date
 *     this codebase keeps removing
 *   - two different stated deadlines in one posting
 *
 * All three are real, all three are PJT Partners, and all three stay TBD.
 */

/** Weekday names the firms actually prefix their dates with. */
const WEEKDAY = "(?:Mon|Tues?|Wed(?:nes)?|Thur?s?|Fri|Sat(?:ur)?|Sun)(?:day)?";
/** "15 Nov 2026" and "4 October 2026". The year is required - see above. */
const DATE = "(\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})";
/** "11:55 PM EST", "5:00PM ET". Optional: most firms state only a day. */
const TIME = "([\\d]{1,2}:[\\d]{2}\\s*(?:AM|PM)?\\s*[A-Z]{2,5})?";

const DEADLINE = new RegExp(
  `Application\\s+Deadline\\s*:?\\s*(?:${WEEKDAY}\\s*,?\\s*)?${DATE}\\s*${TIME}`,
  "gi",
);

/** A plural heading means a list of them, which is not a deadline. */
const PLURAL = /Application\s+Deadlines/i;

export type StatedDeadline = {
  /**
   * A CALENDAR DATE at midnight UTC, deliberately - the convention every
   * consumer of a deadline in this codebase follows (see formatDay in
   * lib/posting-timing.ts). Making it a true instant would shift every stored
   * deadline by a day in one direction or the other depending on where the
   * reader is.
   */
  date: Date;
  /**
   * The firm's own words for the cut-off - "11:55 PM EST" - kept as text
   * rather than parsed. Worth showing, not worth computing with: a student
   * wants to know it is late evening Eastern rather than 9am, and converting
   * it into their timezone is a second chance to be a day wrong for no gain.
   * Null when the firm stated only a day.
   */
  timeText: string | null;
};

export function deadlineFromPostingText(
  text: string | null | undefined,
): StatedDeadline | null {
  if (!text || PLURAL.test(text)) return null;

  const matches = [...text.matchAll(DEADLINE)];
  if (matches.length === 0) return null;

  const parsed = matches
    .map((m) => ({
      date: new Date(`${m[1]} UTC`),
      timeText: m[2] ? m[2].replace(/\s+/g, " ").trim().toUpperCase() : null,
    }))
    .filter((d) => !Number.isNaN(d.date.getTime()));
  if (parsed.length === 0) return null;

  // Two different stated deadlines is the plural case wearing a singular
  // heading - the posting has not told us which one applies. Repeats of the
  // SAME date are fine and common: TalentLink prints it in the title block and
  // again in the body.
  const distinct = new Set(parsed.map((d) => d.date.getTime()));
  if (distinct.size > 1) return null;

  // Prefer the occurrence that also carried a time.
  return parsed.find((d) => d.timeText) ?? parsed[0];
}

/**
 * The stated deadline as the columns the Internships tab reads.
 *
 * A deadline in the past is `closed`, not `confirmed`. The date is the firm's
 * either way; what changed is that it has been and gone, and a posting that
 * says so should stop being offered as something to apply to.
 */
export function deadlineColumnsFromText(
  text: string | null | undefined,
  now: Date = new Date(),
): { deadlineStatus: "confirmed" | "closed"; deadlineDate: Date; timeText: string | null } | null {
  const stated = deadlineFromPostingText(text);
  if (!stated) return null;
  return {
    // End of the stated day, so a deadline today is not treated as gone at
    // 00:01. The stored date stays midnight UTC; this comparison does not.
    deadlineStatus:
      stated.date.getTime() + 86_400_000 > now.getTime() ? "confirmed" : "closed",
    deadlineDate: stated.date,
    timeText: stated.timeText,
  };
}
