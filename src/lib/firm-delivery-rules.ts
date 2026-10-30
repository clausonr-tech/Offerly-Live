// Who hears about what a firm posts. Pure, so the rules are tested on their
// own (scripts/test/firm-delivery.test.ts); lib/firm-delivery.ts applies them.
//
// THE RULE. A student is told when a firm they are MATCHED with - one on
// their top-firms list, matched by the app or added by hand - posts
// something, with two exceptions:
//
//   - an internship they are not eligible for (the firm named the graduating
//     classes it takes, and theirs is not one of them), and
//   - an event at specific schools, when they are not at one of those
//     schools. An event open to students anywhere reaches every match.
//
// Demo firms reach demo students only, and real firms never reach a demo.

export type MatchedStudent = {
  userId: string;
  gradYear: number | null;
  /** Verified school first; the school they claimed at onboarding otherwise. */
  schoolId: string | null;
  claimedSchoolId: string | null;
  isDemo: boolean;
};

export function shouldNotifyOfPosting(
  student: MatchedStudent,
  posting: { eligibleGradYears: number[]; isDemo: boolean },
): boolean {
  if (student.isDemo !== posting.isDemo) return false;
  // Unknown grad year, or a posting that did not say: we cannot rule them
  // out, and a missed internship costs more than one extra notification.
  if (posting.eligibleGradYears.length === 0 || student.gradYear == null) return true;
  return posting.eligibleGradYears.includes(student.gradYear);
}

export function shouldNotifyOfEvent(
  student: MatchedStudent,
  event: { schoolIds: string[]; isDemo: boolean },
): boolean {
  if (student.isDemo !== event.isDemo) return false;
  if (event.schoolIds.length === 0) return true;
  const school = student.schoolId ?? student.claimedSchoolId;
  return !!school && event.schoolIds.includes(school);
}

/**
 * Whether a student may SEE a firm's event on the firm's page. Same school
 * rule as the notification: a campus event at Duke is noise to a student at
 * Penn. Crawled events carry no school ids and show to everyone, as before.
 */
export function eventVisibleTo(
  viewer: { schoolId: string | null; claimedSchoolId: string | null; isDemo: boolean },
  event: { schoolIds: string[]; isDemo: boolean; isActive: boolean },
): boolean {
  if (!event.isActive) return false;
  if (event.isDemo && !viewer.isDemo) return false;
  if (event.schoolIds.length === 0) return true;
  const school = viewer.schoolId ?? viewer.claimedSchoolId;
  return !!school && event.schoolIds.includes(school);
}

export function postingNotificationKey(postingId: string): string {
  return `firm_posting:${postingId}`;
}

export function eventNotificationKey(eventId: string): string {
  return `firm_event:${eventId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The posting or event a firm's bell row is about, read back out of its key -
 * the notifications table has no firm column. Null for any other key, and for
 * a malformed id, which must not reach a uuid query and fail the bell.
 */
export function parseFirmNotificationKey(key: string): { kind: "posting" | "event"; id: string } | null {
  const [prefix, id, ...rest] = key.split(":");
  if (rest.length > 0 || !id || !UUID.test(id)) return null;
  if (prefix === "firm_posting") return { kind: "posting", id };
  if (prefix === "firm_event") return { kind: "event", id };
  return null;
}

/**
 * What changed about an event that a student who already heard about it
 * needs to know: its time, its place, or both. Anything else - a reworded
 * description, a new RSVP link - is not worth interrupting anyone for.
 * Minutes, not milliseconds: a form re-saved with the same time is no change.
 */
export function eventChange(
  before: { startsAt: Date | null; location: string | null },
  after: { startsAt: Date; location: string | null },
): "time" | "place" | "time and place" | null {
  const minute = (d: Date | null) => (d ? Math.floor(d.getTime() / 60_000) : null);
  const norm = (s: string | null) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const time = minute(before.startsAt) !== minute(after.startsAt);
  const place = norm(before.location) !== norm(after.location);
  return time && place ? "time and place" : time ? "time" : place ? "place" : null;
}
