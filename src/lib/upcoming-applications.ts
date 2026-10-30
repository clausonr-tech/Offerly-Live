import "server-only";
import { cache } from "react";
import { localDateString } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { getExpectedPostings, getRelevantPostings } from "@/lib/internship-postings";
import { postingTiming, type PostingTiming } from "@/lib/posting-timing";
import { getTrackedKeys } from "@/lib/discovery-matches";
import { getDb } from "@/db/client";
import { userTopFirms } from "@/db/schema";
import { stillAhead, type ExpectedPosting } from "@/lib/expected-postings";
import { eq } from "drizzle-orm";
import { internshipYearFor } from "@/lib/internship-year";
import { industryGroupOf, interestGroups, namesCoverageGroup } from "@/lib/coverage-match";
import { locationFromTitle, matchesLocation } from "@/lib/posting-location";
import { loadSignalsForFirms, pickBest } from "@/lib/opening-signals";
import { degreeMismatch, normalizeDegreeLevel } from "@/lib/degree-fit";
import { parseTalentLinkDeadlineParts } from "@/lib/monitoring/connectors/talentlink";
import { resolveDeadlineInstant } from "@/lib/deadline-time";
import type { FirmProgramCategory } from "@/lib/firm-metadata";

// "When does the next application open, and when is it due" - for the postings
// the student is actually tracking.
//
// Real postings, real dates, or nothing.
//
// This panel twice grew a way to show something when there was nothing to
// show, and both were removed for the same reason. The first was the
// estimated-window reminder, generated from a firm's typical cycle rather than
// from anything the firm published. The second was subtler: the seeded
// skeleton rows, let in through an `includeUnopened` flag and dated from the
// last time the Internet Archive happened to capture that firm's board, then
// labelled "Est. opens" - which put a Morgan Stanley programme nobody has
// posted on the home page with a date on it.
//
// A label is not enough. A student scanning this list reads a firm, a cycle
// and a date; "est." is four characters against the whole visual weight of a
// row that looks exactly like the real ones beside it. An empty section says
// "nothing confirmed yet", which is true, and is the better failure.

export type UpcomingApplication = {
  id: string;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
  roleTitle: string;
  /**
   * Short industry group - "Healthcare", "Industrials". Shown instead of the
   * role title, which on these boards runs to things like "2027 Strategic
   * Advisory: Real Estate Strategic Advisory Summer Associate Program - New
   * York" and truncates to noise at this width.
   */
  industryGroup: string;
  /** Which intake this is, e.g. "Summer 2028". Shown beside the firm name so a
   *  row says which cycle it belongs to without being opened. */
  cycleLabel: string;
  location: string | null;
  applyUrl: string;
  timing: PostingTiming;
  /**
   * The date this row is sorted and counted down by, or null when nobody has
   * published one. Null is a first-class case, not a gap to paper over: most
   * tracked roles have no announced date at any given moment, and the section
   * is more useful listing them without a countdown than hiding them.
   */
  date: Date | null;
  /** Whether `date` is when it opens or when it closes - "undated" when the
   *  row is here because the student tracks it, not because a date exists. */
  kind: "opens" | "due" | "undated";
  /**
   * Where the date came from. "posting" is published on the posting itself;
   * "signal" came through opening_signals, which carries the sentence it was
   * read out of; "tracked" means no date exists and the row is shown purely
   * because the student is following it.
   *
   * There is deliberately no "estimate". Every value here traces back to
   * something a firm published or something we watched happen.
   */
  provenance: "posting" | "signal" | "tracked";
  /** Open now and reviewed as applications arrive - no close date to count
   *  down to, and the reason to apply early. */
  rolling?: boolean;
  /** The evidence behind a signal-sourced date, for display and for review. */
  evidence?: string | null;
  /**
   * The firm's own words for the cut-off time - "11:55 PM EST" - or null when
   * they stated only a day.
   *
   * Shown under the date rather than merged into it, because it answers a
   * different question. The date decides which week a student plans around;
   * the time decides whether "I will do it on the 15th" is a plan or a
   * mistake, and 11:55 PM Eastern is a very different instruction to someone
   * in California than it looks.
   *
   * Kept as the stated text, never converted to the reader's timezone - see
   * parseTalentLinkDeadlineParts for why re-deriving it would only be a fresh
   * chance to be a day wrong.
   */
  deadlineTime?: string | null;
  /**
   * The deadline as a real instant, ISO-encoded, when the firm's stated zone
   * could be resolved - see lib/deadline-time.ts. Null when it could not, and
   * the row then falls back to the calendar date plus `deadlineTime` verbatim.
   *
   * A string rather than a Date because it crosses into a client component,
   * and it is the client - the only party that knows where the student is -
   * that turns it into a local date and time.
   */
  exactAt?: string | null;
};

