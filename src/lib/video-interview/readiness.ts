import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { servableCounts } from "./question-bank-db";

/**
 * Whether the database can run the video coach, told apart properly:
 *
 *   ready            everything is there
 *   missing_schema   the database answers, but a migration has not been
 *                    applied - named, so a developer knows which
 *   unseeded         the tables exist, the question bank is empty
 *   db_unavailable   the database did not answer at all (an outage, bad
 *                    credentials) - NOT reported as a missing migration
 *
 * Read-only: it never creates, migrates or seeds anything.
 */

export type Readiness =
  | { state: "ready" }
  | { state: "missing_schema"; migrations: string[] }
  | { state: "unseeded" }
  | { state: "db_unavailable" };

type Db = Awaited<ReturnType<typeof getDb>>;

function firstRow(result: unknown): Record<string, unknown> | undefined {
  // PGlite returns { rows }, postgres-js an array.
  if (Array.isArray(result)) return result[0] as Record<string, unknown>;
  return (result as { rows?: Record<string, unknown>[] })?.rows?.[0];
}

export async function checkVideoCoachReadiness(given?: Db): Promise<Readiness> {
  let row: Record<string, unknown> | undefined;
  let db: Db;
  try {
    db = given ?? (await getDb());
    row = firstRow(
      await db.execute(sql`
        select
          to_regclass('public.video_interview_sessions') is not null
            and to_regclass('public.video_interview_questions') is not null
            and to_regclass('public.video_interview_recordings') is not null
            and to_regclass('public.video_interview_consent_events') is not null as has_0029,
          to_regclass('public.interview_questions') is not null
            and exists (
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'video_interview_recordings' and column_name = 'status'
            ) as has_0030,
          to_regclass('public.object_deletion_queue') is not null as has_0031,
          exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'video_interview_sessions' and column_name = 'start_token'
          ) as has_0032,
          exists (
            select 1 from pg_constraint
            where conname = 'video_interview_consent_events_kind_check'
              and pg_get_constraintdef(oid) like '%training_standing_yes%'
          ) as has_0037`),
    );
  } catch {
    return { state: "db_unavailable" };
  }
  if (!row) return { state: "db_unavailable" };

  const migrations: string[] = [];
  if (row.has_0029 !== true) migrations.push("0029_video_interviews");
  if (row.has_0030 !== true) migrations.push("0030_interview_question_bank");
  if (row.has_0031 !== true) migrations.push("0031_object_deletion_queue");
  if (row.has_0032 !== true) migrations.push("0032_per_interview_training_consent");
  if (row.has_0037 !== true) migrations.push("0037_standing_training_consent");
  if (migrations.length) return { state: "missing_schema", migrations };

  try {
    const counts = await servableCounts(db!);
    if (counts.core === 0 || counts.technical === 0) return { state: "unseeded" };
  } catch {
    return { state: "db_unavailable" };
  }
  return { state: "ready" };
}

export type UnavailableView = { title: string; body: string; detail?: string[] };

/**
 * What the page shows when the coach cannot run. In production: a calm,
 * generic line - never a table name, migration or connection detail. In
 * development: exactly what is missing and the safe way to fix it.
 */
export function unavailableView(state: Exclude<Readiness["state"], "ready"> | "load_failed", production: boolean): UnavailableView {
  if (production) {
    return {
      title: "The video interview coach is taking a short break",
      body: "It's temporarily unavailable. Your past interviews are safe - please check back soon. Practice rounds still work in the meantime.",
    };
  }
  switch (state) {
    case "missing_schema":
      return {
        title: "Video coach: database migration missing",
        body: "The database this dev server uses doesn't have the video coach's tables yet.",
        detail: [
          "Apply whichever of these are missing, in order: drizzle/0029_video_interviews.sql, 0030_interview_question_bank.sql, 0031_object_deletion_queue.sql, 0032_per_interview_training_consent.sql, 0037_standing_training_consent.sql.",
          "First confirm which database .env.local points at - see the checklist in docs/VIDEO_INTERVIEW_SETUP.md.",
          "Then run: npm run db:migrate, and npm run db:seed-interview-questions.",
        ],
      };
    case "unseeded":
      return {
        title: "Video coach: question bank is empty",
        body: "The interview_questions table exists but has no servable questions.",
        detail: ["After confirming the target database (docs/VIDEO_INTERVIEW_SETUP.md), run: npm run db:seed-interview-questions"],
      };
    case "db_unavailable":
      return {
        title: "Video coach: database unreachable",
        body: "The database didn't answer. This is a connection problem, not a missing migration.",
        detail: ["Check DATABASE_URL / DATABASE_CA_CERT_FILE, network access, and the dev server log."],
      };
    case "load_failed":
      return {
        title: "Video coach: loading failed",
        body: "The schema is in place but loading this page failed. See the dev server log for the error.",
      };
  }
}

type Logger = Pick<Console, "warn" | "error">;

/**
 * Logs a readiness result at the right level. A missing migration or an
 * empty bank is an EXPECTED setup state with its own screen - a one-line
 * warning, never console.error (which Next.js dev turns into a red issue
 * badge, as if the page had crashed). A database that does not answer is a
 * genuine fault and is logged as an error.
 */
export function logReadiness(r: Readiness, logger: Logger = console): void {
  switch (r.state) {
    case "ready":
      return;
    case "missing_schema":
      logger.warn(`[video coach] waiting on migration(s): ${r.migrations.join(", ")} - see docs/VIDEO_INTERVIEW_SETUP.md`);
      return;
    case "unseeded":
      logger.warn("[video coach] question bank is empty - run npm run db:seed-interview-questions");
      return;
    case "db_unavailable":
      logger.error("[video coach] database unavailable for the readiness check");
      return;
  }
}
