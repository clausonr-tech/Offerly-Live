"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import { getDb } from "@/db/client";
import { computeRelevanceScore } from "@/lib/relevance";
import { contacts, emailDrafts, outreachSends } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { replaceStudentResume } from "@/lib/resume-profile";
import { findStudentResume, readStudentResume } from "@/lib/resume-file";
import { archiveGenerated, archivePushed, deleteArchivedDraft } from "@/lib/email-archive";
import { recordOutreachSend, undoOutreachSend } from "@/lib/outreach-ladder-db";
import { reconcileThankYouJobs, reopenOwedThankYouJobs } from "@/lib/thank-you-db";
import { SUGGESTED_FIELDS, isSuggestedField } from "@/lib/draft-suggestions";
import { suggestionRecord } from "@/lib/draft-suggestions-db";
import { localDateString } from "@/lib/time-zone";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import { resolveRecipient } from "@/lib/draft-recipient";
import { draftAttachesResume, draftLabel, mentionsAttachedResume } from "@/lib/draft-templates";
import { answerFor, resolveSituation, situationQuestions, situationTypes } from "@/lib/draft-occasions";
import { generateEmailDraft, type DraftBrief } from "@/lib/generate-draft";
import { resumeLooksLikeSomeoneElses } from "@/lib/draft-lint";
import { blockedInForm, blockedLanguageError } from "@/lib/content-limits";
import { reserveMonthlyUse } from "@/lib/plan-quotas";
import { captureExample, forgetExample, wasEdited } from "@/lib/training-capture";
import { draftFormLabels } from "@/lib/draft-field-labels";
import { DRAFT_INPUT_FIELDS, DRAFT_SKIP_FIELDS, runGenerateDraft } from "./draft-request";

export type ActionState = { error?: string } | undefined;

const MAX_SUBJECT = 500;
const MAX_BODY = 20_000;

/** What the composer opens with. */
export type ComposerDraft = {
  id: string;
  to: string;
  contactName: string;
  subject: string;
  body: string;
  /** The resume the student should attach when they send it, for cold emails. */
  attachmentName: string | null;
  /** What to read before sending: what the draft softened or left out, files to attach by hand. */
  notes?: string[];
  /** When the student sent it (copied it out, or ticked "I sent this"). ISO,
   *  null or absent while unsent. */
  sentAt?: string | null;
};

export type GenerateState = { error?: string; draft?: ComposerDraft } | undefined;

export type DraftInput = { label: string; value: string };

// The form's fields as the student saw them, in form order. Anything not
// listed (the file upload, hidden routing fields) isn't something they typed.
const INPUT_FIELDS: [name: string, label: string][] = [
  ["outsideName", "Name"],
  ["outsideFirm", "Firm"],
  ["outsideEmail", "Email"],
  ["outsideRole", "Role"],
  ["outsideGroup", "Group or division"],
  ["outsideSchool", "Their school"],
  ["outsideLinkedin", "Their LinkedIn"],
  ["outsideBackground", "What you know about them"],
  ["financeInterest", "What part of finance draws you"],
  ["wantToLearn", "What you want to learn from them"],
  ["specificReason", "What you have in common"],
  ["originalSubject", "Subject line of your email"],
  ["originalDate", "When you sent it"],
  ["originalAsk", "What you asked for"],
  ["followUp1Date", "When you sent follow-up #1"],
  ["meetingWhen", "When"],
  ["interviewTeam", "Firm and team"],
  ["conversationDetails", "What you discussed"],
  ["personalConnection", "How it connects to you"],
  ["nextStepAsk", "What you asked next"],
  ["introName", "Intro to"],
  ["introReason", "Why them"],
  ["extraContext", "Anything else to include"],
];

const NEXT_STEP_LABELS: Record<string, string> = {
  who_else: "Who else I should talk to",
  intro: "An intro to someone specific",
  none: "No ask, just thanks",
};