/**
 * Applications split by whether they can be acted on right now.
 *
 * Two lists rather than one sorted list, because "open, closes in 60 days" and
 * "opens in 60 days" are the same number and completely different
 * instructions. Current is what a student can do this week; upcoming is what
 * they should not be worrying about yet.
 */
export type ApplicationWindows = {
  current: UpcomingApplication[];
  upcoming: UpcomingApplication[];
  /**
   * The coverage groups these lists were narrowed to, empty when they were
   * not. Surfaced so the UI can say WHY a list is short - a filtered list and
   * a thin one look identical otherwise, and a student who cannot tell which
   * they are looking at has no reason to trust either.
   */
  coverage: string[];
};

type WindowUser = Awaited<ReturnType<typeof import("@/lib/current-user").getCurrentUser>>;

/** An announced opening window wider than this is too vague to count down to. */
export const VAGUE_WINDOW_DAYS = 14;

export const getUpcomingApplications = cache(
  async (
    user: WindowUser,
    limit = 8,
    /** Rows per firm per section. The panel rations; the outreach prompt,
     *  which needs every firm's soonest opening, does not. */
    perFirm = 2,
    /** Merge rows of one firm, group, cycle and city into one - right for a
     *  summary panel, wrong for reminders, where two roles are two
     *  applications. */
    collapseSameGroup = true,
  ): Promise<ApplicationWindows> => {
    // The firms the student actually picked, for the third admission check -
    // read first, so their postings can be fetched on their own below.
    const db = await getDb();
    const topFirmIds = new Set(
      (
        await db
          .select({ firmId: userTopFirms.firmId })
          .from(userTopFirms)
          .where(eq(userTopFirms.userId, user.id))
      ).map((r) => r.firmId),
    );

    const cycle = {
      gradYear: user.gradYear,
      // The CYCLE is the one hard gate. A posting from a closed cycle is not
      // a weaker match, it is unusable, so it never reaches the admission
      // rules below.
      internshipYear: internshipYearFor(user),
      // Sector is deliberately NOT filtered in SQL any more. It is one of
      // three things that can admit a posting, and a hard filter here would
      // silently veto the other two - a role at a firm on the student's own
      // list would be dropped before the "is it one of their firms?" check
      // ever ran.
      preferredCategories: null,
    };
    const [everyone, theirs, tracked] = await Promise.all([
      // Everything for the student's own cycle. The onboarding answers are
      // applied by `admit` below rather than here, because they are an OR and
      // SQL filtering on one of them would veto the others.
      getRelevantPostings(cycle),
      // ...and every posting at their own firms, fetched on its own: the list
      // above is capped and ordered by firm name, so a late-alphabet firm on
      // the student's list could fall off the end of it in a big cycle.
      topFirmIds.size > 0 ? getRelevantPostings({ ...cycle, firmIds: [...topFirmIds] }) : Promise.resolve([]),
      getTrackedKeys(user.id),
    ]);
    const postings = [...new Map([...everyone, ...theirs].map((p) => [p.id, p])).values()];

    /**
     * The section is driven by the ONBOARDING ANSWERS, not by what happens to
     * have been auto-tracked already.
     *
     * It used to gate on the tracked set: `postings.filter(p => tracked.has(p))`.
     * That made the student's answers almost inert, because auto-tracking runs
     * once at match time and never again - so changing your sector in the
     * profile removed rows from the old sector and added nothing from the new
     * one, and the section only ever shrank. The answers have to select the
     * list, not merely prune a snapshot taken under the previous answers.
     *
     * `postings` is already filtered by cycle and sector in the query above, so
     * this is that list. Tracking now only affects ORDER - a role the student
     * has explicitly taken on sorts above one merely relevant to them.
     */
    const isTracked = (p: { firmName: string; roleTitle: string }) =>
      tracked.has(`${p.firmName}|${p.roleTitle}`);
    const trackedRows = [...postings].sort(
      (a, b) => Number(isTracked(b)) - Number(isTracked(a)),
    );

    /**
     * Admission: TOP FIRM *and* THEIR INDUSTRY GROUP. Both, every time.
     *
     * This section is a shortlist, not a search. The firm gate says the
     * student put this firm on their own list; the group gate says this
     * particular posting is the thing they said they want to do. A role that
     * clears only the first is Evercore Real Estate shown to a healthcare
     * student because the firm is familiar - which is how one firm's posting
     * day filled the entire panel with eight rows, seven of them in groups the
     * student never asked about.
     *
     * LOCATION IS NOT A WAY IN. It used to be OR-ed alongside the group, and
     * that single `||` was the whole defect: every one of those seven rows was
     * in New York, so the city clause re-admitted everything the group clause
     * had just excluded. Location still matters - it decides which roles
     * survive the per-firm cap below - but "it is in your city" is not by
     * itself a reason to put a job in front of someone. Discovery is where the
     * full list for their cycle lives; this panel is the short one.
     *
     * One deliberate exception: a posting that names NO coverage group is the
     * generalist programme, where coverage is assigned after the offer. Nearly
     * every bulge bracket runs exactly one of these, so excluding them would
     * hide the roles a healthcare student has to apply to in order to end up
     * in healthcare. See namesCoverageGroup.
     *
     * This exception was briefly removed, because "names no coverage group"
     * was letting in BDO's Tax and Assurance internships - real internships,
     * genuinely generalist-looking, and not remotely what a banking student
     * wants. That was never this rule's fault: those postings should not have
     * been classified as investment banking at all, and they no longer are
     * (see OFF_PROFESSION_RULES in monitoring/classify.ts). Fixing it at the
     * classifier lets the exception stand on its own merits here.
     *
     * Worth revisiting: this still infers "generalist" from the ABSENCE of a
     * group rather than from a posting saying so. The moment a firm titles
     * something in a house style our patterns miss, it reads as generalist and
     * gets in. A real generalist flag on the posting would end the guessing.
     */
    const sectors = new Set(user.preferredCategories ?? []);
    const groups = interestGroups(user.nicheInterests);
    const inTheirSector = (p: (typeof trackedRows)[number]) =>
      (p.categories ?? []).some((c) => sectors.has(c));

    const admit = (p: (typeof trackedRows)[number]) => {
      if (!topFirmIds.has(p.firmId)) return false;
      /**
       * A programme this student's degree cannot apply to is not theirs.
       *
       * Checked first, and separately from the coverage logic below, because
       * it is not a preference - it is eligibility. A Summer Analyst seat is
       * undergraduates in their penultimate year (Lazard, BlackRock and
       * Jefferies all say so outright); the MBA equivalent is the Summer
       * Associate seat, which BlackRock opens to MBAs and advanced master's
       * and nobody else. Showing a student the other one is worse than showing
       * them nothing: it is a real opening, indistinguishable on the page from
       * one they can take, and they find out only after applying.
       *
       * Reads the title and description already on the row rather than a
       * column, because degree fit is a property of the PAIR - the classifier
       * that writes these rows runs once per posting with no student in
       * context and cannot decide it.
       *
       * A student who has not answered the question is not filtered at all.
       * See degreeMismatch for why silence never means exclusion.
       */
      const mismatch = degreeMismatch(
        normalizeDegreeLevel(user.degreeLevel),
        p.roleTitle,
        p.descriptionFull,
      );
      if (mismatch) return false;
      // No skeleton check needed any more: getRelevantPostings cannot return
      // one. This function used to carry the exception that let them in - a
      // placeholder admitted on the strength of an Internet Archive sighting,
      // shown as "Est. opens". Both are gone; see isRealPosting.
      /**
       * It has to link to its own application page.
       *
       * `applicationUrl` is null on the firm-level placeholder rows that
       * predate the crawler - a row per firm, no location, deadline TBD, and a
       * title generic enough ("Investment Banking Summer Analyst") that the
       * generalist exception below waves it straight through. The row then
       * renders with `applicationUrl || sourceUrl`, so what a student actually
       * clicked was the firm's front door: Evercore's row opened their FAQ
       * page, Goldman's opened goldmansachs.com/careers.
       *
       * That is worse than not showing the row. A student who opens it has to
       * go and find the posting themselves, having been told we already found
       * it - which is the opposite of what this panel is for. A real
       * requisition always carries its own URL, so this costs nothing real and
       * removes every placeholder.
       */
      if (!p.applicationUrl) return false;
      // No coverage answer to narrow by - the broad sector is all we have.
      if (groups.length === 0) return inTheirSector(p);
      if (groups.includes(industryGroupOf(p))) return true;
      return !namesCoverageGroup(p) && inTheirSector(p);
    };

    const mine = trackedRows.filter(admit);
    const narrowedToCoverage = mine.length < trackedRows.length;

    // Opening signals for every firm in the pipeline, in one query. This is
    // the bridge that was missing: the crawler has been writing real dates into
    // opening_signals while this list only ever read internshipPostings, where
    // every date column is still null - so the section rendered empty even
    // though the dates existed.
    const signals = await loadSignalsForFirms(mine.map((p) => p.firmId));

    const now = new Date();
    // Openings and deadlines are calendar DATES stored at midnight UTC, so
    // they are compared as days on the student's clock, not as instants: as
    // instants, a 6 October opening was "past" from 8pm on the 5th in New York.
    const today = localDateString(now, await getStudentTimeZone());
    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const current: UpcomingApplication[] = [];
    const upcoming: UpcomingApplication[] = [];

    for (const p of mine) {
      const timing = postingTiming(p, now);
      if (timing.state === "closed") continue;

      // Unreachable - admit() already required it. Present so the compiler can
      // narrow `string | null` to `string` for the row below, which is worth
      // more than a cast: if the admission rule ever loses that check, this
      // drops the row instead of reviving the wrong-link fallback silently.
      const applyUrl = p.applicationUrl;
      if (!applyUrl) continue;

      // The firm's stated cut-off, read back out of the sentence the deadline
      // was parsed from (it is kept verbatim in descriptionFull), and resolved
      // to an instant where the zone is one we can pin down confidently.
      const statedTime = parseTalentLinkDeadlineParts(p.descriptionFull).timeText;

      const base = {
        id: p.id,
        firmName: p.firmName,
        firmSlug: p.firmSlug,
        firmWebsite: p.firmWebsite,
        roleTitle: p.roleTitle,
        industryGroup: industryGroupOf(p),
        cycleLabel: `Summer ${p.programYear}`,
        // Falls back to the city named in the title when the board publishes
        // no location field - see lib/posting-location.ts.
        location: p.location ?? locationFromTitle(p.roleTitle),
        applyUrl,
        // Read back out of the stored source text rather than from a column of
        // its own. The sentence the deadline was parsed from is already kept
        // verbatim in descriptionFull ("... Application Deadline:15 Nov 2026
        // 11:55 PM EST"), so the time has been sitting in the database all
        // along - it was only ever discarded on the way in, at the parser.
        deadlineTime: statedTime,
        timing,
      };

      // A date published on the posting itself is still the first choice
      // (postingPlacement). "Open now" rows are the ones the list offers an
      // Apply button on, so this is also the rule for that.
      const placed = postingPlacement(
        { opensAt: p.opensAt, deadlineDate: p.deadlineDate, deadlineStatus: p.deadlineStatus, timingState: timing.state },
        today,
      );
      if (placed) {
        const row: UpcomingApplication = {
          ...base,
          date: placed.date,
          kind: placed.kind,
          provenance: "posting",
          ...(placed.rolling ? { rolling: true } : {}),
          ...(placed.kind === "due" && placed.date
            ? { exactAt: resolveDeadlineInstant(placed.date, statedTime)?.toISOString() ?? null }
            : {}),
        };
        (placed.section === "current" ? current : upcoming).push(row);
        continue;
      }

      // Otherwise ask the signals. Matched on the posting's own programme year
      // and first industry - a cross-listed role picks one, the same way the
      // pipeline's single category column does.
      /**
       * Anything the student tracks that has no usable date still belongs on
       * screen - in Upcoming, without a countdown.
       *
       * This used to `continue`, which meant a role was shown only if someone
       * had published a date for it. In practice almost nothing clears that
       * bar: every signal the crawler writes is `seen_live`, which records
       * when we OBSERVED a posting open and leaves `opensStart` null, so the
       * "opens in future" test could never be true and Upcoming rendered empty
       * permanently. A student tracking eight firms saw an empty section and
       * reasonably concluded the product was broken.
       */
      /**
       * No published date - say so, and leave the row dateless.
       *
       * This file briefly filled the gap with last cycle's observed opening,
       * carried an "est." label and the archived evidence on hover, and it was
       * still wrong. The estimate is a LATE bound read off whenever the
       * Internet Archive happened to capture a board (see
       * monitoring/observed-openings.ts), and every row it produced sat in the
       * same list, at the same size, sorted by the same date key as rows a
       * firm actually announced. "Date not announced" is less satisfying and
       * it is the only thing here that is true.
       */
      const undated = () => {
        upcoming.push({
          ...base,
          timing: { label: "Date not announced", detail: null, state: "upcoming" },
          date: null,
          kind: "undated",
          provenance: "tracked",
        });
      };

      const cycleSignals = signals.get(`${p.firmId}:${p.programYear}`) ?? [];
      const { best } = pickBest(cycleSignals, (p.categories?.[0] as FirmProgramCategory) ?? null);
      // Our own prediction is a window derived from past cycles, not a date
      // anyone published or anything we saw: it may schedule the crawler, but
      // it never becomes a countdown. With nothing stronger, the row is undated
      // - the promise this type makes ("deliberately no estimate") holds.
      if (!best || best.source === "prediction") {
        undated();
        continue;
      }

      const closes = best.closesStart ?? null;
      const opensFrom = best.opensStart ?? null;

      /**
       * The label has to come from the same place the date does.
       *
       * `timing` is derived from the POSTING, whose date columns are null for
       * everything the signals pipeline knows about - so it reads "Not open
       * yet". Pairing that with a signal-derived "Due in 64d" put a countdown
       * and a flat contradiction of it on the same row, which is the exact
       * failure this component was built to end. A signal-sourced row states
       * the date it is counting down to instead.
       */
      const signalTiming = (date: Date, state: PostingTiming["state"]): PostingTiming => ({
        // timeZone: "UTC" is load-bearing, for the reason spelled out at
        // formatDay() in lib/posting-timing.ts - which found and fixed this
        // exact bug, in that file, before this function existed.
        //
        // Deadlines are CALENDAR DATES stored at midnight UTC. Formatting one
        // without a zone uses the server's, and every zone west of UTC renders
        // the previous day: Evercore's 15 Nov 2026 deadline was being shown as
        // "Nov 14, 2026". The countdown beside it said 62d and was right, which
        // is what made it hard to spot - the two disagreed by a day and only
        // the label was wrong.
        //
        // Any new date formatter in this file needs the same line. There are
        // now three of them.
        label: date.toLocaleDateString("en-US", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }),
        detail: null,
        state,
      });

      // Open now: something observed it live (opensEnd is set to when it was
      // seen) and it has not closed. The closing date is what a student needs
      // in that state - "you can apply, here is how long you have".
      // A live sighting's opensEnd is when we saw it open - an instant. Anyone
      // else's is the last day of an announced window - a calendar date, so it
      // counts as open once that day is over; ON the day it is the opening
      // day, which the "opens today" branch below is for.
      const seenOpen =
        best.opensEnd !== null &&
        (best.source === "seen_live" ? best.opensEnd <= now : dayOf(best.opensEnd) < today);
      if (seenOpen && closes && dayOf(closes) >= today) {
        current.push({
          ...base,
          timing: signalTiming(closes, "open"),
          date: closes,
          kind: "due",
          provenance: "signal",
          evidence: best.evidence,
          exactAt: resolveDeadlineInstant(closes, statedTime)?.toISOString() ?? null,
        });
        continue;
      }

      // Not open yet, with a claimed opening window still ahead of it - and a
      // narrow one. "Opens in October" is stored as 1-31 October; counting
      // down to the 1st would be a date nobody claimed, and every prompt would
      // vanish on the 1st though it may open any day that month. A window of
      // two weeks or less is precise enough to plan around; wider is undated.
      const vague =
        !!best.opensStart &&
        !!best.opensEnd &&
        best.opensEnd.getTime() - best.opensStart.getTime() > VAGUE_WINDOW_DAYS * 86_400_000;
      if (opensFrom && dayOf(opensFrom) > today && !vague) {
        upcoming.push({
          ...base,
          timing: signalTiming(opensFrom, "upcoming"),
          date: opensFrom,
          kind: "opens",
          provenance: "signal",
          evidence: best.evidence,
        });
        continue;
      }
      if (opensFrom && dayOf(opensFrom) === today && !vague) {
        current.push({
          ...base,
          timing: signalTiming(opensFrom, "open"),
          date: opensFrom,
          kind: "opens",
          provenance: "signal",
          evidence: best.evidence,
        });
        continue;
      }

      // A signal exists but says nothing about timing - same position as
      // having no signal at all.
      undated();
    }

    /**
     * At most this many rows from any one firm, per section.
     *
     * A panel of eight is a summary of the week, and a firm that posts its
     * whole programme in one go should not be able to take all eight of those
     * slots - not because those rows are wrong, but because a list showing one
     * firm has stopped being a list. The firm's remaining roles are on its own
     * page and in Discovery, neither of which is rationed.
     */
    const PER_FIRM_MAX = perFirm;

    /**
     * Collapse duplicates, then ration by firm.
     *
     * Duplicates are real, not hypothetical: Evercore posts the same capital
     * markets programme under two requisition ids, and both arrived here as
     * "Capital Markets · New York, due in 62d" - two rows a student cannot
     * tell apart and has no way to act on differently.
     *
     * The cap keeps the roles in the cities the student named, then the
     * soonest. This is the one place location is allowed to decide anything,
     * and it is the right place for it: everything being compared has already
     * earned its spot on group, so location is breaking a tie between roles
     * the student wants rather than admitting one they did not ask for.
     */
    const inTheirCities = (w: UpcomingApplication) =>
      matchesLocation(w.location, user.targetLocations);

    const rationed = (rows: UpcomingApplication[]) => {
      const seen = new Set<string>();
      const byFirm = new Map<string, UpcomingApplication[]>();
      // Soonest first, so when the same programme is posted twice with two
      // dates, the one that survives is the one to act on first.
      const bySoonest = [...rows].sort(
        (a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity),
      );
      for (const w of bySoonest) {
        const key = `${w.firmSlug}|${w.industryGroup}|${w.cycleLabel}|${w.location ?? ""}`;
        if (collapseSameGroup) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        byFirm.set(w.firmSlug, [...(byFirm.get(w.firmSlug) ?? []), w]);
      }
      return [...byFirm.values()].flatMap((list) =>
        list
          .sort((a, b) => {
            const city = Number(inTheirCities(b)) - Number(inTheirCities(a));
            if (city !== 0) return city;
            if (a.date && b.date) return a.date.getTime() - b.date.getTime();
            if (a.date) return -1;
            if (b.date) return 1;
            return 0;
          })
          .slice(0, PER_FIRM_MAX),
      );
    };

    /**
     * Dated rows first, soonest at the top; undated ones after, alphabetically,
     * so the ordering never implies an urgency the data does not support.
     *
     * Every date being sorted here was published by a firm or observed
     * first-hand, so "soonest first" means what it looks like it means.
     */
    const soonest = (rows: UpcomingApplication[]) =>
      rationed(rows)
        .sort((a, b) => {
          if (a.date && b.date) return a.date.getTime() - b.date.getTime();
          if (a.date) return -1;
          if (b.date) return 1;
          return a.firmName.localeCompare(b.firmName);
        })
        .slice(0, limit);

    return {
      current: soonest(current),
      upcoming: soonest(upcoming),
      coverage: narrowedToCoverage ? (user.nicheInterests ?? []) : [],
    };
  },
);

