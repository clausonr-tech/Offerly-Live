"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";
import { isLinkedinUrl } from "@/lib/validation";

export type ActionState = { error?: string } | undefined;

/** Rows accepted in one file. */
const MAX_ROWS = 2000;

/** How much posted text is read at all: the row and field caps only apply
 *  once the JSON is parsed, so without this the only bound is the 4.4mb
 *  server-action body limit. A LinkedIn export of 2,000 connections is a
 *  fraction of this. */
const MAX_IMPORT_CHARS = 2_000_000;

/** Contacts one student holds. Imports are the only way to add them in bulk
 *  and can be repeated, so the total is capped, not just the file. */
const MAX_CONTACTS = 10_000;

/** Imports per student per hour: enough to fix a file and try again. */
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60_000;

const importRowSchema = z.object({
  name: z.string().min(1).max(200),
  firm: z.string().max(200).optional().default(""),
  role: z.string().max(200).optional().default(""),
  email: z.string().max(200).optional().default(""),
  /**
   * The same scheme-and-host rule the single-contact form applies, because
   * this is the OTHER way a contact gets a LinkedIn URL and it had no rule at
   * all - a `javascript:` cell in a CSV became an href on the contacts grid.
   *
   * Dropped rather than rejected, which is where this differs from
   * contactSchema: the form has a field to put a message next to, and this
   * action has one error string for a whole file. Voiding a 2,000-row export
   * over one bad cell loses every name in it, so the row is kept and the
   * unusable link is not stored. Nothing unrenderable reaches the column
   * either way, which is the point of the check.
   */
  linkedinUrl: z
    .string()
    .max(500)
    .optional()
    .default("")
    .transform((v) => (isLinkedinUrl(v) ? v : "")),
  school: z.string().max(200).optional().default(""),
  notes: z.string().max(4000).optional().default(""),
  lastContactDate: z.string().optional().default(""),
});

export async function bulkImportContacts(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formData.get("rows");
  if (typeof raw !== "string") {
    return { error: "No rows to import" };
  }
  if (raw.length > MAX_IMPORT_CHARS) {
    return { error: "That file is too large to import. Split it into smaller files and try again." };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: "Could not read parsed CSV data" };
  }

  const arraySchema = z.array(importRowSchema).max(MAX_ROWS);
  const parsed = arraySchema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.length === 0) {
    return { error: "No valid rows to import" };
  }

  // The check runs on the values that are about to be stored, not on the JSON
  // text that carried them: checking the text checked the transport encoding
  // instead of the words, and a \u escape inside a word reads to a whole-word
  // matcher as no word at all until JSON.parse decodes it. Email addresses and
  // the LinkedIn URL are not words a person writes, so they are left out, the
  // same way the single-contact form leaves them out.
  for (const row of parsed.data) {
    const blocked = blockedLanguageError([
      ["Name", row.name],
      ["Firm", row.firm],
      ["Role", row.role],
      ["School", row.school],
      ["Notes", row.notes],
    ]);
    if (blocked) return { error: blocked };
  }

  const userId = await getCurrentUserId();
  const gate = await rateLimit("import:contacts", userId, IMPORT_LIMIT, IMPORT_WINDOW_MS);
  if (!gate.allowed) {
    return {
      error: `You've imported a lot of files just now. Try again in about ${retryAfterText(gate.retryAfterMs)}.`,
    };
  }
  const db = await getDb();

  const [{ held }] = await db
    .select({ held: count() })
    .from(contacts)
    .where(eq(contacts.userId, userId));
  if (held + parsed.data.length > MAX_CONTACTS) {
    return {
      error: `Your contacts list holds up to ${MAX_CONTACTS.toLocaleString()} people, and this file would take it past that. Remove some, or import fewer rows.`,
    };
  }

  await db.insert(contacts).values(
    parsed.data.map((row) => ({
      userId,
      name: row.name,
      firm: row.firm || null,
      role: row.role || null,
      email: row.email || null,
      linkedinUrl: row.linkedinUrl || null,
      school: row.school || null,
      notes: row.notes || null,
      lastContactDate: row.lastContactDate || null,
      relationshipStatus: "not_contacted" as const,
    })),
  );

  revalidatePath("/contacts");
  redirect("/contacts");
}
