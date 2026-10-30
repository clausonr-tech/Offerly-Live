import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailDrafts, events, outreachSends, todoDismissals } from "@/db/schema";
import { getDueFollowUps } from "./follow-ups";
import { getNetworkCoverage } from "./network-coverage";
import { getStudentDayCounter } from "./time-zone-server";
import { TODO_WINDOW_DAYS, dayKey, getOpeningToday, getOutreachNudges, todoNudges } from "./application-outreach";
import { getInterviewPrepNudges, prepHref } from "./interview-prep";
import { FOLLOW_UP_AFTER_DAYS, followUpHref, ordinal } from "./outreach-ladder";
import { getDueLadderFollowUps } from "./outreach-ladder-db";
import { daysOwed, thankYouProgress, thankYouTitle } from "./thank-you";
import { getStudentTimeZone } from "./time-zone-server";
import { dueLabel, reminderScore, reminderTaskId } from "./application-reminders";
import { getApplicationReminders } from "./application-reminders-db";
import { getThankYouPrompts } from "./thank-you-db";

// "What should I do today" for the top of Opportunities.
//
// The point is a SHORT list. Every other panel on that page is a full inventory
// of something - firms, deadlines, events - and a student opening the app does
// not need another inventory, they need the next five moves. So every source
// contributes its tasks, everything is scored on one scale, and the student is
// shown five at a time - lib/today-list.ts keeps today's five, crosses out the
// finished ones, and hands over the next five. The whole list is /todo.
//
// Nothing here invents work: every task points at a row that already exists.

// The task's shape and labels live in their own module so the client
// components that draw a row can import them - this one is server-only.
export { TASK_LABELS, type TaskKind, type TodayTask } from "@/lib/task-types";
import type { TodayTask } from "@/lib/task-types";
import { generatedDetail, generatedTitle, getUnreachedGenerated } from "@/lib/generated-reminders";

const DAY = 86_400_000;

/**
 * How hard an outreach prompt pushes, by how close the opening is.
 *
 * 50 at two weeks out, 92 on the day. Writing to someone before their firm's
 * application opens is the one task here with a hard expiry - the window shuts
 * on the firm's schedule, not the student's - so it climbs as the opening
 * nears: below a deadline due tomorrow, above a follow-up that has been due for
 * a fortnight.
 */
export function outreachTaskScore(daysUntilOpen: number): number {
  const clamped = Math.min(Math.max(daysUntilOpen, 0), TODO_WINDOW_DAYS);
  return 50 + (TODO_WINDOW_DAYS - clamped) * 3;
}

function whenLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** Everything the sources below need about the student. The window and nudge
 *  queries read their profile, not just their id. */
type TodayUser = Parameters<typeof getOutreachNudges>[0];

/**
 * Everything the student has to do, highest score first - the whole list, not
 * the five the dashboard shows at a time (lib/today-list.ts cuts those).
 *
 * Tasks ticked off by hand are left out. Every id is stable for as long as the
 * task is the same task, and changes when it is a new occurrence (a new rung,
 * a new opening, a new stretch of silence), so ticking one never hides the
 * next.
 */
