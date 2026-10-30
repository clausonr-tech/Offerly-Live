// What is worth telling a firm, from a snapshot of its numbers. Pure - no
// database, no clock but the one passed in - so every rule is tested on its
// own (scripts/test/firm-insights.test.ts). lib/firm-insights.ts builds the
// snapshot and writes what comes out.
//
// THE BAR. A firm's notification center is only useful while it is quiet, so
// each rule fires on a line being crossed, never on a number merely existing:
//
//   milestone   an internship's apply clicks, or an event's calendar saves,
//               crossing 10 / 25 / 50... - announced once per line, and only
//               the highest line crossed, so a jump from 0 to 30 is one note
//   reach       how many matched students a new post was sent to
//   surge       a week with at least double the week before (and 10+ clicks)
//   weekly      last week in one line, every Monday, when anything happened
//   deadline    an open posting closing within 3 days, or already past its
//               deadline and still open
//   event_soon  an event in the next day and a half, with how many saved it
//   team        a colleague waiting for approval (the owner only)
//   students    how many students matched with the firm crossing 50 / 100...
//               - only when student-data sharing is on (lib/firm-analytics-rules)
//
// Every insight carries a dedupe key; the same key is never announced twice.
// A count of students under MIN_GROUP is never printed (lib/firm-analytics-rules).
//
// THE FLOOR APPLIES HERE AS HARD AS IT DOES ON THE PAGE. These bodies are
// built from the same numbers the Analytics tab shows - analytics.postings[]
// .applyClicks, analytics.events and analytics.weekly - and they are PERSISTED
// in firm_notifications, where every approved account at the firm reads them
// at its leisure. Engagement is recorded once per student per target per ten
// minutes (lib/firm-analytics recordEngagement), so a count of one is one
// identifiable student, not a small statistic: "1 apply click so far" on a
// posting three people can see is a sentence about a person. Worse, the page
// now hides a week under MIN_GROUP entirely, so an unfloored note would sit in
// the bell contradicting the chart it links to.
//
// So every student-derived count goes through counted() below, and nothing in
// these strings is chosen BY a count: a floored number carrying singular or
// plural agreement ("Fewer than 5 student saved it") announces that the real
// number is exactly one, which is the whole thing the floor exists to hide.

import { countLabel, MIN_GROUP, visibleCount } from "./firm-analytics-rules";

export type Insight = {
  dedupeKey: string;
  kind: "milestone" | "reach" | "surge" | "weekly" | "deadline" | "event_soon" | "team" | "students";
  title: string;
  body: string;
  href: string;
  audience: "all" | "owner";
};

export type InsightSnapshot = {
  now: Date;
  postings: {
    id: string;
    title: string;
    isActive: boolean;
    applyClicks: number;
    notified: number;
    deadlineStatus: string | null;
    deadlineDate: Date | null;
  }[];
  events: { id: string; title: string; date: Date | null; isActive: boolean; calendarAdds: number; clicks: number; notified: number }[];
  /** Engagement per week, oldest first, the last entry being the current week (Monday start, UTC). */
  weekly: { label: string; count: number }[];
  /** Monday 00:00 UTC of the current week - the key for weekly and surge notes. */
  weekStart: Date;
  pendingTeammates: { id: string; name: string }[];
  studentDataShared: boolean;
  matched: number;
};

export const APPLY_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
export const SAVE_MILESTONES = [5, 10, 25, 50, 100, 250];
export const MATCHED_MILESTONES = [50, 100, 250, 500, 1000, 2500];
export const SURGE_MIN = 10;
export const DEADLINE_SOON_DAYS = 3;
export const EVENT_SOON_HOURS = 36;

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "12 matched students", or "fewer than 5 matched students". */
const reach = (n: number) => (n < MIN_GROUP ? `fewer than ${MIN_GROUP} matched students` : plural(n, "matched student"));

