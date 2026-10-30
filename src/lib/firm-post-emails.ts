import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firmRecruitingEvents, firms, internshipPostings, studentEmailPrefs, users } from "@/db/schema";
import { sendEmail } from "@/lib/email";
import { eventKindLabel, type FirmEventKind } from "@/lib/firm-posting-rules";
import { firmPostEmail } from "@/lib/firm-post-emails-rules";

// Emails the students a firm's post was just sent to, so a student who does
// not open Offerly still hears when a firm they match with posts.
//
// Who: exactly the students the bell was just written for (lib/firm-delivery
// returns them), minus demo accounts, minus anyone who turned these emails off
// (student_email_prefs, set on Profile -> Connections). Run after the firm's
// response has gone (next/server `after`), so a firm with a thousand matches
// does not wait on a thousand emails.
//
// Until migration 0019 has created student_email_prefs, nothing is sent: the
// off switch has to exist before the emails do.

const CONCURRENCY = 4;
const MAX_PER_POST = 5000;

export async function emailStudentsAboutPost(input: {
  kind: "internship" | "event";
  postId: string;
  studentIds: string[];
  /** Where the app is served, e.g. https://offerly.app - for the link in the email. */
  baseUrl: string | null;
}): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (input.studentIds.length === 0) return result;
  const db = await getDb();

  let optedOut: Set<string>;
  try {
    const rows = await db
      .select({ userId: studentEmailPrefs.userId })
      .from(studentEmailPrefs)
      .where(and(inArray(studentEmailPrefs.userId, input.studentIds), eq(studentEmailPrefs.firmPosts, false)));
    optedOut = new Set(rows.map((r) => r.userId));
  } catch {
    // No preferences table yet: no way to turn these off, so none are sent.
    return { ...result, skipped: input.studentIds.length };
  }

  const post =
    input.kind === "internship"
      ? await db
          .select({ title: internshipPostings.roleTitle, firmName: firms.name, firmSlug: firms.slug, category: internshipPostings.categories, when: internshipPostings.deadlineDate, place: internshipPostings.location })
          .from(internshipPostings)
          .innerJoin(firms, eq(firms.id, internshipPostings.firmId))
          .where(eq(internshipPostings.id, input.postId))
          .then((r) => r[0])
      : await db
          .select({ title: firmRecruitingEvents.title, firmName: firms.name, firmSlug: firms.slug, kind: firmRecruitingEvents.eventKind, kindLabel: firmRecruitingEvents.kindLabel, when: firmRecruitingEvents.eventDate, place: firmRecruitingEvents.location, school: firmRecruitingEvents.school })
          .from(firmRecruitingEvents)
          .innerJoin(firms, eq(firms.id, firmRecruitingEvents.firmId))
          .where(eq(firmRecruitingEvents.id, input.postId))
          .then((r) => r[0]);
  if (!post) return result;

  const students = await db
    .select({ id: users.id, email: users.email, name: users.name, isDemo: users.isDemo, accountType: users.accountType })
    .from(users)
    .where(inArray(users.id, input.studentIds.slice(0, MAX_PER_POST)));
  const to = students.filter((u) => u.accountType === "student" && !u.isDemo && !optedOut.has(u.id));
  result.skipped = input.studentIds.length - to.length;

  const path =
    input.kind === "internship"
      ? `/discovery/${("category" in post && post.category?.[0]) || "investment_banking"}/internships`
      : `/discovery/firm/${post.firmSlug}`;

  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < to.length) {
        const student = to[next++];
        const message = firmPostEmail({
          kind: input.kind,
          firmName: post.firmName,
          title: post.title,
          eventKind: "kind" in post ? eventKindLabel(post.kind as FirmEventKind, "kindLabel" in post ? post.kindLabel : null) : undefined,
          when: post.when,
          place: post.place,
          school: "school" in post ? post.school : null,
          studentName: student.name,
          link: input.baseUrl ? `${input.baseUrl}${path}` : null,
          settingsLink: input.baseUrl ? `${input.baseUrl}/profile/connections` : null,
        });
        try {
          await sendEmail({ to: student.email, subject: message.subject, text: message.text });
          result.sent++;
        } catch (err) {
          result.failed++;
          console.error("[firm-post-emails]", err instanceof Error ? err.message : err);
        }
      }
    }),
  );
  return result;
}

/** A student's choice, on by default. False only when they turned it off. */
export async function firmPostEmailsOn(userId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const row = await db.query.studentEmailPrefs.findFirst({ where: eq(studentEmailPrefs.userId, userId) });
    return row?.firmPosts ?? true;
  } catch {
    return true;
  }
}

export async function setFirmPostEmails(userId: string, on: boolean): Promise<boolean> {
  try {
    const db = await getDb();
    await db
      .insert(studentEmailPrefs)
      .values({ userId, firmPosts: on, updatedAt: new Date() })
      .onConflictDoUpdate({ target: studentEmailPrefs.userId, set: { firmPosts: on, updatedAt: new Date() } });
    return true;
  } catch {
    return false;
  }
}
