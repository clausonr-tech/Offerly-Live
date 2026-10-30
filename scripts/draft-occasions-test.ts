// Exhaustive checks of the draft form's picker (src/lib/draft-occasions.ts):
// every combination of boxes in every group, plus random click sequences.
//
//   npx tsx scripts/draft-occasions-test.ts
//
// For each valid situation it checks that the strongest box leads with real
// examples, that only the checked boxes' questions are asked, that no question
// is asked twice (under its own name or an alias), that implied answers aren't
// asked, that every required question is asked, that the server would accept a
// fully answered form, and that the prompt builds with the lead's format and a
// ceiling that fits every box.

import {
  ASK_QUESTIONS,
  FOUND_QUESTIONS,
  OCCASIONS,
  QUESTION_MERGES,
  STRENGTH,
  aliasesOf,
  answerFor,
  briefAnswerFor,
  boxById,
  boxesConflict,
  resolveSituation,
  situationQuestions,
  situationTypes,
  suggestions,
  autoFill,
  visibleSections,
  toggleBox,
  type Question,
  type Situation,
} from "../src/lib/draft-occasions";
import { activeFields, emailTypeById, type EmailType } from "../src/lib/draft-templates";
import { SETS_THE_ASK, buildDraftPrompt, combinedExamplesFor } from "../src/lib/draft-prompt";
import { sims } from "./draft-occasions-sim";
import volumeV from "../src/lib/email-examples-v5.json";
import { EMAIL_EXAMPLES } from "../src/lib/email-examples";

const BRIEF_NAMES = new Set([
  "financeInterest",
  "wantToLearn",
  "specificReason",
  "originalSubject",
  "originalDate",
  "originalAsk",
  "followUp1Date",
  "meetingWhen",
  "nextStepAsk",
  "introName",
  "introReason",
  "conversationDetails",
  "interviewTeam",
  "personalConnection",
]);

// Email types with a second person in them besides the recipient: a referrer,
// whoever sent the student on, or the person they were introduced to.
const SECOND_PERSON = new Set(["cold_referral", "redirect_sequence", "close_loop_referrer"]);
const ROLE_WORDS = /\b(referrer|this person|this recruiter|introduced|sent you)\b/i;

// Questions that ask the same thing under different names. Whatever is
// checked, the form never shows both of a pair.
const NEVER_TOGETHER: [string, string][] = [
  ["referrerName", "firstPerson"],
  ["referrerContext", "redirectDetail"],
  ["whyNow", "nextForYou"],
  ["ownNews", "nextForYou"],
  ["howFound", "whereMet"],
];

const failures: string[] = [];
const fail = (where: string, msg: string) => failures.push(`${where}: ${msg}`);

function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) out.push(xs.filter((_, i) => mask & (1 << i)));
  return out;
}

/** Question lists under the defaults, and under each option of each select, so conditional questions are exercised. */
function questionVariants(situation: Situation): { valueOf: (n: string) => string | undefined; qs: Question[]; note: string }[] {
  const base = situationQuestions(situation, () => undefined);
  const variants: { valueOf: (n: string) => string | undefined; qs: Question[]; note: string }[] = [
    { valueOf: () => undefined, qs: base, note: "defaults" },
  ];
  for (const q of base.filter((q) => q.kind === "select")) {
    for (const o of q.options ?? []) {
      const valueOf = (n: string) => (n === q.name ? o.value : undefined);
      variants.push({ valueOf, qs: situationQuestions(situation, valueOf), note: `${q.name}=${o.value}` });
    }
  }
  return variants;
}

