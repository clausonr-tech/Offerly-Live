// Drafting one email, end to end, as both the form's server action and the
// streaming route run it.
//
// `generateDraft` (./actions) used to hold all of this. It was lifted here
// unchanged so the streaming route (app/api/drafts/generate) can run the SAME
// code rather than a second copy of it: there is one place that reads the form,
// one place that calls the pipeline, one place that writes the row, and one set
// of gates. The only difference between the two callers is whether they pass
// `onEvent`.
//
// Not a "use server" file on purpose: its exports are plain functions, and a
// "use server" module may only export server actions.

import "server-only";
import { desc, eq, and } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { computeRelevanceScore } from "@/lib/relevance";
import { emailDrafts } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { replaceStudentResume } from "@/lib/resume-profile";
import { findStudentResume, readStudentResume } from "@/lib/resume-file";
import { archiveGenerated } from "@/lib/email-archive";
import { SUGGESTED_FIELDS, isSuggestedField } from "@/lib/draft-suggestions";
import { suggestionRecord } from "@/lib/draft-suggestions-db";
import { resolveRecipient } from "@/lib/draft-recipient";
import { draftAttachesResume, draftLabel, mentionsAttachedResume } from "@/lib/draft-templates";
import { answerFor, resolveSituation, situationQuestions, situationTypes } from "@/lib/draft-occasions";
import { briefFromForm, typeFieldsFor } from "@/lib/draft-form-answers";
import { generateEmailDraft, type DraftBrief } from "@/lib/generate-draft";
import { resumeLooksLikeSomeoneElses } from "@/lib/draft-lint";
import { blockedInForm } from "@/lib/content-limits";
import { draftFormLabels } from "@/lib/draft-field-labels";
import { isUuid } from "@/lib/firm-links";
import { reserveMonthlyUse } from "@/lib/plan-quotas";
import type { PipelineEvent } from "@/lib/draft-pipeline";

/**
 * Streaming the draft to the composer, off by default.
 *
 * Read on every request rather than at module load, so it can be turned on
 * without a rebuild. Off, or missing, means the form posts to the server action
 * exactly as it always has - which is also what a dead stream falls back to.
 */
export function draftStreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OFFERLY_DRAFT_STREAM === "on";
}

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
/**
 * The form's fields with the labels the student saw, for the blocked-language
 * gate. Exported because every entry point runs that gate in its own body -
 * the server action, the streaming route and this module - so a new entry point
 * cannot reach the model without one (scripts/content-limits-coverage-test).
 */
