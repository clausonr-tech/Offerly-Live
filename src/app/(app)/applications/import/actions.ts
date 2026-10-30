"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, events } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";
import { parseWallClock } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { firmResolver } from "@/lib/firm-name";
import { roleParts, sameRoleParts, type RoleParts } from "@/lib/role-name";

export type ActionState = { error?: string } | undefined;

/** Rows accepted in one file. */
const MAX_ROWS = 2000;

/**
 * How much posted text is read at all.
 *
 * The row and field caps below only apply once the JSON has been parsed, so
 * without this the only bound on the text is the 4.4mb server-action body
 * limit. A real file is a fraction of this: 2,000 rows of firm, role, status
 * and a note is a few hundred kilobytes.
 */
const MAX_IMPORT_CHARS = 2_000_000;

/**
 * Applications one student's tracker holds.
 *
 * Every page that shows a reminder compares each open posting against the
 * whole tracker, so the number of rows a student can store is the number of
 * comparisons every one of their page views pays for. Imports are the only way
 * to add rows in bulk and they can be repeated, so the total is capped rather
 * than just the file.
 */
const MAX_APPLICATIONS = 5_000;

/** Imports per student per hour: enough to fix a file and try again, not
 *  enough to use the importer as a way to pile up stored rows. */
const IMPORT_LIMIT = 10;
const IMPORT_WINDOW_MS = 60 * 60_000;

const importRowSchema = z.object({
  firm: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  status: z.enum([
    "not_started",
    "in_progress",
    "submitted",
    "interviewing",
    "offer",
    "rejected",
  ]),
  notes: z.string().max(4000).optional().default(""),
  appliedDate: z.string().optional().default(""),
  deadlineDate: z.string().optional().default(""),
});

export async function bulkImportApplications(
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

  // The language check runs on the values that are about to be stored, not on
  // the JSON text that carried them. Checking the text checked the transport
  // encoding instead of the words: a \u escape inside a word reads to a
  // whole-word matcher as no word at all, and JSON.parse then handed the real
  // word to the database. The rule is that text is checked before it is saved,
  // so the check is here, after parsing, over every column that holds writing.
  for (const row of parsed.data) {
    const blocked = blockedLanguageError([
      ["Firm", row.firm],
      ["Role", row.role],
      ["Notes", row.notes],
    ]);
    if (blocked) return { error: blocked };
  }

  const userId = await getCurrentUserId();
  const gate = await rateLimit("import:applications", userId, IMPORT_LIMIT, IMPORT_WINDOW_MS);
  if (!gate.allowed) {
    return {
      error: `You've imported a lot of files just now. Try again in about ${retryAfterText(gate.retryAfterMs)}.`,
    };
  }
  const db = await getDb();

  // Two statements for the whole file rather than two per row: a 200-row
  // import was 400 sequential round trips, and the student watched every one.
  //
  // The ids are zipped back to their rows by position, which a single
  // multi-row INSERT ... RETURNING guarantees (verified against this database,
  // 25/25 in order). Splitting it into several INSERTs would break that.
  // One application is one row: a line already on the tracker - the same firm
  // by any name, the same role in any spelling - is not added again, and the
  // same line twice in the file is added once. Its deadline, if it brings one,
  // goes on the entry that already exists.
  const [existing, known] = await Promise.all([
    db.query.applications.findMany({
      where: eq(applications.userId, userId),
      columns: { id: true, firm: true, role: true },
    }),
    trackedFirmNames(userId),
  ]);
  const resolve = firmResolver(known);

  // Matching is bucketed by firm rather than scanned.
  //
  // It used to be a findIndex over every row the student had, with
  // resolve(firm) and the role split recomputed on both sides of every pair -
  // an NFKD pass, a regex chain and a sorted copy of the city list, thousands
  // of times for the same two strings. Each name is now read once, and a row
  // is only compared with the rows under the same firm key, which is the only
  // way two rows could have matched anyway. Buckets hold the student's
  // existing rows first and rows accepted from this file after, so the answer
  // is the one the old scan gave: an entry already on the tracker wins over
  // one earlier in the same file.
  type Candidate = { parts: RoleParts; target: { existingId: string } | { fresh: number } };
  const byFirm = new Map<string, Candidate[]>();
  const bucketFor = (firmKey: string) => {
    let bucket = byFirm.get(firmKey);
    if (!bucket) {
      bucket = [];
      byFirm.set(firmKey, bucket);
    }
    return bucket;
  };
  for (const a of existing) {
    bucketFor(resolve(a.firm)).push({ parts: roleParts(a.role), target: { existingId: a.id } });
  }

  const fresh: typeof parsed.data = [];
  // Each input row's application: an existing id, or the index of a fresh row.
  const target: ({ existingId: string } | { fresh: number })[] = [];
  for (const row of parsed.data) {
    const bucket = bucketFor(resolve(row.firm));
    const parts = roleParts(row.role);
    const match = bucket.find((c) => sameRoleParts(c.parts, parts));
    if (match) {
      target.push(match.target);
      continue;
    }
    fresh.push(row);
    const mine = { fresh: fresh.length - 1 };
    bucket.push({ parts, target: mine });
    target.push(mine);
  }

  // The file brings as many rows as it likes; the tracker has a ceiling, and
  // the import stops at it rather than taking the first few and leaving the
  // student guessing which.
  if (fresh.length > 0) {
    const [{ held }] = await db
      .select({ held: count() })
      .from(applications)
      .where(eq(applications.userId, userId));
    if (held + fresh.length > MAX_APPLICATIONS) {
      return {
        error: `Your tracker holds up to ${MAX_APPLICATIONS.toLocaleString()} applications, and this file would take it past that. Remove some entries, or import fewer rows.`,
      };
    }
  }

  const created = fresh.length
    ? await db
        .insert(applications)
        .values(
          fresh.map((row) => ({
            userId,
            firm: row.firm,
            role: row.role,
            status: row.status,
            notes: row.notes || null,
            appliedDate: row.appliedDate || null,
          })),
        )
        .returning()
    : [];

  // A deadline with no time is filed at 9am on the student's clock. Read in
  // the server's zone (UTC on Vercel) it was 5am in New York.
  const timeZone = await getStudentTimeZone();

  // A deadline the student already has is not filed twice. Importing the same
  // file again matched its rows to the applications already on the tracker,
  // but still inserted a deadline event per row, so the second run left two of
  // every date on the Schedule - and the reminder job treats each one as its
  // own email.
  const filed = new Set(
    (
      await db.query.events.findMany({
        where: and(eq(events.userId, userId), eq(events.type, "deadline")),
        columns: { applicationId: true, eventDate: true },
      })
    ).map((e) => `${e.applicationId ?? ""}\u0000${e.eventDate.getTime()}`),
  );
  const deadlines = parsed.data.flatMap((row, i) => {
    if (!row.deadlineDate) return [];
    const deadlineTime = parseWallClock(`${row.deadlineDate.trim()}T09:00`, timeZone);
    if (!deadlineTime) return [];
    const t = target[i];
    const applicationId = "existingId" in t ? t.existingId : created[t.fresh]?.id;
    if (!applicationId) return [];
    const already = `${applicationId}\u0000${deadlineTime.getTime()}`;
    if (filed.has(already)) return [];
    filed.add(already);
    return [
      {
        userId,
        type: "deadline" as const,
        title: `${row.firm} - ${row.role} application deadline`,
        eventDate: deadlineTime,
        applicationId,
      },
    ];
  });
  if (deadlines.length > 0) await db.insert(events).values(deadlines);

  revalidatePath("/applications");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