function checkSituation(where: string, situation: Situation, ids: string[]) {
  const types = situationTypes(situation);
  const lead = types[0];

  // The strongest checked box leads, and it has examples to write from.
  if (!ids.includes(situation.lead.id)) fail(where, "lead isn't a checked box");
  if (lead.id !== "custom" && !((EMAIL_EXAMPLES as Record<string, unknown[]>)[lead.id]?.length)) {
    fail(where, `lead type ${lead.id} has no examples`);
  }
  for (const id of ids) {
    if (!situation.summary.includes(boxById(id)!.label)) fail(where, `summary is missing "${boxById(id)!.label}"`);
  }

  const involvedFieldNames = new Set(types.flatMap((t) => (t.fields ?? []).map((f) => f.name)));
  const presetNames = new Set(Object.keys(situation.presets));

  for (const { valueOf, qs, note } of questionVariants(situation)) {
    const w = `${where} [${note}]`;
    const names = qs.map((q) => q.name);

    // Nothing asked twice, under its own name or an alias.
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) fail(w, `asked twice: ${dupes.join(", ")}`);
    for (const n of names) {
      const aliased = aliasesOf(n).filter((a) => names.includes(a));
      if (aliased.length) fail(w, `"${n}" and its alias "${aliased[0]}" both asked`);
    }

    // Every question says who it's about: beside a second person, a bare "them" or "they" could mean either one.
    if (types.some((t) => SECOND_PERSON.has(t.id))) {
      for (const q of qs) {
        if (/\b(them|they)\b/i.test(q.label) && !ROLE_WORDS.test(q.label)) fail(w, `"${q.label}" doesn't say who it means`);
      }
    }
    const labels = qs.map((q) => q.label);
    const sameLabel = labels.filter((l, i) => labels.indexOf(l) !== i);
    if (sameLabel.length) fail(w, `two questions labelled "${sameLabel[0]}"`);

    for (const [a, b] of NEVER_TOGETHER) {
      if (names.includes(a) && names.includes(b)) fail(w, `"${a}" and "${b}" ask the same thing and are both on the form`);
    }

    // Implied answers aren't asked.
    for (const n of names) if (presetNames.has(n)) fail(w, `"${n}" is implied by a box but still asked`);

    // Only the checked boxes' questions: every question belongs to an involved type or its brief.
    for (const n of names) {
      if (!involvedFieldNames.has(n) && !BRIEF_NAMES.has(n)) fail(w, `"${n}" doesn't belong to any checked box`);
    }
    if (!types.some((t) => t.isCold) && names.includes("financeInterest")) fail(w, "cold-email questions without a cold box");
    if (!types.some((t) => t.repliesInThread) && names.includes("originalSubject")) fail(w, "thread questions without a reply box");

    // Every required question that applies is asked (by name or alias).
    const answer = (n: string) => situation.presets[n] ?? valueOf(n);
    for (const t of types) {
      for (const f of activeFields(t, answer)) {
        if (!f.required || presetNames.has(f.name)) continue;
        // Deliberately skipped: a secondary box's ask, and "how did you find them" once a connection box says it.
        if (t !== lead && ASK_QUESTIONS.has(f.name)) continue;
        if (FOUND_QUESTIONS.has(f.name) && types.some((x) => ["cold_referral", "cold_after_meeting", "conference_follow_up", "redirect_sequence"].includes(x.id))) continue;
        // ...and "why them specifically", which a recruiter has no answer to.
        if (f.name === "whyThem" && types.some((x) => x.id === "recruiter_outreach")) continue;
        // ...and a near-repeat merged into another question beside the box that
        // repeats it, whether it was dropped under its own name or as the alias
        // that had already absorbed the merge's own drop.
        if (
          QUESTION_MERGES.some(
            (m) =>
              (m.drop === f.name || aliasesOf(m.drop).includes(f.name)) &&
              m.boxes.every((b) => ids.includes(b)) &&
              names.includes(m.keep),
          )
        ) {
          continue;
        }
        if (!names.includes(f.name) && !aliasesOf(f.name).some((a) => names.includes(a))) {
          fail(w, `required "${t.id}.${f.name}" never asked`);
        }
      }
    }

    // The server's pass over a fully answered form: every required question has an answer.
    const typed: Record<string, string> = Object.fromEntries(names.map((n) => [n, "answer"]));
    const field = (n: string) => typed[n] ?? valueOf(n);
    for (const q of situationQuestions(situation, (n) => situation.presets[n] ?? field(n))) {
      if (q.prompt && q.required && !answerFor(q.name, field)) fail(w, `server would reject: "${q.name}" unanswered`);
    }
  }

  // Questions from boxes that aren't checked never appear.
  const qs = situationQuestions(situation, () => undefined).map((q) => q.name);
  for (const section of situation.occasion.sections) {
    for (const box of section.boxes) {
      if (ids.includes(box.id)) continue;
      const t = emailTypeById(box.typeId)!;
      for (const f of t.fields ?? []) {
        if (!involvedFieldNames.has(f.name) && qs.includes(f.name)) fail(where, `unchecked "${box.label}" leaked "${f.name}"`);
      }
    }
  }

  // The prompt: lead's format and examples, each other box worked in, a ceiling that fits them all.
  const also = types.slice(1).map((t: EmailType) => t.id);
  const { system, userText } = buildDraftPrompt({
    studentName: "Maya Okafor",
    studentSchool: "Duke University",
    studentGradYear: 2029,
    type: lead.id,
    alsoTypes: also,
    situationSummary: situation.summary,
    contactName: "Rachel Stein",
    contactFirm: "Morrow & Pike",
    now: new Date("2026-09-20T12:00:00"),
    brief: { fieldAnswers: qs.map((n) => ({ prompt: n, value: "answer" })) },
  });
  if (lead.id !== "custom" && !system.includes(`EMAIL TYPE: ${lead.label.toUpperCase()}`)) fail(where, "prompt doesn't use the lead's format");
  const ceiling = Math.max(...types.map((t) => t.maxWords));
  if (lead.id !== "custom" && !system.includes(`HARD CEILING: ${ceiling} words`)) fail(where, `ceiling isn't ${ceiling}`);
  if (!userText.includes(situation.summary)) fail(where, "summary missing from the prompt");
  for (const t of types.slice(1)) {
    const kept = (t.promptNotes ?? []).filter((n) => !SETS_THE_ASK.test(n));
    if (kept.length > 0 && !userText.includes(`ALSO TRUE - ${t.label}`)) fail(where, `"${t.label}" not worked into the prompt`);
  }
  // Only the lead sets the ask: no secondary box's ask line survives.
  const alsoSection = userText.split(/ALSO TRUE - /).slice(1).join("\n");
  for (const line of alsoSection.split("\n").slice(1)) {
    if (SETS_THE_ASK.test(line)) fail(where, `a secondary box sets the ask: "${line}"`);
  }
}

