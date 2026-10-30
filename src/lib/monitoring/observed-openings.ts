// When last cycle actually opened, read out of the Internet Archive.
//
// WHAT THIS IS
// ------------
// For six firms we can say, from a public archive rather than a guess, that a
// posting for a given programme year was already live on a given day. The
// archived URL carries the cycle in its own slug - Raymond James'
// "XMLNAME-2026-Summer-Internship-Program-Finance", Morgan Stanley's
// "...19107" under a 2026 board - so the cycle and the sighting date come from
// the same record, and the record is public and checkable.
//
// WHAT THIS IS NOT
// ----------------
// It is NOT the opening date. It is the first day the Internet Archive
// happened to capture a posting that was already up. The archive saves pages
// when somebody visits them, not on a schedule, so the true opening is on or
// BEFORE each date here - never after. Every date is therefore a LATE bound,
// and a date derived from it must be shown as an estimate, never as a
// deadline. See lib/upcoming-applications.ts, which labels these "est." and
// keeps them visually distinct from dates a firm published.
//
// Why only six firms, out of 108 monitored sources: a usable date needs the
// archive to have captured a posting whose URL names its cycle. Workday and
// Oracle boards are JavaScript applications, so the archive holds an empty
// shell; most other boards number their postings without naming the cycle.
// The full per-firm coverage audit is in the session notes - the short version
// is that this is everything the archive can support, not a first pass.
//
// Going forward this file should stop growing. `opening_signals` records
// openings first-hand, on the day, with the sentence they were read out of -
// strictly better evidence. This exists to cover the one cycle that happened
// before we were watching.

export type ObservedOpening = {
  firmSlug: string;
  /** The programme year the posting was for, read from its own URL slug. */
  cycleYear: number;
  /** ISO date the posting was first seen live in the archive. A LATE bound. */
  observedAt: string;
  /** What the archived URL said, so the claim can be checked by hand. */
  evidence: string;
};

export const OBSERVED_OPENINGS: ObservedOpening[] = [
  { firmSlug: "raymond-james", cycleYear: 2026, observedAt: "2025-07-31", evidence: "raymondjames.wd1.myworkdayjobs.com - \"2026 Summer Internship Program - Finance\"" },
  { firmSlug: "baker-tilly-capital", cycleYear: 2026, observedAt: "2025-08-01", evidence: "bakertilly.wd5.myworkdayjobs.com - 2026 internship requisition" },
  { firmSlug: "td-securities", cycleYear: 2026, observedAt: "2025-08-14", evidence: "td.wd3.myworkdayjobs.com - 2026 summer requisition" },
  { firmSlug: "morgan-stanley", cycleYear: 2026, observedAt: "2025-09-16", evidence: "morganstanley.tal.net - 2026 cycle vacancy" },
  { firmSlug: "robert-w-baird", cycleYear: 2026, observedAt: "2025-10-06", evidence: "bairdcareers.com - 2026 internship listing" },
  // Weakest of the six and flagged rather than dropped: evercore.tal.net and
  // jefferies.tal.net were each captured on only a handful of days in all of
  // 2025, and this is the first of them. The true opening is very probably
  // months earlier - which is exactly what "late bound" means, and why the UI
  // must not render it as a countdown.
  { firmSlug: "jefferies", cycleYear: 2026, observedAt: "2025-12-16", evidence: "jefferies.tal.net - \"2026 Investment Banking Summer Associate Program\"" },
];

const BY_SLUG = new Map(OBSERVED_OPENINGS.map((o) => [o.firmSlug, o]));

/**
 * The estimated opening date for `targetCycleYear`, or null when we never saw
 * this firm open.
 *
 * The rule is the plainest one available and deliberately so: the SAME
 * MONTH AND DAY, moved by however many cycles separate the one we observed
 * from the one being asked about. Firms run these programmes on an annual
 * calendar, so last year's date is the best single predictor of this year's,
 * and anything more elaborate - drifting by weekday, averaging across firms -
 * would dress up a one-observation guess as a model.
 *
 * Built in UTC so the answer does not shift a day depending on where the
 * student is; these are calendar dates, not moments.
 */
export function estimatedOpening(
  firmSlug: string,
  targetCycleYear: number | null | undefined,
): { date: Date; basedOn: ObservedOpening } | null {
  const seen = BY_SLUG.get(firmSlug);
  if (!seen || targetCycleYear == null) return null;
  const [y, m, d] = seen.observedAt.split("-").map(Number);
  const date = new Date(Date.UTC(y + (targetCycleYear - seen.cycleYear), m - 1, d));
  return Number.isNaN(date.getTime()) ? null : { date, basedOn: seen };
}