// Nothing on this form is more than a few sentences, but a server action can
// be posted megabytes: before this, the only bound on what reached a paid
// model was the body limit in next.config.ts, and a quota unit is a row rather
// than tokens - so one allowed draft could carry an arbitrary prompt. These
// caps sit far above real use (the practice grader's is 4,000) and refuse the
// rest by field name. Checked before the language scan, so the scan never runs
// over a megabyte of text either.
const FIELD_MAX = 2000;
const FIELD_MAX_OVERRIDES: Record<string, number> = { extraContext: 4000 };

function tooLongInput(formData: FormData): string | null {
  const fields: [name: string, label: string][] = [
    ...INPUT_FIELDS,
    ["purpose", "What kind of email this is"],
  ];
  for (const [name, label] of fields) {
    const max = FIELD_MAX_OVERRIDES[name] ?? FIELD_MAX;
    if (String(formData.get(name) ?? "").trim().length > max) {
      return `"${label}" is too long - keep it under ${max.toLocaleString()} characters.`;
    }
  }
  return null;
}

function collectInputs(
  formData: FormData,
  context: { typeLabel: string; to: string; purposeLabel: string; typeFields: DraftInput[] },
): DraftInput[] {
  const value = (name: string) => String(formData.get(name) ?? "").trim();
  const inputs: DraftInput[] = [
    { label: "Situation", value: context.typeLabel },
    { label: "To", value: context.to },
    ...context.typeFields,
  ];
  if (value("useOfferlyOriginal") === "1") {
    inputs.push({ label: "Following up on", value: "Your cold email drafted in Offerly" });
  }
  for (const [name, label] of INPUT_FIELDS) {
    const v = value(name);
    if (v) inputs.push({ label, value: name === "nextStepAsk" ? (NEXT_STEP_LABELS[v] ?? v) : v });
  }
  if (value("purpose")) inputs.push({ label: context.purposeLabel, value: value("purpose") });
  inputs.push({
    label: "Email adds signature",
    value: formData.get("gmailSignature") === "on" ? "Yes - ends on \"Best,\"" : "No - contact info added",
  });
  return inputs;
}

/**
 * The model's notes for the student, plus the ones the app can work out itself
 * and shouldn't leave to the model to remember.
 */
function studentNotes(
  fromModel: string[],
  ctx: {
    materials?: string;
    alumTypeWithoutSharedSchool: boolean;
    contactName: string;
    saysAttachedWithoutResume: boolean;
    /** The resume the student attaches to this email, if any. */
    resumeFilename: string | null;
    studentName: string;
  },
): string[] {
  const notes = [...fromModel];
  const mentions = (word: string) => notes.some((n) => n.toLowerCase().includes(word.toLowerCase()));
  // The composer already reminds the student to attach their resume; anything
  // else a recruiter asked for needs its own reminder.
  if (ctx.materials && !mentions(ctx.materials)) {
    notes.push(`Attach your ${ctx.materials} to the email before sending.`);
  }
  // A resume named for someone else is almost always the wrong file uploaded.
  if (ctx.resumeFilename && resumeLooksLikeSomeoneElses(ctx.resumeFilename, ctx.studentName)) {
    notes.push(`The attached resume is named "${ctx.resumeFilename}", which doesn't look like your name. Check it's your resume before sending.`);
  }
  if (ctx.saysAttachedWithoutResume) {
    notes.push("The email says your resume is attached, but there's no resume on your profile. Upload one, or delete that line.");
  }
  if (ctx.alumTypeWithoutSharedSchool && !mentions("alum")) {
    notes.push(
      `We couldn't confirm ${ctx.contactName} went to your school, so this doesn't say they're an alum. "Cold email: not an alum" may fit better.`,
    );
  }
  return notes;
}

/**
 * The draft form's action. Everything it does lives in runGenerateDraft
 * (./draft-request), which the streaming route runs too, so the two cannot
 * drift apart.
 *
 * The blocked-language gate is called here as well as inside it: every entry
 * point carries the check in its own body, so adding one cannot quietly skip
 * it (lib/content-limits, scripts/content-limits-coverage-test).
 */
