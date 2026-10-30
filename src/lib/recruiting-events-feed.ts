import "server-only";
import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmRecruitingEvents, firms, userTopFirms } from "@/db/schema";
import { findBlockedLanguage } from "@/lib/content-limits";
import { eventVisibleTo } from "@/lib/firm-delivery-rules";
import type { RecruitingEventKind } from "@/lib/monitoring/recruiting-events";
import type { FirmRecruitingEvent } from "@/lib/recruiting-event-display";
import { publicHttpUrl } from "@/lib/safe-url";
import { startOfLocalDay } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { cleanEventDescription } from "@/lib/event-description";

/**
 * The read side of `firm_recruiting_events`.
 *
 * The crawler has been filing these since it learned to keep the rows its
 * classifier rejects - an info session is not an internship, and rejecting it
 * as one was right, but a coffee chat with Evercore is worth a great deal to a
 * student. Until now nothing read the table back.
 */

export type { FirmRecruitingEvent };

/** How much of a crawled description is worth showing inline. */
const SUMMARY_CHARS = 240;

/**
 * Upcoming recruiting events at one firm, soonest first, undated last.
 *
 * Past events are dropped rather than greyed out: this sits on a page about
 * the firm, not a history of it, and an event that has already happened is
 * only noise to someone deciding where to apply.
 */
export async function listFirmRecruitingEvents(
  firmId: string,
  now = new Date(),
  /**
   * Who is looking. A firm's own campus event is shown only to students at
   * the schools it is for, and a demo firm's only to demo accounts - see
   * lib/firm-delivery-rules eventVisibleTo. Crawled events carry no schools
   * and show to everyone, as they always have.
   */
  viewer: { schoolId: string | null; claimedSchoolId: string | null; isDemo: boolean } = {
    schoolId: null,
    claimedSchoolId: null,
    isDemo: false,
  },
  /** The student's zone; read from their account when omitted. */
  timeZone?: string,
): Promise<FirmRecruitingEvent[]> {
  const db = await getDb();

  // Midnight today rather than this instant, so an event at 6pm does not
  // vanish from the page at 6:01pm for someone still deciding to go. The
  // student's midnight, not the server's: UTC midnight is 8pm in New York, and
  // would drop tonight's event while the evening is still under way.
  const startOfToday = startOfLocalDay(now, timeZone ?? (await getStudentTimeZone()));

  const rows = await db
    .select()
    .from(firmRecruitingEvents)
    .where(
      and(
        eq(firmRecruitingEvents.firmId, firmId),
        // Undated rows are kept deliberately. The source published the event
        // and not its time; that is still worth a student's click, and
        // guessing a date to make it sortable is the one thing we never do.
        or(
          isNull(firmRecruitingEvents.eventDate),
          gte(firmRecruitingEvents.eventDate, startOfToday),
        ),
      ),
    )
    .orderBy(asc(firmRecruitingEvents.eventDate));

  return rows
    // Crawled copy, shown to a student. `promote-approved-listings` carries
    // the same obligation for the same reason: a title and description are
    // a firm's own words, fetched from a page we do not control, and a
    // defaced source or a board carrying an unrelated posting would
    // otherwise be rendered verbatim. Dropped here rather than held for
    // review - unlike a posting, nobody is waiting on an event to publish.
    .filter((r) => eventVisibleTo(viewer, r))
    .filter(
      (r) =>
        !findBlockedLanguage(r.title) &&
        !findBlockedLanguage(r.descriptionRaw) &&
        !findBlockedLanguage(r.location) &&
        !findBlockedLanguage(r.school),
    )
    /**
     * And the LINK, on the same terms and for the same reason.
     *
     * A crawled row's `eventUrl` is whatever anchor href the careers page
     * carried - the Puppeteer DOM scan copies `anchor.href` straight through -
     * and unlike a firm-posted event it has no review state and no `cleanUrl`
     * behind it. The event's title IS the link on the firm's page, and the
     * students' calendar notes copy the same string, so a `javascript:`,
     * `data:` or scheme-less value reached a student's href unexamined
     * (security review, 10 October 2026).
     *
     * Dropped rather than shown without its link, exactly as the blocked
     * language above is dropped: nobody is waiting on an event to publish,
     * and an info session a student cannot click through to is not worth a
     * row. A firm-posted row keeps its internal marker, which is replaced
     * with our own route below.
     */
    .filter((r) => r.origin === "firm" || publicHttpUrl(r.eventUrl) !== null)
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.eventKind as RecruitingEventKind,
      kindLabel: r.kindLabel ?? null,
      eventDate: r.eventDate,
      registrationDeadline: r.registrationDeadline,
      school: r.school,
      location: r.location,
      // A firm-posted event's eventUrl is an internal marker, not a page.
      // Its link goes through the click log (the firm's analytics) to the
      // firm's RSVP page, or back to the firm's page when it gave none.
      // Non-null for a crawled row by the filter above, which is also what
      // normalises it - the value stored is the value that was judged.
      eventUrl: r.origin === "firm" ? `/api/firm-events/${r.id}/open` : publicHttpUrl(r.eventUrl)!,
      summary: summarise(r.descriptionRaw),
      postedByFirm: r.origin === "firm",
    }))
    // Postgres sorts NULLs last on ASC, which is the order we want, but the
    // guarantee is stated here rather than relied on from the index.
    .sort((a, b) => {
      if (a.eventDate && b.eventDate) return a.eventDate.getTime() - b.eventDate.getTime();
      if (a.eventDate) return -1;
      if (b.eventDate) return 1;
      return 0;
    });
}

