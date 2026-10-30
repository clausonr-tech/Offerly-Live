// RETIRED, not deleted.
//
// This was the signed-in landing page: the scroll hero with the offer letter
// typing itself out, the firm rolodex, and a panel for each section. Students
// land on Opportunities now, so nothing routes here.
//
// The underscore is what takes it off the router - Next.js treats a folder
// whose name starts with "_" as private and excludes it from routing, so this
// file still type-checks and still compiles, but has no URL. Renaming the
// folder back to `home` is the whole of what it takes to bring it back; the
// redirect in next.config.ts would need removing at the same time.
//
// Anything here that other pages still USE has been moved out to
// src/components/feed rather than left behind an underscore: ActivityFeed,
// PersonMenu, FeedPostText and LogoAvatar. Everything still in this folder is
// used only by this page.

import { format } from "date-fns";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailDrafts } from "@/db/schema";
import { getAllFirmsWithPrograms } from "@/lib/firms";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { getCurrentUser } from "@/lib/current-user";
import { getFeed } from "@/lib/activity";
import { getPrimaryEmailConnection, getValidAccessToken } from "@/lib/google-connection";
import { listCalendarEvents } from "@/lib/google-calendar";
import OpportunitiesPanel, { type RolodexFirm } from "./OpportunitiesPanel";
import SchedulePanel, { type ScheduleSnapshot } from "./SchedulePanel";
import DiscoveryPanel from "./DiscoveryPanel";
import NewsPanel from "./NewsPanel";
import { getMainFinanceNews } from "@/lib/finance-news";
import { getSchoolLeaderboard } from "@/lib/school-leaderboard";
import InterviewPrepPanel from "./InterviewPrepPanel";
import ConnectPanel from "./ConnectPanel";
import DraftsPanel, { type StackDraft } from "./DraftsPanel";
import { getDirectoryMembers } from "@/lib/people";
import ActivityFeed from "@/components/feed/ActivityFeed";
import { NAV_SECTIONS } from "@/lib/nav-sections";
import HomeShell from "./HomeShell";


// Every firm we know, interleaved by sector so the marquee reads as "all of
// finance" rather than a long run of banks followed by a long run of funds.
// Firms are bucketed by their first matching category, then dealt out one
// bucket at a time until every firm has been placed.
const ROLODEX_MAX = 56;

async function buildRolodex(): Promise<RolodexFirm[]> {
  const all = await getAllFirmsWithPrograms();
  const categories = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

  const buckets = new Map<FirmProgramCategory, RolodexFirm[]>(
    categories.map((c) => [c, [] as RolodexFirm[]]),
  );
  for (const firm of all) {
    const category = categories.find((c) => firm.programs.some((p) => p.category === c));
    if (!category) continue;
    buckets.get(category)!.push({
      slug: firm.slug,
      name: firm.name,
      website: firm.website,
      sector: CATEGORY_LABELS[category],
    });
  }

  // Capped. The directory grew to 2,112 firms, and the marquee renders the
  // list TWICE for its seamless loop - so uncapped this became 4,224 cards and
  // as many logo requests on the home page. The strip is ambient: past a few
  // dozen firms it reads exactly the same while costing far more. Interleaving
  // happens first, so the cap still spans every sector.
  const out: RolodexFirm[] = [];
  const deepest = Math.max(...[...buckets.values()].map((b) => b.length));
  for (let round = 0; round < deepest && out.length < ROLODEX_MAX; round++) {
    for (const category of categories) {
      if (out.length >= ROLODEX_MAX) break;
      const firm = buckets.get(category)![round];
      if (firm) out.push(firm);
    }
  }
  return out;
}



// The panel under Contacts: a real month grid, the way Google Calendar's own
// mini picker draws one - see SchedulePanel for why familiarity is the point
// rather than another invented surface.
//
// "Not connected" means literally that: no stored connection, independent of
// whether a live fetch below happens to succeed. A connection that exists but
// fails a single API call (expired token mid-refresh, a hiccup) still counts
// as connected - the honest state for that is an empty grid for today, not a
// demotion to "you never connected anything."
async function buildScheduleSnapshot(userId: string): Promise<ScheduleSnapshot> {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthLabel = format(monthStart, "MMMM yyyy");

  // The grid always starts on the Sunday on/before the 1st and always runs 6
  // full weeks (42 days) - a fixed size regardless of which weekday the month
  // starts on or whether it has 28 or 31 days, which is what keeps this panel
  // the same height as its neighbours every single month.
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const connection = await getPrimaryEmailConnection(userId);
  // Keyed by day, holding the real events themselves now rather than just a
  // boolean - the panel shows actual event chips (Google Calendar's own
  // "little bubbles"), not just a dot, so the title and time have to survive
  // past this point instead of being reduced away.
  const eventsByDay = new Map<string, ScheduleSnapshot["weeks"][number][number]["events"]>();

  if (connection) {
    try {
      const accessToken = await getValidAccessToken(connection);
      const events = await listCalendarEvents(accessToken, gridStart, gridEnd);
      for (const e of events) {
        const key = googleEventDayKey(e.start);
        const list = eventsByDay.get(key) ?? [];
        list.push({ id: e.id, title: e.title, start: e.start });
        eventsByDay.set(key, list);
      }
    } catch {
      // Token refresh or the API call failed - show the grid empty for now
      // rather than failing the whole home page over one connection.
    }
  }

  const todayKey = format(today, "yyyy-MM-dd");
  const weeks: ScheduleSnapshot["weeks"] = [];
  for (let week = 0; week < 6; week++) {
    const days: ScheduleSnapshot["weeks"][number] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + week * 7 + day);
      const dateKey = format(date, "yyyy-MM-dd");
      days.push({
        date: dateKey,
        day: date.getDate(),
        inMonth: date.getMonth() === monthStart.getMonth(),
        isToday: dateKey === todayKey,
        events: eventsByDay.get(dateKey) ?? [],
      });
    }
    weeks.push(days);
  }

  return {
    connected: !!connection,
    accountEmail: connection?.email ?? null,
    monthLabel,
    weeks,
  };
}