export async function generateDraft(
  _prevState: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  // The hand-kept list names 15 of the 139 boxes a student can type into, so
  // everything else came back as "One of your answers" - including `purpose`,
  // the custom occasion's only box. draftFormLabels() derives the rest from the
  // question definitions; the hand list stays on top because it owns the
  // recipient block and reads better for the intro fields.
  const blocked = blockedInForm(formData, { ...draftFormLabels(), ...Object.fromEntries(DRAFT_INPUT_FIELDS) }, DRAFT_SKIP_FIELDS);
  if (blocked) return { error: blocked };
  return runGenerateDraft(formData);
}

export async function saveDraftEdits(
  draftId: string,
  subject: string,
  body: string,
): Promise<{ error?: string }> {
  const cleanSubject = String(subject ?? "").trim();
  const cleanBody = String(body ?? "");
  if (!cleanSubject || !cleanBody.trim()) return { error: "Add a subject and a message first." };
  if (cleanSubject.length > MAX_SUBJECT || cleanBody.length > MAX_BODY) {
    return { error: "That email is too long to save." };
  }
  // The student's own edits get the same limits as the form (lib/content-limits).
  const blocked = blockedLanguageError([["Subject", cleanSubject], ["Message", cleanBody]]);
  if (blocked) return { error: blocked };

  const user = await getCurrentUser();
  const db = await getDb();

  // Read before writing: the row still holds the frozen model output and the
  // contact this was addressed to, and both are needed to build the training
  // example. After the update the working copy is gone.
  const existing = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)),
    with: { contact: true },
  });

  await db
    .update(emailDrafts)
    .set({ subject: cleanSubject, body: cleanBody, updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)));

  // Only meaningful when we know what the model originally wrote - drafts
  // predating modelSubject/modelBody have nothing to compare against, and a
  // "correction" with no original is not a training example, it is just text.
  if (existing?.modelSubject && existing.modelBody) {
    const edited =
      wasEdited(existing.modelSubject, subject) || wasEdited(existing.modelBody, body);
    await captureExample({
      userId: user.id,
      task: "email_draft",
      outcome: edited ? "edited" : "accepted",
      sourceId: draftId,
      promptContext: {
        kind: existing.kind,
        purpose: existing.purpose,
        templateId: existing.templateId,
        contactRole: existing.contact?.role ?? null,
        contactSchool: existing.contact?.school ?? null,
      },
      modelOutput: { subject: existing.modelSubject, body: existing.modelBody },
      humanOutput: edited ? { subject, body } : undefined,
      identities: {
        student: { name: user.name, email: user.email },
        contact: {
          name: existing.contact?.name,
          email: existing.contact?.email,
          firm: existing.contact?.firm,
        },
        school: user.school,
      },
    });
  }

  revalidatePath("/outreach");
  revalidatePath(`/drafts/${draftId}`);
  return {};
}

export async function deleteDraft(draftId: string) {
  const user = await getCurrentUser();
  const db = await getDb();

  const draft = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)),
    columns: { kind: true, sentAt: true },
  });
  // Everything this draft left elsewhere goes BEFORE the draft itself.
  //
  // Neither of these follows from deleting the row: the archive's foreign key
  // is ON DELETE SET NULL, so its sealed copy survived the draft with a null
  // draft id - and once it is null there is nothing left to find it by, which
  // is why this runs first - and training_examples.source_id is not a foreign
  // key at all, so the example survived too. Both deletions are promised in
  // the published privacy policy ("deleting a draft deletes its archived copy
  // and any training example taken from it"), and both are owner-scoped, so a
  // draft id belonging to someone else reaches nothing of theirs.
  if (draft) {
    await deleteArchivedDraft(user.id, draftId);
    await forgetExample({ userId: user.id, task: "email_draft", sourceId: draftId });
  }

  await db
    .delete(emailDrafts)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)));

  // A sent thank-you deleted is one no longer on record: whatever it answered
  // is owed again, and its bell job comes back with it.
  if (draft?.kind === "thank_you" && draft.sentAt) await reopenOwedThankYouJobs(user.id);

  revalidatePath("/outreach");
  revalidatePath("/drafts");
  redirect("/drafts");
}

