/**
 * A graded answer counts toward one round, even when the rounds are saved at
 * the same instant.
 *
 * Interview Prep grades each answer on the server and hands back a signed
 * receipt; finishing a round tallies the receipts, so the score on classmates'
 * leaderboards is never the browser's number. A receipt is spent when the
 * round that counted it is saved: the tally ignores every receipt issued at or
 * before the student's newest saved round.
 *
 * That was a read followed, with nothing in between, by an insert. The same
 * receipts sent in several parallel requests therefore all read the same
 * previous round, all tallied the same score, and all inserted their own
 * practice_sessions row - real points, on the school leaderboard, the game
 * leaderboard and the streak feed, for one round of work. The save now takes a
 * per-student advisory lock and refuses to insert a round when one has already
 * been saved since the request began, answering with the saved round instead.
 *
 * A real database (PGlite migrated by replaying drizzle/*.sql). No network and
 * no model: nothing here grades an answer, it only mints the receipts grading
 * would have issued.
 */

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";

import "./helpers/async-local-storage";
import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { practiceSessions, users } from "@/db/schema";
import { issueReceipt } from "@/lib/practice-seal";
import { finishPracticeRound, type RoundConfig } from "@/lib/practice-session";

const CONFIG: RoundConfig = {
  mode: "technical",
  difficulty: "intermediate",
  categories: ["investment_banking"],
  specialties: {},
  format: "multiple_choice",
};

let h: TestDatabase;
let restore: () => void;

before(async () => {
  h = await createTestDb();
  restore = installAsAppDb(h.db);
});
after(async () => {
  restore();
  await h.close();
});

let n = 0;
async function mkStudent(): Promise<string> {
  const [u] = await h.db
    .insert(users)
    .values({
      email: `practice-replay-${(n += 1)}@example.edu`,
      passwordHash: "x",
      name: "Practice Student",
      plan: "pro",
    })
    .returning({ id: users.id });
  return u.id;
}

/** The receipts five graded answers would have left the browser holding. */
function receiptsFor(userId: string, at = Date.now() - 60_000, points = 10): string[] {
  return Array.from({ length: 5 }, (_, i) => issueReceipt(userId, new Date(at + i * 1000), points, true));
}

async function rounds(userId: string): Promise<{ count: number; points: number }> {
  const [agg] = await h.db
    .select({
      count: sql<number>`count(*)::int`,
      points: sql<number>`coalesce(sum(${practiceSessions.score}), 0)::int`,
    })
    .from(practiceSessions)
    .where(eq(practiceSessions.userId, userId));
  return { count: Number(agg.count), points: Number(agg.points) };
}

test("one round's answers, saved by requests fired together, count once", async () => {
  const userId = await mkStudent();
  const receipts = receiptsFor(userId);
  const { completePracticeRound } = await import("@/app/(app)/learn/practice-actions");

  const answers = await asStudent(h.db, userId, () =>
    Promise.all(Array.from({ length: 6 }, () => completePracticeRound(CONFIG, receipts))),
  );

  const saved = answers.filter((a) => a.summary);
  assert.ok(saved.length > 0, `no request saved the round: ${JSON.stringify(answers)}`);
  const board = await rounds(userId);
  assert.equal(board.count, 1, "the same answers were saved as several rounds");
  assert.equal(board.points, 50, "the leaderboard was given more points than the round scored");
  // Whichever request lost the race still answers with the round that was
  // saved, so an honest double-click shows its score rather than an error.
  for (const a of saved) assert.equal(a.summary!.score, 50);
});

test("sending the same receipts again afterwards scores nothing", async () => {
  const userId = await mkStudent();
  const receipts = receiptsFor(userId);
  const { completePracticeRound } = await import("@/app/(app)/learn/practice-actions");

  const first = await asStudent(h.db, userId, () => completePracticeRound(CONFIG, receipts));
  assert.equal(first.summary?.score, 50);

  const again = await asStudent(h.db, userId, () => completePracticeRound(CONFIG, receipts));
  assert.equal(again.summary, undefined);
  assert.match(again.error ?? "", /Nothing in this round was graded/);
  assert.deepEqual(await rounds(userId), { count: 1, points: 50 });
});

test("the student's next round is saved as its own round", async () => {
  const userId = await mkStudent();
  const { completePracticeRound } = await import("@/app/(app)/learn/practice-actions");

  const first = await asStudent(h.db, userId, () => completePracticeRound(CONFIG, receiptsFor(userId)));
  assert.equal(first.summary?.score, 50);

  // Answers graded after that round was saved: a new round, worth its own points.
  const later = receiptsFor(userId, Date.now() + 2_000, 6);
  const second = await asStudent(h.db, userId, () => completePracticeRound(CONFIG, later));
  assert.equal(second.summary?.score, 30);
  assert.equal(second.summary?.personalBest, 50);
  assert.equal(second.summary?.isPersonalBest, false);
  assert.deepEqual(await rounds(userId), { count: 2, points: 80 });
});

test("finishPracticeRound saves one row for a burst and keeps saving rounds in turn", async () => {
  const userId = await mkStudent();
  const round = { userId, config: CONFIG, score: 70, questionsAnswered: 10, bestStreakInRound: 3 };

  const burst = await Promise.all(Array.from({ length: 5 }, () => finishPracticeRound(round)));
  assert.deepEqual(await rounds(userId), { count: 1, points: 70 }, "a burst saved more than one round");
  for (const s of burst) assert.equal(s.score, 70);
  assert.equal(burst.filter((s) => s.isPersonalBest).length, 1, "every request claimed the personal best");

  // Sequential rounds are untouched: each one is its own row.
  const next = await finishPracticeRound({ ...round, score: 40, bestStreakInRound: 1 });
  assert.equal(next.isPersonalBest, false);
  assert.equal(next.personalBest, 70);
  assert.deepEqual(await rounds(userId), { count: 2, points: 110 });
});

test("`countedAfter` refuses a tally computed against a round that has been superseded", async () => {
  const userId = await mkStudent();
  const round = { userId, config: CONFIG, score: 55, questionsAnswered: 10, bestStreakInRound: 2 };

  // A student's first round: nothing saved yet, so the tally counted from null.
  await finishPracticeRound({ ...round, countedAfter: null });
  const [saved] = await h.db
    .select({ at: practiceSessions.createdAt })
    .from(practiceSessions)
    .where(eq(practiceSessions.userId, userId));

  // The same request arriving again still believes nothing was saved.
  await finishPracticeRound({ ...round, countedAfter: null });
  assert.deepEqual(await rounds(userId), { count: 1, points: 55 }, "a stale tally was saved a second time");

  // A tally that did count from the saved round is a real next round.
  await finishPracticeRound({ ...round, score: 20, countedAfter: saved.at });
  assert.deepEqual(await rounds(userId), { count: 2, points: 75 });
});
