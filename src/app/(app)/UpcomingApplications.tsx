import FirmLogo from "./discovery/FirmLogo";
import LocalDeadline from "./LocalDeadline";
import {
  daysUntil,
  type ApplicationWindows,
  type UpcomingApplication,
} from "@/lib/upcoming-applications";
import EmptyState from "@/components/EmptyState";
import type { ExpectedPosting } from "@/lib/expected-postings";
import { shortRoleTitle } from "@/lib/role-title";
import { externalHref } from "@/lib/safe-url";

// The roles you're tracking: which are open right now, and which open later.
// Replaces "Major upcoming" on Schedule and "Upcoming deadlines" on
// Opportunities, which were two different components answering the same
// question from two different data sources, and disagreeing: one counted down
// from estimated windows, the other listed real postings that all said
// "Deadline TBD". A student comparing the two pages saw a confident "266d" on
// one and "no date" on the other for the same firm.
//
// Lives at the (app) root rather than under either page because it belongs to
// neither.

function Row({ w, showApply }: { w: UpcomingApplication; showApply: boolean }) {
  // Under a fortnight is when a student has to reorder their week.
  const days = w.date ? daysUntil(w.date) : null;
  const urgent = w.kind === "due" && days !== null && days <= 14;
  return (
    // Straight to the firm's application page for THIS posting, not to our own
    // firm page. A student who has decided to apply should not have to land on
    // a profile, find the roles list, and pick the row again - the whole point
    // of this section is that we already know exactly which posting they mean.
    //
    // A plain <a>, not next/link: this leaves the app for a third-party board,
    // and prefetching someone else's careers site is both pointless and rude.
    // rel="noopener" because target=_blank without it hands the opened page a
    // handle on ours.
    <a
      // Guarded at the read boundary: the apply URL is crawled from a
      // careers page, React neutralises only `javascript:`, and this row IS
      // the link. No href leaves the row readable and inert rather than
      // sending the student somewhere the firm did not choose.
      href={externalHref(w.applyUrl) ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50"
      // The sentence a signal-sourced date was read out of, on hover. The date
      // is only as good as its evidence, and this is the cheapest way to let
      // someone check it without leaving the page.
      title={w.evidence ?? undefined}
    >
      <FirmLogo domain={w.firmWebsite} name={w.firmName} size={24} />
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-brand-900">
          {w.firmName}
          {/* Em dash then the intake. Two firms can be open at once for
              different cycles, and without this the row cannot say which. */}
          <span className="font-normal text-warmgray-500"> — {w.cycleLabel}</span>
        </span>
        {/* The industry group and where the job actually is, not the role
            title. These boards title roles "2027 Strategic Advisory: Real
            Estate Strategic Advisory Summer Associate Program - New York",
            which truncates to noise here; the full title is on the posting
            this row opens.

            Location earns its place because the same programme is often
            posted per city, so it is frequently the ONLY thing separating two
            otherwise identical rows - and it is the detail that decides
            whether a student applies at all. */}
        <span className="block truncate text-xs text-warmgray-500">
          {w.industryGroup}
          {w.location ? ` · ${w.location}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-right">
        {/* Says which kind of date this is, not just how far away it is -
            "opens in 40 days" and "due in 40 days" ask for completely
            different behaviour this week. */}
        {/* There is no "Est. opens" branch any more. It rendered a date
            derived from when the Internet Archive last happened to capture a
            firm's board, on a row otherwise identical to one carrying a date
            the firm announced - and it was the only thing putting seeded
            placeholder programmes on this list at all. Both the estimate and
            the placeholders are gone; see lib/upcoming-applications.ts. */}
        {days === null ? (
          // No countdown, because there is no date. Saying "TBD" plainly is
          // the whole point - an invented number here is the failure this
          // component exists to prevent. The second line is dropped too: it
          // would read "Date not announced" directly under "TBD", which says
          // the same thing twice and is what pushed this column off the edge
          // of a 375px screen.
          <span className="block text-xs font-medium text-warmgray-500">TBD</span>
        ) : (
          <>
            <span
              className={`block text-xs font-semibold ${urgent ? "text-error-600" : "text-brand-900"}`}
            >
              {w.kind === "opens" ? "Opens" : "Due"} in {days}d
            </span>
            {/* A real deadline is shown in the STUDENT's timezone, date and
                time together - see LocalDeadline, which does the conversion in
                the browser because the server cannot know where they are.
                Anything else (an opening date, a row with no stated time)
                keeps the firm's calendar date as-is. */}
            {w.kind === "due" ? (
              <LocalDeadline
                exactAt={w.exactAt ?? null}
                fallbackDate={w.timing.label}
                fallbackTime={w.deadlineTime ?? null}
              />
            ) : (
              <span className="block text-[11px] text-warmgray-500">{w.timing.label}</span>
            )}
          </>
        )}
      </span>
      {/* The row already opens the posting; the pill says so. Without it the
          list read as information, and nothing said a click would apply. Open
          roles only - an "Apply" on a role that is not accepting yet would
          send a student to a closed form. A span, not a second link: the
          whole row is the link, and a link inside a link is invalid. Same pill
          as the "Applied yet?" rows below it. */}
      {showApply && (
        <span className="shrink-0 rounded-full border border-brand-200 px-3 py-1 text-xs font-medium text-brand-900 group-hover:border-accent-400">
          Apply
        </span>
      )}
    </a>
  );
}

/**
 * How far ahead Upcoming looks. A role opening next September is not something
 * a student can act on this week, and a list of them buried what was close.
 */
const UPCOMING_HORIZON_DAYS = 30;

/** Opens within the horizon. No date means we cannot say it is close, so no. */
function withinHorizon(date: Date | null | undefined): boolean {
  return !!date && date.getTime() - Date.now() <= UPCOMING_HORIZON_DAYS * 86_400_000;
}

const UTC_DAY = { month: "short", day: "numeric", timeZone: "UTC" } as const;

/**
 * "Sep 13", or "Sep 13, 2027" when it is not this year. Expected dates are a
 * cycle ahead - Summer 2028 opens in September 2027 - so without the year a
 * date next September reads as one that passed a fortnight ago.
 */
function expectedDay(d: Date | null): string | undefined {
  if (!d) return undefined;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", sameYear ? UTC_DAY : { ...UTC_DAY, year: "numeric" });
}

/**
 * A role expected this cycle, carried from last cycle (lib/expected-postings).
 * The same row shape as a real one so the list reads as one, but it says
 * "Expected", counts nothing down, and opens the firm's careers page - there
 * is nothing to apply to yet.
 */
function ExpectedRow({ e }: { e: ExpectedPosting }) {
  const opens = expectedDay(e.expectedOpensAt);
  const due = expectedDay(e.expectedDueAt);
  return (
    <a
      // The firm's careers page, or its page here when it has no usable one -
      // and "usable" now includes the read-boundary check, so a crawled value
      // that is not a public web link falls back to the firm's page here
      // rather than becoming a live href. See lib/safe-url.
      href={externalHref(e.careersUrl) ?? `/discovery/firm/${e.firmSlug}`}
      target={externalHref(e.careersUrl) ? "_blank" : undefined}
      rel="noopener noreferrer"
      className="group flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50"
      title={`Based on the ${e.basedOnYear} cycle. Not open yet.`}
    >
      <FirmLogo domain={e.firmWebsite} name={e.firmName} size={24} />
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-brand-900">
          {e.firmName}
          <span className="font-normal text-warmgray-500"> — Summer {e.programYear}</span>
        </span>
        <span className="block truncate text-xs text-warmgray-500">
          <span className="mr-1 rounded-sm bg-[#eceff3] px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#475467]">
            Expected
          </span>
          {shortRoleTitle(e.roleTitle) || e.roleTitle}
          {e.location ? ` · ${e.location}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-xs font-semibold text-brand-900">
          {opens ? (e.basis === "first_seen" ? `Opens by ${opens}` : `Opens ${opens}`) : "Opening TBD"}
        </span>
        <span className="block text-[11px] text-warmgray-500">
          {due ? `Due ~${due}` : `from ${e.basedOnYear}`}
        </span>
      </span>
    </a>
  );
}

/**
 * One titled section with its own list.
 *
 * A section rather than a label on a shared list: "open now" and "opens later"
 * ask for completely different behaviour this week, and running them together
 * under one heading made the second half read as more of the first. `note`
 * carries the one line that explains what the section is for, which matters
 * most for Upcoming - a row there with no date is deliberate, not missing
 * data, and the caption is where that gets said.
 */
function Section({
  label,
  note,
  rows,
  emptyNote,
  showApply = false,
  expected = [],
}: {
  label: string;
  note: string;
  rows: UpcomingApplication[];
  emptyNote: string;
  showApply?: boolean;
  /** Expected roles, listed after the real ones (Upcoming only). */
  expected?: ExpectedPosting[];
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-900">
          {label}
          <span className="ml-1.5 font-sans tracking-normal text-warmgray-500">
            {rows.length + expected.length}
          </span>
        </p>
        <p className="truncate text-[11px] text-warmgray-500">{note}</p>
      </div>
      {rows.length === 0 && expected.length === 0 ? (
        <EmptyState size="sm">{emptyNote}</EmptyState>
      ) : (
        <div className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
          {rows.map((w) => (
            <Row key={w.id} w={w} showApply={showApply} />
          ))}
          {expected.map((e) => (
            <ExpectedRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function UpcomingApplications({
  windows,
  // "Top" is the rule, not a flourish: a row only reaches this list if the
  // firm is on the student's own shortlist AND the posting matches their
  // industry or their city. The heading has to say that, or a short list
  // reads as a broken one.
  heading = "Top applications",
  action,
  applied,
  expected = [],
}: {
  windows: ApplicationWindows;
  /** Roles at their firms expected this cycle (getExpectedUpcoming). */
  expected?: ExpectedPosting[];
  heading?: string;
  action?: React.ReactNode;
  /**
   * The "Applied yet?" section (dashboard/AppliedCheck), shown under Open
   * now: marking a role applied belongs beside the list of what is open.
   * Opportunities passes it; Schedule, which is about dates, does not.
   */
  applied?: React.ReactNode;
}) {
  const upcoming = windows.upcoming.filter((w) => withinHorizon(w.date));
  const expectedSoon = expected.filter((e) => withinHorizon(e.expectedOpensAt));
  const empty = windows.current.length === 0 && upcoming.length === 0 && expectedSoon.length === 0 && !applied;

  return (
    // min-w-0 so this survives being dropped into a grid or flex parent: the
    // default min-width:auto would let a long role title widen the whole
    // column instead of truncating inside it.
    <div className="min-w-0">
      <div className="mb-2 flex h-6 items-center justify-between">
        <h2 className="text-sm font-medium text-warmgray-500">{heading}</h2>
        {action}
      </div>

      {empty ? (
        // Deliberately a placeholder rather than a fallback to estimated dates.
        // See lib/upcoming-applications.ts for why a guessed countdown is worse
        // than none.
        <EmptyState>
          Nothing yet. This list only shows roles at your top firms that are in your
          industry - add firms in Discovery and they appear here as they open.
        </EmptyState>
      ) : (
        // Open now first, always. What a student can act on today is the whole
        // point of the section; what opens later is context, and it sits in its
        // own section below so the two are never read as one list.
        <div className="space-y-5">
          <Section
            label="Open now"
            // The coverage groups this is filtered to used to be listed here;
            // with several picked, the line ran off the panel and was cut off.
            note="Your firms, accepting now"
            rows={windows.current}
            emptyNote="None of your top firms are open in your industry right now."
            showApply
          />
          {applied}
          <Section
            label="Upcoming"
            note="Your firms, opening within a month"
            rows={upcoming}
            expected={expectedSoon}
            emptyNote="None of your top firms open in the next month."
          />
        </div>
      )}
    </div>
  );
}
