"use server";

import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { reserveMonthlyUse } from "@/lib/plan-quotas";
import { getConsentState, grantAnalysisConsent, setTrainingStanding, type ConsentState } from "@/lib/video-interview/consent";
import {
  confirmTrainingVideoUpload,
  deleteAllTrainingRecordings,
  requestTrainingVideoUpload,
  type UploadGrant,
} from "@/lib/video-interview/training-video";
import {
  VideoInterviewError,
  deleteAllVideoData,
  deleteSession,
  finishSession,
  getSessionForUser,
  markQuestionAsked,
  recordPracticeAnswer,
  skipAnswer,
  startSession,
  submitAnswer,
  type StartInput,
  type SubmitResult,
} from "@/lib/video-interview/sessions";
import { MAX_AUDIO_BYTES, type ClientSession, type TrainingChoice } from "@/lib/video-interview/types";

/**
 * The video coach's server actions. Each one takes the student from the
 * session cookie (getCurrentUserId) - never an id from the request - and hands
 * ids from the request to lib/video-interview/sessions, which matches them
 * against that student only. Server actions also carry Next's same-origin
 * check, so a page on another site cannot post an answer as the student.
 *
 * Errors come back as plain messages. A VideoInterviewError is written for
 * the student; anything else is logged and replaced with a generic line, so
 * no stack trace, SQL or provider response reaches the browser.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string; retryable: boolean; code?: string };

async function run<T>(label: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    // Let the redirect to /login (no session) through.
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof VideoInterviewError) return { ok: false, error: err.message, retryable: err.retryable, ...(err.code ? { code: err.code } : {}) };
    console.error(`video interview ${label} failed:`, err);
    return { ok: false, error: "Something went wrong. Try again.", retryable: true };
  }
}

export async function acceptAnalysisConsent(): Promise<Result<ConsentState>> {
  const userId = await getCurrentUserId();
  return run("consent", async () => {
    await grantAnalysisConsent(userId);
    return getConsentState(userId);
  });
}

/** Changes the standing answer to "contribute my interviews?" - asked once,
 *  at the first Start, and changed here after. */
export async function setVideoTrainingChoice(choice: TrainingChoice): Promise<Result<ConsentState>> {
  const userId = await getCurrentUserId();
  return run("training choice", async () => {
    if (choice !== "yes" && choice !== "no") throw new VideoInterviewError("Choose yes or no.");
    await setTrainingStanding(userId, choice);
    return getConsentState(userId);
  });
}

/** Deletes every training recording the student has contributed, and stops
 *  any interview in progress from contributing more. Interviews stay. */
export async function deleteAllTrainingVideos(): Promise<Result<{ deleted: number; outstanding: number }>> {
  const userId = await getCurrentUserId();
  return run("delete training recordings", () => deleteAllTrainingRecordings(userId));
}

/**
 * For an interview the student contributed: authorises ONE upload of an answer's camera recording
 * straight to private storage. The grant is a presigned PUT, minutes long,
 * for one random key, type and byte length - no credential leaves the server.
 */
export async function requestTrainingUpload(input: { questionId: string; contentType: string; size: number; durationMs: number }): Promise<Result<UploadGrant>> {
  const userId = await getCurrentUserId();
  return run("training upload request", () => requestTrainingVideoUpload(userId, input ?? ({} as never)));
}

/** After the browser's PUT: the server checks the object and keeps it, or
 *  removes it. */
export async function confirmTrainingUpload(uploadId: string): Promise<Result<{ retained: true; questionId: string }>> {
  const userId = await getCurrentUserId();
  return run("training upload confirm", () => confirmTrainingVideoUpload(userId, uploadId));
}

export async function startVideoInterview(input: StartInput): Promise<Result<ClientSession>> {
  const user = await getCurrentUser();
  // One of the plan's monthly interviews (lib/plan-quotas), taken under a
  // per-student lock before the session exists, so interviews started together
  // queue for the use rather than all passing the same count. The per-day and
  // per-minute brakes stay inside startSession; this is the marketed limit.
  // Given back if the session is never created.
  const reservation = await reserveMonthlyUse(user, "videoInterviews");
  if (!reservation.ok) {
    return { ok: false, error: reservation.error, retryable: false, code: "monthly_quota" };
  }
  const started = await run("start", () => startSession(user.id, input ?? ({} as StartInput)));
  if (!started.ok) await reservation.release();
  return started;
}

export async function openVideoInterview(sessionId: string): Promise<Result<ClientSession>> {
  const userId = await getCurrentUserId();
  return run("open", async () => {
    const s = await getSessionForUser(userId, sessionId);
    if (!s) throw new VideoInterviewError("That interview isn't available.");
    return s;
  });
}

export async function beginVideoQuestion(questionId: string): Promise<Result<true>> {
  const userId = await getCurrentUserId();
  return run("begin", async () => {
    if (!(await markQuestionAsked(userId, questionId))) throw new VideoInterviewError("That question isn't part of an open interview.");
    return true as const;
  });
}

/** One answer's audio. FormData: questionId, durationMs, audio (a File). */
export async function submitVideoAnswer(form: FormData): Promise<Result<SubmitResult>> {
  const userId = await getCurrentUserId();
  return run("submit", async () => {
    if (!(form instanceof FormData)) throw new VideoInterviewError("Nothing was uploaded.");
    const questionId = form.get("questionId");
    const durationMs = Number(form.get("durationMs"));
    const audio = form.get("audio");
    if (typeof questionId !== "string") throw new VideoInterviewError("Nothing was uploaded.");
    if (!(audio instanceof File)) throw new VideoInterviewError("The recording didn't arrive. Try again.", true);
    // Size before reading the bytes into memory.
    if (audio.size > MAX_AUDIO_BYTES) throw new VideoInterviewError("That recording is too large to upload.");
    const bytes = Buffer.from(await audio.arrayBuffer());
    return submitAnswer(userId, { questionId, durationMs, file: { bytes, type: audio.type, size: bytes.length } });
  });
}

/** Speech-to-text not set up: the answer was recorded on the device only. */
export async function recordPracticeVideoAnswer(questionId: string): Promise<Result<ClientSession>> {
  const userId = await getCurrentUserId();
  return run("practice answer", () => recordPracticeAnswer(userId, questionId));
}

export async function skipVideoQuestion(questionId: string): Promise<Result<ClientSession>> {
  const userId = await getCurrentUserId();
  return run("skip", () => skipAnswer(userId, questionId));
}

export async function finishVideoInterview(sessionId: string): Promise<Result<ClientSession>> {
  const userId = await getCurrentUserId();
  return run("finish", () => finishSession(userId, sessionId));
}

export async function deleteVideoInterview(sessionId: string): Promise<Result<true>> {
  const userId = await getCurrentUserId();
  return run("delete", async () => {
    if (!(await deleteSession(userId, sessionId))) throw new VideoInterviewError("That interview isn't available.");
    return true as const;
  });
}

export async function deleteAllVideoInterviews(): Promise<Result<true>> {
  const userId = await getCurrentUserId();
  return run("delete all", async () => {
    await deleteAllVideoData(userId);
    return true as const;
  });
}
