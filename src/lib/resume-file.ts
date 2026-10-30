import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews, users } from "@/db/schema";
import { readResumeFile, resumeContentType } from "./resume-storage";

export type StudentResume = { filename: string; storageKey: string };

/**
 * The resume the student gave us: the profile one from onboarding (or the
 * draft form), else the latest one they uploaded to the resume builder.
 */
export async function findStudentResume(userId: string): Promise<StudentResume | null> {
  const db = await getDb();
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { resumeStoragePath: true, resumeFilename: true },
  });
  if (user?.resumeStoragePath) {
    return { filename: user.resumeFilename ?? "resume", storageKey: user.resumeStoragePath };
  }

  const review = await db.query.resumeReviews.findFirst({
    where: eq(resumeReviews.userId, userId),
    orderBy: [desc(resumeReviews.createdAt)],
    columns: { storagePath: true, filename: true },
  });
  if (review?.storagePath) {
    return { filename: review.filename ?? "resume.pdf", storageKey: review.storagePath };
  }
  return null;
}

/** Null when there is no resume, or its file has gone missing. */
export async function readStudentResume(
  resume: StudentResume | null,
): Promise<{ filename: string; mimeType: string; bytes: Buffer } | null> {
  if (!resume) return null;
  // Never throws, as when this read a disk: callers attach the resume to an
  // email when they can, and a failed read must not fail the email.
  const bytes = await readResumeFile(resume.storageKey).catch((e) => {
    console.error("[resume-file] could not read resume", e);
    return null;
  });
  if (!bytes) return null;
  return { filename: resume.filename, mimeType: resumeContentType(resume.storageKey), bytes };
}
