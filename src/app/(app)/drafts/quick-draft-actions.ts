"use server";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, directoryPeople, emailDrafts } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { divisionsFor, firmIdFor } from "@/lib/draft-recipient";
import { quickDraftForm } from "@/lib/quick-draft";
import { isUuid } from "@/lib/firm-links";
import { computeRelevanceScore } from "@/lib/relevance";
import { findStudentResume } from "@/lib/resume-file";

import { generateDraft, type ComposerDraft } from "./actions";

export type QuickDraftResult =
  | {
      draft: ComposerDraft;
      /** True when this is an email already written to them, reopened as the
       *  student last left it rather than paid for again. */
      reused: boolean;
    }
  | { error: string };

/**
 * The "Draft email" button beside a contact: a first cold email to them,
 * written from what the app already knows.
 *
 * Takes a recipient key ("contact-<id>" for the student's own contacts,
 * "directory-<id>" for a directory person on a firm panel) and whether to
 * write a fresh one. Nothing typed reaches it, so it carries no language check
 * of its own; the facts it passes on go through generateDraft, which checks
 * them before the model and checks what the model wrote after.
 *
 * An email already drafted to this person is reopened, with the student's
 * edits, instead of writing another - every draft is two paid model calls,
 * and the one they already have is the one they were working on. `fresh`
 * writes a new one; the old one stays in Email drafts.
 */
export async function draftEmailForContact(recipientKey: string, fresh: boolean): Promise<QuickDraftResult> {
  const [kind, ...rest] = String(recipientKey ?? "").split("-");
  const id = rest.join("-");
  if ((kind !== "contact" && kind !== "directory") || !isUuid(id)) return { error: "Couldn't find that contact." };

  const user = await getCurrentUser();
  const db = await getDb();

  // The student's own contact behind this key, when there is one - for a
  // directory person, the contact they became when first emailed.
  let contact: typeof contacts.$inferSelect | undefined;
  let person: typeof directoryPeople.$inferSelect | undefined;
  if (kind === "contact") {
    contact = await db.query.contacts.findFirst({ where: and(eq(contacts.id, id), eq(contacts.userId, user.id)) });
    if (!contact) return { error: "Couldn't find that contact." };
  } else {
    person = await db.query.directoryPeople.findFirst({ where: eq(directoryPeople.id, id) });
    if (!person || person.delistedAt) return { error: "That person is no longer listed at this firm." };
    if (person.email) {
      contact = await db.query.contacts.findFirst({
        where: and(eq(contacts.userId, user.id), sql`lower(${contacts.email}) = ${person.email.toLowerCase()}`),
      });
    }
  }

  const resume = await findStudentResume(user.id);

  if (!fresh && contact) {
    const earlier = await db.query.emailDrafts.findFirst({
      where: and(
        eq(emailDrafts.userId, user.id),
        eq(emailDrafts.contactId, contact.id),
        eq(emailDrafts.kind, "cold_outreach"),
      ),
      orderBy: [desc(emailDrafts.createdAt)],
    });
    if (earlier) {
      return {
        reused: true,
        draft: {
          id: earlier.id,
          to: contact.email ?? "",
          contactName: contact.name,
          subject: earlier.subject,
          body: earlier.body,
          attachmentName: resume?.filename ?? null,
          sentAt: earlier.sentAt?.toISOString() ?? null,
        },
      };
    }
  }

  const facts = contact
    ? {
        name: contact.name,
        firm: contact.firm,
        role: contact.role,
        school: contact.school,
        background: contact.background,
        connectionAngle: contact.connectionAngle,
        linkedinUrl: contact.linkedinUrl,
      }
    : {
        name: person!.name,
        firm: person!.firmName,
        role: person!.title,
        school: person!.school,
        background: person!.jobHistory,
        connectionAngle: null,
        linkedinUrl: person!.linkedinUrl,
      };
  const firmId = person?.firmId ?? (facts.firm ? await firmIdFor(user.id, facts.firm) : null);
  const sameSchool = computeRelevanceScore(user, {
    school: facts.school,
    background: facts.background,
    notes: null,
  }).reasons.includes("Same school");

  const { box, fields } = quickDraftForm({ ...facts, sameSchool, divisions: await divisionsFor(firmId) });

  // The same form the Email drafts page submits, so this is the same email:
  // same drafter and review pass, same checks, saved the same way.
  const form = new FormData();
  form.set("recipient", contact ? `contact-${contact.id}` : `directory-${id}`);
  form.set("occasion", "first_contact");
  form.append("box", box);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  const result = await generateDraft(undefined, form);
  if (!result?.draft) return { error: result?.error ?? "Couldn't write that email. Try again." };
  return { reused: false, draft: result.draft };
}