// --------------------------------------------------------------- the merges
// A QUESTION_MERGES entry whose boxes are all checked has to do something
// visible. Either it fires - `keep` carries the merged wording and the dropped
// question (under its own name or the alias that absorbed it) is gone - or
// `keep` was never asked because a connection box asks its own alias instead,
// which is an honest substitute. A merge that quietly does neither is the
// defect INPUT-1 #1 and LOGIC-3 F16 found, and it is invisible without this.
const mergeTally = new Map<string, { eligible: number; applied: number; superseded: number }>(
  QUESTION_MERGES.map((m) => [`${m.keep}<-${m.drop}`, { eligible: 0, applied: 0, superseded: 0 }]),
);
function checkMerges(where: string, situation: Situation, ids: string[]) {
  const qs = situationQuestions(situation, () => undefined);
  const names = qs.map((q) => q.name);
  for (const m of QUESTION_MERGES) {
    const tag = `${m.keep}<-${m.drop}`;
    if (!m.boxes.every((b) => ids.includes(b))) continue;
    const tally = mergeTally.get(tag)!;
    tally.eligible++;
    const keep = qs.find((q) => q.name === m.keep);
    if (!keep) {
      const substitute = aliasesOf(m.keep).find((a) => names.includes(a));
      if (substitute) tally.superseded++;
      else fail(where, `merge ${tag} did nothing: neither "${m.keep}" nor an alias of it is asked`);
      continue;
    }
    if (m.text.label && keep.label !== m.text.label) {
      fail(where, `merge ${tag} fired but "${m.keep}" is still worded "${keep.label}"`);
    } else tally.applied++;
    const left = [m.drop, ...aliasesOf(m.drop)].filter((n) => names.includes(n));
    if (left.length) fail(where, `merge ${tag} fired but "${left[0]}" is still asked beside it`);
  }
}

// ------------------------------------------------------------ every combination
let situations = 0;
const noCombined: string[] = [];
const noRequired: string[] = [];
const requiredNoPrompt = new Set<string>();
let rejected = 0;
for (const occasion of OCCASIONS) {
  const ids = occasion.sections.flatMap((s) => s.boxes.map((b) => b.id));
  for (const set of subsets(ids)) {
    const where = `${occasion.id} {${set.join(", ")}}`;
    const conflict = set.some((a) => set.some((b) => a !== b && boxesConflict(a, b)));
    const tooMany = occasion.sections.some((s) => s.mode === "one" && s.boxes.filter((b) => set.includes(b.id)).length > 1);
    const result = resolveSituation(occasion.id, set);
    if ("error" in result) {
      rejected++;
      if (!conflict && !tooMany) fail(where, `valid set rejected: ${result.error}`);
      continue;
    }
    if (conflict || tooMany) {
      fail(where, "invalid set accepted");
      continue;
    }
    situations++;
    checkSituation(where, result, set);
    checkMerges(where, result, set);
    const asked = situationQuestions(result, () => undefined);
    if (!asked.some((q) => q.required)) noRequired.push(where);
    for (const q of asked) if (q.required && !q.prompt) requiredNoPrompt.add(q.name);
    if (set.length > 1 && combinedExamplesFor([result.lead, ...result.also].map((b) => b.id)).examples.length === 0) {
      noCombined.push(result.summary);
    }
  }
}

