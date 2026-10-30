// Expected internships: roles from past recruiting cycles, carried forward into
// the cycles that have not opened yet.
//
// Most internships repeat every year - the same firm, the same programme, the
// same city - but a cycle only shows up on the boards when it opens. Until the
// crawler finds this year's posting, a student looking at Summer 2028 would
// otherwise see nothing at a firm that runs the same analyst class every
// summer. So each role is projected forward from the newest past cycle it was
// seen in, with its description, and with the dates it opened and closed that
// year moved to this one.
//
// An expected role is never an open one. It carries no apply link (it points
// at the firm's careers page), it is never tracked, reminded about or counted
// as open, and every place it appears says "Expected to open ..., based on
// 2026". It stops being projected the moment a real posting for that role and
// year exists in the system, open or not.
//
// Dates, strongest first:
//   1. a release date from the uploaded history (lib/historical-releases.json,
//      written by scripts/import-historical-releases.ts)
//   2. the date the source posting itself said it opened / was due
//   3. the day the crawler first saw the source posting
// each moved forward by the number of years between the two cycles.
//
// Pure: no database. lib/internship-postings.ts (getExpectedPostings) feeds it.

import { roleParts } from "./role-name";

/** How far ahead roles are carried: this cycle's next three. */
export const EXPECTED_YEARS_AHEAD = 3;

export type PastPosting = {
  id: string;
  firmId: string;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
  roleTitle: string;
  location: string | null;
  categories: string[];
  programYear: number;
  eligibleGradYears: number[];
  deadlineStatus: string;
  deadlineDate: Date | null;
  opensAt: Date | null;
  /** When it was first seen: the crawler's first detection, or the row's
   *  creation when there is none - whichever is earlier. */
  firstSeenAt: Date;
  descriptionFull: string;
  requirementsFull: string | null;
  /** The firm's careers page for this role's industry, when known. */
  careersUrl: string | null;
};

/** One row of the uploaded history: when a role was released in a past cycle. */
export type HistoricalRelease = {
  firmName: string;
  roleTitle: string;
  location: string | null;
  programYear: number;
  /** YYYY-MM-DD. */
  releasedOn: string;
  /** YYYY-MM-DD, when the history has it. */
  dueOn?: string | null;
};

type ExpectedBasis = "history" | "posted_dates" | "first_seen";

export type ExpectedPosting = {
  /** Stable per source role and target year. Never a posting id. */
  id: string;
  sourcePostingId: string;
  firmId: string;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
  /** The source title with its years moved to the target cycle. */
  roleTitle: string;
  location: string | null;
  categories: string[];
  programYear: number;
  eligibleGradYears: number[];
  descriptionFull: string;
  requirementsFull: string | null;
  /** When it is expected to open, or null when nothing says. */
  expectedOpensAt: Date | null;
  /** When it is expected to be due, or null when nothing says. */
  expectedDueAt: Date | null;
  /** The cycle the dates and text were carried from. */
  basedOnYear: number;
  basis: ExpectedBasis;
  /** Where the link goes: the firm's careers page, never last year's posting. */
  careersUrl: string;
};

