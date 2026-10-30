import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, events } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { getContactDirectory } from "@/lib/contact-directory";
import { buildGoogleCalendarUrl } from "@/lib/calendar";
import { listCalendarEvents } from "@/lib/google-calendar";
import { isGoogleOAuthConfigured } from "@/lib/google-oauth";
import { getEmailConnections, getValidAccessToken } from "@/lib/google-connection";
import { displayNotes } from "@/lib/event-notes";
import { localDateString, wallClockInputValue } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import EventForm from "./EventForm";
import GoogleConnectBanner from "./GoogleConnectBanner";
import EventRow, { type ScheduleRowEvent } from "./EventRow";
import CalendarView from "./CalendarView";
import { acceptGoogleSync, dismissGoogleSync } from "./actions";
import { addApplicationFromSchedule } from "../applications/actions";
import ShowMoreList from "../ShowMoreList";
import UpcomingApplications from "../UpcomingApplications";
import ExportToGoogle from "./ExportToGoogle";
import { getExpectedUpcoming, getUpcomingApplications } from "@/lib/upcoming-applications";
import AddApplicationForm from "./AddApplicationForm";

// Rendered on the server, whose clock is UTC, so the zone is always named.
function formatDate(d: Date, timeZone: string) {
  return new Date(d).toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Rows revealed per click in the Upcoming list. */
const UPCOMING_PAGE = 5;

const PREFILL_TYPES = [
  "meeting",
  "coffee_chat",
  "deadline",
  "info_session",
  "personal",
  "interview",
] as const;

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string; type?: string }>;
}) {
  const { title: prefillTitle, type: prefillType } = await searchParams;
  const userId = await getCurrentUserId();
  const db = await getDb();
  const timeZone = await getStudentTimeZone();

  // upcomingApplications joins this batch rather than trailing the Google
  // Calendar work below. It only needs the signed-in user - which the cached
  // session lookup already has in hand - so queueing it behind a calendar
  // round trip bought nothing. See lib/application-windows.ts for why the
  // estimated-window countdown that used to sit beside it is gone: a guessed
  // date rendered as a confident "266d" was worse than showing nothing.
  const [allEvents, applicationRows, connections, upcomingApplications, expectedUpcoming] = await Promise.all([
    // The two joins select the columns this page renders and nothing else.
    //
    // `contact: true` selected the WHOLE contacts row - name, email, phone,
    // firm, title, notes, LinkedIn - and both joins match on id alone, with
    // no second comparison of the linked row's owner. The write side now
    // refuses a foreign id (ownedLinks in ./actions), and 0045 cleared the
    // rows written before it did, but the read is the half that decides how
    // much a link that slips through is worth: toRowEvent needs a contact's
    // name and an application's firm and role, so that is all that leaves the
    // database. The same `columns:` form the rest of the app uses - see
    // _home/page.tsx and drafts/[id]/page.tsx.
    db.query.events.findMany({
      where: eq(events.userId, userId),
      with: {
        contact: { columns: { name: true } },
        application: { columns: { firm: true, role: true } },
      },
    }),
    db.query.applications.findMany({
      where: eq(applications.userId, userId),
      columns: {
        id: true,
        firm: true,
        role: true,
        status: true,
        applicationUrl: true,
        appliedDate: true,
      },
    }),
    getEmailConnections(userId),
    getCurrentUser().then(getUpcomingApplications),
    getCurrentUser().then((u) => getExpectedUpcoming(u)).catch(() => []),
  ]);

  // Merge Google Calendar events from every connected account.
  let googleEvents: { id: string; title: string; date: string; end: string | null; htmlLink: string }[] = [];
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 30);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 120);

  for (const connection of connections) {
    try {
      const accessToken = await getValidAccessToken(connection);
      const items = await listCalendarEvents(accessToken, windowStart, windowEnd);
      googleEvents.push(
        ...items.map((e) => ({ id: e.id, title: e.title, date: e.start, end: e.end, htmlLink: e.htmlLink })),
      );
    } catch (err) {
      // One unusable connection (revoked, expired past refresh) must not blank
      // the whole page - the others still render. Logged rather than swallowed:
      // a silent catch here is what made "my calendar is empty" impossible to
      // diagnose, because the read was failing with nothing to show for it.
      console.error("[schedule] Google Calendar read failed for", connection.email, err);
    }
  }

  // A local event that's already synced to Google comes back from the API
  // call above too - drop that duplicate so it isn't shown twice.
  const syncedGoogleIds = new Set(allEvents.map((e) => e.googleEventId).filter((id): id is string => Boolean(id)));
  googleEvents = googleEvents.filter((e) => !syncedGoogleIds.has(e.id));

  // Everything still ahead of the student, nearest first.
  //
  // No longer sliced. It used to hard-cap at 25 and say "showing 25 of 144",
  // which named the problem without solving it: the other 119 were simply
  // unreachable from this page. The reason for the cap was real - a student
  // tracking a hundred roles has a hundred auto-generated deadline events, and
  // rendering all of them turns the page into a wall - so the list now opens
  // five at a time instead, which answers the same concern without hiding
  // anything permanently.
  //
  // From today on, on the student's own calendar. An event whose day has gone
  // by without being ticked off is not "upcoming" (5 October 2026: two of three
  // "upcoming" interviews were from September); it goes to its own section,
  // which asks whether it happened.
  const today = localDateString(new Date(), timeZone);
  const isAhead = (e: { eventDate: Date }) => localDateString(e.eventDate, timeZone) >= today;
  const upcomingEvents = allEvents
    .filter((e) => !e.completed && isAhead(e))
    .sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  const pastNotDone = allEvents
    .filter((e) => !e.completed && !isAhead(e))
    .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime());

  const completed = allEvents
    .filter((e) => e.completed)
    .sort((a, b) => b.eventDate.getTime() - a.eventDate.getTime());
  // Applications split into "still to do" and "already in", with the nearest
  // linked deadline attached. Sorted by urgency so the row a student has to act
  // on today is the one at the top.
  const deadlineByApplication = new Map<string, Date>();
  for (const e of allEvents) {
    if (e.type !== "deadline" || !e.applicationId) continue;
    const current = deadlineByApplication.get(e.applicationId);
    if (!current || e.eventDate < current) deadlineByApplication.set(e.applicationId, e.eventDate);
  }

  const pendingSyncs = allEvents.filter((e) => e.googleSyncStatus === "pending");

  // Grouped the same way the draft form groups them, so the picker can narrow
  // company -> division -> person instead of listing every contact at once.
  const contactOptions = (await getContactDirectory(userId, { includeWithoutEmail: true })).flatMap(
    (company) =>
      company.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        firmKey: company.key,
        firmName: company.name,
        divisions: c.industries as string[],
      })),
  );
  const applicationOptions = applicationRows.map((a) => ({
    id: a.id,
    label: `${a.firm} - ${a.role}`,
  }));

  /**
   * The applications the student is tracking, written onto the calendar.
   *
   * This is the circular part of the system: the crawler finds a posting, the
   * relevance rules decide it is theirs, and the date it carries turns up here
   * without anyone typing it in. A deadline they have to read off one panel
   * and copy into another is a deadline they will miss.
   *
   * Derived on every render rather than stored as `events` rows. They are a
   * VIEW of the postings, not things the student made: a posting whose date
   * moves, or which stops being relevant, must change here too, and a copy in
   * the events table would quietly go stale. It also means nothing to clean up
   * when a firm drops off their list.
   *
   * Every date on this grid was published by a firm or observed first-hand.
   * Estimated openings used to be included, carrying "(est.)" in the title;
   * they are gone, because a guess written onto a calendar is a guess someone
   * plans a week around. See lib/upcoming-applications.ts.
   */
  /**
   * Where on the grid a tracked date belongs.
   *
   * Deadlines are stored as CALENDAR DATES at midnight UTC, and the calendar
   * places events by local time - so midnight UTC on the 15th rendered as
   * "14 Nov, 4:00 PM" for anyone west of UTC. Same failure as the one the
   * applications list had, in a different renderer.
   *
   * `exactAt` is a real instant when the firm published a time, and is used
   * as-is: 11:55 PM Eastern genuinely is 8:55 PM Pacific on the same day.
   * Everything else is a bare day, so its UTC parts are re-read into the
   * reader's own timezone at an hour that matches what the row means - late
   * afternoon for something due, morning for something opening.
   */
  const onLocalDay = (date: Date, hour: number) =>
    new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0);

  /**
   * A deadline gets a real block on the grid, 30 minutes long, ENDING at the
   * moment it is due.
   *
   * Ending rather than starting: the block is the last half hour you have, so
   * its bottom edge is the wall. A marker that started at 8:55 would sit
   * below the line it represents and read as time you still had.
   */
  const MARKER_MIN = 30;
  const endingAt = (at: Date) => new Date(at.getTime() - MARKER_MIN * 60_000);

  const applicationEvents = [
    ...upcomingApplications.current.map((w) => ({
      id: `due-${w.id}`,
      title: `${w.firmName} - application due`,
      type: "deadline" as const,
      // The block runs up to the cut-off; see endingAt.
      date: (() => {
        const at = w.exactAt ? new Date(w.exactAt) : w.date ? onLocalDay(w.date, 17) : null;
        return at ? endingAt(at) : null;
      })(),
      endsAt: w.exactAt ? new Date(w.exactAt) : w.date ? onLocalDay(w.date, 17) : null,
    })),
    ...upcomingApplications.upcoming.map((w) => ({
      id: `opens-${w.id}`,
      title: `${w.firmName} - applications open`,
      type: "opens" as const,
      // An opening is the opposite: the block STARTS when applications open,
      // because that is the first moment you can act rather than the last.
      date: w.date ? onLocalDay(w.date, 9) : null,
      endsAt: w.date ? new Date(onLocalDay(w.date, 9).getTime() + MARKER_MIN * 60_000) : null,
    })),
  ]
    // Undated rows are real and belong in the list beside the grid, but a
    // calendar has nowhere to put them.
    .filter((e): e is typeof e & { date: Date } => e.date instanceof Date)
    .map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      date: e.date.toISOString(),
      // A real end, so the bubble has the same 30-minute height every other
      // timed event gets from its duration rather than a fallback.
      endDate: e.endsAt ? e.endsAt.toISOString() : null,
      completed: false,
    }));

  const calendarEvents = [
    ...allEvents.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      date: e.eventDate.toISOString(),
      endDate: e.endDate ? e.endDate.toISOString() : null,
      completed: e.completed,
    })),
    ...applicationEvents,
  ];

  return (
    <div>
      {/* The title sits in a blue plate - a gradient running deep navy to a
          lit mid-blue across the diagonal, so the box reads as lit from one
          corner rather than as a flat swatch.

          Related to the gradient card on Opportunities, deliberately, but not
          the same object: that one is tilted and full width because it carries
          a name and a count. This is a masthead around a single word, so it
          stays contained and level. Two tilted cards would read as a motif
          rather than as one page's signature.

          Colours are literal hex rather than palette tokens, for the same
          reason they are on that card: this plate is blue in BOTH themes, and
          `text-white` cannot be used on it because the dark theme redefines
          --color-white to #0a0a0a as a card-surface token, which would render
          the heading near-black on blue.

          Contrast measured rather than eyeballed, against the LIGHTEST stop -
          the point where white type is closest to failing. #1d76b3 gives
          4.89:1 with white.

          Note that is the STRICT floor, not the applicable one: at 24px this
          heading is WCAG large text, which only needs 3:1, so there was room
          to go considerably brighter. It stays at the body-text floor anyway -
          the extra headroom costs nothing visually and means the plate does
          not quietly become a problem if this heading is ever made smaller.
          Blues tested at 3.53-4.28:1 were dropped on that basis.

          The paragraph that used to sit under it is gone. It explained that
          this page holds coffee chats, calls and deadlines - which the page
          itself says, in the calendar directly below - and pointed at
          Discovery, which is already a tab in the nav. */}
      <div className="mb-6">
        {/* Full width and the same padding as the Opportunities card, so the
            two pages open at the same weight rather than one with a masthead
            and the other with a badge.

            No tilt, though. The rotation on that card is its own signature and
            a second tilted box would turn a page's identity into a house
            motif. This one matches the size, the colour and the material, not
            the trick - which is also why it does not need that card's mx-1,
            the margin that exists purely to stop rotated corners widening the
            page.

            rounded-2xl, the hero step of the app's corner scale, so every
            section's navy banner has the same silhouette. See the rounding
            scale on [data-app-theme] in globals.css.

            py-8 rather than the py-5 that card uses, to land at a similar
            height: that one runs to 121px because it carries a subtitle line
            under its heading, and this page deliberately has no subtitle (the
            paragraph that was there is gone, for the reason below). Matching
            with padding rather than with invented copy - a sentence written to
            fill a box is worse than an empty inch of blue.

            px-6 over a full-width box gives the gradient a long diagonal
            run, which is what makes it read as an ombre rather than as a navy
            fill with one lit corner. The inset hairline along the top edge is
            what stops a filled box from looking printed on. */}
        <div className="rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-8 shadow-[0_12px_32px_-14px_rgba(11,21,38,0.7)] ring-1 ring-inset ring-[rgba(255,255,255,0.14)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="app-hero-title text-2xl font-normal leading-tight text-[#ffffff]">Schedule</h1>
            {/* Connecting Google is what a student comes here to do; the .ics
                export that used to hold this slot was a power-user escape
                hatch taking the card's only action position. The route it
                pointed at (/api/calendar) is untouched and still serves the
                feed - it simply has no link on this page any more. */}
            <GoogleConnectBanner
              configured={isGoogleOAuthConfigured()}
              connectedEmails={connections.map((c) => c.email)}
            />
          </div>
        </div>
      </div>

      {/* The calendar leads, full width.
          It used to share the top row with the application lists at half
          width, which is why it defaulted to Month - seven day columns plus an
          hour gutter do not fit in half a screen. Full width makes Week and
          Day usable, and it is the thing a student opens this tab to look at.
          The lists that feed it follow underneath. */}
      <div className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-brand-900">Calendar</h2>
          <ExportToGoogle
            connected={connections.length > 0}
            configured={isGoogleOAuthConfigured()}
          />
        </div>
        <CalendarView
          timeZone={timeZone}
          events={calendarEvents}
          googleEvents={googleEvents}
          // The same options the form at the bottom of this page uses, so a
          // slot click and that form offer the same contacts and applications.
          contactOptions={contactOptions}
          applicationOptions={applicationOptions}
        />
      </div>

      {/* What is coming up, and nothing else.
          Two navigation cards used to sit under this - "Tracking N roles at M
          firms" pointing at /tracking, and "Browse all internship
          opportunities" pointing at /discovery. Both were links dressed as
          content: they carried no information this page needed, and Discovery
          is a tab in the sidebar already. /tracking is still reachable from
          Discovery, which is where someone goes when they want to prune a
          list rather than when they came to look at a calendar.

          The two-column grid went with them. It existed to stand a second
          column beside these cards, and with one child left it was rendering
          this list at half width against an empty half page. */}
      <div className="mb-8">
        <UpcomingApplications windows={upcomingApplications} expected={expectedUpcoming} />
      </div>

      <div className="mb-8">
        <AddApplicationForm action={addApplicationFromSchedule} />
      </div>

      {pendingSyncs.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-2 text-base font-semibold text-brand-900">
            Pending Google Calendar sync ({pendingSyncs.length})
          </h2>
          <div className="divide-y divide-brand-100 overflow-hidden rounded-lg border border-accent-400 bg-accent-50/40">
            {pendingSyncs.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-brand-900">{e.title}</p>
                  <p className="text-xs text-warmgray-500">
                    {formatDate(e.eventDate, timeZone)} · linked to an application
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <form action={acceptGoogleSync.bind(null, e.id)}>
                    <button
                      type="submit"
                      className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-400 shadow-card"
                    >
                      Accept & add to Google Calendar
                    </button>
                  </form>
                  <form action={dismissGoogleSync.bind(null, e.id)}>
                    <button
                      type="submit"
                      className="rounded-md border border-brand-100 px-3 py-1.5 text-xs font-medium text-warmgray-600 hover:bg-brand-50"
                    >
                      Dismiss
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-8">
        <h2 className="mb-2 text-base font-semibold text-brand-900">Add an event</h2>
        <EventForm
          contactOptions={contactOptions}
          applicationOptions={applicationOptions}
          defaultTitle={prefillTitle}
          defaultType={
            (PREFILL_TYPES as readonly string[]).includes(prefillType ?? "")
              ? (prefillType as (typeof PREFILL_TYPES)[number])
              : undefined
          }
        />
      </div>


      {upcomingEvents.length > 0 && (
        <div className="mt-8">
          {/* The heading carries the TRUE total, not the number on screen. A
              paged list that also shrinks its own count tells the reader there
              are five things when there are a hundred and forty-four. */}
          <Section title={`Upcoming (${upcomingEvents.length})`}>
            <ShowMoreList
              pageSize={UPCOMING_PAGE}
              rows={upcomingEvents.map((e) => (
                <EventRow key={e.id} event={toRowEvent(e, timeZone)} timeZone={timeZone} />
              ))}
            />
          </Section>
        </div>
      )}

      {pastNotDone.length > 0 && (
        <div className="mt-8">
          <Section title={`Past - did these happen? (${pastNotDone.length})`}>
            <ShowMoreList
              pageSize={UPCOMING_PAGE}
              rows={pastNotDone.map((e) => (
                <EventRow key={e.id} event={toRowEvent(e, timeZone)} timeZone={timeZone} />
              ))}
            />
          </Section>
          <p className="mt-1.5 text-xs text-warmgray-500">
            Mark each one done, or edit its date if it moved.
          </p>
        </div>
      )}

      {completed.length > 0 && (
        <div className="mt-8">
          <Section title={`Completed (${completed.length})`}>
            {completed.map((e) => (
              <EventRow key={e.id} event={toRowEvent(e, timeZone)} timeZone={timeZone} />
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-brand-900">{title}</h2>
      <div className="stagger-in divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
        {children}
      </div>
    </div>
  );
}

// EventRow is a client component (it owns the inline editor's open state), so
// rows cross the boundary as plain JSON. Notes are stripped of Offerly's own
// sync markers and the manual "add to Google" URL is built here, because both
// helpers are server-only. The editor's datetime-local values are written
// here too, in the same zone the save action reads them back in, so opening
// and saving an event without touching it leaves its time where it was.
function toRowEvent(
  e: {
    id: string;
    type: ScheduleRowEvent["type"];
    title: string;
    notes: string | null;
    eventDate: Date;
    endDate: Date | null;
    completed: boolean;
    googleSyncStatus: ScheduleRowEvent["googleSyncStatus"];
    googleMeetUrl: string | null;
    contactId: string | null;
    applicationId: string | null;
    contact: { name: string } | null;
    application: { firm: string; role: string } | null;
  },
  timeZone: string,
): ScheduleRowEvent {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    notes: e.notes,
    eventDate: e.eventDate.toISOString(),
    endDate: e.endDate ? e.endDate.toISOString() : null,
    eventDateInput: wallClockInputValue(e.eventDate, timeZone),
    endDateInput: e.endDate ? wallClockInputValue(e.endDate, timeZone) : "",
    completed: e.completed,
    googleSyncStatus: e.googleSyncStatus,
    googleMeetUrl: e.googleMeetUrl,
    contactId: e.contactId,
    applicationId: e.applicationId,
    contactName: e.contact?.name ?? null,
    applicationLabel: e.application ? `${e.application.firm} (${e.application.role})` : null,
    googleCalendarUrl: buildGoogleCalendarUrl(e),
    visibleNotes: displayNotes(e.notes) ?? null,
  };
}