// ----------------------------------------------------- the required question
// An email the playbook builds on one specific detail must ask for it. Only
// two combinations are allowed to ask nothing at all: a plain alum cold email,
// where every fact is optional by design, and "Something else", whose single
// `purpose` box the server checks on its own. A thank-you asking nothing -
// INPUT-1 #2 - is the email that most needs the detail.
const NO_REQUIRED_OK = new Set(["first_contact {first.alum}", "custom {custom.describe}"]);
const unexpected = noRequired.filter((w) => !NO_REQUIRED_OK.has(w));
const vanished = [...NO_REQUIRED_OK].filter((w) => !noRequired.includes(w));
for (const w of unexpected) fail(w, "no required question at all: the student can submit every field blank");
for (const w of vanished) fail(w, `listed in NO_REQUIRED_OK but it does ask a required question - drop it from the list`);

// A required question with no `prompt` of its own cannot raise the generic
// `Add "<label>"` error: runGenerateDraft skips promptless questions before it
// looks at `required` (INPUT-1 #6, draft-request.ts). Until that order is
// fixed, each one needs a bespoke server check, so the set is pinned here and
// a new one fails this test instead of being silently unenforced.
const REQUIRED_NO_PROMPT: Record<string, string> = {
  originalSubject: 'bespoke check in draft-request.ts: "Add the subject line of the email this replies to."',
  conversationDetails: "NOT ENFORCED on the server yet - needs the required check moved above `if (!q.prompt) continue`",
};
for (const name of requiredNoPrompt) {
  if (!(name in REQUIRED_NO_PROMPT)) {
    fail("required", `"${name}" is required but has no prompt, so the server cannot enforce it - add a reason to REQUIRED_NO_PROMPT or give it a prompt`);
  }
}
for (const name of Object.keys(REQUIRED_NO_PROMPT)) {
  if (!requiredNoPrompt.has(name)) fail("required", `"${name}" is listed in REQUIRED_NO_PROMPT but is no longer required-without-prompt - drop it from the list`);
}

// A box that rewords a question for the student has to reword it for the model
// too. Otherwise the student answers "Your own news since you last spoke" and
// the model is told "The student's update since then" (INPUT-1 #3).
for (const occasion of OCCASIONS) {
  for (const box of occasion.sections.flatMap((s) => s.boxes)) {
    for (const [name, text] of Object.entries(box.questionText ?? {})) {
      if (text.label && !text.prompt) fail(`${box.id}.questionText.${name}`, "rewords the label for the student but not the prompt for the model");
    }
  }
}

// ------------------------------------------------- one answer, sent once
// A shared brief slot must not re-send an answer that already reaches the
// model under a prompted question's own prompt (INPUT-1 #4). Measured over
// every combination: `answerFor` walks the whole alias group and copies it;
// `briefAnswerFor` leaves the prompted alias alone.
let duplicatedByAnswerFor = 0;
for (const occasion of OCCASIONS) {
  for (const set of subsets(occasion.sections.flatMap((s) => s.boxes.map((b) => b.id)))) {
    const r = resolveSituation(occasion.id, set);
    if ("error" in r) continue;
    const qs = situationQuestions(r, () => undefined);
    const field = (n: string) => (qs.some((q) => q.name === n) ? `ANSWER_${n}` : undefined);
    for (const name of BRIEF_NAMES) {
      if (qs.some((q) => q.name === name)) continue; // the brief question itself is on the form
      const promptedAlias = qs.find((q) => q.prompt && aliasesOf(name).includes(q.name));
      if (!promptedAlias) continue;
      duplicatedByAnswerFor++;
      const copied = briefAnswerFor(name, qs, field);
      if (copied !== undefined) {
        fail(`${occasion.id} {${set.join(", ")}}`, `brief "${name}" re-sends "${promptedAlias.name}" (${copied}), which the model already gets as "${promptedAlias.prompt}"`);
      }
      if (answerFor(name, field) === undefined) fail(`${occasion.id} {${set.join(", ")}}`, `answerFor no longer reaches "${name}" - briefAnswerFor has nothing left to guard`);
    }
  }
}

