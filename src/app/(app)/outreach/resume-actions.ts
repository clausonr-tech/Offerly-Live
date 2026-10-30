"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { reserveMonthlyUse } from "@/lib/plan-quotas";
import { deleteResumeFiles, readResumeFile, saveResumeFile } from "@/lib/resume-storage";
import { adoptStoredResume } from "@/lib/resume-profile";
import {
  NotAResumeError,
  rescoreReview,
  reviewResume,
  UnsupportedResumeFormatError,
  type ResumeReview,
} from "@/lib/resume-review";
import { buildRevisedResume } from "@/lib/resume-rewrite";
import { placeholdersIn } from "@/lib/resume-placeholders";
import { QuotaExceededError } from "@/lib/ai-runner";

export type ResumeActionState =
  | {
      error?: string;
      reviewId?: string;
      /** The file was not a resume. The panel asks for another file rather than showing a review. */
      notResume?: boolean;
    }
  | undefined;

/** The longest pasted job posting a review reads. Well above a real posting
 *  (a few thousand characters), and the bound on the one free-text field that
 *  reaches the paid model. */
const JOB_DESCRIPTION_MAX = 20_000;

export async function reviewUploadedResume(
  _prev: ResumeActionState,
  formData: FormData,
): Promise<ResumeActionState> {
  const user = await getCurrentUser();
  const userId = user.id;

  // The pasted posting is the one free-text field that reaches the paid model,
  // and a server action can be posted megabytes: the body limit was the only
  // bound, while a quota unit is a row rather than tokens. Bounded generously
  // (a long posting is a few thousand characters) and read before the file is
  // stored, so a refused review leaves no orphan upload.
  const jobDescriptionRaw = String(formData.get("jobDescription") ?? "").trim();
  if (jobDescriptionRaw.length > JOB_DESCRIPTION_MAX) {
    return {
      error: `That job posting is too long - paste under ${JOB_DESCRIPTION_MAX.toLocaleString()} characters.`,
    };
  }

  const file = formData.get("resume");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a resume to upload." };
  }
  // Checked before the file is stored: the review needs a PDF, and saving a
  // .docx we cannot review just leaves an orphan in storage.
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return { error: "Resume review needs a PDF. Export your resume as a PDF and upload that." };
  }

  // One of this month's reviews (lib/plan-quotas), taken under a per-student
  // lock before the file is stored and before anything reaches a model: a
  // refused review costs nothing and leaves no orphan upload, and reviews
  // fired together queue for the use rather than all passing the same count.
  // Given back below on every path that does not end in a review row.
  const reservation = await reserveMonthlyUse(user, "resumeReviews");
  if (!reservation.ok) return { error: reservation.error };
  const releaseUse = reservation.release;
  let committed = false;

  let storedKey: string | null = null;
  try {
    // saveResumeFile owns the size cap, the extension allow-list and the
    // random storage name, so the upload path stays identical to onboarding's.
    // The owner is passed so this path shares the per-student hourly upload
    // bound with the profile and onboarding paths; without it the review was
    // the one door with no bound on stored files.
    const stored = await saveResumeFile(file, userId);
    storedKey = stored.storageKey;
    const bytes = stored.bytes;

    // Empty textarea reads back as "", which would send the model an empty
    // <job_description> block and invite it to invent keyword gaps. Normalised
    // to null so the ATS critic takes its no-posting branch instead. Read and
    // length-checked above, before the upload was stored.
    const jobDescription = jobDescriptionRaw || null;
    const blockedJd = blockedLanguageError([["Job description", jobDescription]]);
    if (blockedJd) return { error: blockedJd };

    const review = await reviewResume({
      userId,
      filename: stored.originalName,
      pdf: bytes,
      jobDescription,
    });

    const db = await getDb();
    const [row] = await db
      .insert(resumeReviews)
      .values({
        userId,
        filename: stored.originalName,
        storagePath: stored.storageKey,
        score: review.score,
        dimensions: review.dimensions,
        summary: review.summary,
        strengths: review.strengths,
        improvements: review.improvements,
        rewrites: review.rewrites,
        jobDescription,
      })
      // Bare returning(): the db handle is a union of the pglite and
      // postgres-js drivers, and only the no-argument overload is common to
      // both. Matches how the rest of the codebase inserts.
      .returning();

    // The review exists, so the month's use is spent from here on, whatever
    // happens to the steps below.
    committed = true;

    // A resume uploaded for review is the student's resume: it becomes the one
    // on their profile, is read for their emails, and gets attached to cold
    // emails. After the review row exists, so the replaced file's cleanup
    // can't delete a file a review still needs.
    await adoptStoredResume(userId, stored, bytes);

    revalidatePath("/outreach", "layout");
    revalidatePath("/profile");
    return { reviewId: row.id };
  } catch (e) {
    // Not a resume: no review is saved and the file is not kept - it must not
    // become the resume on their profile or attached to their emails, which
    // only happens after a review exists. They are asked for another file.
    if (e instanceof NotAResumeError) {
      if (storedKey) await deleteResumeFiles([storedKey]).catch(() => {});
      return { error: e.message, notResume: true };
    }
    // Quota and format problems are things the student can act on, so they are
    // surfaced verbatim. Anything else is logged and reported generically.
    if (e instanceof QuotaExceededError || e instanceof UnsupportedResumeFormatError) {
      return { error: e.message };
    }
    console.error("[resume-review]", e);
    return { error: "Could not review that resume. Try again in a moment." };
  } finally {
    // A review that never happened has never counted - and must not leave its
    // upload behind either. This covers every exit after the file was stored,
    // including the blocked-language return and the quota/format branches,
    // rather than only the "not a resume" one that cleaned up before.
    if (!committed) {
      await releaseUse();
      if (storedKey) await deleteResumeFiles([storedKey]).catch(() => {});
    }
  }
}