/** The fields the student clicked "Use this" on, as the form sends them. Only
 *  known field names survive; anything else in the list is ignored. */
function parseTaken(value: FormDataEntryValue | null): string[] {
  try {
    const list = JSON.parse(String(value ?? "[]"));
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && isSuggestedField(f)) : [];
  } catch {
    return [];
  }
}

// One address, no display name, no separators.
const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** The kinds of email that climb the cold-email ladder. A thank-you does not. */
const LADDER_KINDS = new Set(["cold_outreach", "follow_up"]);

export type SendResult = {
  error?: string;
  /** Set when this send was recorded as an email on the contact's ladder. */
  sent?: { sendId: string; step: number; contactName: string };
};

/**
 * The student copied this draft out of the composer, which is how an email
 * leaves Offerly: they paste it into their own mail and send it from there.
 * So a copy is recorded as the send - see markDraftSent.
 */
export async function recordDraftCopied(
  draftId: string,
  input: { to: string; subject: string; body: string },
): Promise<SendResult> {
  // Checked here, at the door, as well as inside markDraftSent: what is copied
  // is about to reach a real person (lib/content-limits).
  const blocked = blockedLanguageError([["Subject", String(input.subject ?? "")], ["Message", String(input.body ?? "")]]);
  if (blocked) return { error: blocked };
  return markDraftSent(draftId, input, "copy");
}

/**
 * The "I sent this" box under the composer. Ticked, it records the send
 * exactly as a copy does; unticked, it takes it back. Copying ticks it, so the
 * box always says what Offerly has on record.
 */
export async function setDraftSent(
  draftId: string,
  sent: boolean,
  input: { to: string; subject: string; body: string },
): Promise<SendResult> {
  if (sent) {
    // Ticking saves the composer's text as the version that went, so it gets
    // the same check as a copy. Unticking saves nothing typed.
    const blocked = blockedLanguageError([["Subject", String(input.subject ?? "")], ["Message", String(input.body ?? "")]]);
    if (blocked) return { error: blocked };
    return markDraftSent(draftId, input, "manual");
  }

  const user = await getCurrentUser();
  const db = await getDb();
  const draft = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)),
    columns: { id: true, kind: true },
  });
  if (!draft) return { error: "Couldn't find that draft." };

  await db
    .update(emailDrafts)
    .set({ sentAt: null, updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)));

  // A thank-you taken back is owed again: its bell job comes back with it.
  if (draft.kind === "thank_you") await reopenOwedThankYouJobs(user.id);

  // Its rung on the ladder goes too, when it is the latest one. An earlier
  // rung stays: taking back email 1 from under email 2 would leave a ladder
  // that says a follow-up went to someone never written to.
  const rung = await db.query.outreachSends.findFirst({
    where: and(eq(outreachSends.draftId, draftId), eq(outreachSends.userId, user.id)),
    columns: { id: true },
  });
  if (rung) await undoOutreachSend(user.id, rung.id);

  revalidatePath("/outreach");
  revalidatePath(`/drafts/${draftId}`);
  revalidatePath("/networking", "layout");
  revalidatePath("/contacts", "layout");
  return {};
}

/**
 * Record that this draft was sent.
 *
 * Saves the version that went, seals it into the archive beside what the model
 * wrote - the drafted-versus-sent pair is the most valuable training signal
 * this product collects - and then keeps the rest of the app true to it:
 *
 *   - a cold email or follow-up to a saved contact goes on that person's ladder,
 *     so the next follow-up is prompted a week from now;
 *   - a thank-you closes the thank-you prompt about that person, and an
 *     interview thank-you the prompt about the interview it followed.
 *
 * Idempotent per draft: sending the same draft twice is one email.
 */
