import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, contacts, events, firms } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import TodayList from "./TodayList";
import TopFirmsSection from "./TopFirmsSection";
import TopApplicationsSection from "./TopApplicationsSection";
import ContactMap from "./ContactMap";
import { getTodayList } from "@/lib/today-list";
import EmptyState from "@/components/EmptyState";
import { EVENT_KIND_LABELS } from "@/lib/recruiting-event-display";
import { listUpcomingFirmEventsForStudent } from "@/lib/recruiting-events-feed";
import { getStudentTimeZone } from "@/lib/time-zone-server";

// Rendered on the server, whose clock is UTC, so the zone is always named.
function formatDateTime(d: Date, timeZone: string) {
  return new Date(d).toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Location is stored as the first "Location: ..." line inside the free-text
// notes field (events has no dedicated location column).
function extractLocation(notes: string | null) {
  if (!notes) return null;
  const match = notes.match(/^Location: (.+)$/m);
  return match ? match[1] : null;
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const userId = user.id;
  const db = await getDb();

  // Every read the page itself needs, issued together: none of these depends
  // on another's result. This used to be two sequential Promise.all waves -
  // two network waits for no reason beyond the order the lines were written.
  // The two heavy reads - the ranked match tree and the posting scorer - are
  // not here at all: each lives behind its own Suspense boundary
  // (TopFirmsSection, TopApplicationsSection), so this wave stays fast and the
  // header, Today and sessions paint without waiting for the slowest query.
  const [
    deadlineEvents,
    infoSessionEvents,
    contactRows,
    trackedCount,
    todayList,
    timeZone,
    firmEvents,
  ] = await Promise.all([
    db.query.events.findMany({
      where: and(eq(events.userId, userId), eq(events.type, "deadline"), eq(events.completed, false)),
      orderBy: [asc(events.eventDate)],
      limit: 8,
    }),
    db.query.events.findMany({
      where: and(eq(events.userId, userId), eq(events.type, "info_session"), eq(events.completed, false)),
      orderBy: [asc(events.eventDate)],
      limit: 8,
    }),
    // currentCity and firm feed the header's map; the length, the empty check below.
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { id: true, currentCity: true, firm: true },
    }),
    // A count, not the rows: the header only prints how many applications are
    // tracked, and the full rows were being fetched just to take .length.
    db.$count(applications, eq(applications.userId, userId)),
    getTodayList(user),
    getStudentTimeZone(),
    listUpcomingFirmEventsForStudent(user),
  ]);

  // Logos for the map's firm cards: each firm the student knows people at,
  // matched to the directory by name (contacts carry the firm as typed text).
  const contactFirmNames = [...new Set(contactRows.map((c) => c.firm?.trim()).filter((f): f is string => Boolean(f)))];
  const firmSites =
    contactFirmNames.length === 0
      ? []
      : await db
          .select({ name: firms.name, website: firms.website })
          .from(firms)
          .where(inArray(firms.name, contactFirmNames.slice(0, 500)));
  const siteByFirm = new Map(firmSites.map((f) => [f.name.toLowerCase(), f.website]));

  const isEmpty = contactRows.length === 0 && deadlineEvents.length === 0 && infoSessionEvents.length === 0;
  if (isEmpty && !user.preferredCategories?.length) {
    return <OnboardingEmptyState />;
  }

  // Speaker events & info sessions: the ones the student logged, and the ones
  // their matched firms posted on the firm portal, soonest first. A firm event
  // already added to their calendar is on the list as that calendar entry
  // (its notes carry the event's id - see addRecruitingEventToCalendar), so
  // it is not listed twice.
  const sessionRows = [
    ...infoSessionEvents.map((e) => ({
      key: e.id,
      title: e.title,
      detail: extractLocation(e.notes),
      date: e.eventDate,
      href: "/schedule",
    })),
    ...firmEvents
      .filter((f) => f.eventDate && !infoSessionEvents.some((e) => e.notes?.includes(`recruiting_event:${f.id}`)))
      .map((f) => ({
        key: f.id,
        title: f.title,
        detail: [`${f.kindLabel ?? EVENT_KIND_LABELS[f.kind] ?? "Event"} · ${f.firmName}`, f.location]
          .filter(Boolean)
          .join(" · "),
        date: f.eventDate!,
        // The firm's page, where "Add to my calendar" is.
        href: `/discovery/firm/${f.firmSlug}`,
      })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <div>
      {/* One grid, three blocks. From xl: the navy header card and what is
          due stack in the left column, and the top firms fill the right one
          from the top. The firms column keeps the 1.6 share it had on the
          left, so its rows are the same width as before; the header took the
          narrow column and grew taller to hold the map. Below xl it is one
          column: header, firms, then the rest.

          grid-rows-[auto_1fr] because the firms column spans both rows: an fr
          row absorbs its extra height, where two auto rows would split it and
          open a gap between the header and Today. */}
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] xl:grid-rows-[auto_1fr]">
        {/* Colours are literal hex, not tokens: this card is always dark navy,
            and the theme's --color-white is not guaranteed to be white. */}
        <div className="min-w-0 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)] xl:col-start-1 xl:row-start-1">
          <h1 className="app-hero-title text-2xl font-normal text-[#ffffff]">
            External Network
            {user.name ? (
              <>
                {" "}for <span className="text-[#cbc1fa]">{user.name.split(" ")[0]}</span>
              </>
            ) : null}
          </h1>
          {/* Directly under the title: where the people in this network are.
              The Add application button that sat here is gone - adding one
              is still on Schedule and /applications/new. */}
          <ContactMap
            contacts={contactRows.map((c) => ({
              city: c.currentCity,
              firm: c.firm,
              domain: c.firm ? siteByFirm.get(c.firm.trim().toLowerCase()) ?? null : null,
            }))}
            school={user.school}
            className="mt-3 block w-full max-w-[18rem]"
          />
          <p className="mt-3 text-sm text-[#c3cfe2]">
            Your top firms, the people inside them, and {trackedCount} application
            {trackedCount === 1 ? "" : "s"} tracked.
          </p>
        </div>

        <div className="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <TopFirmsSection />

          {/* Under the firms and at their width: these are events the firms
              post, so they read as part of the same list. min-w-0 because a
              grid item defaults to min-width:auto - "never shrink below your
              own content" - and this panel's helper text once held the column
              at 941px inside a 375px viewport. */}
          <div className="mt-8 min-w-0">
            <div className="mb-2 flex h-6 items-center justify-between">
              <h2 className="text-sm font-medium text-warmgray-500">Speaker events & info sessions</h2>
              <Link href="/schedule?type=info_session" className="text-xs text-brand-900 hover:underline">
                + Add
              </Link>
            </div>
            {sessionRows.length === 0 ? (
              <EmptyState>
                Events your firms post show up here. Log other info sessions and speaker events as you
                hear about them.
              </EmptyState>
            ) : (
              <>
              <SectionLabel>Upcoming</SectionLabel>
              <div className="list-panel stagger-in divide-y divide-brand-100 overflow-hidden border border-brand-100">
                {sessionRows.map((e) => (
                  <Link
                    key={e.key}
                    href={e.href}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-brand-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-brand-900">{e.title}</p>
                      {e.detail && <p className="truncate text-[11px] text-warmgray-500">{e.detail}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-warmgray-500">{formatDateTime(e.date, timeZone)}</span>
                  </Link>
                ))}
              </div>
              </>
            )}
          </div>
        </div>

        <aside className="min-w-0 space-y-8 xl:col-start-1 xl:row-start-2">
          <TodayList list={todayList} timeZone={timeZone} />
          <TopApplicationsSection />
        </aside>
      </div>
    </div>
  );
}

