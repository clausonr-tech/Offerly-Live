import "server-only";

import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { sttUsage } from "@/db/schema";

/**
 * A rolling bound on speech-to-text spend, in audio seconds.
 *
 * The coach already caps how many answers a student may upload
 * (lib/video-interview/limits) and upload-validation caps the BYTES of each
 * one. Neither bounds what the provider actually bills, which is audio
 * MINUTES: `durationMs` is the browser's claim, and a few hundred kilobytes of
 * low-bitrate audio can be an hour long. So the bytes cap did not bound the
 * spend at all.
 *
 * Two controls. Both prefer the duration the PROVIDER reports; neither ever
 * reads the one the client sent.
 *
 *   - an answer whose real audio is longer than the question's answer time is
 *     refused after transcription (tooLongForAnswer). The transcript is thrown
 *     away, so lying about the length buys nothing;
 *   - every transcription's seconds are recorded, and once a student has spent
 *     DAILY_AUDIO_SECONDS in the last day no further answer is transcribed. A
 *     repeated attempt therefore costs a bounded amount.
 *
 * WHEN THE PROVIDER REPORTS NOTHING. A provider configured with the plain
 * "json" response format - the gpt-4o transcribe models cannot do better -
 * returns no duration at all. The first version of this file charged the answer
 * time the question ALLOWED in that case, reasoning that charging the maximum
 * made under-reporting worthless. The third adversarial pass showed that the
 * "maximum" was the wrong maximum: four megabytes of audio encoded at eight
 * kilobits a second is seventy minutes long, and it was being charged as three.
 * Sixty of those in a day is seventy hours of billed transcription against a
 * budget whose own comment said it capped the day at three.
 *
 * So the fallback charges what the BYTES are worth instead: `chargeableSeconds`
 * divides the file by what a second of this app's own audio weighs. Bytes are
 * the server's own measurement of a file it has in hand, not a claim. An honest
 * answer is charged about its own length; a file that is heavier than its
 * declared length can be is refused before the call, by the per-second weight
 * cap in upload-validation. The default model (whisper-1) answers with
 * verbose_json and a real duration, so the honest path never meets any of this.
 *
 * The budget has to fit documented honest use: sessionsPerDay (12) times a full
 * five-question interview of the LONGEST answer (180s, not the 120s this
 * comment used to claim) is 10,980 seconds, which the old three-hour budget
 * cut off just before the last answer of the last session. Four hours clears it
 * with room for retries.
 */
export const DAILY_AUDIO_SECONDS = 4 * 60 * 60;

/**
 * What a second of this app's own audio weighs: the recorder is started at
 * 48 kbit/s (learn/video/VideoInterview.tsx), which is 6 KiB a second.
 *
 * The first version of this divided by Opus's absolute floor of 6 kbit/s
 * instead, on the reasoning that the most audio those bytes COULD be is the
 * right thing to charge. The arithmetic of that was not checked against honest
 * use: a real three-minute answer weighs about 1.08 MB, which at the floor is
 * charged as 1,406 seconds - nearly eight times its length - so a student doing
 * exactly what the product offers was refused after ten long answers, two of
 * their twelve sessions. That is the same kind of mistake as the budget that
 * used to sit below honest use, made in the same file while fixing it.
 *
 * At the recorder's own rate an honest answer charges about its own length, and
 * a deliberately low-bitrate file is bounded by the per-second WEIGHT cap in
 * upload-validation instead - which is the control written for that, and which
 * means four megabytes can only be offered against a question of at least
 * ~128 seconds.
 */
const EXPECTED_AUDIO_BYTES_PER_SECOND = 6 * 1024;

/**
 * What to charge for one transcription.
 *
 * The provider's own measurement when there is one - that is the truth, and the
 * student should pay for what they actually recorded. Otherwise the upper bound
 * the bytes allow, never less than the answer time, so the fallback can only
 * ever be stricter than charging the allowance.
 */
