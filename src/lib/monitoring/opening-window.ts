import "server-only";

/**
 * Crawl harder when a firm is about to open.
 *
 * WHAT THIS CLOSES
 * ----------------
 * opening-history.ts derives, from Internet Archive snapshots, the window in
 * which a firm has historically first posted internships. The crawler roadmap
 * chose that as item #1 specifically because "the window feeds priority.ts, so a
 * firm is crawled hard in the weeks around its historical opening date and
 * barely at all outside them - accuracy and cost improve together instead of
 * trading off."
 *
 * The deriving half shipped. This is the half that was never built, so until
 * now a derived window changed nothing about when anything was crawled.
 *
 * WHY A MULTIPLIER AND NOT A TIER CHANGE
 * --------------------------------------
 * The obvious implementation is to write a higher tier onto the source when
 * its window approaches. It is the wrong one: a stored tier has to be put back
 * afterwards by something, and if that something does not run - a failed job, a
 * killed process, a database restored from a snapshot - the firm is stuck on an
 * expensive tier indefinitely and nothing says so. This codebase already has a
 * source of truth for "how often", and it is the tier table; overwriting it
 * from a PREDICTION would also lose the human decision recorded there.
 *
 * So this is a multiplier on the interval, exactly like seasonFor(). It
 * expires on its own because it is derived from today's date every time it is
 * asked, there is nothing to clean up, and the tier stays the tier.
 *
 * WHAT IT IS ALLOWED TO DO
 * ------------------------
 * Only speed things UP. A window is `source: "prediction"`, the weakest
 * evidence in the system - it loses to a firm's own announcement, a live
 * sighting and a student's report. Evidence that weak may spend extra requests
 * on a guess; it may not stop us looking at a firm because a guess said
 * nothing would happen. Being wrong in the fast direction costs a few HTTP
 * requests. Being wrong in the slow direction costs a student the internship.
 */

export type OpeningWindowInput = {
  /** Start of the historical window, inclusive. */
  opensStart: Date;
  /** End of the historical window, inclusive. */
  opensEnd: Date;
};

export type WindowUrgency = {
  /** Multiply the source's normal check interval by this. Never above 1. */
  intervalMultiplier: number;
  /** Added to the priority score, which decides queue ORDER under --limit. */
  priorityBoost: number;
  /** True when the window is close enough to be acting on. */
  imminent: boolean;
  /** Quotable in a log and in the audit - why this source moved. */
  reason: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Neither faster nor slower, and says why. */
const NEUTRAL = (reason: string): WindowUrgency => ({
  intervalMultiplier: 1,
  priorityBoost: 0,
  imminent: false,
  reason,
});

/**
 * How early to start accelerating.
 *
 * Fourteen days rather than "a couple", because the window itself is already
 * padded by a week either side in deriveWindow and because the thing being
 * predicted is a date a firm can move. Starting two weeks out means a firm
 * that opens eight days early than its own history is still caught on the
 * hour rather than a week later.
 */
const LEAD_DAYS = 14;

/**
 * How long to keep crawling hard after the window closes.
 *
 * A firm that has not opened by the end of its historical window is the case
 * we most want to be watching, not least: the window was derived from two or
 * three observations and being a fortnight late is ordinary.
 */
const TRAIL_DAYS = 14;

/**
 * The acceleration bands.
 *
 * Deliberately coarse. The evidence behind a window is two or three archived
 * snapshots, and a finer gradient would imply a precision the archive never
 * had - the same reasoning that makes deriveWindow refuse a span wider than
 * 75 days rather than average it into a single date.
 */
const BANDS: { withinDays: number; multiplier: number; boost: number; label: string }[] = [
  { withinDays: 3, multiplier: 0.1, boost: 40, label: "opens within 3 days" },
  { withinDays: 7, multiplier: 0.25, boost: 30, label: "opens within a week" },
  { withinDays: LEAD_DAYS, multiplier: 0.5, boost: 20, label: "opens within a fortnight" },
];

/** Whole days from `now` until `date`, negative once it has passed. */
function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / DAY_MS);
}

/**
 * How urgently this source should be checked, given its historical window.
 *
 * Pure and date-injectable, so the bands can be tested without waiting a year
 * for the calendar to agree.
 */
export function windowUrgency(
  window: OpeningWindowInput | null | undefined,
  now = new Date(),
): WindowUrgency {
  if (!window) return NEUTRAL("no historical opening window for this source");

  const start = window.opensStart;
  const end = window.opensEnd;
  if (
    !(start instanceof Date) ||
    !(end instanceof Date) ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return NEUTRAL("historical window is unreadable");
  }
  // A window whose end precedes its start is not a window. Refused rather
  // than reordered: silently swapping them would hide whatever produced it.
  if (end.getTime() < start.getTime()) return NEUTRAL("historical window is inverted");

  const untilStart = daysUntil(start, now);
  const untilEnd = daysUntil(end, now);

  // Inside the window itself - the firm opens around now, by its own history.
  if (untilStart <= 0 && untilEnd >= 0) {
    return {
      intervalMultiplier: 0.1,
      priorityBoost: 50,
      imminent: true,
      reason: `inside the historical opening window (${iso(start)} to ${iso(end)})`,
    };
  }

  // Just after it. Still watching, because a fortnight late is ordinary.
  if (untilEnd < 0) {
    const daysPast = -untilEnd;
    if (daysPast <= TRAIL_DAYS) {
      return {
        intervalMultiplier: 0.25,
        priorityBoost: 25,
        imminent: true,
        reason: `${daysPast} day(s) past the historical window and nothing seen yet`,
      };
    }
    return NEUTRAL(`historical window closed ${daysPast} days ago`);
  }

  // Approaching. The bands run tightest-first so the first match wins.
  for (const band of BANDS) {
    if (untilStart <= band.withinDays) {
      return {
        intervalMultiplier: band.multiplier,
        priorityBoost: band.boost,
        imminent: true,
        reason: `${band.label} (historically ${iso(start)} to ${iso(end)})`,
      };
    }
  }

  return NEUTRAL(`historical opening window is ${untilStart} days away`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The shortest interval this may produce, as a floor.
 *
 * A tier on a 60 minute cadence multiplied by 0.1 is six minutes, which is
 * more often than any careers page meaningfully changes and more often than
 * this crawler should hit one host. The multiplier expresses intent; this is
 * what keeps intent from becoming impoliteness.
 */
export const MIN_INTERVAL_MS = 15 * 60 * 1000;

/** The interval to use, with the floor applied. */
export function applyUrgency(baseIntervalMs: number, urgency: WindowUrgency): number {
  return Math.max(MIN_INTERVAL_MS, Math.round(baseIntervalMs * urgency.intervalMultiplier));
}
