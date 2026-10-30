// What a firm's Analytics tab may show, and how it is summarised. Pure: the
// privacy rules below are the important part of the feature, so they are
// tested on their own (scripts/test/firm-analytics.test.ts).
//
// PRIVACY RULES
//
// 1. Totals only. A firm never sees a student's name, email, profile or
//    anything that could be traced to one person.
// 2. No small groups. Any breakdown row (a school, a class year) covering
//    fewer than MIN_GROUP students is folded into "Other", and "Other" itself
//    is hidden if it is still too small. Five students from one school is a
//    trend; one student from one school is a person.
// 3. Never GPA, never visa sponsorship. Onboarding promises students their GPA
//    is "never shown to anyone", and sponsorship status is sensitive enough
//    that no aggregate of it is worth the risk. Neither is read here at all.
// 4. OPTED-IN STUDENTS ONLY. Everything built from student profiles, contacts
//    or applications - the totals, the funnel, every breakdown - counts only
//    students who opted in to sharing with firms under the current policy
//    (sharedWithFirmsWhere in lib/firm-sharing.ts, applied to the cohort in
//    lib/firm-analytics.ts). Engagement with the firm's OWN posts (clicks,
//    calendar adds, how many were told) reads no profile and is counted as
//    before. The demo firm shows sample data either way.

/**
 * On since POLICY_VERSION 2026-09-23, whose privacy policy describes opt-in
 * sharing with firms. Turning it off locks the student sections again.
 */
export const STUDENT_DATA_SHARING_ENABLED = true;

/** The smallest group a breakdown row may describe. */
export const MIN_GROUP = 5;

export type Bucket = { label: string; count: number };

export type Breakdown = {
  rows: Bucket[];
  /** Students in the breakdown, including any folded into Other or hidden. */
  total: number;
  /** Students left out because their group, and Other, were too small. */
  hidden: number;
};

/**
 * Counts values into labelled rows, largest first, keeping at most `max`
 * rows. Rows under MIN_GROUP - and everything past `max` - go into "Other";
 * "Other" is dropped too when it is under MIN_GROUP, and counted as hidden.
 * Null and empty values are "Not given", which is subject to the same rule.
 */
export function breakdown(values: (string | null | undefined)[], max = 8, minGroup = MIN_GROUP): Breakdown {
  const counts = new Map<string, number>();
  for (const v of values) {
    const label = v && v.trim() ? v.trim() : "Not given";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows: Bucket[] = [];
  let other = 0;
  for (const [label, count] of sorted) {
    if (count >= minGroup && rows.length < max) rows.push({ label, count });
    else other += count;
  }
  let hidden = 0;
  if (other >= minGroup) rows.push({ label: "Other", count: other });
  else hidden = other;
  return { rows, total: values.length, hidden };
}

/** Breakdown of multi-valued answers (a student picks several sectors). Each student counts once per value. */
export function multiBreakdown(lists: (string[] | null | undefined)[], max = 8, minGroup = MIN_GROUP): Breakdown {
  const flat = lists.flatMap((l) => (l && l.length ? l : [null]));
  const b = breakdown(flat, max, minGroup);
  return { ...b, total: lists.length };
}

/** A share as a whole percentage, or null when there is nothing to divide by. */
/**
 * A count of students as a firm may see it: zero, or MIN_GROUP and over, as
 * the number; anything between as "Fewer than 5". A total of one or two can
 * point at a person the firm could name (the one student who applied), so
 * small totals are floored like breakdown rows are. Null for a hidden count.
 */
export function visibleCount(n: number, minGroup = MIN_GROUP): number | null {
  return n === 0 || n >= minGroup ? n : null;
}

/** visibleCount, as the words to print. */
export function countLabel(n: number, minGroup = MIN_GROUP): string {
  const v = visibleCount(n, minGroup);
  return v === null ? `Fewer than ${minGroup}` : v.toLocaleString("en-US");
}

export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export const DEGREE_LABELS: Record<string, string> = {
  bachelors: "Bachelor's",
  masters: "Master's or MBA",
  phd: "PhD",
};

export const APPLIED_STATUSES = new Set(["submitted", "interviewing", "offer", "rejected"]);

export type FirmAnalytics = {
  firmName: string;
  /** The demo firm's numbers are sample data, and the page says so. */
  isSample: boolean;
  /** False while STUDENT_DATA_SHARING_ENABLED is off for a real firm. */
  studentDataShared: boolean;
  generatedAt: Date;
  totals: {
    matched: number;
    foundContacts: number;
    contactsFound: number;
    tracking: number;
    applied: number;
    interviewing: number;
    offers: number;
    applyClicks: number;
    applyClickStudents: number;
    eventClicks: number;
    calendarAdds: number;
    notified: number;
  };
  funnel: Bucket[];
  postings: { id: string; title: string; isActive: boolean; origin: string; applyClicks: number; students: number; notified: number }[];
  events: { id: string; title: string; date: Date | null; isActive: boolean; clicks: number; calendarAdds: number; notified: number }[];
  schools: Breakdown;
  gradYears: Breakdown;
  degrees: Breakdown;
  sectors: Breakdown;
  locations: Breakdown;
  /** Clicks on this firm's posts in each of the last 8 weeks, oldest first. */
  weekly: Bucket[];
};

/** Week buckets ending this week, labelled by their Monday ("Sep 15"). */
export function weeklyCounts(dates: Date[], now: Date = new Date(), weeks = 8): Bucket[] {
  const monday = (d: Date) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = (x.getUTCDay() + 6) % 7;
    x.setUTCDate(x.getUTCDate() - dow);
    return x;
  };
  const start = monday(now);
  start.setUTCDate(start.getUTCDate() - 7 * (weeks - 1));
  const out: Bucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + 7 * i);
    out.push({ label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), count: 0 });
  }
  for (const date of dates) {
    const idx = Math.floor((monday(date).getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (idx >= 0 && idx < weeks) out[idx].count++;
  }
  return out;
}
