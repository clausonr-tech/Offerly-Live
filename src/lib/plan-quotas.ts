import "server-only";

import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { and, eq, gte, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import { emailDrafts, featureUsage, resumeReviews, videoInterviewSessions } from "@/db/schema";
import {
  MONTHLY_CONTACT_CREDITS,
  getContactCredits,
  isUnlimitedAccount,
  isUnmeteredEnvironment,
} from "@/lib/contact-credits";
import type { Plan } from "@/lib/model-registry";

/**
 * The monthly feature quotas each plan buys - the numbers on the pricing page.
 *
 * These are the marketed limits, distinct from the two other ceilings in the
 * app: DAILY_LIMITS (lib/model-registry) is the per-day fair-use backstop on
 * all AI calls together, and the video coach's LIMITS (lib/video-interview)
 * are per-day/per-minute abuse brakes. A paying student should only ever meet
 * THESE numbers.
 *
 * Contact generations live in lib/contact-credits (they predate this file and
 * meter provider spend, not AI calls); its MONTHLY_CONTACT_CREDITS holds the
 * same 0/30/60 ladder, and getMonthlyUsage below folds it in so the billing
 * page reads one shape.
 *
 * Free is zero on every row: the free tier is the Internal Network (the
 * community), and these features' pages sit behind the plan gate
 * (lib/plan-access). The zeros are defence in depth for a free account calling
 * a server action directly, not the gate itself.
 *
 * Counting is by calendar month, the same convention contact credits already
 * use - not the billing cycle. Simpler to reason about, already how the app
 * words it ("resets at the start of next month"), and the difference only
 * matters in a student's first month.
 */
export const MONTHLY_QUOTAS: Record<Plan, { emailDrafts: number; resumeReviews: number; videoInterviews: number }> = {
  free: { emailDrafts: 0, resumeReviews: 0, videoInterviews: 0 },
  pro: { emailDrafts: 60, resumeReviews: 20, videoInterviews: 20 },
  pro_plus: { emailDrafts: 120, resumeReviews: 40, videoInterviews: 40 },
};

export type MeteredFeature = keyof (typeof MONTHLY_QUOTAS)["free"];

/** How each feature reads in a limit message. */
const FEATURE_WORDS: Record<MeteredFeature, string> = {
  emailDrafts: "email drafts",
  resumeReviews: "resume reviews",
  videoInterviews: "video interviews",
};

/**
 * The message a student sees at the limit. Pure, so it is testable and so the
 * wording stays in one place: the refusal, the billing page and the pricing
 * page all describe the same ladder.
 */
function quotaExhaustedMessage(feature: MeteredFeature, plan: Plan, limit: number): string {
  const words = FEATURE_WORDS[feature];
  if (limit === 0) {
    return `${words[0].toUpperCase()}${words.slice(1)} are part of Offerly Pro. Upgrade on the Billing page to use them.`;
  }
  const upsell = plan === "pro" ? " Pro+ doubles every monthly limit." : "";
  return `You've used all ${limit} ${words} for this month. They reset at the start of next month.${upsell}`;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * One use = one row in the feature's own table, created this month. Counting
 * the domain tables rather than ai_usage is deliberate: a draft is several
 * model calls and a resume review is six, so ai_usage rows would overcount,
 * and a failed call that wrote no draft should not cost a use.
 *
 * Those rows are all deletable by the student, though, which handed the
 * allowance back with the draft - so the real count is the greater of this and
 * the append-only feature_usage ledger (migration 0042). The ledger is what a
 * reservation is written to; the domain count still carries the history from
 * before the ledger existed, so nobody's month resets on deploy.
 */
function usageWhere(userId: string, feature: MeteredFeature, since: Date): { table: typeof emailDrafts | typeof resumeReviews | typeof videoInterviewSessions; where: SQL } {
  switch (feature) {
    case "emailDrafts":
      return { table: emailDrafts, where: and(eq(emailDrafts.userId, userId), gte(emailDrafts.createdAt, since))! };
    case "resumeReviews":
      return { table: resumeReviews, where: and(eq(resumeReviews.userId, userId), gte(resumeReviews.createdAt, since))! };
    case "videoInterviews":
      return {
        table: videoInterviewSessions,
        where: and(eq(videoInterviewSessions.userId, userId), gte(videoInterviewSessions.createdAt, since))!,
      };
  }
}

/** The ledger's count for this month - the half a deletion cannot lower. */
function ledgerWhere(userId: string, feature: MeteredFeature, since: Date): SQL {
  return and(
    eq(featureUsage.userId, userId),
    eq(featureUsage.feature, feature),
    gte(featureUsage.createdAt, since),
  )!;
}

async function usedThisMonth(userId: string, feature: MeteredFeature): Promise<number> {
  const db = await getDb();
  const since = startOfMonth();
  const { table, where } = usageWhere(userId, feature, since);
  const [domain] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  const [ledger] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(featureUsage)
    .where(ledgerWhere(userId, feature, since));
  return Math.max(domain?.n ?? 0, ledger?.n ?? 0);
}

/** What a reservation hands back: how to give the use back if nothing came of it. */
export type MonthlyReservation =
  | { ok: false; error: string }
  | { ok: true; release: () => Promise<void> };

/**
 * Takes one of this month's uses BEFORE the paid work starts.
 *
 * Counted and written under a per-student, per-feature lock in one
 * transaction, so requests fired together queue for it and exactly the first
 * ones through get a use - where checking the count and recording only
 * afterwards let a burst all pass the same check. The same shape
 * lib/ai-runner uses for the daily ceiling.
 *
 * `release()` gives the use back, and the caller must call it on every path
 * that does not end in the feature's own row being written: a failed call has
 * never counted.
 *
 * The accounts that bypass contact credits bypass this, and local dev is never
 * metered - in both cases release() is a no-op.
 */
export async function reserveMonthlyUse(
  user: { id: string; email: string | null; plan: Plan },
  feature: MeteredFeature,
): Promise<MonthlyReservation> {
  const noop: MonthlyReservation = { ok: true, release: async () => {} };
  if (isUnlimitedAccount(user.email) || isUnmeteredEnvironment()) return noop;
  const limit = MONTHLY_QUOTAS[user.plan][feature];
  if (limit === 0) return { ok: false, error: quotaExhaustedMessage(feature, user.plan, 0) };

  const db = await getDb();
  const since = startOfMonth();
  const { table, where } = usageWhere(user.id, feature, since);
  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  const id = await run(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_FAMILY.monthlyQuota}, hashtext(${`monthly-quota:${user.id}:${feature}`}))`);
    const [domain] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
    const [ledger] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(featureUsage)
      .where(ledgerWhere(user.id, feature, since));
    if (Math.max(domain?.n ?? 0, ledger?.n ?? 0) >= limit) return null;
    const [mine] = await tx
      .insert(featureUsage)
      .values({ userId: user.id, feature, createdAt: new Date() })
      .returning();
    return mine.id;
  });
  if (!id) return { ok: false, error: quotaExhaustedMessage(feature, user.plan, limit) };
  return {
    ok: true,
    release: async () => {
      try {
        const live = await getDb();
        await live.delete(featureUsage).where(eq(featureUsage.id, id));
      } catch {
        // A use that cannot be given back is the safe direction to fail.
      }
    },
  };
}

/**
 * The gate, as a reservation: see reserveMonthlyUse above.
 *
 * Called at the top of the server action that spends the feature - before the
 * upload is stored, before anything reaches a model - so a refusal costs
 * nothing, and the use is taken under a lock so a burst cannot all pass the
 * same count. Every path that does not write the feature's own row calls
 * release().
 */

export type MonthlyUsage = {
  feature: MeteredFeature | "contactGenerations";
  label: string;
  used: number;
  limit: number;
};

/**
 * This month's usage against every metered feature, for the billing page.
 * Contact generations come from their own ledger (getContactCredits counts
 * in-flight runs conservatively; a plain row count here would disagree with
 * the number the generate button shows).
 */
export async function getMonthlyUsage(user: { id: string; plan: Plan }): Promise<MonthlyUsage[]> {
  const quotas = MONTHLY_QUOTAS[user.plan];
  const [credits, ...counts] = await Promise.all([
    getContactCredits(user.id),
    ...(Object.keys(quotas) as MeteredFeature[]).map(async (feature) => ({
      feature,
      used: await usedThisMonth(user.id, feature),
      limit: quotas[feature],
    })),
  ]);
  return [
    {
      feature: "contactGenerations",
      label: "Contact generations",
      used: credits.used,
      limit: MONTHLY_CONTACT_CREDITS[user.plan],
    },
    ...counts.map((c) => ({
      ...c,
      label: FEATURE_WORDS[c.feature][0].toUpperCase() + FEATURE_WORDS[c.feature].slice(1),
    })),
  ];
}