export const DRAFT_INPUT_FIELDS: [name: string, label: string][] = [
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
  for (const [name, label] of DRAFT_INPUT_FIELDS) {
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


/** Form fields that carry no words: ids, fixed choices and flags. */
export const DRAFT_SKIP_FIELDS = ["recipient", "occasion", "box", "gmailSignature", "useOfferlyOriginal"];

/**
 * How much of one answer reaches the model.
 *
 * Matched to the caps the rest of the pipeline already has: the outside
 * recipient's "what you know about them" is 2,000 (lib/draft-recipient), and a
 * saved email body is 20,000 (./actions). Every form field here answers a
 * one-line question, so 2,000 is already far past any honest answer; `purpose`
 * and `extraContext` get 4,000 because they are the two a student may
 * reasonably write a paragraph into.
 */
export const FIELD_MAX = 2_000;
export const LONG_FIELD_MAX = 4_000;

/**
 * One form answer as the model will see it: trimmed, and no longer than `max`.
 *
 * Exported so the cap is one function with one test rather than a `.slice` in
 * four places (scripts/draft-pipeline-flow-test.ts).
 */
export function capAnswer(value: FormDataEntryValue | null | undefined, max = FIELD_MAX): string {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * The message for a recipient key whose id could never be a row id, or null
 * when it could be.
 *
 * `contacts.id` and `directory_people.id` are `uuid` columns, so an id that is
 * not one arrives at Postgres as a malformed `uuid` parameter and raises 22P02
 * out of the server action: the student gets a 500 where they should get a
 * sentence (INPUT-2 F7). The two sibling resolvers already check this
 * (`loadRecipient` in lib/draft-suggestions-db, `draftEmailForContact` in
 * quick-draft-actions); `resolveRecipient` does not, and that file is not this
 * one, so the check lives at its only caller in the app.
 */
export function recipientIdError(recipient: string): string | null {
  for (const prefix of ["contact-", "directory-"]) {
    if (recipient.startsWith(prefix) && !isUuid(recipient.slice(prefix.length))) {
      return "Couldn't find that person. Choose who this email is for again.";
    }
  }
  return null;
}

/**
 * Read the form, draft the email, run every gate, save the row.
 *
 * `onEvent`, when given, is handed straight to the pipeline, which then
 * streams the draft call and reports the plan, the subject and the body as the
 * model writes them (lib/draft-stream). It changes NOTHING about what is
 * saved: the row below is still written once, after the review pass, the
 * deterministic fixes, draftChecks and the final findBlockedLanguage. The
 * events are a view of text on its way past, never the text of record.
 */
// A request can carry megabytes while a draft costs one monthly use, so one
// allowed draft could otherwise carry an arbitrary prompt. These caps sit far
// above real use and REFUSE by field name rather than truncating: a student
// whose paragraph is silently cut would never know. Checked before anything
// else - the language scan included - so nothing downstream runs over a
// megabyte of text. (Main's behaviour and its test; this branch had only a
// silent cap, and the generate path lives here now.)
function tooLongInput(formData: FormData): string | null {
  const fields: [name: string, label: string][] = [
    ...DRAFT_INPUT_FIELDS,
    ["purpose", "What kind of email this is"],
  ];
  for (const [name, label] of fields) {
    const max = name === "extraContext" || name === "purpose" ? LONG_FIELD_MAX : FIELD_MAX;
    if (String(formData.get(name) ?? "").trim().length > max) {
      return `"${label}" is too long - keep it under ${max.toLocaleString()} characters.`;
    }
  }
  return null;
}

export async function runGenerateDraft(
  formData: FormData,
  opts: { onEvent?: (event: PipelineEvent) => void } = {},
): Promise<GenerateState> {
  // "contact-<id>", "directory-<id>" or "outside" - see lib/draft-recipient.ts.
  const recipient = String(formData.get("recipient") ?? "");
  // Cheapest check first: refuse an impossible field before anything reads it.
  const tooLong = tooLongInput(formData);
  if (tooLong) return { error: tooLong };
  // Rebuilt from the checked boxes rather than trusted from the browser: the
  // strongest box's type writes the email, the rest are worked in.
  const situation = resolveSituation(String(formData.get("occasion") ?? ""), formData.getAll("box").map(String));
  // Both capped at the longer limit: they are the two fields a student may
  // legitimately write a paragraph into, and `purpose` is the only signal the
  // model gets for a "custom" email.
  const extraContext = capAnswer(formData.get("extraContext"), LONG_FIELD_MAX);
  // The student's own words for what this email is. Required for "custom",
  // where it is the only signal the model has about the situation.
  const purpose = capAnswer(formData.get("purpose"), LONG_FIELD_MAX);

  // Slurs, hateful terms or profanity anywhere on the form stop here, before
  // anything reaches the model (lib/content-limits). The form warns first; this
  // is the check that holds if the form is bypassed.
  // The hand-kept list names 15 of the 139 boxes a student can type into, so
  // everything else came back as "One of your answers" - including `purpose`,
  // the custom occasion's only box. draftFormLabels() derives the rest from the
  // question definitions; the hand list stays on top because it owns the
  // recipient block and reads better for the intro fields.
  const blocked = blockedInForm(formData, { ...draftFormLabels(), ...Object.fromEntries(DRAFT_INPUT_FIELDS) }, DRAFT_SKIP_FIELDS);
  if (blocked) return { error: blocked };

  // Every brief field is optional - a blank one just means the model has less
  // to work with, never an error.
  //
  // Capped, because this was the one path in the pipeline that wasn't. Save and
  // send cap the subject at 500 and the body at 20,000 (./actions), and the
  // outside-recipient fields cap at 200/500/2,000 (lib/draft-recipient), but
  // the generate path trimmed and nothing else: MEASURED, 100 KB in
  // `extraContext` plus 100 KB in `purpose` produced a 201,221-byte user
  // message with nothing truncated (INPUT-3 F3). The monthly allowance counts
  // drafts, not tokens, and the user message is in no cache tier, so one
  // quota'd draft could be inflated roughly twentyfold and repeated for the
  // whole month's allowance.
  //
  // The cap truncates rather than refusing: these are answers to short
  // questions - "what you have in common", "when you sent it" - and no honest
  // answer comes near 2,000 characters, so a student who meets this limit has
  // pasted something by accident and would rather have a draft than an error
  // about a field they didn't mean to fill. The blocked-language gate above
  // reads the WHOLE submission, before any of this, so truncation can never
  // hide a slur past it.
  const field = (name: string, max = FIELD_MAX): string | undefined => capAnswer(formData.get(name), max) || undefined;

  if (!recipient) {
    return { error: "Choose who this email is for" };
  }
  const badId = recipientIdError(recipient);
  if (badId) return { error: badId };
  if ("error" in situation) {
    return { error: situation.error };
  }
  const types = situationTypes(situation);
  const type = types[0];
  if (type.id === "custom" && !purpose) {
    return { error: "Tell us what kind of email this is so we can pick the right shape." };
  }

  // The type's own fields, read from its definition rather than a branch per
  // type. Select answers are sent as their labels, which is what they mean.
  // Every checked box's questions, each asked once, and only those that apply
  // to the options chosen. Answers a box already implies come from the box.
  // Shared brief questions have no prompt of their own; they're read above.
  const questions = situationQuestions(situation, (name) => situation.presets[name] ?? field(name));
  const asked = typeFieldsFor(questions, field);
  if ("error" in asked) return { error: asked.error };
  const typeFields = asked.typeFields;
  const brief = briefFromForm(questions, field);

  const user = await getCurrentUser();

  // The plan's monthly draft allowance (lib/plan-quotas), RESERVED before
  // anything reaches a model, and given back if the generation fails: a draft
  // that never existed never counted. Covers Quick Draft too - it generates
  // through this function. (Reservation semantics came from main; this function
  // is where the generate path lives on this branch.)
  const reservation = await reserveMonthlyUse(user, "emailDrafts");
  if (!reservation.ok) return { error: reservation.error };
  const releaseUse = reservation.release;

  const db = await getDb();

  const resolved = await resolveRecipient(user.id, recipient, formData);
  if ("error" in resolved) {
    return { error: resolved.error };
  }
  const { contact, firmDivisions, group } = resolved;

  // What the boxes imply, e.g. "Someone I emailed sent me to them" is the redirect
  // email to this person, so the model hears it as if it had been answered.
  for (const t of types) {
    for (const f of t.fields ?? []) {
      const preset = situation.presets[f.name];
      if (!preset || typeFields.some((tf) => tf.name === f.name)) continue;
      const value = preset === "{recipient}" ? contact.name : (f.options?.find((o) => o.value === preset)?.label ?? preset);
      typeFields.push({ name: f.name, prompt: f.prompt, label: f.label, value });
    }
  }
  brief.fieldAnswers = typeFields.map(({ prompt, value }) => ({ prompt, value }));

  const overlaps = computeRelevanceScore(user, contact).reasons;

  const isFollowUp = types.some((t) => t.repliesInThread);
  // A follow-up (or a reply setting up the call) to a cold email written in Offerly is built from that email
  // itself - its subject, when it went out, and what it said - so the student
  // is not asked for anything the app already has.
  if (isFollowUp && field("useOfferlyOriginal") === "1") {
    const earlier = await db.query.emailDrafts.findMany({
      where: and(eq(emailDrafts.userId, user.id), eq(emailDrafts.contactId, contact.id)),
      orderBy: [desc(emailDrafts.createdAt)],
      columns: { kind: true, templateId: true, subject: true, body: true, createdAt: true },
    });
    const cold = earlier.find((d) => d.kind === "cold_outreach");
    if (cold) {
      brief.originalSubject = cold.subject;
      // A follow-up to a referral or met-in-person email reminds them of that
      // connection, so the model needs to know which kind it was.
      brief.originalTypeLabel = draftLabel(cold.kind, cold.templateId);
      brief.originalDate = formatDistanceToNow(cold.createdAt, { addSuffix: true });
      brief.originalBody = cold.body;
    }
    const firstFollowUp = earlier.find((d) => d.templateId === "follow_up_1");
    if (type.id === "follow_up_2" && firstFollowUp) {
      brief.followUp1Date = formatDistanceToNow(firstFollowUp.createdAt, { addSuffix: true });
      brief.followUp1Body = firstFollowUp.body;
    }
  }
  if (isFollowUp && !brief.originalSubject) {
    return { error: "Add the subject line of the email this replies to." };
  }

  // The resume, last of the gates.
  //
  // It sits here rather than above the follow-up checks because reading an
  // uploaded resume is a model call, and up there it was spent on submissions
  // that then returned an error and wrote no draft row - an unmetered call a
  // student could repeat for free (INPUT-2 F5). Below every check that can
  // refuse the request, the read only ever happens on a draft that is going to
  // be attempted, which the monthly draft allowance already counts.
  //
  // The read is the same `resumeReview` model call the Resume Review feature
  // spends, so it also passes that feature's monthly allowance. It writes no
  // `resume_reviews` row - there is no review to store, only a summary - so
  // this gate bounds it by the allowance without consuming it. Making it
  // consume one needs its own metered feature, which is a migration: see
  // docs/concepts/audit/FIX-PIPELINE.md.
  let resumeSummary = user.resumeText;
  const upload = formData.get("resume");
  if (upload instanceof File && upload.size > 0) {
    const resumeReservation = await reserveMonthlyUse(user, "resumeReviews");
    if (!resumeReservation.ok) { await releaseUse(); return { error: resumeReservation.error }; }
    try {
      resumeSummary = (await replaceStudentResume(user.id, upload)).summary;
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Couldn't upload that resume." };
    }
  }

  // Whether a resume EXISTS, asked once and independently of whether this email
  // type reads its bytes.
  //
  // `resumeOnFile` used to be `Boolean(resume)`, and `resume` is only read for
  // the types that attach it, so 28 of the 41 types told the model "the student
  // has no resume on file ... add a note to upload a resume" in the same prompt
  // that quoted their resume summary (MEASURED, INPUT-2 F1). Worst on `custom`,
  // where a student who asks to include their resume is told they have none.
  const onFile = await findStudentResume(user.id);

  // Emails that say a resume is attached always carry it, so there is no
  // drafting one without a resume on file.
  // Types that attach it only when the email says so still read it, so the
  // draft can know whether there is one to mention.
  const attachesResume = types.some((t) => t.attachResume);
  const resume =
    attachesResume || types.some((t) => t.attachResumeIfMentioned) ? await readStudentResume(onFile) : null;
  if (attachesResume && !resume) {
    return {
      error: "Upload your resume first. It's attached to this email and it's where your experience comes from.",
    };
  }

  let draft;
  try {
    draft = await generateEmailDraft({
      onEvent: opts.onEvent,
      userId: user.id,
      // Full profile, not just name/school: the connection step needs hometown,
      // interests, and motivations to find a real overlap rather than settling
      // for "we're both interested in finance".
      // Blank when the profile has no name; the prompt then never writes one.
      studentName: user.name?.trim() ?? "",
      studentSchool: user.school,
      // Contact lines under the sign-off, straight from the profile.
      studentSchoolEmail: user.schoolEmail,
      studentPhone: user.phone,
      studentLinkedinUrl: user.linkedinUrl,
      // Read once at upload; every email type draws on it.
      studentResumeSummary: resumeSummary,
      gmailSignature: formData.get("gmailSignature") === "on",
      studentGradYear: user.gradYear,
      studentMajor: user.major,
      studentHometown: user.hometown,
      studentInterests: user.interests,
      studentClubs: user.clubsAndActivities,
      studentExperience:
        [...(user.priorExperience ?? []), user.proudExperience].filter(Boolean).join("; ") || null,
      studentTargetGroup: user.targetGroup,
      studentMotivations: user.motivations,
      // Onboarding asks "Will you need visa sponsorship?"; only a yes matters to a draft.
      studentSponsorship: user.sponsorshipNeeded === "Yes" ? "needs visa sponsorship for full-time work" : null,
      contactName: contact.name,
      contactFirm: contact.firm,
      contactRole: contact.role,
      contactSchool: contact.school,
      contactBackground: contact.background,
      contactNotes: contact.notes,
      // Not picked in the form any more, but still what makes the email fit
      // the group this person actually works in.
      contactFirmDivisions: firmDivisions,
      contactGroup: group,
      // Reuse any connection angle already generated for this contact rather
      // than paying to re-derive the same overlap.
      contactConnectionAngle: contact.connectionAngle,
      // The deterministic overlap check already runs elsewhere in the app; its
      // result was never reaching the draft prompt, so the model was re-deriving
      // (and sometimes missing) a same-school match the database already knew.
      detectedOverlaps: overlaps,
      // A fellow alum is found through the school's alumni database, which is
      // how the playbook's cold emails say it.
      alumniSchool: overlaps.includes("Same school") ? user.school : null,
      // A Word resume can still be attached by the student, but only a PDF can be read.
      // Only when the resume hasn't been read yet - the summary already says
      // what the PDF does, for a fraction of the tokens.
      resumePdf: !resumeSummary && resume?.mimeType === "application/pdf" ? resume.bytes : null,
      // A summary with no file still counts: the prompt quotes it, so telling
      // the model there is no resume would contradict the block above it.
      resumeOnFile: Boolean(onFile) || Boolean(resumeSummary),
      type: type.id,
      alsoTypes: types.slice(1).map((t) => t.id),
      situationSummary: situation.summary,
      // Lead first: the examples written for this mix of boxes are matched on it.
      boxIds: [situation.lead, ...situation.also].map((b) => b.id),
      purpose: purpose || null,
      brief,
      extraContext: extraContext || undefined,
    });
  } catch (err) {
    // Give the month's use back: a draft that never existed never counted.
    await releaseUse();
    return { error: err instanceof Error ? err.message : "Failed to generate draft" };
  }

  // Any email that says the resume is attached carries it, whatever its type -
  // a custom email the student asked to include it in, a keep-in-touch update.
  const attachedResume = resume ?? (mentionsAttachedResume(draft.body) ? await readStudentResume(onFile) : null);

  const attachmentName =
    attachedResume && (attachesResume || draftAttachesResume(type, type.dbKind, draft.body)) ? attachedResume.filename : null;

  const inputs = collectInputs(formData, {
    typeLabel: situation.summary,
    to: [contact.name, contact.role, contact.firm].filter(Boolean).join(", "),
    purposeLabel: type.id === "custom" ? "What this email is for" : "Anything else to mention",
    typeFields: typeFields.map(({ label, value }) => ({ label, value })),
  });

  // What the drafter suggested for this person, and what the student did with
  // each - rebuilt on the server, with only "which did they take" from the form.
  const suggestions = recipient.startsWith("contact-") || recipient.startsWith("directory-")
    ? await suggestionRecord(
        user.id,
        recipient,
        Object.fromEntries(SUGGESTED_FIELDS.map((f) => [f, String(formData.get(f) ?? "")])),
        new Set(parseTaken(formData.get("suggestionsTaken"))),
      ).catch((err) => {
        console.error("[draft-suggestions] could not record outcomes", err);
        return null;
      })
    : null;

  const [created] = await db
    .insert(emailDrafts)
    .values({
      userId: user.id,
      contactId: contact.id,
      suggestions,
      // The kind column keeps its original four values; the exact type rides
      // in template_id so no enum migration is needed.
      kind: type.dbKind,
      purpose: purpose || null,
      templateId: type.id,
      gaps: draft.gaps,
      inputs,
      subject: draft.subject,
      body: draft.body,
      // The same text, stored twice on purpose: subject/body are the working
      // copy the student edits, these two are the frozen record of what the
      // model produced. See their doc comment in schema.ts.
      modelSubject: draft.subject,
      modelBody: draft.body,
    })
    .returning();

  // The original, before the student touches it - the other half of what the
  // learner compares against what actually went out.
  await archiveGenerated({
    userId: user.id,
    draftId: created.id,
    emailType: type.id,
    // The pre-review draft rides along so the review pass's effect can be measured later.
    content: { subject: draft.subject, body: draft.body, preReview: draft.preReview, review: draft.review },
  });

  revalidatePath("/outreach");
  // A directory or outside recipient was just saved as a contact.
  revalidatePath("/contacts");
  // Returned rather than redirected: the draft opens in the composer right
  // under the form, where the student edits it and sends it on.
  return {
    draft: {
      id: created.id,
      to: contact.email ?? "",
      contactName: contact.name,
      subject: draft.subject,
      body: draft.body,
      attachmentName,
      notes: studentNotes(draft.notesForStudent, {
        materials: field("materials"),
        alumTypeWithoutSharedSchool: types.some((t) => t.id === "cold_email") && !overlaps.includes("Same school"),
        contactName: contact.name,
        saysAttachedWithoutResume: !attachedResume && mentionsAttachedResume(draft.body),
        resumeFilename: attachmentName,
        studentName: user.name ?? "",
      }),
    },
  };
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
