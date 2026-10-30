// The specimen ratchet: no prompt may print a phrasing it wants written.
//
//   npx tsx scripts/draft-specimen-test.ts
//
// MEASURED (docs/concepts/HARNESS.md, DECISIONS.md D3/D11): the review pass
// removed the canned courtesy lines from three drafts and replaced them with
// VOICE_RULES' OWN printed alternative - "Any time that suits you works for me"
// - word for word in two of the three. A demonstration beats an instruction, so
// a rule that quotes a preferred phrasing turns that phrasing into the next
// template. The same mechanism one level down is why 192 template-prose example
// emails produce template-prose drafts.
//
// So every quoted phrasing in the prompt stack is classified, and only two of
// the three classes may be quoted:
//
//   Class N - shown as what NOT to write. QUOTED, deliberately: quoting a
//             banned phrase is the precise discriminator and does not cause it
//             to be used. A model does not copy the sentence labelled wrong.
//   Class P - a positive specimen that is a complete, reusable sentence or
//             courtesy line. These are the contaminators, and the list below is
//             the set that may NEVER appear in a prompt again. Each was replaced
//             by a description plus a testable constraint.
//   Class S - a specimen demonstrating STRUCTURE: clause order, where a
//             sentence ends, or a rendering another check keys on. Kept, and
//             labelled as a shape by the global rule.
//
// This file is the ratchet. It is pure string assertion over the real exported
// prompts - no model, no API, no fixture - so a specimen cannot creep back in
// without failing the build, which is the only thing that stops it.

import { VOICE_RULES, buildDraftPrompt, type DraftPromptInput } from "../src/lib/draft-prompt";
import { EMAIL_TYPES } from "../src/lib/draft-templates";
import { buildReviewPrompt } from "../src/lib/draft-review";

