// Turning a firm's stated cut-off into a real instant.
//
// A deadline arrives as prose - "15 Nov 2026 11:55 PM EST" - and until now we
// kept the calendar date and showed the time as text, because showing the
// firm's own words is never wrong. Rendering it in the student's timezone is
// strictly more useful, but it is only possible once the text is an INSTANT,
// and that means resolving "EST" to an offset.
//
// Why a fixed table of abbreviations is correct here, rather than the usual
// warning against them: the abbreviation itself says whether daylight saving
// was in effect. EST is always UTC-5 and EDT is always UTC-4, so there is no
// date-dependent lookup to get wrong - which is exactly the failure mode that
// makes abbreviations dangerous when you only have "Eastern Time".
//
// Anything not on this list resolves to null and the caller shows the firm's
// stated text unchanged. That is the whole safety property: a zone we cannot
// resolve confidently produces no conversion at all, never a wrong one.

/** Offsets in minutes from UTC. */
const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0, UT: 0, GMT: 0, Z: 0,
  // UK / western Europe
  BST: 60, WET: 0, WEST: 60,
  // continental Europe
  CET: 60, CEST: 120, EET: 120, EEST: 180,
  // North America. CST/CDT are read as US Central, not China Standard Time:
  // every source feeding this pipeline is a US or European recruiting board,
  // and none of them publish from a CST+8 office. Revisit this line - and only
  // this line - if an APAC feed is ever added.
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600,
  // Canada / Atlantic
  AST: -240, ADT: -180, NST: -210, NDT: -150,
};

/**
 * The exact moment a deadline falls, or null when it cannot be pinned down.
 *
 * `calendarDate` is the stored midnight-UTC date; `timeText` is the firm's
 * words for the time of day. Returns null when either is missing or the zone
 * is one this table does not claim to know - the caller must then fall back to
 * showing `timeText` verbatim.
 */
export function resolveDeadlineInstant(
  calendarDate: Date | null | undefined,
  timeText: string | null | undefined,
): Date | null {
  if (!calendarDate || !timeText) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*([A-Z]{1,4})$/i.exec(timeText.trim());
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.toUpperCase();
  const zone = m[4].toUpperCase();

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;
  if (meridiem === "PM" && hour < 12) hour += 12;
  // 12:00 AM is midnight, not noon - the one hour where the obvious
  // arithmetic is wrong, and the one a deadline is most likely to use.
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23) return null;

  const offset = ZONE_OFFSETS[zone];
  if (offset === undefined) return null;

  // The stored date is the calendar day in the FIRM's zone, read off a
  // midnight-UTC timestamp - so take its UTC parts, attach the stated
  // wall-clock time, then subtract the zone's offset to reach the instant.
  const utcMs = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
    hour,
    minute,
  );
  const instant = new Date(utcMs - offset * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
