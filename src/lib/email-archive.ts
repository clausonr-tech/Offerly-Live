import "server-only";
import { createCipheriv, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailArchive } from "@/db/schema";
import { mayTrainOn } from "@/lib/training-consent";

// Write-only, encrypted archive of the emails students send (and, before
// Offerly stopped connecting Gmail, pushed to Gmail).
//
// Each version is sealed with AES-256-GCM under EMAIL_ARCHIVE_KEY, a 32-byte
// base64 key that exists only in the server environment. There is no decrypt
// function in the app on purpose: nothing a student or visitor can reach reads
// this data back. The learner that eventually reads it gets its own
// server-only module.
//
// Archiving never blocks the student. If the key is missing or the write
// fails, the send is still recorded and the failure is logged.

const KEY_VERSION = 1;

/**
 * How long a sealed email may be kept, in months.
 *
 * Not a tuning knob: the published Privacy Policy retention table and AI
 * notice 7.6 promise "24 months after each email is archived", so this number
 * and that sentence have to say the same thing. Changing it means changing the
 * published text in the same commit.
 */
export const ARCHIVE_RETENTION_MONTHS = 24;

/** The date before which an archived email is past its 24 months. */
export function archiveExpiryCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_RETENTION_MONTHS);
  return cutoff;
}

/**
 * Deletes every archived email past its 24 months, and says how many went.
 *
 * The promise was published with nothing behind it: rows were written on every
 * send and deleted only when the student opted out of Training Use or deleted
 * their account, so the oldest would have been kept forever. There is no cron
 * in this project (vercel.json declares none) and a scheduled job is not
 * something this module can add, so the table sweeps itself: every archive
 * write runs the purge, at most once every PURGE_EVERY_MS per server instance.
 * Slower than a nightly job and good enough - the table is only written when
 * students are sending email, which is exactly when it needs sweeping.
 *
 * Exported so an operator (or a scheduled job, if one is ever added) can call
 * it directly, and so the retention test can drive it with a fixed clock.
 */
export async function purgeExpiredArchives(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const gone = await db
    .delete(emailArchive)
    .where(lt(emailArchive.createdAt, archiveExpiryCutoff(now)))
    .returning();
  return gone.length;
}

/** How often one server instance bothers to sweep. */
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
let lastPurgeAt = 0;

/** The sweep as the write paths run it: throttled, and never able to fail a send. */
async function purgeSoon(): Promise<void> {
  if (Date.now() - lastPurgeAt < PURGE_EVERY_MS) return;
  lastPurgeAt = Date.now();
  try {
    const gone = await purgeExpiredArchives();
    if (gone > 0) console.info(`[email-archive] purged ${gone} archived emails past ${ARCHIVE_RETENTION_MONTHS} months`);
  } catch (e) {
    // Retention is not the student's problem: a failed sweep is logged and
    // retried by the next write.
    console.error("[email-archive] retention purge failed", e);
  }
}

/**
 * Deletes the archived copy of one draft.
 *
 * Called when the student deletes the draft. The archive's foreign key is ON
 * DELETE SET NULL, so without this the sealed row simply outlived the draft
 * with a null draft id - while the published policy says deleting a draft
 * deletes its archived copy too.
 */
export async function deleteArchivedDraft(userId: string, draftId: string): Promise<number> {
  const db = await getDb();
  const gone = await db
    .delete(emailArchive)
    .where(and(eq(emailArchive.draftId, draftId), eq(emailArchive.userId, userId)))
    .returning();
  return gone.length;
}

type EmailContent = {
  subject: string;
  body: string;
  /** The model's draft before the review pass edited it, so the review's effect can be measured. */
  preReview?: { subject: string; body: string };
  /** What the review found, and whether its edit was kept. */
  review?: unknown;
};

function archiveKey(): Buffer | null {
  const raw = process.env.EMAIL_ARCHIVE_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function seal(content: EmailContent, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

function missingKey() {
  // Refuse rather than fall back to plaintext: an archive that is sometimes
  // unencrypted is an unencrypted archive.
  console.error("[email-archive] EMAIL_ARCHIVE_KEY is missing or not 32 bytes of base64; email not archived");
}

/** Called when the model writes a draft, so the original survives the student's edits. */
export async function archiveGenerated(input: {
  userId: string;
  draftId: string;
  emailType: string;
  content: EmailContent;
}) {
  // The archive exists for the learner, so it keeps nothing from a student
  // who has not said yes to Training Use (lib/training-consent).
  if (!(await mayTrainOn(input.userId))) return;
  const key = archiveKey();
  if (!key) return missingKey();
  try {
    const db = await getDb();
    await db.insert(emailArchive).values({
      userId: input.userId,
      draftId: input.draftId,
      emailType: input.emailType,
      generatedCiphertext: seal(input.content, key),
      keyVersion: KEY_VERSION,
    });
    await purgeSoon();
  } catch (e) {
    console.error("[email-archive] could not archive generated draft", e);
  }
}

/** Called each time the student marks a draft sent; the latest one wins. */
export async function archivePushed(input: {
  userId: string;
  draftId: string;
  emailType: string;
  content: EmailContent;
  resumeAttached: boolean;
}) {
  if (!(await mayTrainOn(input.userId))) return;
  const key = archiveKey();
  if (!key) return missingKey();
  try {
    const db = await getDb();
    const sealed = seal(input.content, key);
    const updated = await db
      .update(emailArchive)
      .set({
        finalCiphertext: sealed,
        resumeAttached: input.resumeAttached,
        pushCount: sql`${emailArchive.pushCount} + 1`,
        pushedAt: new Date(),
      })
      .where(and(eq(emailArchive.draftId, input.draftId), eq(emailArchive.userId, input.userId)))
      .returning();

    // Drafts written before the archive existed have no row to complete.
    if (updated.length === 0) {
      await db.insert(emailArchive).values({
        userId: input.userId,
        draftId: input.draftId,
        emailType: input.emailType,
        finalCiphertext: sealed,
        resumeAttached: input.resumeAttached,
        pushCount: 1,
        pushedAt: new Date(),
        keyVersion: KEY_VERSION,
      });
    }
    await purgeSoon();
  } catch (e) {
    console.error("[email-archive] could not archive pushed email", e);
  }
}