// The one combination where both framings reached the prompt as real lines.
{
  const r = resolveSituation("thanks", ["thanks.chat", "thanks.helped"]);
  if ("error" in r) fail("thanks.chat+thanks.helped", r.error);
  else {
    const qs = situationQuestions(r, () => undefined);
    const field = (n: string) => (qs.some((q) => q.name === n) ? `ANSWER_${n}` : undefined);
    const types = situationTypes(r);
    const { userText } = buildDraftPrompt({
      studentName: "Maya Okafor",
      contactName: "Rachel Stein",
      type: types[0].id,
      alsoTypes: types.slice(1).map((t) => t.id),
      now: new Date("2026-09-20T12:00:00"),
      brief: {
        conversationDetails: briefAnswerFor("conversationDetails", qs, field),
        fieldAnswers: qs.filter((q) => q.prompt).map((q) => ({ prompt: q.prompt, value: answerFor(q.name, field) ?? "answer" })),
      },
    });
    const hits = userText.split("\n").filter((l) => l.includes("ANSWER_conversationDetail"));
    if (hits.length !== 1) fail("thanks.chat+thanks.helped", `one typed answer reaches the model ${hits.length}x:\n    ${hits.join("\n    ")}`);
  }
}

// ------------------------------------------------------ ids we don't recognise
// A box id that isn't one of this occasion's is refused, not quietly dropped
// (INPUT-1 #5). The form can't produce one - switching occasion clears the
// checked boxes - so the only sender is a stale or tampered POST, and building
// an email from fewer boxes than were ticked, silently, is worse than saying no.
for (const [label, ids] of [
  ["another occasion's boxes beside a real one", ["first.alum", "thanks.chat", "offers.accept"]],
  ["another occasion's boxes only", ["thanks.chat"]],
  ["an id that is no box at all", ["first.alum", "not.a.box"]],
  ["a prototype key", ["first.alum", "__proto__"]],
  ["a whitespace-padded id", [" first.alum"]],
] as [string, string[]][]) {
  const r = resolveSituation("first_contact", ids);
  if (!("error" in r)) fail("foreign ids", `${label}: accepted as lead=${r.lead.id} also=[${r.also.map((b) => b.id)}]`);
}
if ("error" in resolveSituation("first_contact", ["first.alum", "first.alum", "first.alum"])) {
  fail("foreign ids", "a duplicate of a real box is not a foreign id");
}

// --------------------------------------------- the lead is never the browser's
// `rank()` gives every id STRENGTH doesn't list the same rank, and sort is
// stable, so unranked boxes tie and the lead falls to the order the client
// posted the checkboxes. It is harmless only because every unranked box sits
// in a `mode: "one"` section, where no two of them can be checked together.
// The day someone adds a second `mode: "any"` section the lead - which picks
// the format, the examples and the ask - becomes a function of post order,
// with no error anywhere (LOGIC-3 F15). Rank the box or keep it in a "one"
// section; this says which.
for (const occasion of OCCASIONS) {
  for (const section of occasion.sections) {
    if (section.mode !== "any") continue;
    for (const box of section.boxes) {
      if (!STRENGTH.includes(box.id)) {
        fail(`${occasion.id} / ${section.title}`, `"${box.id}" can be checked beside another box but isn't in STRENGTH, so which one leads would come from the browser's post order`);
      }
    }
  }
}
for (const id of STRENGTH) if (!boxById(id)) fail("STRENGTH", `"${id}" is not a box`);

// ------------------------------------------- every checked box says something
// `blendRules` promises the model "Every checked box shows up. Each fact given
// for it appears once". A secondary box that puts no ALSO TRUE block in the
// prompt breaks that promise, and on most of these it is the student's whole
// account of how they came to the recipient that vanishes (LOGIC-3 F5).
//
// The cause is in draft-prompt.ts, not here: the secondary call passes
// `fieldAnswers: []`, so `redirect_sequence`'s `redirectStep` can't be
// resolved, the per-step filter is skipped, and all three step notes are then
// dropped as SETS_THE_ASK alternatives. Until that is fixed the silence is
// held to exactly what it is today: only redirect_sequence, and never more
// places than now. Fixing draft-prompt.ts drives the count to 0 and this still
// passes.
const SILENT_SECONDARY_TYPE = "redirect_sequence";
const SILENT_SECONDARY_MAX = 14;
const silentSecondary: string[] = [];
for (const sim of sims().filter((x) => x.profile === "full")) {
  const { userText } = buildDraftPrompt(sim.input);
  for (const t of sim.input.alsoTypes ?? []) {
    const label = emailTypeById(t)!.label;
    if (userText.includes(`ALSO TRUE - ${label}`)) continue;
    silentSecondary.push(`${sim.id} [${sim.ids.join(",")}] secondary=${t}`);
    if (t !== SILENT_SECONDARY_TYPE) {
      fail(`${sim.id} [${sim.ids.join(",")}]`, `checked box's type "${t}" puts nothing in the prompt at all`);
    }
  }
}
if (silentSecondary.length > SILENT_SECONDARY_MAX) {
  fail("ALSO TRUE", `${silentSecondary.length} checked boxes contribute nothing, up from ${SILENT_SECONDARY_MAX}:\n    ${silentSecondary.slice(SILENT_SECONDARY_MAX).join("\n    ")}`);
}