/**
 * Roles at the student's own firms expected to open this cycle, soonest
 * first, one per firm: the Upcoming list's "Expected" rows.
 *
 * Its own function, not rows inside getUpcomingApplications, on purpose: the
 * reminders and the outreach prompts read that one, and an expected role must
 * never set off an "apply" reminder or count as open (lib/expected-postings).
 * Their sectors only, as the panel's own admission does for real roles.
 */
export const getExpectedUpcoming = cache(async (user: WindowUser, limit = 6): Promise<ExpectedPosting[]> => {
  const db = await getDb();
  const firmIds = (
    await db.select({ firmId: userTopFirms.firmId }).from(userTopFirms).where(eq(userTopFirms.userId, user.id))
  ).map((r) => r.firmId);
  if (firmIds.length === 0) return [];
  const expected = await getExpectedPostings({
    gradYear: user.gradYear,
    internshipYear: internshipYearFor(user),
    preferredCategories: user.preferredCategories ?? null,
    firmIds,
  });
  // Only what can still open. A date carried from last cycle that has already
  // passed is a guess that missed, not a role "not open yet" - and it is
  // dropped before the one-per-firm pick, so a firm's later role still shows.
  const today = localDateString(new Date(), await getStudentTimeZone());
  const seen = new Set<string>();
  const out: ExpectedPosting[] = [];
  for (const e of expected) {
    if (!stillAhead(e, today)) continue;
    if (seen.has(e.firmId)) continue;
    seen.add(e.firmId);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
});

/**
 * Where a posting goes on its own published dates, or null when it has none
 * that settle it (the signals decide then).
 *
 *   opens after today            Upcoming, counting down to the opening
 *   opens today                  Open now - the one day an "apply" prompt is for
 *   rolling and open             Open now, nothing to count down to
 *   confirmed deadline, not past Open now, counting down to the deadline
 *
 * `today` is a YYYY-MM-DD day; dates are compared by their UTC calendar day,
 * as they are stored.
 */
export function postingPlacement(
  p: {
    opensAt: Date | string | null;
    deadlineDate: Date | string | null;
    deadlineStatus: string | null;
    timingState: PostingTiming["state"];
  },
  today: string,
): { section: "current" | "upcoming"; date: Date | null; kind: "opens" | "due" | "undated"; rolling?: true } | null {
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  const opensAt = p.opensAt ? new Date(p.opensAt) : null;
  const deadlineDate = p.deadlineDate ? new Date(p.deadlineDate) : null;
  if (opensAt && dayOf(opensAt) > today) return { section: "upcoming", date: opensAt, kind: "opens" };
  if (opensAt && dayOf(opensAt) === today) return { section: "current", date: opensAt, kind: "opens" };
  if (p.deadlineStatus === "rolling" && p.timingState === "open") {
    return { section: "current", date: null, kind: "undated", rolling: true };
  }
  if (p.deadlineStatus === "confirmed" && deadlineDate && dayOf(deadlineDate) >= today) {
    return { section: "current", date: deadlineDate, kind: "due" };
  }
  return null;
}

/** Whole days from now, floored at zero. */
export function daysUntil(date: Date, now: Date = new Date()) {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}
