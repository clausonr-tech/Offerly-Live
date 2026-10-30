import "server-only";
import { and, asc, desc, eq, gte } from "drizzle-orm";

import { getDb } from "@/db/client";
import { completedTasks, todoBatches } from "@/db/schema";
import { localDateString } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import {
  BATCH_SIZE,
  DONE_VISIBLE_MS,
  batchFinished,
  carryForward,
  groupByDay,
  nextBatch,
  resolveBatch,
  type CompletedDay,
  type CompletedTask,
  type ListedTask,
  type TaskSnapshot,
} from "@/lib/todo-batch";
import { getAllTasks, type TodayTask } from "@/lib/today-tasks";

// The "Today" list on Opportunities: five tasks at a time, finished ones
// crossed out in place, the next five on request. The rules are in
// todo-batch.ts; this reads and writes the day's batches.

type ListUser = Parameters<typeof getAllTasks>[0];

export type TodayList = {
  /** The current five, in order, each marked done or not. */
  items: ListedTask[];
  /** All of the current five are done. */
  finished: boolean;
  /** How many live tasks have not been shown today - what "next 5" draws on. */
  waiting: number;
  /** Every live task, for the "see everything" count. */
  total: number;
};

async function today(now: Date): Promise<string> {
  return localDateString(now, await getStudentTimeZone());
}

async function batchesFor(userId: string, day: string) {
  const db = await getDb();
  return db.query.todoBatches.findMany({
    where: and(eq(todoBatches.userId, userId), eq(todoBatches.day, day)),
    orderBy: [asc(todoBatches.batch)],
  });
}

/**
 * Save finished tasks to the permanent history.
 *
 * Called with the tasks the app has seen finish (a shown task it no longer
 * lists) as "auto", and by the tick as "manual". One row per task, and the
 * first word wins: a task ticked by hand stays "manual" when the app notices
 * it gone a moment later.
 */
export async function recordCompleted(
  userId: string,
  tasks: TaskSnapshot[],
  source: "manual" | "auto",
  now: Date = new Date(),
) {
  if (tasks.length === 0) return;
  const db = await getDb();
  await db
    .insert(completedTasks)
    .values(
      tasks.map((t) => ({
        userId,
        taskId: t.id,
        kind: t.kind,
        title: t.title,
        detail: t.detail,
        href: t.href,
        source,
        completedAt: now,
      })),
    )
    .onConflictDoNothing();
}

/** Write a batch, or leave the one a racing request wrote first. */
async function writeBatch(userId: string, day: string, batch: number, items: TaskSnapshot[]) {
  const db = await getDb();
  await db.insert(todoBatches).values({ userId, day, batch, items }).onConflictDoNothing();
}

/** The current batch with any task that turned into another swapped for it
 *  (see carryForward), saved back so every later read agrees. */
async function carried(
  userId: string,
  day: string,
  current: { batch: number; items: unknown } | undefined,
  all: TaskSnapshot[],
): Promise<TaskSnapshot[]> {
  const items = (current?.items as TaskSnapshot[] | undefined) ?? [];
  const swapped = current ? carryForward(items, all) : null;
  if (!swapped || !current) return items;
  const db = await getDb();
  await db
    .update(todoBatches)
    .set({ items: swapped })
    .where(and(eq(todoBatches.userId, userId), eq(todoBatches.day, day), eq(todoBatches.batch, current.batch)));
  return swapped;
}

/**
 * Today's five, with what is done crossed out.
 *
 * The first read of the day writes batch 1 - the top five right now. Until the
 * student loads more, that set is what they see: tasks leave it only by being
 * finished, and new ones wait on the full list. A day that started with
 * nothing to do takes the top five as soon as there is something.
 */
