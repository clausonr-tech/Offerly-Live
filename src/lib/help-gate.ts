import "server-only";

import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { aiUsage } from "@/db/schema";
import {
  HELP_LIMITS,
  dailyBudgetUsd,
  decideHelpGate,
  helpSpendUsd,
  type HelpGateReason,
} from "./help-chat-rules";

/**
 * The Help assistant's gates, TAKEN rather than checked.
 *
 * The gates themselves are the pure rules in lib/help-chat-rules; this is the
 * database half of them. It used to count the student's questions and
 * everyone's spend, hand those numbers to decideHelpGate, and only write the
 * ai_usage row after the model answered. Between the count and the write a
 * question did not exist, so questions fired together all read the same
 * pre-call numbers and all passed - the in-process InFlightGuard stops that
 * only on ONE server instance, and there are several.
 *
 * So a question is now RESERVED before the model is called: counted and
 * written in one transaction under an advisory lock, the same shape
 * lib/ai-runner's reserveQuota and lib/plan-quotas' reserveMonthlyUse use for
 * the daily and monthly ceilings. Requests fired together queue for the lock,
 * and exactly the first ones through get in.
 *
 * TWO LOCKS, AND ONLY ONE OF THEM IS WAITED FOR.
 *
 * The student's own gates - the minute window and their day - have to be
 * EXACT, so they are taken under a lock on that student alone, waited for.
 * Only that one student's questions ever queue on it, the chat disables its
 * send button between them, and the section it guards is a count, a sum and an
 * insert - milliseconds. The queue is bounded by how many requests one account
 * can have in the air at once.
 *
 * The global daily budget is a gate across everybody, and it was taken the
 * same way: ONE `pg_advisory_xact_lock(hashtext('help-gate'))` for every
 * student AND every firm recruiter (lib/firm-help-assistant asks for the same
 * `quota: "help"`), waited for with no timeout, wrapped around a
 * `sum(input_tokens)` over every chat row of the day. That is a self-inflicted
 * denial of service. ai_usage grows with every AI call in the app, the pool is
 * eight connections per instance and does not pipeline, and
 * `pg_advisory_xact_lock` waits forever - so a handful of simultaneous
 * questions could hold every connection waiting on one lock. It does not stop
 * at the Help assistant either: lib/rate-limit catches ANY database error and
 * falls back to a per-process memory counter, so a wedged pool quietly drops
 * every rate limiter in the app to its weak fallback, exactly when the traffic
 * that wedged it is arriving.
 *
 * So the global lock is now TRIED, never waited for
 * (`pg_try_advisory_xact_lock`), and a question that does not get it reads the
 * budget unlocked and carries on. The cost is that questions reading at the
 * same instant can see the same total and together carry the shared budget a
 * little past its ceiling. That overshoot is bounded and already paid for by
 * the provisional-cost design below - every question in flight is charged an
 * estimate the moment it is reserved - and it is bounded again by the
 * per-student gates, which stay exact. An unbounded lock queue in front of
 * every AI feature is not bounded by anything.
 */

/** The row a reserved question holds, or the refusal that stopped it. */
export type HelpReservation =
  | { ok: true; id: string }
  | { ok: false; reason: HelpGateReason; message: string };

/**
 * What a question provisionally costs while it is in flight, in the
 * cost-equivalent units ai_usage stores for Help rows (see
 * costEquivalentInputTokens).
 *
 * A reservation written with zeros would be counted by the minute and daily
 * gates but would add nothing to the global budget, so questions in flight
 * could still walk the budget past its ceiling together. Charging an estimate
 * up front bounds that overshoot by the estimate's error: recordUsage
 * overwrites the row with the real tokens the moment the call returns, and the
 * row of a question that never reached the model is deleted, so nothing
 * provisional outlives the question. (A question the model DID answer keeps
 * its row even if that overwrite fails - see AnsweredFlag in lib/ai-runner -
 * so the budget keeps the estimate rather than losing the spend entirely.)
 *
 * Sized from a normal question: the ~20k-token knowledge block read from cache
 * at a tenth of its price, plus a short question and a short answer.
 */
export const HELP_PROVISIONAL_USAGE = { inputTokens: 2_000, outputTokens: 500 } as const;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Takes one question BEFORE the model is called, and returns the ai_usage row
 * that holds it. The row is filled in with the real model and tokens once the
 * call returns (recordUsage), and released only if the call never happened - a
 * question that was never answered has never counted.
 */
export async function reserveHelpQuestion(userId: string, model: string): Promise<HelpReservation> {
  const db = await getDb();
  const since = startOfToday();
  const minuteAgo = new Date(Date.now() - HELP_LIMITS.windowMs);
  const budgetUsd = dailyBudgetUsd(process.env.HELP_ASSISTANT_DAILY_BUDGET_USD);

  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  return run(async (tx) => {
    // Waited for: this student's minute window and day must be exact, and only
    // their own questions ever queue here.
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_FAMILY.helpGateUser}, hashtext(${`help-gate:${userId}`}))`);
    // TRIED, not waited for. Taken in this order on every path and never
    // waited for, so the pair cannot deadlock. Whether it was granted changes
    // nothing below: the budget is read either way, and a question that read
    // it unlocked may overshoot the shared ceiling by its own provisional cost
    // rather than joining a queue that has no end. See the note at the top.
    await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_FAMILY.helpGateGlobal}, hashtext(${"help-gate"}))`);

    const [mine] = await tx
      .select({
        today: sql<number>`count(*)::int`,
        // gte() rather than a bare ${minuteAgo}: a raw Date inside sql`` skips
        // the column's encoder, and the postgres driver rejects it outright -
        // which failed every question before it reached the model.
        lastMinute: sql<number>`(count(*) filter (where ${gte(aiUsage.createdAt, minuteAgo)}))::int`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), eq(aiUsage.feature, "chat"), gte(aiUsage.createdAt, since)));

    const [everyone] = await tx
      .select({
        input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
        output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.feature, "chat"), gte(aiUsage.createdAt, since)));

    const verdict = decideHelpGate({
      inFlight: false, // claimed by the caller before this runs
      lastMinute: Number(mine?.lastMinute ?? 0),
      today: Number(mine?.today ?? 0),
      globalSpendUsd: helpSpendUsd(Number(everyone?.input ?? 0), Number(everyone?.output ?? 0)),
      budgetUsd,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };

    const [row] = await tx
      .insert(aiUsage)
      .values({
        userId,
        feature: "chat",
        model,
        inputTokens: HELP_PROVISIONAL_USAGE.inputTokens,
        outputTokens: HELP_PROVISIONAL_USAGE.outputTokens,
        usedFallback: false,
        createdAt: new Date(),
      })
      .returning();
    return { ok: true, id: row.id };
  });
}

/** Gives a reserved question back, for a call that never reached the model. */
export async function releaseHelpQuestion(reservationId: string): Promise<void> {
  const db = await getDb();
  await db.delete(aiUsage).where(eq(aiUsage.id, reservationId));
}