// Every box can be reached, and every email type is reachable from some box.
const reachable = new Set(OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes.map((b) => b.typeId))));
for (const t of ["cold_email", "cold_not_alum", "cold_referral", "cold_after_meeting", "conference_follow_up", "recruiter_outreach", "recruiting_inbox", "follow_up_1", "follow_up_2", "recruiter_follow_up", "recruiting_inbox_follow_up", "stalled_thread_nudge", "interview_check_in", "call_scheduling", "reschedule_call", "recruiter_scheduling_reply", "not_now_reply", "redirect_sequence", "coffee_in_person_reply", "thank_you_chat", "thank_you_offered_help", "thank_you_event", "thank_you_recruiter_session", "keep_in_touch", "close_loop_referrer", "referral_ask", "second_conversation", "congratulations", "thank_you_interview", "thank_you_superday", "thank_you_phone_screen", "recorded_round_note", "withdraw_process", "after_rejection", "offer_extension", "accept_offer", "decline_offer", "thank_helper_offer", "professor_recommendation", "reference_request", "custom"] as const) {
  if (!reachable.has(t)) fail("coverage", `no box leads to ${t}`);
}

// ------------------------------------------------------------ combination examples
// Every Volume V example is a situation the picker allows, and a student who
// checks exactly its boxes gets it in the prompt.
const VOLUME_V = volumeV as { sections: { section: number; title: string }[]; examples: { boxes: string[]; subject: string; section: number }[] };
let unusedExamples = 0;
const DEAD_EXAMPLES = 3;
// Section 16's own examples are dead too, but its format still reaches every
// three-box student through combinedExamplesBlock's "Three or More" rule, so
// the only section no student ever sees is 15.
const UNREACHABLE_SECTIONS = [15];
for (const ex of VOLUME_V.examples) {
  const where = `combined ${ex.boxes.join("+")}`;
  const occasion = OCCASIONS.find((o) => o.sections.some((s) => s.boxes.some((b) => b.id === ex.boxes[0])));
  const r = occasion ? resolveSituation(occasion.id, ex.boxes) : { error: "no occasion has these boxes" };
  if ("error" in r) {
    // Written for a mix the picker forbids, so no student can ever see it.
    // "Someone I know suggested them" and "Someone I emailed sent me to them"
    // exclude each other on purpose - two people who each connected the
    // student is one too many for one email to carry clearly - so sections 15
    // and 16's mixes are dead corpus (LOGIC-3 F11). The examples stay: the
    // corpus is not this file's to edit, and deleting a playbook section is a
    // product decision, not a test's. What is held here is the count, so a
    // *new* example written for an impossible mix fails instead of being
    // maintained for nothing.
    if (ex.boxes.includes("first.referred") && ex.boxes.includes("first.pointed")) {
      unusedExamples++;
    } else fail(where, `not a valid situation: ${r.error}`);
    continue;
  }
  const types = situationTypes(r);
  const { system } = buildDraftPrompt({
    studentName: "Maya Okafor",
    contactName: "Rachel Stein",
    type: types[0].id,
    alsoTypes: types.slice(1).map((t) => t.id),
    boxIds: [r.lead, ...r.also].map((b) => b.id),
    now: new Date("2026-09-20T12:00:00"),
  });
  if (!system.includes("COMBINATION EXAMPLES") || !system.includes(`Subject: ${ex.subject}`)) fail(where, `"${ex.subject}" isn't in the prompt`);
  if (/cut a fact/i.test(system)) fail(where, "the prompt tells the model to drop something the student checked");
}