// Uppercase sub-heading used where a column's h2 needs a second line before
// its first card - kept only where the layout still needs it, now that
// "Upcoming deadlines" no longer splits into two sub-lists of its own.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
      {children}
    </p>
  );
}


function OnboardingEmptyState() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-brand-900">Welcome to Offerly</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          Two minutes of setup gets your recruiting pipeline moving. Pick a place to start.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/profile/interests" className="rounded-lg border border-brand-100 bg-white p-5 hover:border-brand-200">
          <p className="text-sm font-medium text-brand-900">Set up your profile</p>
          <p className="mt-1 text-sm text-warmgray-500">
            School, hometown, interests, and preferred sectors - this is what powers the matches
            on this page.
          </p>
        </Link>
        <Link href="/contacts/new" className="rounded-lg border border-brand-100 bg-white p-5 hover:border-brand-200">
          <p className="text-sm font-medium text-brand-900">Add your first contact</p>
          <p className="mt-1 text-sm text-warmgray-500">
            Start your personal recruiting CRM with someone you already know or want to reach out to.
          </p>
        </Link>
        <Link href="/discovery" className="rounded-lg border border-brand-100 bg-white p-5 hover:border-brand-200">
          <p className="text-sm font-medium text-brand-900">Explore Discovery</p>
          <p className="mt-1 text-sm text-warmgray-500">
            Learn what each type of finance actually is, when firms recruit, and the bigger names
            to know.
          </p>
        </Link>
        <Link href="/learn" className="rounded-lg border border-brand-100 bg-white p-5 hover:border-brand-200">
          <p className="text-sm font-medium text-brand-900">Practice for interviews</p>
          <p className="mt-1 text-sm text-warmgray-500">
            Answer behavioral questions and get AI feedback, plus curated technical prep resources.
          </p>
        </Link>
      </div>
    </div>
  );
}