export async function getTodayList(user: ListUser, now: Date = new Date()): Promise<TodayList> {
  const [all, day] = await Promise.all([getAllTasks(user, now), today(now)]);
  let batches = await batchesFor(user.id, day);

  const latest = batches[batches.length - 1];
  const latestItems = (latest?.items as TaskSnapshot[] | undefined) ?? [];
  if (!latest || (latestItems.length === 0 && all.length > 0)) {
    const shown = new Set(batches.flatMap((b) => (b.items as TaskSnapshot[]).map((i) => i.id)));
    await writeBatch(user.id, day, (latest?.batch ?? 0) + 1, nextBatch(all, shown));
    batches = await batchesFor(user.id, day);
  }

  const current = batches[batches.length - 1];
  const live = new Set(all.map((t) => t.id));
  const items = resolveBatch(await carried(user.id, day, current, all), live);
  const shownToday = new Set(batches.flatMap((b) => (b.items as TaskSnapshot[]).map((i) => i.id)));
  await recordCompleted(user.id, items.filter((i) => i.done), "auto", now);

  return {
    items,
    finished: batchFinished(items),
    waiting: all.filter((t) => !shownToday.has(t.id)).length,
    total: all.length,
  };
}

/**
 * "Load the next 5" - only once every one of the current five is done, which
 * is the promise the button makes. Returns false when it did nothing.
 */
export async function loadNextBatch(user: ListUser, now: Date = new Date()): Promise<boolean> {
  const [all, day] = await Promise.all([getAllTasks(user, now), today(now)]);
  const batches = await batchesFor(user.id, day);
  const current = batches[batches.length - 1];
  if (!current) return false;

  const live = new Set(all.map((t) => t.id));
  if (!batchFinished(resolveBatch(await carried(user.id, day, current, all), live))) return false;

  const shown = new Set(batches.flatMap((b) => (b.items as TaskSnapshot[]).map((i) => i.id)));
  const next = nextBatch(all, shown);
  if (next.length === 0) return false;
  await writeBatch(user.id, day, current.batch + 1, next);
  return true;
}

/**
 * Everything, for the full list page: every live task in order, then what was
 * finished in the last day, crossed out, and how many are in the history.
 */
export async function getEverything(
  user: ListUser,
  now: Date = new Date(),
): Promise<{ open: TodayTask[]; recentlyDone: CompletedTask[]; completedCount: number }> {
  const [all, day] = await Promise.all([getAllTasks(user, now), today(now)]);

  // Anything shown today that has since finished goes into the history first,
  // so a task done elsewhere is on this page even before the dashboard is
  // opened again.
  const live = new Set(all.map((t) => t.id));
  const shown = (await batchesFor(user.id, day)).flatMap((b) => b.items as TaskSnapshot[]);
  await recordCompleted(user.id, resolveBatch(shown, live).filter((i) => i.done), "auto", now);

  const db = await getDb();
  const [recent, everyDone] = await Promise.all([
    db.query.completedTasks.findMany({
      where: and(
        eq(completedTasks.userId, user.id),
        gte(completedTasks.completedAt, new Date(now.getTime() - DONE_VISIBLE_MS)),
      ),
      orderBy: [desc(completedTasks.completedAt)],
    }),
    db.query.completedTasks.findMany({
      where: eq(completedTasks.userId, user.id),
      columns: { id: true },
    }),
  ]);

  return {
    open: all,
    recentlyDone: recent.map(toCompleted),
    completedCount: everyDone.length,
  };
}

function toCompleted(row: typeof completedTasks.$inferSelect): CompletedTask {
  return {
    id: row.taskId,
    kind: row.kind as CompletedTask["kind"],
    title: row.title,
    detail: row.detail,
    href: row.href,
    score: 0,
    completedAt: row.completedAt,
    source: row.source,
  };
}

/** The whole completed history, a day at a time on the student's clock. */
export async function getCompletedHistory(userId: string, now: Date = new Date()): Promise<CompletedDay[]> {
  const db = await getDb();
  const rows = await db.query.completedTasks.findMany({
    where: eq(completedTasks.userId, userId),
    orderBy: [desc(completedTasks.completedAt)],
  });
  return groupByDay(rows.map(toCompleted), await getStudentTimeZone(), now);
}

export { BATCH_SIZE };