// The panel under Connect. Drafts are few and personal - not a table worth
// paginating on the home page, and the panel only ever shows the single most
// recent one in full - so this fetches just that one row, body included.
async function buildDraftStack(userId: string): Promise<StackDraft[]> {
  const db = await getDb();
  const rows = await db.query.emailDrafts.findMany({
    where: eq(emailDrafts.userId, userId),
    orderBy: [desc(emailDrafts.createdAt)],
    limit: 1,
    with: { contact: { columns: { name: true } } },
  });

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    body: r.body,
    kind: r.kind,
    createdAt: r.createdAt.toISOString(),
    contactName: r.contact?.name ?? null,
  }));
}

/** Google returns an all-day event's start as a bare "YYYY-MM-DD" and a timed
 *  event's as a full ISO string with an offset. Parsing the bare form with
 *  `new Date(...)` reads it as UTC midnight, which is the wrong calendar day
 *  for anyone west of Greenwich. A date-only string is already the local day key, so
 *  it is used as-is; only a full timestamp needs `new Date` + `format`. */
function googleEventDayKey(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  return format(new Date(start), "yyyy-MM-dd");
}

export default async function HomePage() {
  const user = await getCurrentUser();
  const userId = user.id;
  const [
    rolodexFirms,
    feed,
    schedule,
    newsItems,
    leaderboard,
    directoryMembers,
    draftStack,
  ] = await Promise.all([
    buildRolodex(),
    getFeed(userId),
    buildScheduleSnapshot(userId),
    getMainFinanceNews(),
    getSchoolLeaderboard({ userId, metric: "streak" }),
    getDirectoryMembers(userId),
    buildDraftStack(userId),
  ]);

  return (
    // HomeShell owns the hero: its scroll cue retires the email for the rest of
    // the visit and swaps in the sticky section bar, and that swap has to hold
    // both pieces so it can compensate the scroll position as the hero leaves.
    <HomeShell sections={NAV_SECTIONS}>
      {/* A cinematic backdrop used to run the full length of this page; only
          DiscoveryPanel's own video survives it. Kept as a plain relative
          wrapper; nothing else needs the containing block, but removing it
          entirely was not worth the risk for a wrapper that costs nothing. */}
      <div className="relative">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-0">
          <div className="min-w-0 feed-divider lg:border-r lg:pr-10">
            {/* Order matches the tab strip in NavLinks.tsx, top to bottom:
                Opportunities, Contacts, Schedule, Discovery, Community, News,
                Interview Prep, Outreach. Scrolling the hub and reading the tabs
                should walk the product in the same order.

                Two of these render under a label that is not their filename:
                DiscoveryPanel carries the Opportunities id/title/href (the
                video sits at that position) and OpportunitiesPanel carries
                Discovery's. The swap was deliberate and the files were never
                renamed, so the mapping lives in this render order, not in the
                names - read the labels, not the imports.

                Applications has no panel here: it folded into Schedule, and a
                section with no tab of its own does not belong on the hub. */}
            <DiscoveryPanel />
            <SchedulePanel schedule={schedule} />
            <OpportunitiesPanel firms={rolodexFirms} />
            <ConnectPanel members={directoryMembers} />
            <NewsPanel items={newsItems} />
            <InterviewPrepPanel
              currentStreak={user.practiceCurrentStreak}
              bestStreak={user.practiceBestStreak}
              leaderboard={leaderboard}
            />
            <DraftsPanel drafts={draftStack} userName={user.name ?? "Your name"} />
          </div>

          {/* The live feed, as a narrow rail that holds its position while the page
              moves past it. `sticky` pins it; the fixed height plus overflow-y is
              what lets the pointer scroll the feed itself when it is over the
              rail, and `overscroll-contain` stops that scroll chaining back into
              the page once the feed hits its end. `will-change-transform`
              pre-promotes the rail to its own layer, same reasoning as the
              video backdrop's sticky wrapper: this and the backdrop both run
              out of sticking room at roughly the same point, right before the
              footer, and un-sticking two independently composited layers at
              once is where scroll stutter showed up. */}
          <aside
            aria-labelledby="feed-heading"
            className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto lg:overscroll-contain lg:pl-10 lg:pr-1 lg:will-change-transform"
          >
            <h2
              id="feed-heading"
              className="home-panel mb-3 inline-block rounded-lg px-2.5 py-1 font-mono text-xs uppercase tracking-[0.2em] text-warmgray-600"
            >
              Live feed
            </h2>
            <ActivityFeed items={feed} />
          </aside>
        </div>
      </div>
    </HomeShell>
  );
}
