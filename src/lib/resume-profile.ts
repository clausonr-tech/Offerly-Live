import "server-only";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { resumeReviews, users } from "@/db/schema";
import { runAiFeature } from "./ai-runner";
import { outputConfigFor } from "./model-registry";
import { deleteResumeFiles, readResumeFile, saveResumeFile, type StoredResume } from "./resume-storage";
import { findStudentResume, readStudentResume } from "./resume-file";
import { extensionOf, isReadableResume } from "./resume-formats";
import { docxToText } from "./docx-text";
import { isValidGpa } from "./gpa";
import { fillEmptyProfileFromResume } from "./profile-autofill";

// The student's resume, read every time one is uploaded and kept as a summary.
//
// Every email type draws on it - a cold email's experience line, a thank-you's
// personal connection, a keeping-in-touch update - so it is read here, once
// per upload, rather than sending the file to the model on every draft. Stored
// in users.resume_text, which the rest of the app already treats as "what the
// resume says". A GPA on the resume fills in the student's exact GPA too.
//
// Every upload path goes through adoptStoredResume: the profile, the draft
// form, onboarding and the resume builder. A resume that is uploaded anywhere
// is the resume, and it is always read.

const summarySchema = z.object({
  education: z.array(z.object({ school: z.string(), detail: z.string() })),
  /** Current college GPA as a bare number, e.g. "3.97". Empty when not listed. */
  gpa: z.string(),
  experience: z.array(
    z.object({
      organization: z.string(),
      title: z.string(),
      location: z.string(),
      dates: z.string(),
      highlights: z.array(z.string()),
    }),
  ),
  activities: z.array(
    z.object({ organization: z.string(), role: z.string(), dates: z.string(), highlights: z.array(z.string()) }),
  ),
  skills: z.array(z.string()),
  interests: z.array(z.string()),
});

type ResumeSummary = z.infer<typeof summarySchema>;

/** Plain, labelled text - readable in a prompt. */
function formatSummary(s: ResumeSummary, gpa: string | null): string {
  const line = (parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join(" · ");
  const bullets = (items: string[]) => items.map((h) => `    - ${h}`);
  const sections = [
    (s.education.length || gpa) && [
      "EDUCATION",
      ...s.education.map((e) => `- ${line([e.school, e.detail])}`),
      ...(gpa ? [`- GPA: ${gpa}`] : []),
    ],
    s.experience.length && [
      "WORK EXPERIENCE",
      ...s.experience.flatMap((e) => [
        `- ${line([e.organization, e.title, e.location, e.dates])}`,
        ...bullets(e.highlights),
      ]),
    ],
    s.activities.length && [
      "CLUBS & ACTIVITIES",
      ...s.activities.flatMap((a) => [`- ${line([a.organization, a.role, a.dates])}`, ...bullets(a.highlights)]),
    ],
    s.skills.length && ["SKILLS", `- ${s.skills.join(", ")}`],
    s.interests.length && ["INTERESTS", `- ${s.interests.join(", ")}`],
  ].filter((section): section is string[] => Array.isArray(section));
  return sections.map((section) => section.join("\n")).join("\n\n");
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * The resume in whatever form the model reads best: PDFs and images as they
 * are, so layout helps it tell a job title from a bullet; Word and text files
 * as plain text. Null when there is nothing to read.
 */
function resumeContentBlock(ext: string, bytes: Buffer) {
  if (ext === ".pdf") {
    return {
      type: "document" as const,
      source: { type: "base64" as const, media_type: "application/pdf" as const, data: bytes.toString("base64") },
    };
  }
  const image = IMAGE_TYPES[ext];
  if (image) {
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: image, data: bytes.toString("base64") },
    };
  }
  const text = ext === ".docx" ? docxToText(bytes) : ext === ".txt" ? bytes.toString("utf8").slice(0, 100_000) : "";
  if (!text.trim()) return null;
  return {
    type: "document" as const,
    source: { type: "text" as const, media_type: "text/plain" as const, data: text },
  };
}