function summarise(raw: string | null): string | null {
  // Form-field dumps ("~~DATADICT..~~:14548 Title:... Region:...") become a
  // plain line first - see lib/event-description.
  const flat = cleanEventDescription(raw);
  if (!flat) return null;
  if (flat.length <= SUMMARY_CHARS) return flat;
  // Cut on a word boundary so the ellipsis does not land mid-word.
  const cut = flat.slice(0, SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SUMMARY_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export type StudentFirmEvent = FirmRecruitingEvent & { firmName: string; firmSlug: string };

/**
 * Upcoming events that firms a student is matched with posted themselves,
 * soonest first - the ones the bell told them about, in one place. Same
 * visibility rule as the firm's page (lib/firm-delivery-rules eventVisibleTo):
 * a campus event only at its schools, demo events only to demo accounts, and
 * nothing closed or taken down.
 */
export async function listUpcomingFirmEventsForStudent(
  viewer: { id: string; schoolId: string | null; claimedSchoolId: string | null; isDemo: boolean },
  now: Date = new Date(),
  limit = 6,
): Promise<StudentFirmEvent[]> {
  const db = await getDb();
  const matched = await db.select({ firmId: userTopFirms.firmId }).from(userTopFirms).where(eq(userTopFirms.userId, viewer.id));
  if (matched.length === 0) return [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ e: firmRecruitingEvents, firmName: firms.name, firmSlug: firms.slug })
    .from(firmRecruitingEvents)
    .innerJoin(firms, eq(firms.id, firmRecruitingEvents.firmId))
    .where(
      and(
        inArray(firmRecruitingEvents.firmId, matched.map((m) => m.firmId)),
        eq(firmRecruitingEvents.origin, "firm"),
        gte(firmRecruitingEvents.eventDate, startOfToday),
      ),
    )
    .orderBy(asc(firmRecruitingEvents.eventDate))
    .limit(limit * 4);
  return rows
    .filter(({ e }) => eventVisibleTo(viewer, e))
    .filter(({ e }) => !findBlockedLanguage(e.title) && !findBlockedLanguage(e.descriptionRaw) && !findBlockedLanguage(e.location))
    .slice(0, limit)
    .map(({ e, firmName, firmSlug }) => ({
      id: e.id,
      title: e.title,
      kind: e.eventKind as RecruitingEventKind,
      kindLabel: e.kindLabel ?? null,
      eventDate: e.eventDate,
      registrationDeadline: e.registrationDeadline,
      school: e.school,
      location: e.location,
      eventUrl: `/api/firm-events/${e.id}/open`,
      summary: summarise(e.descriptionRaw),
      postedByFirm: true,
      firmName,
      firmSlug,
    }));
}