// The dead corpus, pinned. Growth is a failure; shrinking (someone relaxes the
// exclusion, or the section is retired) only needs the numbers here updated.
if (unusedExamples > DEAD_EXAMPLES) {
  fail("combined", `${unusedExamples} examples are written for boxes that can't be checked together, up from ${DEAD_EXAMPLES}`);
}
// Which playbook sections any student can actually be shown: the ones the
// examples win, plus the "Three or More" format every three-box student gets.
const shownSections = new Set<number>();
for (const occasion of OCCASIONS) {
  for (const set of subsets(occasion.sections.flatMap((sec) => sec.boxes.map((b) => b.id)))) {
    if (set.length < 2) continue;
    const r = resolveSituation(occasion.id, set);
    if ("error" in r) continue;
    const boxIds = [r.lead, ...r.also].map((b) => b.id);
    for (const sec of combinedExamplesFor(boxIds).sections) shownSections.add(sec.section);
    if (boxIds.length >= 3) for (const sec of VOLUME_V.sections) if (/^Three or More/.test(sec.title)) shownSections.add(sec.section);
  }
}
const unreachableSections = VOLUME_V.sections.map((sec) => sec.section).filter((n) => !shownSections.has(n));
for (const n of unreachableSections) {
  if (!UNREACHABLE_SECTIONS.includes(n)) {
    fail("combined", `section #${n} ("${VOLUME_V.sections.find((x) => x.section === n)?.title}") can never be shown to anyone - no student can check its mix`);
  }
}

// A combination that gets no examples although the corpus holds a mix the
// student checked in full. `combinedExamplesFor` requires the stored mix to
// contain the *lead* box, so a fully-checked mix that doesn't is discarded and
// its playbook format goes with it (LOGIC-3 F11). The fix is in
// draft-prompt.ts. Held one-directional: a new one fails here, and relaxing
// the lead rule empties the list and still passes.
const EXAMPLES_LOST_MAX = 1;
const examplesLost: string[] = [];
for (const occasion of OCCASIONS) {
  for (const set of subsets(occasion.sections.flatMap((sec) => sec.boxes.map((b) => b.id)))) {
    if (set.length < 2) continue;
    const r = resolveSituation(occasion.id, set);
    if ("error" in r) continue;
    const boxIds = [r.lead, ...r.also].map((b) => b.id);
    if (combinedExamplesFor(boxIds).examples.length > 0) continue;
    const checked = new Set(boxIds);
    const stored = VOLUME_V.examples.filter((e) => e.boxes.length >= 2 && e.boxes.every((b) => checked.has(b)));
    if (stored.length) examplesLost.push(`[${boxIds.join(",")}] lead=${boxIds[0]} unused mix: ${stored[0].boxes.join("+")}`);
  }
}
if (examplesLost.length > EXAMPLES_LOST_MAX) {
  fail("combined", `${examplesLost.length} combinations lose examples the corpus holds, up from ${EXAMPLES_LOST_MAX}:\n    ${examplesLost.join("\n    ")}`);
}

// ------------------------------------------------------------ random clicking
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
let sequences = 0;
for (const occasion of OCCASIONS) {
  const ids = occasion.sections.flatMap((s) => s.boxes.map((b) => b.id));
  for (let run = 0; run < 60; run++) {
    let checked: string[] = [];
    for (let click = 0; click < 12; click++) {
      checked = toggleBox(occasion, checked, ids[Math.floor(rand() * ids.length)]);
      if (checked.length === 0) continue;
      const r = resolveSituation(occasion.id, checked);
      if ("error" in r) fail(`${occasion.id} clicks`, `clicking produced an invalid set {${checked.join(", ")}}: ${r.error}`);
    }
    sequences++;
  }
}

// ------------------------------------------------------------ what the app already knows
const s1 = suggestions({ sameSchool: true, role: "Vice President", name: "Rachel Stein", hasPriorColdEmail: false, hasFollowUp1: false });
if (!s1.has("first.alum") || !s1.has("first_contact") || s1.has("first.recruiter")) fail("suggestions", `alum VP: ${[...s1]}`);
const s2 = suggestions({ sameSchool: false, role: "Campus Recruiter", name: "Priya Nair", hasPriorColdEmail: true, hasFollowUp1: false });
if (!s2.has("first.recruiter") || !s2.has("follow_up") || !s2.has("follow.first")) fail("suggestions", `recruiter with prior email: ${[...s2]}`);
const s3 = suggestions({ sameSchool: true, role: null, name: "Morrow & Pike Recruiting Team", hasPriorColdEmail: true, hasFollowUp1: true });
if (!s3.has("first.inbox") || s3.has("first.alum") || !s3.has("follow.final")) fail("suggestions", `team inbox: ${[...s3]}`);
const s4 = suggestions({ sameSchool: false, knownNotAlum: true, role: "Associate", name: "Dana Reed", hasPriorColdEmail: false, hasFollowUp1: false });
if (!s4.has("first.not_alum") || s4.has("first.alum")) fail("suggestions", `known non-alum: ${[...s4]}`);
const s5 = suggestions({ sameSchool: false, role: "Associate", name: "Dana Reed", hasPriorColdEmail: false, hasFollowUp1: false });
if (s5.has("first.not_alum")) fail("suggestions", `unknown school is not "not an alum": ${[...s5]}`);