/**
 * A student-derived count as a firm may read it: floored at MIN_GROUP, with a
 * noun that is never picked from the number.
 *
 * `noun` is always the plural form, and that is correct for every value this
 * can print rather than a compromise: countLabel yields either 0, or a number
 * from MIN_GROUP up, or the words "Fewer than 5" - and the plural reads right
 * for all three. The singular form is simply never reachable, which is the
 * point. plural() remains for counts that are not about students (days left on
 * a deadline, the milestone line itself), where agreement gives nothing away.
 */
const counted = (n: number, noun: string) => `${countLabel(n)} ${noun}`;

/** counted(), for the middle of a sentence rather than the start of one. */
const countedMid = (n: number, noun: string) => {
  const s = counted(n, noun);
  return s.charAt(0).toLowerCase() + s.slice(1);
};

/** The highest line a count has crossed, or null below the first. */
export function highestCrossed(count: number, lines: number[]): number | null {
  let hit: number | null = null;
  for (const l of lines) if (count >= l) hit = l;
  return hit;
}

export function insightsFor(s: InsightSnapshot): Insight[] {
  const out: Insight[] = [];
  const now = s.now.getTime();

  for (const p of s.postings) {
    const line = highestCrossed(p.applyClicks, APPLY_MILESTONES);
    if (line) {
      out.push({
        dedupeKey: `apply:${p.id}:${line}`,
        kind: "milestone",
        title: `${p.title} passed ${line} apply clicks`,
        body: `${counted(p.applyClicks, "apply clicks")} so far.`,
        href: "/firms/analytics",
        audience: "all",
      });
    }
    if (p.notified > 0) {
      out.push({
        dedupeKey: `reach:posting:${p.id}`,
        kind: "reach",
        title: `${p.title} reached ${reach(p.notified)}`,
        body: "Everyone matched with your firm who can apply was notified.",
        href: "/firms/analytics",
        audience: "all",
      });
    }
    if (p.isActive && p.deadlineStatus === "confirmed" && p.deadlineDate) {
      const left = p.deadlineDate.getTime() - now;
      if (left > 0 && left <= DEADLINE_SOON_DAYS * DAY) {
        const days = Math.max(1, Math.ceil(left / DAY));
        out.push({
          dedupeKey: `deadline_soon:${p.id}:${iso(p.deadlineDate)}`,
          kind: "deadline",
          title: `${p.title} closes in ${plural(days, "day")}`,
          body: `${counted(p.applyClicks, "apply clicks")} so far. Edit the deadline if it has moved.`,
          href: `/firms/internships/${p.id}`,
          audience: "all",
        });
      } else if (left <= 0) {
        out.push({
          dedupeKey: `deadline_passed:${p.id}:${iso(p.deadlineDate)}`,
          kind: "deadline",
          title: `${p.title} is past its deadline but still open`,
          body: "Close it so students stop seeing it, or move the deadline.",
          href: "/firms/postings?type=internships",
          audience: "all",
        });
      }
    }
  }

  for (const e of s.events) {
    const line = highestCrossed(e.calendarAdds, SAVE_MILESTONES);
    if (line) {
      out.push({
        dedupeKey: `saves:${e.id}:${line}`,
        kind: "milestone",
        // The title's number is the milestone line, not a count - it is 5, 10,
        // 25... by construction, so it tells a reader nothing about anyone. The
        // body's two numbers ARE counts: an event can cross 5 saves while
        // holding one click, so the clicks are floored like everything else.
        title: `${plural(line, "student")} saved ${e.title}`,
        body: `${counted(e.calendarAdds, "calendar saves")} and ${countedMid(e.clicks, "clicks")} so far.`,
        href: "/firms/analytics",
        audience: "all",
      });
    }
    if (e.notified > 0) {
      out.push({
        dedupeKey: `reach:event:${e.id}`,
        kind: "reach",
        title: `${e.title} reached ${reach(e.notified)}`,
        body: "Matched students at the schools you picked were notified.",
        href: "/firms/analytics",
        audience: "all",
      });
    }
    if (e.isActive && e.date) {
      const until = e.date.getTime() - now;
      if (until > 0 && until <= EVENT_SOON_HOURS * 60 * 60 * 1000) {
        out.push({
          dedupeKey: `event_soon:${e.id}`,
          kind: "event_soon",
          title: `${e.title} is coming up`,
          // "Fewer than 5 student saved it" used to read through the floor:
          // the singular was only ever chosen for exactly one, so the word
          // handed back the number countLabel had just hidden.
          body:
            e.calendarAdds > 0
              ? `${counted(e.calendarAdds, "students")} saved it to their calendar.`
              : "No calendar saves yet.",
          href: `/firms/events/${e.id}`,
          audience: "all",
        });
      }
    }
  }

  const thisWeek = s.weekly.at(-1)?.count ?? 0;
  const lastWeek = s.weekly.at(-2)?.count ?? 0;
  const weekBefore = s.weekly.at(-3)?.count ?? 0;

  if (thisWeek >= SURGE_MIN && thisWeek >= 2 * lastWeek) {
    out.push({
      dedupeKey: `surge:${iso(s.weekStart)}`,
      kind: "surge",
      title: "Engagement is surging this week",
      // This week is at least SURGE_MIN, so it is always printable. Last week
      // is not: the rule fires on a doubling, and 1 -> 10 doubles. Printed raw
      // it named the single student who clicked in a quiet week.
      body:
        lastWeek > 0
          ? `${counted(thisWeek, "clicks")} so far this week, against ${countedMid(lastWeek, "in all of last week")}.`
          : `${counted(thisWeek, "clicks")} so far this week, up from none last week.`,
      href: "/firms/analytics",
      audience: "all",
    });
  }

  // Last week, once it is over. Keyed by the week it describes.
  if (lastWeek > 0) {
    // The percentage is withheld unless BOTH weeks are printable numbers.
    // A change of "+200% on the week before" beside a floored total is an
    // equation with one unknown: the reader divides and recovers the week we
    // just hid, and does it for the week before that too. So the comparison
    // only appears when neither week was something worth hiding, and the
    // generic line stands in its place when it is not.
    const change =
      visibleCount(lastWeek) !== null && weekBefore > 0 && visibleCount(weekBefore) !== null
        ? Math.round(((lastWeek - weekBefore) / weekBefore) * 100)
        : null;
    const lastWeekStart = new Date(s.weekStart.getTime() - 7 * DAY);
    out.push({
      dedupeKey: `weekly:${iso(lastWeekStart)}`,
      kind: "weekly",
      title: `Last week: ${counted(lastWeek, "clicks")} on your posts`,
      body:
        change === null
          ? "Apply clicks, event clicks and calendar saves combined."
          : `${change >= 0 ? "Up" : "Down"} ${Math.abs(change)}% on the week before.`,
      href: "/firms/analytics",
      audience: "all",
    });
  }

  for (const t of s.pendingTeammates) {
    out.push({
      dedupeKey: `team:${t.id}`,
      kind: "team",
      title: `${t.name} is waiting for approval`,
      body: "Approve them on the Team page if they work with you.",
      href: "/firms/team",
      audience: "owner",
    });
  }

  if (s.studentDataShared) {
    const line = highestCrossed(s.matched, MATCHED_MILESTONES);
    if (line) {
      out.push({
        dedupeKey: `matched:${line}`,
        kind: "students",
        title: `${line.toLocaleString("en-US")} students have matched with your firm`,
        body: `${counted(s.matched, "students")} have you on their top-firms list.`,
        href: "/firms/analytics",
        audience: "all",
      });
    }
  }

  return out;
}

/** Monday 00:00 UTC of the week containing `d` - the same weeks as the analytics chart. */
export function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

/** Unread: written after the account last opened the notification center. */
export function isUnread(createdAt: Date, seenAt: Date | null): boolean {
  return !seenAt || createdAt.getTime() > seenAt.getTime();
}
