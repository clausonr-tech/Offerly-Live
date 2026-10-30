// The rules for the "Today" list's batches of five, apart from the database.
//
// A student sees five tasks at a time. A task they finish - by ticking it, or
// by doing the work so the app stops listing it - stays in its place crossed
// out rather than vanishing, so the list shows progress instead of quietly
// shuffling. When all five are crossed out, they can load the next five.
//
// Pure, so the rules are testable without a database; lib/today-list.ts does
// the reading and writing.

import type { TodayTask } from "@/lib/task-types";

export const BATCH_SIZE = 5;

/** A task as it read when it was shown - enough to draw it crossed out after
 *  the app has stopped listing it. */
export type TaskSnapshot = Pick<TodayTask, "id" | "kind" | "title" | "detail" | "href" | "score" | "doneKey">;

export type ListedTask = TaskSnapshot & { done: boolean };

/** Keep only what a snapshot needs; nothing else goes into the stored batch. */
export function snapshot(task: TaskSnapshot): TaskSnapshot {
  const { id, kind, title, detail, href, score, doneKey } = task;
  return doneKey ? { id, kind, title, detail, href, score, doneKey } : { id, kind, title, detail, href, score };
}

/**
 * The batch as it stands now: each task done once the app no longer lists it.
 *
 * "No longer listed" covers every way a task finishes - ticked (a ticked task
 * is left out of the live list), done in the app (a round played, an email
 * sent), or simply over (the event has passed). All of them are crossed out.
 */
export function resolveBatch(items: TaskSnapshot[], live: ReadonlySet<string>): ListedTask[] {
  return items.map((item) => ({ ...item, done: !live.has(item.id) }));
}

/**
 * A task that became another without being done: an interview's practice row
 * turns into its refresher the evening before, under a new id. Left alone, the
 * practice row would read as finished - crossed out and filed in the done
 * history though nobody practised - and the refresher would wait off the list.
 * This puts the refresher in its place instead. Returns null when nothing in
 * the batch has turned into anything.
 */
export function carryForward(items: TaskSnapshot[], all: TaskSnapshot[]): TaskSnapshot[] | null {
  const live = new Map(all.map((t) => [t.id, t]));
  const present = new Set(items.map((i) => i.id));
  let changed = false;
  const out = items.map((item) => {
    if (live.has(item.id)) return item;
    const m = /^interview-(.+)-prep$/.exec(item.id);
    const next = m ? live.get(`interview-${m[1]}-refresh`) : undefined;
    if (!next || present.has(next.id)) return item;
    changed = true;
    present.add(next.id);
    return snapshot(next);
  });
  return changed ? out : null;
}

/** Every task in the batch is finished - time to offer the next five. */
export function batchFinished(items: ListedTask[]): boolean {
  return items.length > 0 && items.every((i) => i.done);
}

/**
 * The next five: the highest-scoring live tasks not already shown today.
 * `all` arrives sorted by score, which is the order they are offered in.
 */
export function nextBatch(
  all: TaskSnapshot[],
  shownToday: ReadonlySet<string>,
  size: number = BATCH_SIZE,
): TaskSnapshot[] {
  return all.filter((t) => !shownToday.has(t.id)).slice(0, size).map(snapshot);
}

// ---------- the completed history ----------

/** How long a finished task stays on the to-do page before it lives only in
 *  the completed history. */
export const DONE_VISIBLE_MS = 24 * 60 * 60 * 1000;

export type CompletedTask = TaskSnapshot & { completedAt: Date; source: string };

export type CompletedDay = {
  /** "YYYY-MM-DD" on the student's clock. */
  day: string;
  /** "Today", "Yesterday", or "Monday, September 21". */
  label: string;
  items: CompletedTask[];
};

function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Completed tasks grouped by the day they were finished, newest day first and
 * newest first within a day - the student's day, not the server's.
 */
export function groupByDay(tasks: CompletedTask[], timeZone: string, now: Date = new Date()): CompletedDay[] {
  const today = localDay(now, timeZone);
  // The calendar day before today - not 24 hours ago, which on the night the
  // clocks go back is still "today" at 11:30pm.
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const byDay = new Map<string, CompletedTask[]>();
  for (const t of [...tasks].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime())) {
    const day = localDay(t.completedAt, timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), t]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, items]) => ({
      day,
      label:
        day === today
          ? "Today"
          : day === yesterday
            ? "Yesterday"
            : new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                weekday: "long",
                month: "long",
                day: "numeric",
              }).format(new Date(`${day}T12:00:00Z`)),
      items,
    }));
}

/** Finished within the last day - what the to-do page still shows. */
export function recentlyDone(tasks: CompletedTask[], now: Date = new Date()): CompletedTask[] {
  return tasks
    .filter((t) => now.getTime() - t.completedAt.getTime() < DONE_VISIBLE_MS)
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
}