export function chargeableSeconds(input: {
  reportedSeconds: number | null;
  bytes: number;
  allowedSeconds: number;
}): number {
  const { reportedSeconds, bytes, allowedSeconds } = input;
  if (reportedSeconds !== null && Number.isFinite(reportedSeconds) && reportedSeconds > 0) {
    return reportedSeconds;
  }
  const fromBytes = Number.isFinite(bytes) && bytes > 0 ? bytes / EXPECTED_AUDIO_BYTES_PER_SECOND : 0;
  return Math.max(allowedSeconds, fromBytes);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The refusal, when the day is spent. */
const BUDGET_SPENT = "That's a lot of recording time today. The coach will be ready again tomorrow.";

/** How much audio this student has had transcribed in the last rolling day. */
export async function audioSecondsUsed(userId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${sttUsage.seconds}), 0)::int` })
    .from(sttUsage)
    .where(and(eq(sttUsage.userId, userId), gte(sttUsage.createdAt, new Date(now.getTime() - DAY_MS))));
  return row?.total ?? 0;
}


/**
 * Takes the day's audio BEFORE the provider is called, and hands back a way to
 * correct it afterwards.
 *
 * `audioBudgetError` was a plain SELECT and the charge happened after the call
 * returned, which is read-then-act: twelve submissions fired together all read
 * the same zero, all passed, and all twelve reached the provider - about four
 * and a half times the day's ceiling in one burst, repeatable daily. Every
 * other ceiling in this codebase was converted away from that shape
 * (lib/plan-quotas, lib/ai-runner, lib/help-gate, lib/practice-session,
 * lib/rate-limit) and each says so; this was the last one left.
 *
 * So the charge is reserved: counted and written in one transaction behind a
 * per-student advisory lock, at what the bytes are worth, before anything is
 * sent. `settle` then corrects the row down to the duration the provider
 * actually reports, so an honest answer ends up charged for what it was, and
 * `release` gives it back entirely when the call never happened.
 *
 * The lock is per student, so it only ever serialises one person's own
 * submissions - and it is waited for, not tried, because unlike the shared rate
 * limiter this is reached only from a signed-in student's own upload, where
 * there is no unauthenticated burst to queue the pool behind.
 */
export type AudioReservation =
  | { ok: false; error: string }
  | { ok: true; settle: (realSeconds: number | null) => Promise<void>; release: () => Promise<void> };

export async function reserveAudioSeconds(
  userId: string,
  seconds: number,
  now: Date = new Date(),
): Promise<AudioReservation> {
  const charge = Math.max(1, Math.ceil(Number.isFinite(seconds) && seconds > 0 ? seconds : 1));
  const db = await getDb();
  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  const id = await run(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_FAMILY.sttBudget}, hashtext(${`stt-budget:${userId}`}))`);
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${sttUsage.seconds}), 0)::int` })
      .from(sttUsage)
      .where(and(eq(sttUsage.userId, userId), gte(sttUsage.createdAt, new Date(now.getTime() - DAY_MS))));
    if ((row?.total ?? 0) >= DAILY_AUDIO_SECONDS) return null;
    const [mine] = await tx.insert(sttUsage).values({ userId, seconds: charge, createdAt: now }).returning();
    return mine.id;
  });
  if (!id) return { ok: false, error: BUDGET_SPENT };
  return {
    ok: true,
    settle: async (realSeconds) => {
      if (realSeconds === null || !Number.isFinite(realSeconds) || realSeconds <= 0) return;
      try {
        const live = await getDb();
        await live
          .update(sttUsage)
          .set({ seconds: Math.max(1, Math.ceil(realSeconds)) })
          .where(eq(sttUsage.id, id));
      } catch {
        // The provisional charge stands, which is the safe direction.
      }
    },
    release: async () => {
      try {
        const live = await getDb();
        await live.delete(sttUsage).where(eq(sttUsage.id, id));
      } catch {
        // A charge that stays is the safe direction to fail.
      }
    },
  };
}


/**
 * Whether the provider's own measurement says this audio was longer than the
 * question allowed. Null duration means the provider did not report one, in
 * which case the claimed length (already checked against the server's clock in
 * upload-validation) is all there is and the answer stands.
 */
export function tooLongForAnswer(
  durationSeconds: number | null,
  answerSeconds: number,
  graceMs: number,
): boolean {
  if (durationSeconds === null) return false;
  return durationSeconds > answerSeconds + graceMs / 1000;
}