function lower(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A firm's name as a key: "Moelis & Company" and "moelis and company" agree. */
export function firmNameKey(name: string): string {
  return lower(name.replace(/&/g, " and "))
    .replace(/\b(inc|llc|llp|lp|ltd|plc|co|corp|corporation|company|group|holdings|the|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The same role in any cycle: the title's words without its years, plus the
 * city. "2027 Summer Analyst - M&A (New York)" and "2028 Summer Analyst -
 * M&A (New York)" share a key; the London one does not.
 */
export function roleCycleKey(roleTitle: string, location: string | null): string {
  const parts = roleParts(roleTitle);
  const city = lower(location).split(" ").filter(Boolean).sort().join(" ");
  return `${parts.words}|${parts.cities}|${city}`;
}

/** Every year in a title moved by `delta`: "2027 Analyst, Class of 2028" + 1. */
export function shiftTitleYears(title: string, delta: number): string {
  if (delta === 0) return title;
  return title
    .replace(/\b(20[2-4]\d)\b/g, (y) => String(Number(y) + delta))
    // "'27" / "’27" as a class year.
    .replace(/(['’])([2-4]\d)\b/g, (_, q: string, yy: string) => `${q}${String((Number(yy) + delta) % 100).padStart(2, "0")}`);
}

/**
 * Whether a past title is a role worth carrying forward.
 *
 * Stricter than isNamedRoleTitle (any word passes that), because an expected
 * role goes in front of a student with a date on it. It has to name an
 * internship-shaped role, and not be one of the careers-site placeholders the
 * boards list beside real roles: "Join our Talent Community!", "... Apply
 * Now", a general application.
 */
export function isCarryableTitle(title: string): boolean {
  const t = title.toLowerCase();
  if (/talent (community|network|pool)|join our|apply now|general (application|interest)|expression of interest|resume drop|submit your (resume|cv)|stay connected|future opportunities/.test(t)) {
    return false;
  }
  return /\b(intern|interns|internship|internships|summer|analyst|analysts|associate|associates|co-?op|fellow|fellowship|programme|program|placement|off-cycle|insight)\b/.test(t);
}

/**
 * Where an expected role links: the firm's careers page when it is a real web
 * address, else the firm's own site. Firm data is typed in by hand and by
 * crawlers, and anything that is not http(s) - a bare path, a mailto, a
 * javascript: URL - is never put in an href.
 */
export function careersLink(careersUrl: string | null | undefined, firmWebsite: string | null | undefined): string {
  const url = careersUrl?.trim() ?? "";
  if (/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(url)) return url;
  const site = (firmWebsite ?? "").trim().replace(/^https?:\/\//i, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(site) ? `https://${site}` : "";
}

/** A calendar date moved by whole years, landing on the same month and day (Feb 29 → Feb 28). */
export function shiftYears(d: Date, years: number): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), 1, d.getUTCHours(), d.getUTCMinutes()));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return out;
}

function parseDay(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The expected roles for one cycle.
 *
 * `past` is every earlier-cycle posting that could be carried; `existing` is
 * every posting already in the system for `targetYear` (open or closed) - a
 * role with one is not projected, because its real dates beat any guess.
 */
export function projectExpected(input: {
  past: readonly PastPosting[];
  existing: readonly { firmId: string; roleTitle: string; location: string | null }[];
  targetYear: number;
  history?: readonly HistoricalRelease[];
}): ExpectedPosting[] {
  const { targetYear } = input;
  // Already posted for this cycle - passed in, or among the rows handed over
  // as past - so its real dates win.
  const taken = new Set(
    [...input.existing, ...input.past.filter((p) => p.programYear === targetYear)].map(
      (e) => `${e.firmId}#${roleCycleKey(e.roleTitle, e.location)}`,
    ),
  );

  // The newest past cycle each role was seen in is the one carried forward:
  // last year's description and dates, not the year before's.
  const newest = new Map<string, PastPosting>();
  for (const p of input.past) {
    if (p.programYear >= targetYear) continue;
    const key = `${p.firmId}#${roleCycleKey(p.roleTitle, p.location)}`;
    if (taken.has(key)) continue;
    const held = newest.get(key);
    if (!held || p.programYear > held.programYear || (p.programYear === held.programYear && p.firstSeenAt < held.firstSeenAt)) {
      newest.set(key, p);
    }
  }

  // The uploaded history, newest cycle per role.
  const historyByKey = new Map<string, HistoricalRelease>();
  for (const h of input.history ?? []) {
    if (!parseDay(h.releasedOn) || h.programYear >= targetYear) continue;
    const key = `${firmNameKey(h.firmName)}#${roleCycleKey(h.roleTitle, h.location)}`;
    const held = historyByKey.get(key);
    if (!held || h.programYear > held.programYear) historyByKey.set(key, h);
  }

  const out: ExpectedPosting[] = [];
  for (const p of newest.values()) {
    const delta = targetYear - p.programYear;
    const hist = historyByKey.get(`${firmNameKey(p.firmName)}#${roleCycleKey(p.roleTitle, p.location)}`);

    let opens: Date | null = null;
    let due: Date | null = null;
    let basis: ExpectedBasis;
    let basedOnYear = p.programYear;
    if (hist) {
      const hDelta = targetYear - hist.programYear;
      opens = shiftYears(parseDay(hist.releasedOn)!, hDelta);
      const hDue = parseDay(hist.dueOn);
      due = hDue ? shiftYears(hDue, hDelta) : null;
      basis = "history";
      basedOnYear = hist.programYear;
    } else if (p.opensAt) {
      opens = shiftYears(p.opensAt, delta);
      basis = "posted_dates";
    } else {
      // It never said when it opened, so when it was first seen is the
      // opening - an upper bound, hence "around" on the label.
      opens = shiftYears(p.firstSeenAt, delta);
      basis = "first_seen";
    }
    if (!due && p.deadlineStatus === "confirmed" && p.deadlineDate && basis !== "history") {
      due = shiftYears(p.deadlineDate, delta);
    }
    // A due date before the opening is a source error, not a plan to repeat.
    if (opens && due && due.getTime() < opens.getTime()) due = null;

    out.push({
      id: `expected:${p.id}:${targetYear}`,
      sourcePostingId: p.id,
      firmId: p.firmId,
      firmName: p.firmName,
      firmSlug: p.firmSlug,
      firmWebsite: p.firmWebsite,
      roleTitle: shiftTitleYears(p.roleTitle, delta),
      location: p.location,
      categories: p.categories,
      programYear: targetYear,
      eligibleGradYears: p.eligibleGradYears.map((y) => y + delta),
      descriptionFull: p.descriptionFull,
      requirementsFull: p.requirementsFull,
      expectedOpensAt: opens,
      expectedDueAt: due,
      basedOnYear,
      basis,
      careersUrl: careersLink(p.careersUrl, p.firmWebsite),
    });
  }
  return out.sort(
    (a, b) =>
      (a.expectedOpensAt?.getTime() ?? Infinity) - (b.expectedOpensAt?.getTime() ?? Infinity) ||
      a.firmName.localeCompare(b.firmName) ||
      a.roleTitle.localeCompare(b.roleTitle),
  );
}

/**
 * Whether an expected role could still open: its expected opening is `today`
 * (a YYYY-MM-DD day, compared by UTC calendar day as the dates are stored) or
 * later, or nothing says when. A role whose carried-forward date has passed
 * without a real posting appearing is not "upcoming" - listing it under
 * "not open yet" with a date already behind us reads as broken.
 */
export function stillAhead(e: Pick<ExpectedPosting, "expectedOpensAt">, today: string): boolean {
  return !e.expectedOpensAt || e.expectedOpensAt.toISOString().slice(0, 10) >= today;
}

/** How far ahead an expected role may be shown: about a month. */
export const EXPECTED_SHOW_WITHIN_DAYS = 31;

/**
 * Whether an expected role is close enough to show: expected to open between
 * today and EXPECTED_SHOW_WITHIN_DAYS from now. Further out, or with no date,
 * it is left out (5 October 2026: "Expected to open by Sep 13, 2027" on a
 * sophomore's matches, a year away, while that cycle's real postings were
 * already arriving - a carried-forward date that far off misleads more than
 * it helps). A real posting replaces the role the moment it appears anyway.
 */
export function showableExpected(e: Pick<ExpectedPosting, "expectedOpensAt">, now: Date): boolean {
  if (!e.expectedOpensAt) return false;
  const today = now.toISOString().slice(0, 10);
  const limit = new Date(now.getTime() + EXPECTED_SHOW_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const day = e.expectedOpensAt.toISOString().slice(0, 10);
  return day >= today && day <= limit;
}

/** "Expected to open Aug 1, 2027 · based on 2026" - what every expected row says. */
export function expectedLabel(e: Pick<ExpectedPosting, "expectedOpensAt" | "basedOnYear" | "basis">): string {
  const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const when = e.expectedOpensAt
    ? // First seen is when the crawler found it open - the latest it can have
      // opened, not when it did - so it is promised as "by", never "on".
      `${e.basis === "first_seen" ? "Expected to open by" : "Expected to open"} ${day(e.expectedOpensAt)}`
    : "Expected to open - date not known yet";
  return `${when} · based on ${e.basedOnYear}`;
}

/** "Due around Nov 15, 2027", or null. */
export function expectedDueLabel(e: Pick<ExpectedPosting, "expectedDueAt">): string | null {
  if (!e.expectedDueAt) return null;
  return `Expected due ${e.expectedDueAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