export async function getAllTasks(user: TodayUser, now: Date = new Date()): Promise<TodayTask[]> {
  const db = await getDb();
  const userId = user.id;

  // A fortnight either side: recently-missed deadlines still need acting on,
  // and anything further out is not today's problem.
  const from = new Date(now.getTime() - 3 * DAY);
  const to = new Date(now.getTime() + 14 * DAY);

  const [upcoming, drafts, followUps, coverage, nudges, openingToday, reminders, interviews, ladder, copied, thanks, dismissed, timeZone, unreached] = await Promise.all([
    db.query.events.findMany({
      where: and(
        eq(events.userId, userId),
        // Something already ticked off is not still today's work.
        eq(events.completed, false),
        gte(events.eventDate, from),
        lte(events.eventDate, to),
      ),
      columns: { id: true, title: true, type: true, eventDate: true, endDate: true },
    }),
    db.query.emailDrafts.findMany({
      where: eq(emailDrafts.userId, userId),
      columns: { id: true, subject: true, updatedAt: true, pushedToGmailAt: true, sentAt: true },
    }),
    getDueFollowUps(userId, now),
    getNetworkCoverage(userId),
    getOutreachNudges(user, now),
    getOpeningToday(user, now),
    getApplicationReminders(user, now),
    getInterviewPrepNudges(user, now),
    getDueLadderFollowUps(userId, now),
    db.query.outreachSends.findMany({
      where: eq(outreachSends.userId, userId),
      columns: { draftId: true },
    }),
    getThankYouPrompts(userId, now),
    db.query.todoDismissals.findMany({
      where: eq(todoDismissals.userId, userId),
      columns: { taskId: true },
    }),
    getStudentTimeZone(),
    getUnreachedGenerated(userId, now),
  ]);

  const tasks: TodayTask[] = [];
  // "Today" and "1d ago" on the student's calendar, not the server's UTC one.
  const daysUntil = await getStudentDayCounter();

  for (const e of upcoming) {
    const days = daysUntil(e.eventDate, now);
    const isDeadline = e.type === "deadline";
    // A coffee chat or meeting that has already happened is not something to
    // do - it happened. What it leaves behind (the thank-you) is its own row.
    // A missed deadline is different: it may still need acting on, so it stays.
    // "Has happened" is by the clock, not the calendar day: a coffee chat that
    // ended an hour ago is not "Scheduled today" beside its own thank-you.
    if (!isDeadline && (days < 0 || (e.endDate ?? e.eventDate).getTime() < now.getTime())) continue;
    // Deadlines outrank meetings at the same distance: a missed deadline cannot
    // be rescheduled. Both decay as they move away from today.
    const base = isDeadline ? 100 : 80;
    tasks.push({
      id: `event-${e.id}`,
      kind: isDeadline ? "deadline" : "event",
      title: e.title,
      detail: isDeadline ? `Application deadline ${whenLabel(days)}` : `Scheduled ${whenLabel(days)}`,
      href: "/schedule",
      score: base - Math.abs(days) * 4 + (days < 0 ? -10 : 0),
    });
  }

  // An interview does not move and cannot be rescheduled by the student, so
  // preparing for one outranks everything here except a deadline today. It is
  // also the only task on this list with a hard floor on the work: a round of
  // technicals takes ten minutes, which is the point of putting it in front of
  // someone the night before.
  // Both phases land here: the countdown until they have practised, and the
  // refresher in the last hours whatever they did before. Either way the row
  // leaves once they play a round - getInterviewPrepNudges stops returning it.
  for (const i of interviews) {
    const who = i.firmName ?? i.title;
    tasks.push({
      id: `interview-${i.eventId}-${i.phase}`,
      kind: "interview",
      title: i.phase === "refresh" ? `Refresher for ${who}` : `Practise for ${who}`,
      detail:
        i.phase === "refresh"
          ? `Quick technicals round · interview ${i.dayLabel}`
          : `Technicals · interview ${i.dayLabel}`,
      href: prepHref(),
      score: i.phase === "refresh" ? 99 : 96 - i.daysUntil * 3,
    });
  }

  // One row per FIRM, never one per person. "Email Goldman Sachs, five left" is
  // one job a student can pick up and work down; five rows that each name one
  // person would fill this whole list with one firm and push everything else
  // they have to do today off the bottom.
  // The day an application opens: apply. Above everything but a deadline
  // today - it is the thing the whole countdown was for.
  for (const o of openingToday) {
    tasks.push({
      id: `apply-${o.firmKey}-${dayKey(o.opensOn)}`,
      kind: "apply",
      title: `Apply to ${o.firmName}`,
      detail: `${o.cycleLabel} · applications open today`,
      href: o.applyUrl,
      score: 98,
    });
  }

  // An open application not applied to, from two weeks before its deadline
  // (the whole time, when rolling). Ticking it is "I applied".
  for (const r of reminders) {
    if (!r.onTodo) continue;
    tasks.push({
      id: reminderTaskId(r.key),
      kind: "apply",
      title: `Apply to ${r.firmName}`,
      detail: [r.role, dueLabel(r), r.daysLeft === 0 && r.deadlineTime ? `closes ${r.deadlineTime}` : null]
        .filter(Boolean)
        .join(" · "),
      href: r.applyUrl ?? "/applications",
      score: reminderScore(r),
    });
  }

  for (const n of todoNudges(nudges)) {
    tasks.push({
      // The opening in the id: next year's application is a new task.
      id: `outreach-${n.firmKey}-${dayKey(n.opensOn)}`,
      kind: "outreach",
      title: `Email ${n.firmName}`,
      detail: `${n.contacts.length} contact${n.contacts.length === 1 ? "" : "s"} left to email · opens ${whenLabel(n.daysUntilOpen)}`,
      // Their contact table filtered to this firm - every one of these people,
      // including the ones with no address yet. The banner links to the drafter
      // per person; a single row cannot, so it hands over the list instead.
      href: `/contacts?q=${encodeURIComponent(n.contactFirmQuery)}`,
      score: outreachTaskScore(n.daysUntilOpen),
    });
  }

  // A cold email a week old with no reply: the next rung of the ladder. One row
  // per person, because each is its own email to write. Climbs the longer it
  // waits - a follow-up is worth most in the second week and little by the
  // fifth - and starts level with an outreach row a week from its opening.
  for (const f of ladder) {
    tasks.push({
      id: `ladder-${f.contactId}-${f.step}`,
      kind: "follow_up",
      title: `Follow up with ${f.name}`,
      detail: [f.firm, `${ordinal(f.step)} email`, `no reply in ${FOLLOW_UP_AFTER_DAYS + f.daysOverdue} days`]
        .filter(Boolean)
        .join(" · "),
      href: followUpHref(f.contactId, f.step),
      score: Math.min(88, 70 + f.daysOverdue * 2),
    });
  }

  // A chat, call or interview a couple of hours over with nobody thanked.
  // Level with an overdue follow-up: both are one short email, and a thank-you
  // loses most of its worth after a day, so it climbs by the hour it waits.
  for (const t of thanks) {
    const hours = Math.floor((now.getTime() - t.dueAt.getTime()) / 3_600_000);
    tasks.push({
      id: `thanks-${t.key}`,
      kind: "thank_you",
      title: thankYouTitle(t),
      // Counted on the student's clock: the server's is UTC, and a chat at
      // 7pm in New York read at 10pm is "today", not "1d ago".
      detail: [t.title, whenLabel(-daysOwed(t.startsAt, now, timeZone)), thankYouProgress(t)]
        .filter(Boolean)
        .join(" · "),
      href: t.href,
      score: Math.min(90, 80 + hours),
      doneKey: t.key,
    });
  }

  for (const f of followUps) {
    tasks.push({
      // The last touch in the id: ticking this catch-up must not silence the
      // next one, a month after they speak again.
      id: `follow-${f.contactId}-${dayKey(f.lastTouch)}`,
      kind: "follow_up",
      title: `Follow up with ${f.name}`,
      detail: [f.firm, `${f.daysSince} days since you last spoke`].filter(Boolean).join(" · "),
      href: `/contacts/${f.contactId}`,
      // Scaled by how far past due it is, capped so one very cold contact
      // cannot occupy the whole list.
      score: Math.min(75, 40 + f.overdueByDays),
    });
  }

  // A written-but-unsent draft is the cheapest task on the list: the work is
  // already done and it just needs sending. "Unsent" means never copied out of
  // the composer and never pushed to Gmail - once it has gone, it is not a job.
  const sentDrafts = new Set(copied.map((c) => c.draftId).filter(Boolean));
  const unsent = drafts.filter((d) => !d.sentAt && !d.pushedToGmailAt && !sentDrafts.has(d.id));
  for (const d of unsent) {
    tasks.push({
      id: `draft-${d.id}`,
      kind: "draft",
      title: `Send: ${d.subject}`,
      detail: "Draft written and waiting to go out",
      href: `/drafts/${d.id}`,
      score: 55,
    });
  }

  // People they found with contact search three or more days ago and never
  // wrote to - the same reminder as the bell's (lib/generated-reminders).
  // Named by the person; the firm page it opens has a Draft email button for
  // each of them. The lead's id is in the task's: once they are written to,
  // the next person heads a new task rather than hiding behind a ticked one.
  for (const f of unreached) {
    tasks.push({
      id: `generated-${f.firmKey}-${f.lead.contactId}`,
      kind: "outreach",
      title: generatedTitle(f),
      detail: generatedDetail(f),
      href: f.href,
      // Above an empty firm, below a draft already written; climbs a little
      // the longer they wait.
      score: Math.min(52, 42 + f.days),
    });
  }

  for (const c of coverage.filter((x) => x.personalCount === 0)) {
    tasks.push({
      id: `coverage-${c.firmId}`,
      kind: "coverage",
      title: `Find someone at ${c.firmName}`,
      detail: "On your firm list with no contacts yet",
      href: `/discovery/firm/${c.firmSlug}`,
      score: 30,
    });
  }

  const ticked = new Set(dismissed.map((d) => d.taskId));
  return tasks
    .filter((t) => !ticked.has(t.id))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