async function markDraftSent(
  draftId: string,
  input: { to: string; subject: string; body: string },
  source: "copy" | "manual",
): Promise<SendResult> {
  const to = String(input.to ?? "").trim();
  const subject = String(input.subject ?? "").trim();
  const body = String(input.body ?? "");

  if (!subject || !body.trim()) return { error: "Add a subject and a message first." };
  if (subject.length > MAX_SUBJECT || body.length > MAX_BODY) return { error: "That email is too long to send." };
  // What went is going to a real person: same limits as the form and the
  // editor (lib/content-limits).
  const blocked = blockedLanguageError([["Subject", subject], ["Message", body]]);
  if (blocked) return { error: blocked };

  const user = await getCurrentUser();
  const db = await getDb();

  const draft = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)),
    // The name and the firm too: the training capture strips both out of the
    // stored example, and a column left out of this list is a column the
    // de-identifier is never given - which is how the firm survived in the
    // corpus while the policy said it was removed.
    with: { contact: { columns: { id: true, email: true, name: true, firm: true } } },
  });
  if (!draft) return { error: "Couldn't find that draft." };

  // Saved as sent, so the draft in Offerly is the email that went out. The
  // first send's time is kept: a second copy is the same email, not a new one.
  await db
    .update(emailDrafts)
    .set({ subject, body, sentAt: draft.sentAt ?? new Date(), updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, user.id)));

  // An address typed into the To line fills a gap on the contact, never
  // overwrites one the student already saved.
  if (draft.contact && !draft.contact.email && EMAIL_PATTERN.test(to)) {
    await db
      .update(contacts)
      .set({ email: to })
      .where(and(eq(contacts.id, draft.contact.id), eq(contacts.userId, user.id)));
  }

  await archivePushed({
    userId: user.id,
    draftId,
    emailType: draft.templateId ?? draft.kind,
    content: { subject, body },
    // Offerly no longer attaches anything; the student does, in their own mail.
    resumeAttached: false,
  });

  if (draft.modelSubject && draft.modelBody) {
    const edited = wasEdited(draft.modelSubject, subject) || wasEdited(draft.modelBody, body);
    await captureExample({
      userId: user.id,
      task: "email_draft",
      // "delivered" outranks accepted/edited: the student sent this to a real
      // person, which is a stronger endorsement than saving it.
      outcome: "delivered",
      sourceId: draftId,
      promptContext: {
        kind: draft.kind,
        purpose: draft.purpose,
        templateId: draft.templateId,
      },
      modelOutput: { subject: draft.modelSubject, body: draft.modelBody },
      humanOutput: edited ? { subject, body } : undefined,
      identities: {
        student: { name: user.name, email: user.email },
        // Same identities the saveDraft capture passes - including the firm.
        // This row upserts over that one, so an omission here does not just
        // under-redact this write, it replaces a correctly redacted example.
        contact: { name: draft.contact?.name, email: draft.contact?.email ?? to, firm: draft.contact?.firm },
        school: user.school,
      },
    });
  }

  // Someone thanked has been spoken to: an interviewer saved from "Outside of
  // your matched contacts" lands as "not contacted", and left there would come
  // back two days later as a contact to cold-email before their firm opens.
  if (draft.kind === "thank_you" && draft.contactId) {
    await db
      .update(contacts)
      .set({
        relationshipStatus: "in_conversation",
        lastContactDate: localDateString(new Date(), await getStudentTimeZone()),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contacts.id, draft.contactId),
          eq(contacts.userId, user.id),
          eq(contacts.relationshipStatus, "not_contacted"),
        ),
      );
  }

  // Closes whichever thank-you jobs this answered - the chat with this person,
  // or the interview it followed - judged by when it was first sent, so a
  // second copy of Tuesday's note never closes Wednesday's chat.
  if (draft.kind === "thank_you") await reconcileThankYouJobs(user.id);

  const sent =
    draft.contactId && LADDER_KINDS.has(draft.kind)
      ? await recordOutreachSend({
          userId: user.id,
          contactId: draft.contactId,
          draftId,
          source,
        })
      : null;

  revalidatePath("/outreach");
  revalidatePath(`/drafts/${draftId}`);
  revalidatePath("/", "layout");
  return sent ? { sent } : {};
}
