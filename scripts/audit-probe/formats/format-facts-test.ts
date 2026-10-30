// Generalises gradmonth-test.ts over `format` bodies.
//
// gradmonth-test.ts guards one fact (a graduation month) in one place
// (promptNotes). The bug it guards - a step demanding a fact nothing in the app
// holds, so the drafter follows GAP_RULES and leaves "[graduation month]" in a
// real student's email - can sit in any of the three strings a type sends to the
// model, and `format` is the one nobody had read. This test checks all three,
// over every fact a type can demand, and over the branch selects that hide a
// field after the format has already asked for it.
//
//   npx tsx scripts/audit-probe/formats/format-facts-test.ts
//
// Five checks. KNOWN holds the instances FORMAT-AUDIT.md reports as open, so
// the test is green today and goes red the moment a NEW one appears. Delete a
// KNOWN line when its finding is fixed.
import { EMAIL_TYPES, activeFields, type EmailType } from "../../../src/lib/draft-templates";
import volumeV from "../../../src/lib/email-examples-v5.json";

/** Open findings, by `check/type/detail`. See docs/concepts/audit/FORMAT-AUDIT.md. */
const KNOWN = new Set([
  // F2 (the graduation-month demand in a format body) - CLEARED, and the two
  // entries removed 2026-10-12: recruiting_inbox and recruiter_outreach now
  // ask for a graduation YEAR and carry the no-month clause in the step
  // itself, so the check no longer fires on them and the exemptions were
  // only hiding the pattern from the next type that gets it wrong.
  // F3 - a bracketed placeholder printed in a line the reviewer may not touch.
  "bracket/interview_check_in/[Role]",
  "bracket/professor_recommendation/[Last name]",
  // F8 - dead, not harmful: finishDraft() sets a follow-up's subject from
  // brief.originalSubject, which draft-request.ts refuses to submit without, so
  // the model's subject is discarded and this bracket cannot ship. Kept here so
  // the check stays on for the next type that prints one.
  "bracket/follow_up_1/[original subject line]",
  "bracket/follow_up_2/[original subject line]",
  // F5 - a numbered step demanding a fact the student's own answer hides.
  // CLEARED 2026-10-12 (docs/concepts/audit/PROMPT-COHERENCE.md): every step
  // that demanded a hidden field now carries its own branch condition, so
  // offer_extension (requestedDate / extensionReason / otherFirm),
  // coffee_in_person_reply (coffeeSpot) and thank_you_event (eventAsk) are no
  // longer exceptions. Nothing is KNOWN under this check any more; the next
  // one to appear fails the build, which is the point.
]);

const text = (t: EmailType) => [...t.format, ...(t.promptNotes ?? [])];
const fieldText = (t: EmailType) => (t.fields ?? []).map((f) => `${f.name} ${f.label} ${f.hint ?? ""} ${f.prompt}`).join(" | ");
let failed = 0;
const fail = (key: string, msg: string) => {
  if (KNOWN.has(key)) return;
  console.log(`FAIL ${key}\n     ${msg}`);
  failed++;
};

// ---- 1. a step demanding a fact nothing in the app holds -------------------
// A fact is supplied if the type has a field for it, or a profile column holds
// it. `profile: false` means nothing anywhere does - those are the gradmonth
// class, and a type may only name one if it also carries an escape clause.
const FACTS: { id: string; pattern: RegExp; profile: boolean }[] = [
  { id: "graduation date", pattern: /graduation (date|month)/i, profile: false },
  { id: "graduation year", pattern: /graduation year|class year/i, profile: true },
  { id: "phone number", pattern: /phone number|your number/i, profile: true },
  { id: "the recipient's team or group", pattern: /\btheir (team|group)\b/i, profile: true },
  { id: "the recipient's last name", pattern: /\blast name\b/i, profile: true },
  { id: "a requisition number", pattern: /requisition number|\breq ?#/i, profile: false },
  { id: "a start date", pattern: /\bstart date\b/i, profile: false },
  { id: "a deadline", pattern: /\bdeadline\b/i, profile: false },
  { id: "a time zone", pattern: /time zone/i, profile: false },
];
const ESCAPE = /never (ask for|leave)|no placeholder|isn't given|if (it|the|no|none|nothing)\b|leave (it|that sentence|them) out|holds only a year|with no /i;
for (const t of EMAIL_TYPES) {
  for (const f of FACTS) {
    const step = t.format.find((s) => f.pattern.test(s));
    if (!step) continue;
    if (f.profile || f.pattern.test(fieldText(t))) continue;
    if (text(t).some((s) => f.pattern.test(s) && ESCAPE.test(s))) continue;
    fail(`unsupplied/${t.id}/${f.id}`, `format step demands "${f.id}" with no field, no profile column and no escape clause: ${step}`);
  }
}

// ---- 2. a literal [placeholder] in a line the reviewer may not rewrite -----
// draft-review's REVIEW_SYSTEM keeps the greeting line and every [bracketed
// placeholder] exactly as written, and leaves the subject alone. A bracket
// printed in a step about the greeting or the subject therefore ships.
for (const t of EMAIL_TYPES)
  for (const s of t.format)
    if (/greet|subject/i.test(s))
      for (const m of s.matchAll(/\[[^\]]{1,40}\]/g))
        fail(`bracket/${t.id}/${m[0]}`, `format step prints ${m[0]} in a greeting or subject line, which the reviewer may not rewrite: ${s}`);

