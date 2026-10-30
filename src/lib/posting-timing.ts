// What to tell a student about *when* they can act on a posting.
//
// Two dates, not one. deadlineDate is when an application closes; opensAt is
// when it drops. For most of the recruiting year the useful answer is the open
// date - a 2028 cycle posting seen in September 2026 has no deadline yet and
// won't for months, and labelling that "Deadline TBD" reads as missing data
// rather than as "nothing to do yet". "Not open yet" is the honest version of
// the same state, and it is the default here rather than an edge case.
//
// Firms announce months far more often than days ("applications open in
// August"), so each date has a free-text twin carrying the firm's own wording.
// Text wins when both exist: "Drops August 2027" is what the firm actually
// said, and inventing "Aug 1, 2027" from it would be a precision we don't have.

export type TimingInput = {
  deadlineStatus: "tbd" | "confirmed" | "rolling" | "closed" | string | null;
  deadlineText?: string | null;
  deadlineDate?: Date | string | null;
  opensText?: string | null;
  opensAt?: Date | string | null;
};

export type PostingTiming = {
  /** Short label for the card: "Drops Aug 2027", "Due Oct 14", "Not open yet". */
  label: string;
  /** Secondary clause, only when both dates are worth showing at once. */
  detail: string | null;
  /** Drives colour. "open" is actionable now; "upcoming" is dated but not yet. */
  state: "open" | "upcoming" | "unknown" | "closed";
};

// Long enough for "Applications open August 2027", short enough to exclude the
// paragraphs of cycle guidance these text columns actually tend to hold.
const MAX_LABEL_CHARS = 40;

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// UTC, deliberately. These are calendar dates - "the deadline is October 14" -
// stored in a timestamp column at midnight. Formatting midnight UTC in a
// west-of-UTC timezone renders the day before, so a student in California was
// shown "Oct 13" for an October 14 deadline. A recruiting deadline off by a day
// is the one rounding error this app cannot afford.
function formatDay(d: Date) {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function postingTiming(p: TimingInput, now: Date = new Date()): PostingTiming {
  if (p.deadlineStatus === "closed") {
    return { label: "Closed", detail: null, state: "closed" };
  }

  const opensAt = asDate(p.opensAt);
  const deadlineDate = asDate(p.deadlineDate);
  const deadlineKnown = p.deadlineStatus === "confirmed" && deadlineDate;
  // A date that has already passed is not a future open date any more - the
  // posting is open, and saying "drops last March" would be worse than silence.
  const notOpenYet = (opensAt && opensAt > now) || (!opensAt && !!p.opensText);

  // --- Hasn't dropped yet: lead with when it will, per the spec. ---
  if (notOpenYet) {
    const opensText = p.opensText?.trim();
    const opensLabel =
      (opensText && opensText.length <= MAX_LABEL_CHARS ? opensText : null) ||
      (opensAt ? formatDay(opensAt) : null);
    if (opensLabel) {
      return {
        label: `Drops ${opensLabel}`,
        // A firm that has already published its close date deserves to have it
        // shown, but as the subordinate half - the student can't act on it yet.
        detail: deadlineKnown ? `due ${formatDay(deadlineDate)}` : null,
        state: "upcoming",
      };
    }
  }

  // --- Open now, on a rolling basis. ---
  if (p.deadlineStatus === "rolling") {
    return { label: "Rolling", detail: null, state: "open" };
  }

  // --- Open now, with a real close date. ---
  if (deadlineKnown) {
    return { label: `Due ${formatDay(deadlineDate)}`, detail: null, state: "open" };
  }

  // --- Nothing dated either way. ---
  //
  // The firm's own wording is better than a shrug *if it is actually a label*.
  // In practice deadlineText is usually a paragraph of cycle guidance - the
  // seeded postings average ~690 characters of "summer analyst applications
  // typically open the summer before junior year..." - and rendering that in a
  // status chip produced a wall of prose where a date belonged. So it is used
  // only when it is short enough to be what it claims to be.
  const said = p.deadlineText?.trim();
  if (said && said.length <= MAX_LABEL_CHARS && !said.includes("\n")) {
    return { label: said, detail: null, state: "unknown" };
  }

  return { label: "Not open yet", detail: null, state: "unknown" };
}

// Same token vocabulary the rest of the app uses for posting status, so these
// read as part of one system rather than a second colour language.
export const TIMING_STYLES: Record<PostingTiming["state"], string> = {
  open: "bg-success-50 text-success-700",
  upcoming: "bg-gold-50 text-gold-700",
  unknown: "bg-warmgray-100 text-warmgray-600",
  closed: "bg-error-50 text-error-600",
};