// Auto-filled answers: checked for the student, always a valid set, and never
// a "How are you connected?" box for one of their own contacts.
const alumFill = autoFill({ sameSchool: true, role: "Vice President", name: "Rachel Stein", hasPriorColdEmail: false, hasFollowUp1: false }, { outside: false });
if (alumFill.occasionId !== "first_contact" || alumFill.boxes.join() !== "first.alum") fail("autoFill", `alum: ${JSON.stringify(alumFill)}`);
const followFill = autoFill({ sameSchool: false, role: null, name: "Dana Reed", hasPriorColdEmail: true, hasFollowUp1: true }, { outside: false });
if (followFill.occasionId !== "follow_up" || followFill.boxes.join() !== "follow.final") fail("autoFill", `final follow-up: ${JSON.stringify(followFill)}`);
const keptFill = autoFill({ sameSchool: true, role: null, name: "Dana Reed", hasPriorColdEmail: true, hasFollowUp1: false }, { outside: false, occasionId: "first_contact" });
if (keptFill.occasionId !== "first_contact" || keptFill.boxes.join() !== "first.alum") fail("autoFill", `keeps the student's occasion: ${JSON.stringify(keptFill)}`);
if (autoFill(null, { outside: true }).occasionId !== "") fail("autoFill", "no recipient fills nothing");
for (const o of OCCASIONS) {
  for (const outside of [true, false]) {
    for (const sameSchool of [true, false]) {
      for (const role of ["Campus Recruiter", "Analyst", null]) {
        const f = autoFill({ sameSchool, knownNotAlum: !sameSchool, role, name: "Sam Lee", hasPriorColdEmail: false, hasFollowUp1: false }, { outside, occasionId: o.id });
        if (f.boxes.length === 0) continue;
        const r = resolveSituation(f.occasionId, f.boxes);
        if ("error" in r) fail("autoFill", `${o.id} ${f.boxes}: ${r.error}`);
        const shown = new Set(visibleSections(o, outside).flatMap((sec) => sec.boxes.map((b) => b.id)));
        if (f.boxes.some((b) => !shown.has(b))) fail("autoFill", `${o.id} checked a hidden box: ${f.boxes}`);
      }
    }
  }
}
if (visibleSections(OCCASIONS.find((o) => o.id === "first_contact")!, false).some((sec) => sec.title === "How are you connected?")) {
  fail("visibleSections", "the connection section showed for an Offerly contact");
}

for (const [tag, t] of mergeTally) {
  console.log(`merge ${tag}: ${t.eligible} eligible firings, ${t.applied} apply the merged wording, ${t.superseded} superseded by a connection box's own alias of "keep"`);
}
console.log(`playbook sections no student can ever be shown: ${unreachableSections.map((n) => `#${n}`).join(", ") || "none"}`);
console.log(`${examplesLost.length} combinations lose combination examples the corpus holds (draft-prompt.ts owns the fix, ceiling ${EXAMPLES_LOST_MAX}): ${examplesLost.join("; ")}`);
console.log(`${silentSecondary.length} checked boxes contribute no ALSO TRUE block (all ${SILENT_SECONDARY_TYPE}; draft-prompt.ts owns the fix, ceiling ${SILENT_SECONDARY_MAX})`);
console.log(`${duplicatedByAnswerFor} brief slots where answerFor would re-send a prompted answer, 0 left by briefAnswerFor`);
console.log(`${situations} valid situations checked, ${rejected} invalid combinations correctly rejected, ${sequences} random click sequences`);
console.log(`${VOLUME_V.examples.length} combination examples checked (${unusedExamples} for boxes that can't be checked together); ${noCombined.length} multi-box situations have none:\n  ${noCombined.join("\n  ")}`);
if (failures.length) {
  console.log(`\n${failures.length} failures:`);
  for (const f of failures.slice(0, 60)) console.log(`  ${f}`);
  // Printing the count is not a gate: without this the script exited 0 with
  // failures on screen, so every caller read it as green.
  process.exitCode = 1;
} else {
  console.log("0 failures");
}