/** Reads a resume into a summary, plus the GPA when it lists a valid one. */
async function analyzeResume(
  userId: string,
  bytes: Buffer,
  ext: string,
): Promise<{ summary: string; gpa: string | null }> {
  const resume = resumeContentBlock(ext, bytes);
  if (!resume) throw new Error("There's nothing in that resume to read.");

  const response = await runAiFeature({ feature: "resumeReview", userId }, (client, cfg) =>
    client.messages.parse({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      output_config: outputConfigFor(cfg, { format: zodOutputFormat(summarySchema) }),
      system:
        "You extract a college student's resume into structured data, exactly as written. Copy names, titles, " +
        "dates and places as they appear. Keep each highlight to one short line in the resume's own terms, " +
        "keeping any numbers. Never add, infer or embellish anything that is not in the resume. Leave a list " +
        "empty, or a field as an empty string, when the resume doesn't have it. Omit contact details and street " +
        "addresses.\n" +
        "`gpa` is the student's CURRENT college or university GPA as a bare number like \"3.72\" - not a high " +
        "school GPA, not a weighted \"4.25/4\", not a major GPA unless it is the only one. Empty string if none.",
      messages: [
        {
          role: "user",
          content: [resume, { type: "text" as const, text: "Extract this resume." }],
        },
      ],
    }),
  );
  if (!response.parsed_output) throw new Error("Couldn't read that resume.");
  const gpa = isValidGpa(response.parsed_output.gpa) ? response.parsed_output.gpa.trim() : null;
  return { summary: formatSummary(response.parsed_output, gpa), gpa };
}

/**
 * Makes an already-stored file the student's resume and reads it.
 *
 * A failed read never blocks the upload - the file is still attached to cold
 * emails, and the student can retry the read from their profile.
 */
export async function adoptStoredResume(
  userId: string,
  stored: StoredResume,
  bytes?: Buffer,
): Promise<{ filename: string; summary: string | null }> {
  const db = await getDb();
  const previous = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { resumeStoragePath: true },
  });

  let read: { summary: string; gpa: string | null } | null = null;
  if (isReadableResume(stored.storageKey)) {
    try {
      const file = bytes ?? (await readResumeFile(stored.storageKey));
      if (!file) throw new Error(`No stored resume under ${stored.storageKey}`);
      read = await analyzeResume(userId, file, extensionOf(stored.storageKey));
    } catch (e) {
      console.error("[resume-profile] could not read resume", e);
    }
  }

  await db
    .update(users)
    .set({
      resumeFilename: stored.originalName,
      resumeStoragePath: stored.storageKey,
      resumeText: read?.summary ?? null,
      resumeParsedAt: read ? new Date() : null,
      // The resume is the newest record of the GPA, so it wins when it has one.
      ...(read?.gpa ? { gpaBand: read.gpa } : {}),
    })
    .where(eq(users.id, userId));

  // An empty major, filled from the degree line just read. Free, and never
  // over something the student typed - see lib/profile-autofill.
  if (read) await fillEmptyProfileFromResume(userId);

  // The replaced file goes, unless a resume review still points at it.
  const old = previous?.resumeStoragePath;
  if (old && old !== stored.storageKey) {
    const inUse = await db.query.resumeReviews.findFirst({
      where: and(eq(resumeReviews.userId, userId), eq(resumeReviews.storagePath, old)),
      columns: { id: true },
    });
    if (!inUse) await deleteResumeFiles([old]);
  }

  return { filename: stored.originalName, summary: read?.summary ?? null };
}

/** Stores an uploaded file and makes it the student's resume. Throws only for a file that can't be stored. */
export async function replaceStudentResume(
  userId: string,
  file: File,
): Promise<{ filename: string; summary: string | null }> {
  // The owner is passed so the upload counts against this student's hourly
  // storage bound rather than against nobody's.
  const stored = await saveResumeFile(file, userId);
  return adoptStoredResume(userId, stored, stored.bytes);
}

/** Retries the read on the resume already on file. Null when there is no readable resume. */
export async function reanalyzeStudentResume(userId: string): Promise<string | null> {
  const found = await findStudentResume(userId);
  if (!found || !isReadableResume(found.storageKey)) return null;
  const resume = await readStudentResume(found);
  if (!resume) return null;

  const { summary, gpa } = await analyzeResume(userId, resume.bytes, extensionOf(found.storageKey));
  const db = await getDb();
  await db
    .update(users)
    .set({ resumeText: summary, resumeParsedAt: new Date(), ...(gpa ? { gpaBand: gpa } : {}) })
    .where(eq(users.id, userId));
  return summary;
}