// ---- 3. a step demanding a fact the student's own answer hides -------------
// A select that picks which situation this is hides the other branches' fields
// (activeFields), so the fact never reaches the prompt. An unconditional
// numbered step still asking for it sends the drafter to GAP_RULES.
for (const t of EMAIL_TYPES) {
  for (const sel of (t.fields ?? []).filter((f) => f.kind === "select")) {
    for (const opt of sel.options ?? []) {
      const active = new Set(activeFields(t, (n) => (n === sel.name ? opt.value : undefined)).map((f) => f.name));
      for (const hidden of (t.fields ?? []).filter((f) => !active.has(f.name))) {
        // The fact is only demanded if a step names it in the field's own words.
        const words = (hidden.label + " " + (hidden.placeholder ?? "")).toLowerCase().match(/[a-z]{5,}/g) ?? [];
        const step = t.format.find((s) => !/\bif\b|\bunless\b|\bor\b/i.test(s) && words.filter((w) => s.toLowerCase().includes(w)).length >= 2);
        if (step) fail(`hidden/${t.id}/${hidden.name}`, `"${sel.label}" = "${opt.label}" hides \`${hidden.name}\`, but an unconditional step still asks for it: ${step}`);
      }
    }
  }
  // A "nothing / no ask" option with no step or note saying what to write instead.
  const noneOpt = (t.fields ?? []).find((f) => f.kind === "select" && (f.options ?? []).some((o) => /^(nothing|none)\b/i.test(o.label)));
  if (noneOpt && t.format.some((s) => /^Ask\b/i.test(s)) && !text(t).some((s) => /or none at all|no ask|isn't asking for anything|just wanted to say thank|offered nothing/i.test(s)))
    fail(`hidden/${t.id}/${noneOpt.name}`, `"${noneOpt.label}" offers a no-ask option, but every ask step is unconditional and no note says what to write instead`);
}

// ---- 4. the combination formats, which checks 1-3 never read --------------
// MEASURED 12 October 2026 (audit/AB-2026-10-12.md). Scenario 819 shipped
// "The most useful part was [one thing you learned from Ben]." as a paragraph
// of its own. The demand was not in any `format` or `promptNotes` that checks
// 1-3 read: it was in the Volume V COMBINATION FORMAT, which refines the
// per-type format and which nothing here had ever looked at. `redirectDetail`
// is an optional field, so a sparse student leaves it blank and the drafter
// goes to GAP_RULES.
//
// This is the exact instance, asserted exactly, rather than a heuristic over
// all 18 sections with six unexamined exemptions - the same 18 sections hold
// five more steps that insist on a specific fact, and whether each one's field
// is required has not been checked. That audit is open; see FORMAT-AUDIT.md.
type VSection = { section: number; title: string; format: string[] };
const V_SECTIONS = (volumeV as { sections: VSection[] }).sections;
const CLOSE_LOOP_ESCAPE = /only when THIS EMAIL says what came of the conversation/;

const s17 = V_SECTIONS.find((s) => s.section === 17);
if (!s17) fail("combination/17/missing", "Volume V section 17 (the redirect close-the-loop) is gone - re-point this check");
else if (!s17.format.some((f) => CLOSE_LOOP_ESCAPE.test(f)))
  fail(
    "combination/17/redirectDetail",
    `section 17 "${s17.title}" asks for one thing the student learned with no branch condition. ` +
      "`redirectDetail` is optional, so a student who left it blank gets a bracket mid-paragraph.",
  );

const redirect = EMAIL_TYPES.find((t) => t.id === "redirect_sequence")!;
if (!(redirect.promptNotes ?? []).some((n) => /never a bracketed marker where the specific thing would go/.test(n)))
  fail(
    "combination/redirect_sequence/redirectDetail",
    "redirect_sequence's close-the-loop note asks for one specific thing that came of the conversation " +
      "with no branch condition for the student who did not say.",
  );

// ---- 5. an unconditional step demanding a merely-OPTIONAL field ------------
// MEASURED 13 October 2026. `second_conversation`'s step 3 said "Ask for 15
// minutes, and say why now rather than later". `whyNow` is optional, a sparse
// student leaves it blank, and the model manufactured an urgency to fill the
// gap - "where my approach could be sharper", which the judge called fuzzy and
// unanswerable. Two of two sparse second_conversation emails failed this way
// (822, 826 in audit-probe/sweep87-2026-10-12).
//
// Asserted as the one instance, not as a pattern. A general check - any
// unconditional step naming an optional field's words - fires 19 times across
// the playbook, and most are this matcher mistaking a prose note for a demand
// ("More formal than replying to a professional" matching `timeZone`). Nineteen
// unexamined exemptions is the failure this file's KNOWN list warns about, and
// the same call was made for the Volume V sections in D55.
const secondConversation = EMAIL_TYPES.find((t) => t.id === "second_conversation")!;
if (!secondConversation.format.some((f) => /only when THIS EMAIL gives a reason/.test(f)))
  fail(
    "optional/second_conversation/whyNow",
    "step 3 asks the student to say why now with no branch condition. `whyNow` is optional, so a student who " +
      "left it blank gets an invented urgency - measured as a vague, unanswerable ask in 2 of 2 sparse emails.",
  );

console.log(
  failed === 0
    ? `${EMAIL_TYPES.length}/${EMAIL_TYPES.length} types + ${V_SECTIONS.length} combination formats: no new unsupplied-fact demand, no new bracket in a greeting or subject step, no new step asking for a hidden field, redirect close-the-loop and second-conversation still branch (${KNOWN.size} known open findings allowed)`
    : `${failed} new failing`,
);
process.exit(failed === 0 ? 0 : 1);