/* ------------------------- Applying the changes ------------------------- */

export type RevisionState = { error?: string; ok?: boolean } | undefined;

/**
 * Loads the stored PDF for a review the caller owns and rewrites it against
 * that review's findings.
 *
 * Every query is scoped by userId: the review id arrives from the browser, so
 * ownership is checked in the WHERE clause rather than assumed.
 */
export async function generateRevision(
  _prev: RevisionState,
  formData: FormData,
): Promise<RevisionState> {
  const userId = await getCurrentUserId();
  const reviewId = String(formData.get("reviewId") ?? "");
  if (!reviewId) return { error: "Missing review." };

  try {
    const db = await getDb();
    const row = await db.query.resumeReviews.findFirst({
      where: and(eq(resumeReviews.id, reviewId), eq(resumeReviews.userId, userId)),
    });
    if (!row) return { error: "Couldn't find that review." };

    // The lists are rebuilt from the stored dimensions the same way the page
    // builds them, so the ids the browser sends line up with the same entries
    // here. Sending ids rather than the text itself keeps the form small and
    // means the server never trusts the browser's copy of the findings.
    const { improvements } = rescoreReview(row.dimensions as ResumeReview["dimensions"]);
    const rewrites = (row.rewrites ?? []) as ResumeReview["rewrites"];

    let selected: string[] = [];
    try {
      const parsed = JSON.parse(String(formData.get("selected") ?? "[]"));
      if (Array.isArray(parsed)) selected = parsed.map(String);
    } catch {
      /* fall through to "everything" below */
    }

    // No selection means apply the lot - that is what an empty picker implies,
    // and it keeps the button working if the checkboxes ever fail to render.
    const pickedIssues = selected.length
      ? improvements.filter((_, i) => selected.includes(`issue-${i}`))
      : improvements;
    const pickedRewrites = selected.length
      ? rewrites.filter((_, i) => selected.includes(`rewrite-${i}`))
      : rewrites;

    if (pickedIssues.length === 0 && pickedRewrites.length === 0) {
      return { error: "Pick at least one change to apply." };
    }

    // Enforced here, not only by disabling the button: a rewrite that runs with
    // an unanswered gap spends a model call and hands back a resume with
    // "[add figure: ...]" still in it, which is exactly what the student asked
    // us to prevent.
    const unansweredGaps = pickedRewrites.reduce((n, r) => {
      const needed = placeholdersIn(r.after).length;
      const given = answers.filter((a) => a.line === r.after && a.answer).length;
      return n + Math.max(0, needed - given);
    }, 0);
    if (unansweredGaps > 0) {
      return {
        error: `Fill in the ${unansweredGaps} highlighted box${unansweredGaps === 1 ? "" : "es"} before rewriting - otherwise those lines come back with a gap.`,
      };
    }

    // Figures the student typed against individual changes, keyed by the
    // change's title. Values are theirs, not the model's - this is the whole
    // point of asking before the rewrite rather than after.
    let answers: { line: string; question: string; answer: string }[] = [];
    try {
      const parsed = JSON.parse(String(formData.get("answers") ?? "[]"));
      if (Array.isArray(parsed)) {
        answers = parsed
          .filter((a) => a && typeof a === "object" && typeof a.answer === "string" && a.answer.trim())
          .map((a) => ({
            line: String(a.line ?? "").slice(0, 400),
            question: String(a.question ?? "").slice(0, 200),
            answer: String(a.answer).trim().slice(0, 400),
          }));
      }
    } catch {
      /* no answers supplied */
    }

    const blockedAnswers = blockedLanguageError(answers.map((a) => ["Your answer", a.answer] as [string, string]));
    if (blockedAnswers) return { error: blockedAnswers };

    const bytes = await readResumeFile(row.storagePath);
    if (!bytes) return { error: "The resume for this review is missing. Upload it again to rewrite it." };
    const revised = await buildRevisedResume({
      userId,
      pdf: bytes,
      review: {
        summary: row.summary,
        improvements: pickedIssues,
        rewrites: pickedRewrites,
      },
      answers,
    });

    await db
      .update(resumeReviews)
      // revisedOriginal is written once, here, and never again - the frozen
      // record of what the model produced, against which the student's later
      // edits read as corrections rather than as the only version that ever
      // existed.
      .set({ revised, revisedOriginal: revised, revisedUpdatedAt: new Date() })
      .where(and(eq(resumeReviews.id, reviewId), eq(resumeReviews.userId, userId)));

    revalidatePath("/outreach", "layout");
    return { ok: true };
  } catch (e) {
    if (e instanceof QuotaExceededError) return { error: e.message };
    console.error("[resume-revision]", e);
    return { error: "Could not rewrite that resume. Try again in a moment." };
  }
}