let passed = 0;
const failures: string[] = [];
function t(name: string, ok: boolean, got?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${got === undefined ? "" : ` -> ${JSON.stringify(got)}`}`);
}

/** Same words whatever the apostrophe, quote character or run of whitespace. */
const loose = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Class P. Every string here was printed in a prompt as the phrasing to use,
// and every one is a complete sentence or courtesy line a model can paste
// unchanged into any email. None may be quoted in any prompt again.
// ---------------------------------------------------------------------------
const CLASS_P: { text: string; was: string }[] = [
  // VOICE_RULES - the courtesy lines. The flexibility line is the one MEASURED
  // being copied verbatim by the reviewer in 2 of 3 edits.
  { text: "My resume's attached in case it's useful", was: "VOICE_RULES, courtesy lines: the resume" },
  { text: "Any time that suits you works for me", was: "VOICE_RULES, courtesy lines: flexibility (MEASURED contaminating)" },
  { text: "No worries at all if the timing's wrong", was: "VOICE_RULES, courtesy lines: the easy out" },
  { text: "Following up on my note in case it got buried.", was: "VOICE_RULES, misplaced-clause rule: the preferred rewrite" },
  // The last positive specimen left in VOICE_RULES (PROMPT-COHERENCE, D11 item
  // 3): a complete opener printed as the one to prefer, and printed with an
  // invented weekday - the same fault F8 reports in follow_up_1's own format
  // step. The pattern is pinned with its frame ("X" beats "Y") rather than as
  // the bare phrase, because REVIEW_SYSTEM still quotes the bare phrase as a
  // Class-N example of a glued-together opener, where it belongs.
  { text: '"Following up on my note from Tuesday" beats', was: "VOICE_RULES, throat-clearing rule: the preferred opener, with an invented weekday" },
  { text: "I'm a sophomore at Duke, and I'm also from Atlanta.", was: "VOICE_RULES and REVIEW_SYSTEM 6b: common ground" },
  // REVIEW_SYSTEM rules 6 and 6b.
  { text: "where I gather you also studied", was: "REVIEW_SYSTEM 6: shared school (also contradicted rule 6's own \"not 'I gather'\")" },
  { text: "Following up on my note from last week in case it got buried.", was: "REVIEW_SYSTEM 6b: the buried-note rewrite" },
  { text: "Following up on my note from last week.", was: "REVIEW_SYSTEM 6b: the allowed dropped-subject opener" },
  { text: "Happy to work around your schedule.", was: "REVIEW_SYSTEM 6b: allowed opener - and VOICE_RULES bans this very line (conflict C11)" },
  { text: "As a fellow Duke student, I'd love to hear about your path", was: "REVIEW_SYSTEM 6b: the \"As a [role]\" rewrite" },
  { text: "I watched your episode on community banking and would love to set up a call", was: "REVIEW_SYSTEM 6b: the dangling-actor rewrite" },
  { text: "Emily Tran suggested I reach out to you.", was: "REVIEW_SYSTEM 6b: the plain-fact referral line" },
  { text: "Ben and I had our call. Thank you again for connecting us.", was: "REVIEW_SYSTEM 6b: statement-then-thanks" },
  { text: "Could you confirm my application was received?", was: "REVIEW_SYSTEM 6b: a request stays a question" },
];

// ---------------------------------------------------------------------------
// Class N. Quoted on purpose, and the test pins them so a later "tidy-up" that
// strips the banned phrasings cannot pass unnoticed: without them the rule
// loses its discriminator and becomes advice.
// ---------------------------------------------------------------------------
const CLASS_N = [
  "I hope you're doing well",
  "I wanted to reach out",
  "I wanted to follow up",
  "I just wanted to say",
  "I noticed we're both from Atlanta",
  "too, like you",
  "made all the difference",
  "exactly what I needed",
];

// ---------------------------------------------------------------------------
// Class S. Shapes, kept. "a fellow Duke alum" is BOTH a positive specimen and
// the rendering guardRevision's shared-school regex keys on (`\bfellow
// <school>`, `\balum\w*`): rewriting it away would make the reviewer phrase a
// shared school in words the guard then reads as "dropped the shared school"
// and throw the whole edit out. It stays, labelled a shape by the global rule.
// ---------------------------------------------------------------------------
const CLASS_S = ["a fellow Duke alum", "My name is ..."];

/** The sentence that tells both models a quoted phrasing is a shape, not a phrase. */
const GLOBAL_RULE = "is an illustration of a shape, never a phrase to use";

const REVIEW_INPUT: DraftPromptInput = {
  studentName: "Alex Rivera",
  studentSchool: "Duke University",
  studentGradYear: 2029,
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  type: "cold_referral",
  boxIds: ["first.referred"],
};
// The prompt that actually ships, not a copy of it.
const REVIEW_SYSTEM = buildReviewPrompt(REVIEW_INPUT, { subject: "s", body: "Hi Rachel,\n\nBest,\nAlex Rivera" }, []).system;

const PROMPTS: [string, string][] = [
  ["VOICE_RULES", VOICE_RULES],
  ["REVIEW_SYSTEM", REVIEW_SYSTEM],
];

// 1. The global rule is in both prompts. Without it, every Class-S specimen
//    that stays is an unlabelled demonstration.
for (const [name, text] of PROMPTS) {
  t(`${name} carries the global specimen rule`, loose(text).includes(loose(GLOBAL_RULE)));
}

// 2. No Class-P string survives anywhere in either prompt.
for (const [name, text] of PROMPTS) {
  const body = loose(text);
  for (const { text: specimen, was } of CLASS_P) {
    t(`${name} does not print Class-P specimen (${was}): "${specimen}"`, !body.includes(loose(specimen)));
  }
}

// 3. The negative specimens are still quoted. A rule whose banned phrasing has
//    been paraphrased away no longer discriminates.
for (const n of CLASS_N) {
  t(`Class-N specimen still quoted somewhere: "${n}"`, PROMPTS.some(([, text]) => loose(text).includes(loose(n))));
}

// 4. The structural specimens are still there, and "a fellow Duke alum" in
//    particular, because the guard's shared-school regex depends on the shape.
for (const s of CLASS_S) {
  t(`Class-S specimen kept: "${s}"`, PROMPTS.some(([, text]) => loose(text).includes(loose(s))));
}

// 5. REVIEW_SYSTEM embeds VOICE_RULES, so a specimen rewritten in one and not
//    the other would otherwise pass item 2 on the wrong prompt.
t("REVIEW_SYSTEM still embeds VOICE_RULES verbatim", REVIEW_SYSTEM.includes(VOICE_RULES));

// 6. The drafter gets the voice policy too (R2a). The whole point of putting
//    VOICE_RULES in the drafting prompt is that the reviewer stops fighting the
//    drafter's own examples on every draft; if it is ever taken out again, the
//    specimens here are not the problem any more and this test should say so.
const draftSystem = buildDraftPrompt({ ...REVIEW_INPUT, now: new Date("2026-09-20T12:00:00") });
t("the drafting prompt contains VOICE_RULES", draftSystem.system.includes(VOICE_RULES));
t("and VOICE_RULES is in the INVARIANT tier, so it stays cacheable", draftSystem.systemTiers.invariant.includes(VOICE_RULES));

// ---------------------------------------------------------------------------
// 7. The same rule one level down: a type's own `format` and `promptNotes`.
//
// F7/F8 (docs/concepts/audit/FORMAT-AUDIT.md): seven format steps instructed
// the flexibility courtesy line VOICE_RULES bans outright, and follow_up_1
// step 2 quoted a 13-word opener containing "last week" - HOUSE_RULES' own
// example of a forbidden invented specific. The drafter was instructed toward
// a line the reviewer then paid a model call to strip. These assertions are
// the ratchet on that: the format may describe the job, never print the line.
// ---------------------------------------------------------------------------
const BANNED_IN_FORMAT = [
  // The four stock courtesy lines VOICE_RULES bans by name, plus the paraphrase
  // the format steps actually used.
  "I attached my resume for your reference",
  "happy to work around your schedule",
  "work around their schedule",
  "please do not hesitate to reach out",
  "I look forward to hearing from you",
  // F8's sentence, and the invented specific inside it.
  "in case it got buried",
  "from last week",
];
// Checked over `format` only, not `promptNotes`. The numbered format tells the
// drafter what to write, so a line printed there is an instruction; a note may
// quote one as WRONG, and OTHER_FIRST_EMAIL_NOTE deliberately does ("Never fold
// it into the follow-up line (\"... in case it got buried\")") - Class N, which
// is exactly what should stay quoted.
for (const phrase of BANNED_IN_FORMAT) {
  const hits = EMAIL_TYPES.flatMap((type) =>
    type.format.filter((step) => loose(step).includes(loose(phrase))).map((step) => `${type.id}: ${step}`),
  );
  t(`no format step instructs the banned line "${phrase}"`, hits.length === 0, hits);
}

// A step may name a concept in quotation marks ("a little more time", "why you
// specifically"); it may not print a sentence. Six words is the longest quoted
// run left in all 41 formats, so this is a ratchet at today's value rather than
// a round number - F8's quote was 13.
const longQuotes = EMAIL_TYPES.flatMap((type) =>
  type.format.flatMap((step) =>
    [...step.matchAll(/"([^"]+)"/g)]
      .filter((m) => m[1].trim().split(/\s+/).length > 6)
      .map((m) => `${type.id}: "${m[1]}"`),
  ),
);
t("no format step quotes a run longer than six words (a quoted sentence is a demonstration)", longQuotes.length === 0, longQuotes);

// And the global rule reaches the drafter through the whole prompt, not just
// through VOICE_RULES in isolation.
t("the drafting prompt carries the global specimen rule", loose(draftSystem.system).includes(loose(GLOBAL_RULE)));

console.log(failures.length === 0 ? `${passed}/${passed} passed` : `${passed} passed, ${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
