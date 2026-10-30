import "server-only";

import { LOCK_FAMILY } from "@/lib/advisory-locks";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { videoInterviewConsentEvents, videoInterviewSessions } from "@/db/schema";
import { VIDEO_POLICY_VERSION, type TrainingChoice } from "./types";

/**
 * The video coach's REQUIRED consent: analysis - each answer's audio goes to
 * the server to be transcribed and graded. Read from an append-only event
 * log, and it counts only when given under the CURRENT VIDEO_POLICY_VERSION.
 *
 * Training is the student's STANDING answer, asked once - at their first
 * "Start interview" - and then applied to every interview they start, until
 * they change it on the setup page (5 October 2026: asking at every Start was
 * one question too many). It lives in this log too, as "training_standing_yes"
 * / "training_standing_no", and counts only under the current version, so a
 * policy change asks again. Each session still copies the answer it started
 * under (video_interview_sessions.training_opt_in) - that copy, not this log,
 * is what authorises its uploads (training-video).
 *
 * Older "training_granted"/"training_revoked" rows, and the per-interview
 * answers on sessions from before, are history only: they authorise nothing,
 * and do not stand in for the question.
 */

export type TrainingStanding = { choice: TrainingChoice; decidedAt: string };

export type ConsentState = {
  analysis: { grantedAt: string } | null;
  /** The standing training answer, or null when it has not been asked yet. */
  training: TrainingStanding | null;
  policyVersion: string;
};

export const TRAINING_STANDING_KINDS = { yes: "training_standing_yes", no: "training_standing_no" } as const satisfies Record<TrainingChoice, string>;

/** The latest standing answer in a student's log rows (newest first), under the current version. */
export function standingTraining(rows: { kind: string; version: string; at: Date }[]): TrainingStanding | null {
  const row = rows.find(
    (r) => (r.kind === TRAINING_STANDING_KINDS.yes || r.kind === TRAINING_STANDING_KINDS.no) && r.version === VIDEO_POLICY_VERSION,
  );
  if (!row) return null;
  return { choice: row.kind === TRAINING_STANDING_KINDS.yes ? "yes" : "no", decidedAt: row.at.toISOString() };
}

export async function getConsentState(userId: string): Promise<ConsentState> {
  const db = await getDb();
  const rows = await db
    .select({ kind: videoInterviewConsentEvents.kind, version: videoInterviewConsentEvents.policyVersion, at: videoInterviewConsentEvents.createdAt })
    .from(videoInterviewConsentEvents)
    .where(eq(videoInterviewConsentEvents.userId, userId))
    .orderBy(desc(videoInterviewConsentEvents.createdAt), desc(videoInterviewConsentEvents.id))
    .limit(200);

  const analysis = rows.find((r) => r.kind === "analysis_granted" && r.version === VIDEO_POLICY_VERSION);
  return {
    analysis: analysis ? { grantedAt: analysis.at.toISOString() } : null,
    training: standingTraining(rows),
    policyVersion: VIDEO_POLICY_VERSION,
  };
}

export async function grantAnalysisConsent(userId: string): Promise<void> {
  const db = await getDb();
  await db.insert(videoInterviewConsentEvents).values({ userId, kind: "analysis_granted", policyVersion: VIDEO_POLICY_VERSION });
}

type Db = Awaited<ReturnType<typeof getDb>>;

/** The lock that serialises one student's Starts and answer changes (sessions.startSession takes it too). */
export function trainingLock(userId: string) {
  return sql`select pg_advisory_xact_lock(${LOCK_FAMILY.videoSession}, hashtext(${`video-session:${userId}`}))`;
}

/** The standing answer as the database has it now - for use inside the lock. */
export async function readTrainingStanding(db: Db, userId: string): Promise<TrainingStanding | null> {
  const rows = await db
    .select({ kind: videoInterviewConsentEvents.kind, version: videoInterviewConsentEvents.policyVersion, at: videoInterviewConsentEvents.createdAt })
    .from(videoInterviewConsentEvents)
    .where(eq(videoInterviewConsentEvents.userId, userId))
    .orderBy(desc(videoInterviewConsentEvents.createdAt), desc(videoInterviewConsentEvents.id))
    .limit(200);
  return standingTraining(rows);
}

/**
 * Logs a standing answer, timed strictly after every earlier row of this
 * student's. "The latest answer" is read by time, and two answers in one tick
 * of the clock - a millisecond on some databases, or a Start whose
 * transaction began before a change committed - would otherwise tie and be
 * ordered by their random ids, so the older answer could win (5 October 2026,
 * caught by the generated tests). Call it under trainingLock.
 */
export async function recordTrainingStanding(db: Db, userId: string, choice: TrainingChoice): Promise<void> {
  await db.execute(sql`
    insert into video_interview_consent_events (user_id, kind, policy_version, created_at)
    select ${userId}, ${TRAINING_STANDING_KINDS[choice]}, ${VIDEO_POLICY_VERSION},
           greatest(clock_timestamp()::timestamp, coalesce(max(created_at) + interval '1 millisecond', clock_timestamp()::timestamp))
    from video_interview_consent_events
    where user_id = ${userId}`);
}

/**
 * Changes the standing training answer. Saying no also stops an unfinished
 * interview from contributing more - a withdrawal takes effect at once - but
 * keeps what was already contributed: deleting that is its own button.
 */
export async function setTrainingStanding(userId: string, choice: TrainingChoice): Promise<void> {
  if (choice !== "yes" && choice !== "no") throw new Error("training choice must be yes or no");
  const db = await getDb();
  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <R>(f: (tx: Db) => Promise<R>) => Promise<R>;
  await run(async (tx) => {
    await tx.execute(trainingLock(userId));
    await recordTrainingStanding(tx, userId, choice);
    if (choice !== "no") return;
    await tx
      .update(videoInterviewSessions)
      .set({ trainingOptIn: false, trainingWithdrawnAt: new Date() })
      .where(
        and(
          eq(videoInterviewSessions.userId, userId),
          eq(videoInterviewSessions.status, "in_progress"),
          eq(videoInterviewSessions.trainingOptIn, true),
        ),
      );
  });
}
