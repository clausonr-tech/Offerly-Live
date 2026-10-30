// Tests for the review pass and the automatic draft checks, with no API calls:
// the guard, the student checks, and the whole draft-then-review pipeline run
// against a fake client that returns scripted responses.
//
//   npx tsx --conditions=react-server scripts/draft-review-test.ts

import type Anthropic from "@anthropic-ai/sdk";
import { buildDraftPrompt, finishDraft, type DraftPromptInput } from "../src/lib/draft-prompt";
import { buildReviewPrompt, detailScore, detailSurvived, guardRevision, studentNotesFromReview } from "../src/lib/draft-review";
import { ASK, commaSplices, DETAIL_COMMON, draftChecks, findingCategory, formatPhone, privateTopicsIn, resumeLooksLikeSomeoneElses } from "../src/lib/draft-lint";
import { EMAIL_EXAMPLES } from "../src/lib/email-examples";
import { runDraftPipeline } from "../src/lib/draft-pipeline";
import { applyReviewEdit, SPAN_GUARD_DEFAULT } from "../src/lib/draft-span-guard";
import { alignBodies, segment } from "../src/lib/draft-align";
import { getSubCallConfig } from "../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

let passed = 0;
const failures: string[] = [];
function t(name: string, ok: boolean, got?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${got === undefined ? "" : ` -> ${JSON.stringify(got)}`}`);
}

const INPUT: DraftPromptInput = {
  studentName: "Alex Rivera",
  studentSchool: "University of Pennsylvania",
  studentGradYear: 2029,
  studentPhone: "15550101234",
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  contactRole: "Vice President",
  type: "cold_referral",
  alsoTypes: ["cold_after_meeting"],
  boxIds: ["first.referred", "first.met"],
  now: new Date("2026-09-20T12:00:00"),
  brief: {
    fieldAnswers: [
      { prompt: "Referred by", value: "Jeff Moreno" },
      { prompt: "Where and when they met", value: "the WITG x WUEC panel" },
    ],
  },
};

const SIGNATURE = "Best,\nAlex Rivera\nUniversity of Pennsylvania ’29\n(555) 010-1234";
const DRAFT = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I'm a sophomore at the University of Pennsylvania. Would you have 15 minutes for a call? My resume is attached.

Thank you!

${SIGNATURE}`;

// ------------------------------------------------------------------ guard
const reworded = DRAFT.replace("and it was great to meet you", "and I was glad to meet you");
const g1 = guardRevision({ subject: "Referred by Jeff Moreno", body: DRAFT }, { subject: "Referred by Jeff Moreno", body: reworded }, INPUT);
t("guard keeps a plain rewording", g1.ok, g1);

const g2 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("panel.", "panel at Goldman.") }, INPUT);
t("guard rejects a new name mid-sentence", !g2.ok && /Goldman/.test(g2.reason), g2);

const g3 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("15 minutes", "20 minutes") }, INPUT);
t("guard rejects a new number", !g3.ok && /20/.test(g3.reason), g3);

const withGap = DRAFT.replace("University of Pennsylvania.", "University of Pennsylvania, and I want to learn [what you want to learn].");
const g4 = guardRevision({ subject: "s", body: withGap }, { subject: "s", body: DRAFT }, INPUT);
t("guard rejects a dropped placeholder", !g4.ok && /placeholder/.test(g4.reason), g4);

const g5 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("Hi Rachel,", "Dear Rachel,") }, INPUT);
t("guard rejects a changed greeting", !g5.ok && /greeting/.test(g5.reason), g5);

const g6 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("Would you have 15 minutes for a call? ", "") }, INPUT);
t("guard rejects a dropped ask", !g6.ok, g6);

const g7 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("Thank you!", `Thank you!\n\n${"I am very eager to learn more about the work. ".repeat(4)}`) }, INPUT);
t("guard rejects a much longer email", !g7.ok && /grew/.test(g7.reason), g7);

const g8 = guardRevision({ subject: "Referred by Jeff Moreno", body: DRAFT }, { subject: "Exciting Opportunity Awaits", body: reworded }, INPUT);
t("guard keeps the body but not an invented subject", g8.ok && g8.subject === "Referred by Jeff Moreno", g8);

const g9 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("Jeff Moreno suggested", "On Tuesday, Jeff Moreno suggested") }, INPUT);
t("guard rejects an invented day, even opening a sentence's second word", !g9.ok, g9);

// ------------------------------------------------------------------ checks
t("phone: 11 digits with a leading 1", formatPhone("15550101234") === "(555) 010-1234", formatPhone("15550101234"));
t("phone: dotted", formatPhone("555.010.1234") === "(555) 010-1234", formatPhone("555.010.1234"));
t("phone: international stays as typed", formatPhone("+44 20 7946 0958") === "+44 20 7946 0958");
t("phone: already formatted stays", formatPhone("(919) 555-0142") === "(919) 555-0142");
t("signature uses the formatted phone", buildDraftPrompt(INPUT).userText.includes("(555) 010-1234"));

t("resume: someone else's name", resumeLooksLikeSomeoneElses("Aidan Matus-Enochs - Resume 1.docx", "Alex Rivera"));
t("resume: the student's own", !resumeLooksLikeSomeoneElses("Kai_Clauson_Resume_2026.pdf", "Alex Rivera"));
t("resume: no name at all", !resumeLooksLikeSomeoneElses("Resume Final v3.pdf", "Alex Rivera"));
t("resume: last name only", !resumeLooksLikeSomeoneElses("Clauson Resume.pdf", "Alex Rivera"));

// The real draft that started this: a one-word recipient, a repeated class year, filler.
const ANCHORAGE = `Hi Anchorage,

I met Jeff at the WITG x WUEC panel, where we ended up talking about his poker obsession and his Mustang.

My name is Alex Rivera, and I'm a sophomore at the University of Pennsylvania (Class of 2029) studying finance. I also gather we're from the same hometown.

I wanted to reach out to learn more about the credit and distressed group's recruiting process. First, when does your process typically open for sophomores?

I've attached my resume for reference. Thank you very much for your time!

${SIGNATURE}`;
const checks = draftChecks({ contactName: "Anchorage", contactFirm: "Anchorage Capital", gmailSignature: false, studentGradYear: 2029 }, ANCHORAGE);
t("checks: greeting that's the firm's name", checks.forStudent.some((n) => /firm's name/.test(n)), checks.forStudent);
t("checks: class year repeated", checks.forReview.some((n) => /Class of 2029/.test(n)), checks.forReview);
t("checks: filler phrase", checks.forReview.some((n) => /wanted to reach out/.test(n)), checks.forReview);
t("checks: hometown tacked on", checks.forReview.some((n) => /tacked onto/.test(n)), checks.forReview);
const single = draftChecks({ contactName: "Jordan", contactFirm: "Morrow & Pike", gmailSignature: false, studentGradYear: 2029 }, "Hi Jordan,\n\nHello.\n\nBest,");
t("checks: one-word recipient name", single.forStudent.some((n) => /only one name/.test(n)), single.forStudent);
const team = draftChecks({ contactName: "Morrow & Pike Recruiting Team", contactFirm: "Morrow & Pike", gmailSignature: false, studentGradYear: 2029 }, "Hello Morrow & Pike Recruiting Team,\n\nHello.\n\nBest,");
t("checks: a team inbox isn't flagged", team.forStudent.length === 0, team.forStudent);

// ------------------------------------------------------------------ prompts
const drafting = buildDraftPrompt(INPUT).system;
t("drafting prompt plans first", drafting.includes("PLAN FIRST"));
t("drafting prompt carries the voice rules too (R2a)", drafting.includes("SOUND LIKE A PERSON"));
const reviewPrompt = buildReviewPrompt(INPUT, { subject: "Referred by Jeff Moreno", body: DRAFT, plan: { people: [{ name: "Jeff Moreno", role: "referrer" }], sentences: [] } }, ["filler phrase: \"I wanted to reach out\""]);
t("review prompt carries the voice rules", reviewPrompt.system.includes("SOUND LIKE A PERSON"));
t("review prompt names the recipient's role", reviewPrompt.userText.includes("RECIPIENT, the person this email is addressed to: Rachel Stein"));
t("review prompt includes the facts, the plan, the checks and the draft",
  ["Referred by: Jeff Moreno", "Jeff Moreno: referrer", "wanted to reach out", "DRAFT\nSubject: Referred by Jeff Moreno"].every((s) => reviewPrompt.userText.includes(s)));

t("notes: only what the student must act on", studentNotesFromReview([
  { kind: "grammar", quote: "a", fix: "fixed", needsStudent: false },
  { kind: "private", quote: "his gambling", fix: "Took out the gambling.", needsStudent: true },
], true).join() === "Took out the gambling.");

// The rejected path must not echo the model's own words back. `quote` is
// model-written text: the pipeline gates it now, but the note should never have
// been built out of it (FIX-PIPELINE 1, "Reported, not fixed").
const rejectedNote = studentNotesFromReview([
  { kind: "private", quote: "his gambling debts", fix: "Took that out.", needsStudent: true },
], false).join();
t("notes: a rejected edit never echoes the model's quote", !rejectedNote.includes("gambling debts"), rejectedNote);
t("notes: a rejected edit still carries the fix", rejectedNote === "Check what the review flagged before sending. Took that out.", rejectedNote);

// ------------------------------------------------------------------ pipeline
function fakeClient(responses: unknown[]) {
  const calls: { model: string; system: unknown }[] = [];
  const client = {
    messages: {
      parse: async (req: { model: string; system: unknown }) => {
        calls.push(req);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
const usage = { input_tokens: 1000, output_tokens: 200 };
const draftResponse = (body: string) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { plan: { people: [], sentences: [] }, subject: "Referred by Jeff Moreno", body, connectionUsed: null, gaps: [], notesForStudent: [] },
});
const reviewResponse = (body: string, problems: unknown[] = []) => ({
  stop_reason: "end_turn",
  usage,
  parsed_output: { problems, subject: "Referred by Jeff Moreno", body },
});
const DRAFT_CONFIG = { model: "claude-sonnet-5", effort: "low", thinking: "disabled", maxTokens: 4096 } as const;

async function pipelineTests() {
  const a = fakeClient([draftResponse(DRAFT), reviewResponse(reworded, [{ kind: "flow", quote: "it was great", fix: "smoother", needsStudent: false }])]);
  const r1 = await runDraftPipeline(a.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("pipeline: an accepted edit replaces the draft", r1.review?.applied === true && r1.draft.body.includes("I was glad to meet you"), r1.review);
  t("pipeline: keeps the pre-review draft", r1.preReview.body.includes("it was great to meet you"));
  t("pipeline: the review runs on Sonnet", a.calls[1]?.model === "claude-sonnet-5", a.calls.map((c) => c.model));
  t("pipeline: usage covers both calls", r1.usage.input_tokens === 2000 && r1.usage.output_tokens === 400, r1.usage);
  t("pipeline: grammar fixes aren't student notes", r1.draft.notesForStudent.length === 0, r1.draft.notesForStudent);
  t("pipeline: signature rebuilt after the edit", r1.draft.body.endsWith("(555) 010-1234"), r1.draft.body.slice(-40));

  // Rejected twice: the edit and its one retry both add a firm nobody typed.
  const goldman = DRAFT.replace("panel.", "panel at Goldman.");
  const b = fakeClient([draftResponse(DRAFT), reviewResponse(goldman), reviewResponse(goldman)]);
  const r2 = await runDraftPipeline(b.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("pipeline: a rejected edit keeps the draft", r2.review?.applied === false && !r2.draft.body.includes("Goldman") && Boolean(r2.review?.rejected), r2.review);
  t("pipeline: a rejected edit is kept for diagnosis", Boolean(r2.review?.revisedBody?.includes("Goldman")), r2.review);
  t("pipeline: a rejected edit gets exactly one retry", b.calls.length === 3, b.calls.length);
  const retryAsk = JSON.stringify((b.calls[2] as unknown as { messages: unknown[] })?.messages?.at(-1));
  t("pipeline: the retry is told why the edit was thrown away", /That edit can't be used: it added/.test(retryAsk), retryAsk);

  // Rejected, then put right on the retry: the retry's edit is used.
  const g = fakeClient([draftResponse(DRAFT), reviewResponse(goldman), reviewResponse(reworded, [{ kind: "flow", quote: "it was great", fix: "smoother", needsStudent: false }])]);
  const r2b = await runDraftPipeline(g.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("pipeline: a retry that passes the guard is applied", r2b.review?.applied === true && r2b.draft.body.includes("I was glad to meet you") && !r2b.draft.body.includes("Goldman"), r2b.review);
  t("pipeline: usage covers the retry too", r2b.usage.input_tokens === 3000, r2b.usage);

  // No time left: no retry.
  const h = fakeClient([draftResponse(DRAFT), reviewResponse(goldman)]);
  await runDraftPipeline(h.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG, reviewRetryBeforeMs: 0 });
  t("pipeline: no retry once the request is too old", h.calls.length === 2, h.calls.length);

  const c = fakeClient([draftResponse(DRAFT), new Error("overloaded")]);
  const r3 = await runDraftPipeline(c.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("pipeline: a failed review still returns the draft", r3.draft.body.includes("it was great to meet you") && Boolean(r3.review?.error), r3.review);

  const d = fakeClient([
    draftResponse(DRAFT),
    reviewResponse(reworded, [{ kind: "mismatch", quote: "sales and trading", fix: "Your interest is sales and trading, but this is a credit team.", needsStudent: true }]),
  ]);
  const r4 = await runDraftPipeline(d.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  t("pipeline: a problem for the student becomes a note", r4.draft.notesForStudent.some((n) => /credit team/.test(n)), r4.draft.notesForStudent);

  const e = fakeClient([draftResponse(DRAFT.replace("Hi Rachel,", "Hi Anchorage,"))]);
  const r5 = await runDraftPipeline(e.client, { ...INPUT, contactName: "Anchorage" }, { draft: DRAFT_CONFIG, review: null });
  t("pipeline: automatic student checks become notes", r5.draft.notesForStudent.some((n) => /firm's name/.test(n)), r5.draft.notesForStudent);
}

async function moreTests() {
  // Guard: an edit may not drop what the student typed, except a private detail.
  const typedInput: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [...INPUT.brief!.fieldAnswers!, { prompt: "What stuck with the student", value: "his advice about staffing on live deals" }] },
  };
  const withDetail = DRAFT.replace("Would you have", "His advice about staffing on live deals stuck with me. Would you have");
  const g10 = guardRevision({ subject: "s", body: withDetail }, { subject: "s", body: DRAFT }, typedInput);
  t("guard rejects an edit that drops a typed detail", !g10.ok && /typed/.test(g10.reason), g10);
  const privateInput: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [...INPUT.brief!.fieldAnswers!, { prompt: "What they talked about", value: "his gambling addiction" }] },
  };
  const withPrivate = DRAFT.replace("Would you have", "We talked about his gambling addiction. Would you have");
  const g11 = guardRevision({ subject: "s", body: withPrivate }, { subject: "s", body: DRAFT }, privateInput);
  t("guard lets the reviewer take out a private detail", g11.ok, g11);

  const optionInput: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [...INPUT.brief!.fieldAnswers!, { prompt: "Which email in the redirect sequence this is", value: "Emailing the person they pointed me to" }] },
  };
  const withOptionWords = DRAFT.replace("Would you have", "I am emailing the person they pointed me to. Would you have");
  const g12 = guardRevision({ subject: "s", body: withOptionWords }, { subject: "s", body: DRAFT }, optionInput);
  t("guard doesn't treat a picked option as a typed detail", g12.ok, g12);

  const alumInput: DraftPromptInput = { ...INPUT, alumniSchool: "University of Pennsylvania", detectedOverlaps: ["Same school"] };
  const withAlum = DRAFT.replace("I'm a sophomore at the University of Pennsylvania.", "I'm a sophomore at the University of Pennsylvania, where I gather you also studied.");
  const g13 = guardRevision({ subject: "s", body: withAlum }, { subject: "s", body: DRAFT }, alumInput);
  t("guard rejects an edit that drops the shared school", !g13.ok && /shared school/.test(g13.reason), g13);

  // A comma splice is reported to the reviewer and is NOT a veto any more: the
  // check is right about one body in five, and a wrong veto throws away every
  // other fix in the edit (LOGIC-2 F2; see DIAGNOSTIC_CATEGORIES). The pin is
  // now that the finding is still produced.
  const spliced = DRAFT.replace("Jeff Moreno suggested I write to you, and it was great to meet you", "Jeff Moreno suggested I write to you, it was great to meet you");
  const g14 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: spliced }, INPUT);
  t("guard doesn't veto an edit over a comma splice, but the lint still reports it",
    g14.ok && draftChecks({ contactName: "Rachel Stein", contactFirm: null, gmailSignature: true, studentGradYear: 2029 }, spliced).forReview.some((i) => /comma splice/.test(i)), g14);

  const g15 = guardRevision({ subject: "Referred by Jeff Moreno", body: DRAFT }, { subject: "Jeff Moreno Referred", body: reworded }, INPUT);
  t("guard keeps the subject without a reported subject problem", g15.ok && g15.subject === "Referred by Jeff Moreno", g15);
  const g16 = guardRevision({ subject: "Refered by Jeff Moreno", body: DRAFT }, { subject: "Referred by Jeff Moreno", body: reworded }, INPUT, [
    { kind: "spelling", quote: "Refered by Jeff Moreno", fix: "spelling", needsStudent: false },
  ]);
  t("guard takes a reported subject spelling fix", g16.ok && g16.subject === "Referred by Jeff Moreno", g16);

  const mangledSignature = reworded.replace("University of Pennsylvania ’29", "University of Pennsylvania 201929");
  const g17 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: mangledSignature }, INPUT);
  t("guard ignores a mangled signature (it's rebuilt anyway)", g17.ok, g17);

  t("comma splice: a pronoun clause after a comma", commaSplices("Emily suggested I follow up, she interned on your team.").length === 1);
  t("comma splice: thanks joined to the next sentence", commaSplices("Thank you again for connecting me with Ben, we had our call this week.").length === 1);
  t("comma splice: an aside before the clause is fine", commaSplices("I'm a sophomore at Duke studying economics and, like you, I'm from Atlanta.").length === 0);
  const dashed = draftChecks({ contactName: "Rachel Stein", contactFirm: "Morrow & Pike", gmailSignature: true, studentGradYear: 2029 }, "Hi Rachel,\n\nNo reply needed - thank you again.\n\nBest,");
  t("checks: a spaced hyphen used as a dash", dashed.forReview.some((i) => /dash/.test(i)), dashed.forReview);
  const opinionBody = "Hi Rachel,\n\nEmily thought you'd be the right person to ask.\n\nBest,";
  const noOpinionTyped = draftChecks({ contactName: "Rachel Stein", contactFirm: "Morrow & Pike", gmailSignature: true, studentGradYear: 2029, brief: {} }, opinionBody);
  t("checks: an opinion nobody typed", noOpinionTyped.forReview.some((i) => /opinion/.test(i)), noOpinionTyped.forReview);
  const opinionTyped = draftChecks(
    { contactName: "Rachel Stein", contactFirm: "Morrow & Pike", gmailSignature: true, studentGradYear: 2029, brief: { fieldAnswers: [{ prompt: "Why", value: "she said you're the person to ask" }] } },
    opinionBody,
  );
  t("checks: an opinion the student typed is fine", !opinionTyped.forReview.some((i) => /opinion/.test(i)), opinionTyped.forReview);
  const unescaped = finishDraft({ ...INPUT, gmailSignature: true }, { subject: "s", body: "Hi Rachel,\n\nI like M&A.//nI had two questions about https://nyu.edu/news.//\n\nBest,", connectionUsed: null, gaps: [] }).body;
  t("finish: a stray //n becomes a paragraph break, URLs untouched", unescaped.includes("M&A.\n\nI had") && unescaped.includes("https://nyu.edu/news.") && !unescaped.includes("M&A.//n") && !/news\.\/\//.test(unescaped), unescaped);

  t("comma splice: an introductory phrase is fine", commaSplices("This summer, I built a model. Since then, I spent time on it.").length === 0);

  const whoPrompt = buildReviewPrompt(INPUT, { subject: "s", body: DRAFT }, []).userText;
  t("review prompt states who's who from the boxes", whoPrompt.includes("WHO'S WHO") && whoPrompt.includes("The student met the RECIPIENT in person."), whoPrompt.slice(0, 200));

  t("review facts carry the class year", buildReviewPrompt(INPUT, { subject: "s", body: DRAFT }, []).userText.includes("a sophomore"));

  const n = fakeClient([
    { ...draftResponse(DRAFT), parsed_output: { ...draftResponse(DRAFT).parsed_output, notesForStudent: ["Please attach your resume in Gmail before sending.", "Your resume will be attached automatically since Rachel offered to pass it along.", "I removed the signature block since your Gmail adds it automatically.", "Attach your transcript in Gmail."] } },
  ]);
  const r7 = await runDraftPipeline(n.client, INPUT, { draft: DRAFT_CONFIG, review: null });
  t("pipeline: drops notes about what the app does itself", r7.draft.notesForStudent.length === 1 && /transcript/.test(r7.draft.notesForStudent[0]), r7.draft.notesForStudent);

  t("private topics found", privateTopicsIn("we talked about his gambling addiction").join() === "gambling,addiction", privateTopicsIn("we talked about his gambling addiction"));
  t("private topics: an ordinary email has none", privateTopicsIn(DRAFT).length === 0, privateTopicsIn(DRAFT));
  const rehab = draftChecks({ contactName: "Rachel Stein", contactFirm: "Morrow & Pike", gmailSignature: true, studentGradYear: 2029 }, "Hi Rachel,\n\nGlad your rehab went well.\n\nBest,");
  t("checks: a private topic becomes a student note", rehab.forStudent.some((n) => /rehab/.test(n)), rehab.forStudent);

  const f = fakeClient([draftResponse(DRAFT), reviewResponse(reworded)]);
  await runDraftPipeline(f.client, { ...INPUT, resumePdf: Buffer.from("%PDF-1.4") }, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG });
  const calls = f.calls as unknown as { messages: { content: unknown }[]; system: unknown }[];
  t("pipeline: the review sees the resume PDF", JSON.stringify(calls[1]?.messages[0].content).includes("application/pdf"));
  t("pipeline: both system prompts are cacheable", calls.length === 2 && calls.every((c) => JSON.stringify(c.system).includes("ephemeral")));

  const h = fakeClient([draftResponse(DRAFT)]);
  const r6 = await runDraftPipeline(h.client, INPUT, { draft: DRAFT_CONFIG, review: DRAFT_REVIEW_CONFIG, reviewSkipAfterMs: -1 });
  t("pipeline: the review is skipped past the time budget", h.calls.length === 1 && /skipped/.test(r6.review?.error ?? ""), r6.review);
}

// ------------------------------------------------- D4: the guard's measured false positives
//
// Each block below reproduces a bug the coordinator measured against the real
// functions (docs/concepts/DECISIONS.md D4, docs/concepts/PLAN-B-accuracy.md
// M5-M9, M12) and pins the behaviour that replaced it.

function d4Tests() {
  // BUG 1 (M12). The reviewer is instructed to take private details out. On a
  // short email, taking out the sentence that carried one shrinks the body past
  // the floor, and the floor fired before the private exemption could apply -
  // so the guard punished the reviewer for obeying rule 3 and the private
  // detail shipped.
  const privateFacts: DraftPromptInput = { ...INPUT, brief: { conversationDetails: "she mentioned her divorce and the move" } };
  const PRIVATE_BEFORE =
    "Hi Rachel,\n\nThank you for the call. You mentioned your divorce and the move, which I appreciated hearing about.\n\nBest,\nMaya Patel";
  const PRIVATE_AFTER = "Hi Rachel,\n\nThank you for the call.\n\nBest,\nMaya Patel";
  const b1 = guardRevision({ subject: "s", body: PRIVATE_BEFORE }, { subject: "s", body: PRIVATE_AFTER }, privateFacts, [
    { kind: "private", quote: "your divorce and the move", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: removing a private detail may shrink a short email past the floor", b1.ok, b1);

  // ...and the floor still catches a reviewer that guts the email, even while
  // it reports a private problem. Only the sentences carrying the reported
  // quote are discounted; everything else still has to clear 60%.
  const GUTTABLE =
    "Hi Rachel,\n\nThank you for the call. You mentioned your divorce and the move, which I appreciated hearing about. " +
    "Your points about the credit team and how it staffs analysts stuck with me, and I have been thinking about them since.\n\nBest,\nMaya Patel";
  const b1b = guardRevision({ subject: "s", body: GUTTABLE }, { subject: "s", body: "Hi Rachel,\n\nThank you.\n\nBest,\nMaya Patel" }, privateFacts, [
    { kind: "private", quote: "your divorce and the move", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: the shrink floor still catches a gutted email", !b1b.ok && /cut from/.test(b1b.reason), b1b);

  // ...and a reviewer that reports a private problem it did not actually remove
  // earns no credit: the quote is still in the body it returned.
  const b1c = guardRevision({ subject: "s", body: GUTTABLE }, { subject: "s", body: PRIVATE_BEFORE }, privateFacts, [
    { kind: "private", quote: "your divorce and the move", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: no shrink credit for a private detail the edit kept", !b1c.ok && /cut from/.test(b1c.reason), b1c);

  // BUG 2 (M9). "Penn" and "the University of Pennsylvania" are one school by
  // src/lib/school-name.ts's own table, but the new-proper-noun rule saw
  // "University" as a word that isn't in FACTS and threw the edit away. The
  // rule is the main defence against an invented firm, person or place, so only
  // the table's canonical name for a school FACTS actually names is admitted.
  const pennFacts: DraftPromptInput = { ...INPUT, studentSchool: "Penn" };
  const PENN_SHORT = "Hi Rachel,\n\nI am a junior at Penn studying economics, and I would value ten minutes of your time.\n\nBest,\nMaya Patel";
  const PENN_LONG = PENN_SHORT.replace("I am a junior at Penn", "I'm a junior at the University of Pennsylvania");
  const b2 = guardRevision({ subject: "s", body: PENN_SHORT }, { subject: "s", body: PENN_LONG }, pennFacts);
  t("guard: the school's own full name may replace its nickname", b2.ok, b2);
  const b2b = guardRevision({ subject: "s", body: PENN_LONG }, { subject: "s", body: PENN_SHORT }, { ...INPUT, studentSchool: "University of Pennsylvania" });
  t("guard: the nickname may replace the full name", b2b.ok, b2b);
  const b2c = guardRevision({ subject: "s", body: PENN_SHORT }, { subject: "s", body: PENN_SHORT.replace("at Penn", "at Princeton") }, pennFacts);
  t("guard: still rejects a school FACTS never named", !b2c.ok && /Princeton/.test(b2c.reason), b2c);
  const b2d = guardRevision({ subject: "s", body: PENN_SHORT }, { subject: "s", body: PENN_SHORT.replace("at Penn", "at Penn State") }, pennFacts);
  t("guard: still rejects a lookalike school", !b2d.ok && /State/.test(b2d.reason), b2d);
  const b2e = guardRevision({ subject: "s", body: PENN_SHORT }, { subject: "s", body: PENN_SHORT.replace("at Penn", "at Wharton") }, pennFacts);
  t("guard: still rejects a school inside the school FACTS named", !b2e.ok && /Wharton/.test(b2e.reason), b2e);
  const alumniFacts: DraftPromptInput = { ...INPUT, studentSchool: "Villanova", alumniSchool: "Notre Dame", contactSchool: "Notre Dame" };
  const ND = "Hi Rachel,\n\nI am a junior at Villanova, and I gather you studied at Notre Dame.\n\nBest,\nMaya Patel";
  const b2f = guardRevision(
    { subject: "s", body: ND },
    { subject: "s", body: ND.replace("you studied at Notre Dame", "you studied at the University of Notre Dame") },
    alumniFacts,
  );
  t("guard: the recipient's school may be written out in full too", b2f.ok, b2f);

  // BUG 5 (M10). Structural: runDraftPipeline strips the PDF before building
  // promptInput, so the REVIEWER is shown the resume and the GUARD gets only
  // `hasResumePdf: true`. A reviewer that works a real resume fact back in is
  // then rejected for inventing it. With no summary to check against, exactly
  // one unknown capitalised word becomes accept-with-note instead of a silent
  // rejection; two is still a rejection, and a summary turns the allowance off.
  const pdfFacts: DraftPromptInput = { ...INPUT, studentSchool: "Penn", hasResumePdf: true };
  const CLUB = "Hi Rachel,\n\nI am a sophomore at Penn studying finance, and I run an investment club.\n\nBest,\nAlex Rivera";
  const CLUB_NAMED = CLUB.replace("an investment club", "the Pinecrest investment club");
  const b5 = guardRevision({ subject: "s", body: CLUB }, { subject: "s", body: CLUB_NAMED }, pdfFacts);
  t("guard: one proper noun from an unread resume PDF is accepted with a note", b5.ok && /Pinecrest/.test(b5.note ?? ""), b5);
  const b5b = guardRevision(
    { subject: "s", body: CLUB },
    { subject: "s", body: CLUB.replace("an investment club", "the Pinecrest Fellows club") },
    pdfFacts,
  );
  t("guard: two unknown proper nouns are still rejected with a resume PDF", !b5b.ok && /Pinecrest/.test(b5b.reason), b5b);
  const b5c = guardRevision({ subject: "s", body: CLUB }, { subject: "s", body: CLUB_NAMED }, {
    ...pdfFacts,
    studentResumeSummary: "Treasurer of the campus finance society.",
  });
  t("guard: the allowance is off once the resume text is available", !b5c.ok && /Pinecrest/.test(b5c.reason), b5c);
  const b5d = guardRevision({ subject: "s", body: CLUB }, { subject: "s", body: CLUB_NAMED }, { ...INPUT, studentSchool: "Penn" });
  t("guard: no resume, no allowance", !b5d.ok && /Pinecrest/.test(b5d.reason), b5d);
  t("guard: an ordinary accepted edit carries no note", g1.ok && g1.note === undefined, g1);

  // M11 / PLAN-B v2 §2.4. The lint comparison was a COUNT, and `forReview` is
  // empty on both sides for about seven drafts in eight, so it compared nothing
  // to nothing - and the strict `>` admitted swapping one defect for another.
  // It is now a veto by category: a kind of problem the draft did not have is a
  // regression; more of a kind it already had is not the guard's business.
  const SWAP_BEFORE =
    "Hi Rachel,\n\nI wanted to reach out about the credit team. Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.\n\nBest,\nAlex Rivera";
  const SWAP_AFTER =
    "Hi Rachel,\n\nI am writing about the credit team. Jeff Moreno suggested I write to you, it was great to meet you at the WITG x WUEC panel.\n\nBest,\nAlex Rivera";
  // M11's swap detection stands, but not on `comma splice`, which no longer
  // votes: swapping filler FOR a splice is now accepted, while swapping a
  // splice for filler is still a regression (b6c below). The asymmetry is the
  // measured one - `filler phrase` is right when it fires, `comma splice` is
  // wrong four times in five (LOGIC-2 F2/F8).
  const b6 = guardRevision({ subject: "s", body: SWAP_BEFORE }, { subject: "s", body: SWAP_AFTER }, INPUT);
  t("guard: a swap into a diagnostic-only category is not a rejection", b6.ok, b6);
  const MORE_FILLER =
    "Hi Rachel,\n\nI wanted to reach out. I hope this email finds you well. Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.\n\nBest,\nAlex Rivera";
  const b6b = guardRevision({ subject: "s", body: SWAP_BEFORE }, { subject: "s", body: MORE_FILLER }, INPUT);
  t("guard: more of a finding the draft already had is not a rejection", b6b.ok, b6b);
  const b6c = guardRevision({ subject: "s", body: SWAP_AFTER }, { subject: "s", body: SWAP_BEFORE }, INPUT);
  t("guard: trading a comma splice for a filler phrase is also a regression", !b6c.ok && /filler/.test(b6c.reason), b6c);
  // Every finding the lint can produce must classify, or the veto silently
  // lumps unrelated defects into one category and stops noticing a swap.
  const unclassified = new Set<string>();
  for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES)) {
    for (const e of examples) {
      const name = e.body.match(/^(?:Hi|Hello|Dear)\s+([^,]+),/)?.[1]?.trim() ?? "there";
      for (const f of draftChecks({ contactName: name, contactFirm: null, gmailSignature: false, studentGradYear: null, brief: {}, purpose: null, extraContext: "" }, e.body).forReview) {
        if (findingCategory(f) === "other") unclassified.add(`${typeId}: ${f}`);
      }
    }
  }
  t("lint: every finding the playbook corpus produces has a category", unclassified.size === 0, [...unclassified]);

  // BUG 3 (M5/M6/M7): coverage()'s five-character stem. The fixture table is
  // PLAN-B R5's, every row with the verdict the guard should reach.
  const DETAIL_FIXTURES: [string, string, boolean, string][] = [
    // M6 - the ratio holds while the specific half vanishes.
    ["his advice about staffing on live deals and how he moved from audit to restructuring",
     "He gave me advice about staffing on live deals, which stuck with me.", false, "M6: half the detail dropped"],
    ["his advice about staffing on live deals and how he moved from audit to restructuring",
     "His advice about staffing on live deals, and how he moved from audit to restructuring, stuck with me.", true, "M6 control: all of it kept"],
    // M5 - stems that collide on five characters but are different words.
    ["the intern class", "we reviewed the internal process", false, "M5: intern vs internal"],
    ["my interest in credit", "the summer intern class", false, "M5: interest vs intern"],
    ["distressed debt", "the distribution desk", false, "M5: distressed vs distribution"],
    // M5 - stems that SHOULD stay together.
    ["his move into management", "the manager I spoke with", true, "M5: management and manager are one word"],
    ["restructuring", "we restructure portfolios", true, "M5: restructuring and restructure are one word"],
    ["financing", "the finance team", true, "M5: financing and finance are one word"],
    // M7 - a paraphrase that genuinely drops the student's own word.
    ["we ended up talking about his Mustang", "We spent most of the conversation on his car.", false, "M7: the anchor is gone"],
    // The anchor rule's point: paraphrase freely AROUND an anchor.
    ["his advice about staffing on live deals", "Your advice on how live deals get staffed stuck with me.", true, "paraphrase around the anchors"],
    ["we spent most of the conversation on the Pinecrest investment club", "The Pinecrest investment club came up.", true, "common words dropped, anchors kept"],
    // Plain presence and absence.
    ["we talked about his cars", "We talked about his cars.", true, "the word is there"],
    ["we talked about his cars", "We talked about the markets.", false, "the word is gone"],
    ["", "anything at all", true, "nothing typed, nothing to lose"],
  ];
  let detailRows = 0;
  for (const [detail, body, want, why] of DETAIL_FIXTURES) {
    const got = detailSurvived(detail, body);
    if (got === want) detailRows++;
    else failures.push(`detail fixture (${why}): wanted ${want}, got ${got}`);
  }
  t(`detail: all ${DETAIL_FIXTURES.length} R5 fixture rows`, detailRows === DETAIL_FIXTURES.length, `${detailRows}/${DETAIL_FIXTURES.length}`);
  const timed = detailScore("call on 10/6 at 3pm", "Could we speak on October 6?");
  t("detail: a lost time is named as a lost anchor", !detailSurvived("call on 10/6 at 3pm", "Could we speak on October 6?") && timed.anchorsLost.includes("3pm"), timed);

  // Corpus sanity (R5 §5.3): every six-word window of every body is found in that
  // body, and is missed once removed from it. Strided rather than sampled at an
  // offset derived from body.length, which re-rolled the sample whenever a body
  // was edited and so could not distinguish a sensitivity loss from a new sample.
  // Both the window and the body-without-it are built from the SAME flattened
  // word list. Taking the window out with a string replace against the raw body
  // silently does nothing whenever the span crosses a line break, which left
  // the body intact and made this read 69% when the real number is 96%.
  const windows = Object.values(EMAIL_EXAMPLES).flat().map((e) => {
    const flat = e.body.replace(/\s*\n\s*/g, " ");
    const words = flat.split(/\s+/).filter(Boolean);
    const starts: number[] = [];
    for (let i = 0; i + 6 <= words.length; i += 6) starts.push(i);
    return starts.map((start) => ({
      body: flat,
      window: words.slice(start, start + 6).join(" "),
      without: [...words.slice(0, start), ...words.slice(start + 6)].join(" "),
    }));
  }).flat().filter((w) => w.window.trim().length > 0);
  const present = windows.filter((w) => detailSurvived(w.window, w.body)).length;
  const absent = windows.filter((w) => !detailSurvived(w.window, w.without)).length;
  t(`detail: a window of a body survives in that body (${present}/${windows.length})`, present === windows.length, `${present}/${windows.length}`);
  t(`detail: a window removed from a body is noticed (${absent}/${windows.length})`, absent / windows.length >= 0.92, `${absent}/${windows.length}`);

  // DETAIL_COMMON is generated, so the generator stays runnable: these are the
  // tokens that appear lowercase in >=10% of the playbook's bodies.
  const bodies = Object.values(EMAIL_EXAMPLES).flat().map((e) => e.body);
  const seen = new Map<string, number>();
  const STOP = new Set("about after also been before from have into just like more most much only over some that than their them then there these they this those very what when where which while with would your".split(" "));
  for (const b of bodies) {
    for (const w of new Set((b.match(/[A-Za-z0-9#]+/g) ?? []).filter((x) => x === x.toLowerCase() && x.length >= 4 && !/\d/.test(x) && !STOP.has(x)))) {
      seen.set(w, (seen.get(w) ?? 0) + 1);
    }
  }
  const regenerated = [...seen].filter(([, n]) => n >= Math.ceil(bodies.length * 0.1)).map(([w]) => w).sort();
  t(`detail: DETAIL_COMMON still matches the corpus it was generated from (${regenerated.length} tokens)`,
    regenerated.length === DETAIL_COMMON.size && regenerated.every((w) => DETAIL_COMMON.has(w)),
    { regenerated: regenerated.length, constant: DETAIL_COMMON.size, missing: regenerated.filter((w) => !DETAIL_COMMON.has(w)).slice(0, 8) });

  // ...and the guard reaches the same verdict through its typed-detail rule.
  const m6Facts: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [{ prompt: "What stuck with the student", value: "his advice about staffing on live deals and how he moved from audit to restructuring" }] },
  };
  const M6_FULL =
    "Hi Rachel,\n\nHis advice about staffing on live deals, and how he moved from audit to restructuring, stuck with me.\n\nBest,\nAlex Rivera";
  const M6_HALF = "Hi Rachel,\n\nHis advice about staffing on live deals stuck with me.\n\nBest,\nAlex Rivera";
  const b3 = guardRevision({ subject: "s", body: M6_FULL }, { subject: "s", body: M6_HALF }, m6Facts);
  t("guard: an edit that drops half a typed detail is rejected", !b3.ok && /typed/.test(b3.reason), b3);

  // BUG 4 (M4). ASK matched 35 of the playbook's 192 bodies, so the guard's
  // "dropped the ask" rule and the congratulations-ordering check did nothing
  // on about four email shapes in five.
  //
  // The sample below is hand-labelled: the FIRST example of each of the 40
  // types, read in full, marked for whether the email asks the recipient to do
  // or answer something. An offer ("I am glad to send anything else") and a
  // sentiment ("I would love to stay in touch") are not asks; a softened
  // request ("if you have 10 minutes, I would love to hear...") is.
  const ASK_SAMPLE: [string, boolean][] = [
    ["accept_offer", true], ["after_rejection", true], ["call_scheduling", true], ["close_loop_referrer", false],
    ["coffee_in_person_reply", true], ["cold_after_meeting", true], ["cold_email", true], ["cold_not_alum", true],
    ["cold_referral", true], ["conference_follow_up", true], ["congratulations", false], ["decline_offer", false],
    ["follow_up_1", true], ["follow_up_2", true], ["interview_check_in", true], ["keep_in_touch", true],
    ["not_now_reply", false], ["offer_extension", true], ["professor_recommendation", true], ["recorded_round_note", true],
    ["recruiter_follow_up", true], ["recruiter_outreach", true], ["recruiter_scheduling_reply", true], ["recruiting_inbox", true],
    ["recruiting_inbox_follow_up", true], ["redirect_sequence", true], ["reference_request", true], ["referral_ask", true],
    ["reschedule_call", true], ["second_conversation", true], ["stalled_thread_nudge", true], ["thank_helper_offer", false],
    ["thank_you_chat", true], ["thank_you_event", true], ["thank_you_interview", false], ["thank_you_offered_help", false],
    ["thank_you_phone_screen", false], ["thank_you_recruiter_session", true], ["thank_you_superday", false], ["withdraw_process", false],
  ];
  const examples = EMAIL_EXAMPLES as Record<string, { body: string }[]>;
  t("ask: the sample is 40 bodies and every type exists", ASK_SAMPLE.length === 40 && ASK_SAMPLE.every(([ty]) => examples[ty]?.[0]), ASK_SAMPLE.filter(([ty]) => !examples[ty]?.[0]));
  let askTp = 0;
  let askFp = 0;
  let askFn = 0;
  const askFpTypes: string[] = [];
  for (const [type, isAsk] of ASK_SAMPLE) {
    const hit = ASK.test(examples[type][0].body);
    if (hit && isAsk) askTp++;
    else if (hit && !isAsk) { askFp++; askFpTypes.push(type); }
    else if (!hit && isAsk) askFn++;
  }
  const recall = askTp / (askTp + askFn);
  t(`ask: no body without an ask is matched (precision ${(100 * askTp / Math.max(1, askTp + askFp)).toFixed(0)}%)`, askFp === 0, askFpTypes);
  t(`ask: at least 70% of real asks are matched (recall ${(100 * recall).toFixed(1)}%)`, recall >= 0.7, `${askTp}/${askTp + askFn}`);
  // 131 before the offer arm was narrowed, 115 after: the rule deliberately no
  // longer counts "please let me know if there is anything else you need from
  // me", which was the sole trigger on 25 gold bodies and is an offer, not an
  // ask (LOGIC-2 F3). The floor is kept well above half the corpus, which is
  // what this test is for - the rule being inert on most shapes was BUG 4.
  const askCorpus = Object.values(examples).flat().filter((e) => ASK.test(e.body)).length;
  t(`ask: the rule is live on most playbook shapes (${askCorpus}/192)`, askCorpus >= 110, askCorpus);
  // The guard rule it exists for: an edit that deletes the one request is not an edit.
  // Padded so that losing the ask does NOT trip the shrink floor: without the
  // padding this passes for the wrong reason and tests nothing about the ask.
  const ASK_SENTENCE = " The one thing still open on my end is whether a 15 minute call works for you in the next few weeks.";
  const NUDGE_BODY =
    "Hi Rachel,\n\nThank you for the note back, and I am glad the conference was as useful for you as it was for me. " +
    "I have been following the infrastructure work since we spoke, and your point about staffing has stayed with me." +
    ASK_SENTENCE +
    " Any day and any time is fine, including early mornings.\n\nBest,\nAlex Rivera";
  const b4 = guardRevision(
    { subject: "s", body: NUDGE_BODY },
    { subject: "s", body: NUDGE_BODY.replace(ASK_SENTENCE, "") },
    INPUT,
  );
  t("guard: deleting a softened ask is caught as the ask, not as shrinkage", !b4.ok && /ask/.test(b4.reason), b4);

  // C-series / the reviewer's prompt contradicted itself and the code: one line
  // said "grows past 20% or shrinks past 40%" (which the code enforces) and
  // another "never more than 15% longer" (which nothing enforces). A reviewer
  // given two different limits cannot aim at either.
  const sys = buildReviewPrompt(INPUT, { subject: "s", body: DRAFT }, []).system;
  t("prompt: the contradictory 15% limit is gone", !/15% longer/.test(sys), sys.match(/[^.]*15%[^.]*/)?.[0]);
  t("prompt: states the limits the code actually enforces", /20% longer/.test(sys) && /60%/.test(sys), sys.match(/[^.]*20%[^.]*/)?.[0]);
  t("prompt: tells the reviewer a reported private removal is exempt from the floor", /don't count against the shrink limit/.test(sys), false);
  // ...and those numbers are the real ones, proved at the boundary. The email
  // grows by repeating two words it already uses, so the growth is the only
  // thing that changes: no new name, no new finding, no repeated word.
  const PAD = "Hi Rachel,\n\n" + "I am a sophomore studying finance and economics at school. ".repeat(10) + "\nBest,\nAlex Rivera";
  const padWords = PAD.split("Best,")[0].split(/\s+/).filter(Boolean).length;
  const grow = (pairs: number) =>
    guardRevision({ subject: "s", body: PAD }, { subject: "s", body: PAD.replace("at school.", `at school${" finance economics".repeat(pairs)}.`) }, INPUT);
  const under = grow(Math.floor((padWords * 0.19) / 2));
  const over = grow(Math.ceil((padWords * 0.21) / 2));
  t("guard: the growth ceiling really is 20%", under.ok && !over.ok && /grew/.test(over.reason), { under, over });
}

// ------------------------------------------- LOGIC-1 / LOGIC-2: the audit round's soundness defects
//
// Every block reproduces a defect measured in docs/concepts/audit/LOGIC-1-guard.md
// or LOGIC-2-lint.md, with a probe under scripts/audit-probe/, and pins the
// behaviour that replaced it. The reproduction is in the comment; the fix is in
// docs/concepts/audit/FIX-GUARD.md.

function fixGuardTests() {
  // S1. The typed-detail exemption trusted the reviewer's own `kind` plus a
  // quote that resembled the detail - it never checked the quote was in the
  // draft, gone from the edit, or private at all. So echoing a typed detail
  // back as a "private" quote deleted it (probe1-deletion-credit.ts, 1e).
  const s1Facts: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [{ prompt: "What stuck with the student", value: "his advice about staffing on live deals and how he moved from audit to restructuring" }] },
  };
  const S1_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday. The advice you gave about staffing on live deals, and how you moved from audit to restructuring, " +
    "stuck with me and I have thought about it since. Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const S1_GONE =
    "Hi Rachel,\n\nThank you for the time on Thursday. What you said about the work your team takes on stuck with me and I have thought about it since. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const s1a = guardRevision({ subject: "s", body: S1_BEFORE }, { subject: "s", body: S1_GONE }, s1Facts, [
    { kind: "private", quote: "his advice about staffing on live deals and how he moved from audit to restructuring", fix: "Removed it", needsStudent: false },
  ]);
  t("guard: a private quote that was never in the draft earns no exemption", !s1a.ok && /typed/.test(s1a.reason), s1a);
  const S1_HALF =
    "Hi Rachel,\n\nThank you for the time on Thursday. The advice you gave about staffing on live deals stuck with me and I have thought about it since. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const s1b = guardRevision({ subject: "s", body: S1_BEFORE }, { subject: "s", body: S1_HALF }, s1Facts, [
    { kind: "private", quote: "The advice you gave about staffing on live deals", fix: "Removed it", needsStudent: false },
  ]);
  t("guard: a private quote the edit kept earns no exemption", !s1b.ok && /typed/.test(s1b.reason), s1b);
  // ...and the real thing still works: quoted, really gone, and really private.
  const s1Private: DraftPromptInput = { ...INPUT, brief: { conversationDetails: "her divorce and the move" } };
  const S1_PRIV_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday. You mentioned your divorce and the move, which I appreciated hearing about. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const S1_PRIV_AFTER =
    "Hi Rachel,\n\nThank you for the time on Thursday. It was good of you to make the time. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const s1c = guardRevision({ subject: "s", body: S1_PRIV_BEFORE }, { subject: "s", body: S1_PRIV_AFTER }, s1Private, [
    { kind: "private", quote: "your divorce and the move", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: a corroborated private removal still exempts the typed detail", s1c.ok, s1c);

  // F1. `privateTopicsIn` was the typed-detail exemption, and one finance word
  // in the detail switched the guard's protection off: "the restructuring of
  // Hertz" was protected, "the bankruptcy of Hertz" was droppable
  // (private-guard-probe.ts).
  const f1Facts: DraftPromptInput = {
    ...INPUT,
    brief: { fieldAnswers: [{ prompt: "Why them", value: "your work on the bankruptcy of Hertz is what got me interested in the group" }] },
  };
  const F1_BEFORE =
    "Hi Rachel,\n\nYour work on the bankruptcy of Hertz is what got me interested in the group, and I have followed it since. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const F1_AFTER =
    "Hi Rachel,\n\nThe work your group takes on is what got me interested in it, and I have followed the team since. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const f1 = guardRevision({ subject: "s", body: F1_BEFORE }, { subject: "s", body: F1_AFTER }, f1Facts);
  t("guard: a typed detail with a finance word in it is still protected", !f1.ok && /typed/.test(f1.reason), f1);

  // F1, the other direction: the word list missed every genuinely sensitive
  // disclosure and fired on ordinary coverage vocabulary (misc-probe.ts private:
  // 20 of 20 missed, 14 of 15 benign sentences flagged).
  const SENSITIVE_DISCLOSURES = [
    "She mentioned her husband's illness and how hard the treatment has been.",
    "He told me he is in recovery and no longer drinks.",
    "We talked about his custody battle and the settlement.",
    "She told me about her ADHD medication.",
    "He spoke about losing his daughter last year.",
    "She shared that she is on antidepressants.",
    "He mentioned his immigration status is still pending.",
    "We talked about her mental health and the hospital stay.",
    "He said he was let go in the last round of cuts.",
    "She mentioned her IVF treatments.",
    "He is going through a separation.",
    "She told me about her abortion.",
    "He said his son is in a treatment centre.",
    "She mentioned she had been sober for two years.",
    "He is on disability leave.",
    "She told me she voted for the measure and goes to synagogue on Fridays.",
    "He mentioned his HIV status.",
    "He was indicted last spring.",
    "She mentioned her tumour was benign.",
    "He said the firm is under SEC investigation and he was subpoenaed.",
  ];
  const BENIGN_FINANCE = [
    "I was fascinated by your father's cancer research at the medical centre.",
    "I would love to hear about the Chapter 11 deal your team ran.",
    "Your work on the bankruptcy of Hertz was what got me interested in restructuring.",
    "I am taking a class on the economics of addiction this spring.",
    "I read your note on the lawsuit that reshaped the industry.",
    "The diagnostics company you took public is one I follow closely.",
    "I am interested in your pregnancy-tech portfolio company.",
    "I read the piece on how the firm was arrested mid-process - a figure of speech, I know.",
    "Your panel on anxiety in junior bankers was the most useful hour of my semester.",
    "The therapy-services roll-up your group did last year is what drew me in.",
    "I follow the oncology franchise and the chemotherapy pipeline closely.",
    "I would like to hear how the firm thinks about gambling and gaming credit.",
    "Our club pitched a rehab-clinic operator last spring.",
    "The DUI-detection hardware company in your portfolio caught my eye.",
    "I wrote my thesis on divorce rates and household formation.",
  ];
  const caught = SENSITIVE_DISCLOSURES.filter((s) => privateTopicsIn(s).length > 0).length;
  const falsePositives = BENIGN_FINANCE.filter((s) => privateTopicsIn(s).length > 0);
  t(`private topics: at least 16 of the 20 measured disclosures are found (${caught}/20)`, caught >= 16,
    SENSITIVE_DISCLOSURES.filter((s) => privateTopicsIn(s).length === 0));
  t(`private topics: at most 2 of the 15 benign finance sentences fire (${falsePositives.length}/15)`, falsePositives.length <= 2, falsePositives);

  // OUTPUT-3. There was no pattern for an SSN, a bank or card number, a pay
  // figure, a home address or someone else's phone - the list draft-prompt.ts
  // forbids in an email - so the reviewer removing one was punished as dropping
  // a typed detail, and the value shipped.
  const lintBase = { contactName: "Rachel Stein", contactFirm: "Anchorage Capital", gmailSignature: true, studentGradYear: 2029 } as const;
  const vals = (body: string) => draftChecks(lintBase, `Hi Rachel,\n\n${body}\n\nBest,`).forStudent.join(" ");
  t("values: an SSN becomes a student note", /Social Security/i.test(vals("They asked me to send my SSN 123-45-6789 before the interview.")), vals("They asked me to send my SSN 123-45-6789 before the interview."));
  t("values: a card number becomes a student note", /card/i.test(vals("I paid the fee with 4111 1111 1111 1111 on the portal.")));
  t("values: a routing number becomes a student note", /account|routing/i.test(vals("My account number is 000123456789 if payroll needs it.")));
  t("values: a pay figure becomes a student note", /paid/i.test(vals("The salary was $95,000 and I wanted your read on it.")), vals("The salary was $95,000 and I wanted your read on it."));
  t("values: a home address becomes a student note", /address/i.test(vals("My address is 14 Elm Street, Apt 3, Boulder 80302 if you need it.")));
  t("values: someone else's phone becomes a student note", /phone/i.test(vals("Jeff said to reach him on his cell, (555) 123-4567, any time.")));
  t("values: a deal size is not a pay figure", vals("Your team's $400 million financing for the airline is what drew me in.") === "", vals("Your team's $400 million financing for the airline is what drew me in."));
  t("values: a year and a class size are not sensitive", vals("I am in the class of 2029 and there are 1,200 of us studying finance.") === "");
  t("values: the student's own number in the body is not someone else's", vals("You can reach me on 555-010-1234 whenever suits you.") === "");
  t("values: a street with no number and no unit is not an address", vals("We could meet at Marlow Coffee on Chandler Street if that is easier.") === "");
  const ssnFacts: DraftPromptInput = { ...INPUT, brief: { conversationDetails: "he asked me to send my SSN 123-45-6789 for the background check" } };
  const SSN_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday. He asked me to send my SSN 123-45-6789 for the background check, so I will do that today. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const SSN_AFTER =
    "Hi Rachel,\n\nThank you for the time on Thursday. I will get the background check paperwork over today, as he asked. " +
    "Would you have 15 minutes in the next two weeks for a call?\n\nBest,\nAlex Rivera";
  const ssn = guardRevision({ subject: "s", body: SSN_BEFORE }, { subject: "s", body: SSN_AFTER }, ssnFacts, [
    { kind: "other", quote: "my SSN 123-45-6789", fix: "Took the number out", needsStudent: true },
  ]);
  t("guard: taking an SSN out is never punished, whatever the reviewer calls it", ssn.ok, ssn);

  // S4. `stem` stripped one suffix and stopped, so stem("partners")="partner"
  // but stem("partner")="partn" and a plural never met its own singular: 10 of
  // 14 pairs lost in both directions (probe4-detail-survived.ts, 4b).
  const PAIRS = ["banker", "manager", "merger", "trader", "meeting", "briefing", "earning", "quarter", "partner", "semester"];
  const bothWays = PAIRS.filter((w) => detailSurvived(`the ${w}s on the desk`, `A ${w} on the desk.`) && detailSurvived(`the ${w} on the desk`, `The ${w}s on the desk.`));
  t(`detail: a plural matches its own singular, both ways (${bothWays.length}/${PAIRS.length})`, bothWays.length === PAIRS.length,
    PAIRS.filter((w) => !bothWays.includes(w)));

  // S3. The deletion credit landed at the word-count rule only, so the ask
  // rule, the shared-school rule and the category veto each rejected the very
  // removal the credit exists to allow (probe2-ordering.ts, 2a/2b/2c).
  const askFacts: DraftPromptInput = { ...INPUT, brief: { conversationDetails: "how she kept recruiting on track through her divorce" } };
  const ASK_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday, which I have thought about since. I would love to hear how you kept recruiting on track through your divorce, if you have 15 minutes.\n\nBest,\nAlex Rivera";
  const ASK_AFTER = "Hi Rachel,\n\nThank you for the time on Thursday, which I have thought about since.\n\nBest,\nAlex Rivera";
  const s3a = guardRevision({ subject: "s", body: ASK_BEFORE }, { subject: "s", body: ASK_AFTER }, askFacts, [
    { kind: "private", quote: "how you kept recruiting on track through your divorce", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: a private removal that takes the ask with it is accepted", s3a.ok, s3a);
  t("guard: ...and the student is told the ask went with it", /ask/i.test((s3a.ok && s3a.note) || ""), s3a);
  const schoolFacts: DraftPromptInput = { ...INPUT, alumniSchool: "University of Pennsylvania", brief: { conversationDetails: "his cancer diagnosis last spring" } };
  const SCHOOL_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday, which I have thought about since. I gather you also studied at Pennsylvania, and I was sorry to hear about his cancer diagnosis last spring.\n\nBest,\nAlex Rivera";
  const SCHOOL_AFTER = "Hi Rachel,\n\nThank you for the time on Thursday, which I have thought about since.\n\nBest,\nAlex Rivera";
  const s3b = guardRevision({ subject: "s", body: SCHOOL_BEFORE }, { subject: "s", body: SCHOOL_AFTER }, schoolFacts, [
    { kind: "private", quote: "I gather you also studied at Pennsylvania, and I was sorry to hear about his cancer diagnosis last spring.", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: a private removal that takes the shared-school line with it is accepted", s3b.ok, s3b);
  const DOUBLE_BEFORE =
    "Hi Rachel,\n\nThank you for the time on Thursday. You mentioned your divorce and the move, which I appreciated. I have thought about the credit team since, and the way it staffs its analysts.\n\nBest,\nAlex Rivera";
  const DOUBLE_AFTER =
    "Hi Rachel,\n\nThank you for the time on Thursday.  I have thought about the credit team since, and the way it staffs its analysts.\n\nBest,\nAlex Rivera";
  const s3c = guardRevision({ subject: "s", body: DOUBLE_BEFORE }, { subject: "s", body: DOUBLE_AFTER }, { ...INPUT, brief: { conversationDetails: "her divorce and the move" } }, [
    { kind: "private", quote: "You mentioned your divorce and the move, which I appreciated.", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: a cut that leaves a double space is not 'made the writing worse'", s3c.ok, s3c);

  // F4. `guardRevision` judged the reviewer's RAW body while `finishDraft` ran
  // afterwards, so the veto read a string the student never sees: an em dash
  // the rewrite turns into ", and thank you" passed the veto and shipped
  // (interaction-probe.ts, §2). The guard now accepts the pipeline's normaliser.
  const DASH_BEFORE = "Hi Rachel,\n\nThe call was useful. Thank you again for making the time, and for the introduction to Ben.\n\nBest,\nAlex Rivera";
  const DASH_AFTER = "Hi Rachel,\n\nThe call was useful — and thank you again for making the time, and for the introduction to Ben.\n\nBest,\nAlex Rivera";
  const emDash = (body: string) => body.replace(/\s*—+\s*/g, ", ");
  const f4raw = guardRevision({ subject: "s", body: DASH_BEFORE }, { subject: "s", body: DASH_AFTER }, INPUT);
  const f4fin = guardRevision({ subject: "s", body: DASH_BEFORE }, { subject: "s", body: DASH_AFTER }, INPUT, [], emDash);
  t("guard: judges the finished text when the pipeline passes its normaliser", !f4fin.ok && /thank-you/.test(f4fin.reason), { raw: f4raw, finished: f4fin });

  // F2 / LOGIC-2 F6(d). `commaSplices` reported 10 of 10 ordinary introductory
  // phrases as splices, missed 9 of 10 real ones, and 4 of its 5 gold hits were
  // its own false positives - and it VETOED the whole edit (splice-probe.ts,
  // tier-probe.ts §b). It is now a diagnostic the reviewer is told about, and
  // not veto-eligible.
  const SPLICE_FP = "Hi Rachel,\n\nThank you for the note. Having read the fund's latest letter, I came away with one question about the credit book.\n\nBest,\nAlex Rivera";
  const SPLICE_OK = "Hi Rachel,\n\nThank you for the note. I read the fund's latest letter and came away with one question about the credit book.\n\nBest,\nAlex Rivera";
  const f2 = guardRevision({ subject: "s", body: SPLICE_OK }, { subject: "s", body: SPLICE_FP }, INPUT);
  t("guard: a reported comma splice no longer vetoes the whole edit", f2.ok, f2);
  const spliceLint = draftChecks(lintBase, "Hi Rachel,\n\nThank you again for connecting me with Ben, we had our call this week.\n\nBest,");
  t("lint: a comma splice is still reported to the reviewer", spliceLint.forReview.some((i) => /comma splice/.test(i)), spliceLint.forReview);

  // F3. ASK's `let me know` arm matched the canned courtesy OFFER the voice work
  // wants removed, so the guard rejected an edit whose only change was deleting
  // it, as "dropped the ask" (ask-probe.ts heldout/offeronly, interaction-probe §4).
  const OFFERS = [
    "Please let me know if there is anything else you need from me.",
    "Past this, please let me know if there is anything else you need from me!",
    "Please let me know if there is anything further you need from me before Friday.",
    "Please let me know if there is anything else I should do on my end.",
    "Please do not hesitate to reach out if anything else would be useful.",
  ];
  const REAL_ASKS = [
    "Please let me know if you have 15 minutes in the next two weeks.",
    "Let me know what time works for you and I will make it work.",
    "Let me know whether the sophomore program is open this cycle.",
    "Please let me know your availability and I will send an invite.",
  ];
  t("ask: a courtesy offer is not an ask", OFFERS.every((s) => !ASK.test(s)), OFFERS.filter((s) => ASK.test(s)));
  t("ask: a real request is still an ask", REAL_ASKS.every((s) => ASK.test(s)), REAL_ASKS.filter((s) => !ASK.test(s)));
  const CANNED = " Please let me know if there is anything else you need from me.";
  const THANKS_BODY =
    "Hi Rachel,\n\nThank you for the time on Thursday, and for walking me through how the credit team staffs its analysts. " +
    "I came away with a much clearer picture of the work, and of what the summer looks like for an analyst on the desk." +
    CANNED +
    "\n\nBest,\nAlex Rivera";
  const f3 = guardRevision({ subject: "s", body: THANKS_BODY }, { subject: "s", body: THANKS_BODY.replace(CANNED, "") }, INPUT);
  t("guard: deleting the canned courtesy line is not 'dropped the ask'", f3.ok, f3);

  // S5. Any spelling problem whose quote was a SUBSTRING of the old subject
  // opened the subject gate - including one letter, which replaced the whole
  // subject (probe7-misc.ts, 7a).
  const s5 = guardRevision({ subject: "Referred by Jeff Moreno", body: DRAFT }, { subject: "Sophomore at the Pennsylvania panel", body: reworded }, INPUT, [
    { kind: "spelling", quote: "e", fix: "spelling", needsStudent: false },
  ]);
  t("guard: a one-character quote doesn't open the subject gate", s5.ok && s5.subject === "Referred by Jeff Moreno", s5);
  const s5b = guardRevision({ subject: "Referred by Jeff Moreno", body: DRAFT }, { subject: "Referred by the panel", body: reworded }, INPUT, [
    { kind: "spelling", quote: "Referred", fix: "spelling", needsStudent: false },
  ]);
  t("guard: the subject gate needs the rest of the subject kept", s5b.ok && s5b.subject === "Referred by Jeff Moreno", s5b);

  // S6. Rule 0 looked for the literal line "Best,", so a reworded sign-off made
  // the guard judge the signature it rebuilds anyway: "Best regards," turned the
  // class year into a new fact (probe2-ordering.ts, 2d).
  const s6 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: reworded.replace("Best,", "Best regards,") }, INPUT);
  t("guard: a reworded sign-off still keeps the signature out of judgement", s6.ok, s6);

  // S9. `known.includes(word)` was a SUBSTRING test: "Reno" passed on 100% of
  // corpus bodies because the referrer is Mo-reno (probe3-substring.ts).
  const s9 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("at the WITG x WUEC panel", "at the WITG x WUEC panel in Reno") }, INPUT);
  t("guard: a short invented name inside a known word is still new", !s9.ok && /Reno/.test(s9.reason), s9);
  // ...and the whole-word test has to keep a word that carries punctuation: the
  // tokeniser splits `known` twice so "M&A" is one word and so are "M" and "A".
  const ampersand: DraftPromptInput = { ...INPUT, extraContext: "I want to learn how the M&A team staffs its analysts" };
  const s9b = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("for a call?", "for a call about M&A?") }, ampersand);
  t("guard: a known word that carries punctuation is still matched whole", s9b.ok, s9b);

  // S12. Every rule returned on its first hit, and the retry prompt is handed
  // `reason` as the complete list - so an edit with two fabrications was told
  // about one, fixed it, and was rejected again (probe2-ordering.ts, 2f).
  const s12 = guardRevision({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("panel.", "panel at Goldman in 2024.") }, INPUT);
  t("guard: one rejection names every fabrication in the edit", !s12.ok && /2024/.test(s12.reason) && /Goldman/.test(s12.reason), s12);

  // S11. `loose` folded case, curly quotes and whitespace and nothing else, so
  // a reviewer that quoted the sentence it removed with an em dash where the
  // draft had a comma got no credit and the private detail stayed in the email
  // (probe7-misc.ts, 7d).
  const S11_BEFORE = "Hi Rachel,\n\nThank you for the call, you mentioned your divorce and the move, which I appreciated hearing about.\n\nBest,\nKai";
  const S11_AFTER = "Hi Rachel,\n\nThank you for the call.\n\nBest,\nKai";
  const s11 = guardRevision({ subject: "s", body: S11_BEFORE }, { subject: "s", body: S11_AFTER }, { ...INPUT, brief: { conversationDetails: "her divorce and the move" } }, [
    { kind: "private", quote: "you mentioned your divorce and the move — which I appreciated hearing about", fix: "Removed it", needsStudent: true },
  ]);
  t("guard: a quote the reviewer repunctuated still earns its credit", s11.ok, s11);
}

pipelineTests().then(moreTests).then(d4Tests).then(fixGuardTests).then(sharedSchoolTests).then(spanGuardTests).then(spanFixtureTable).then(spanSafetySweep).then(spanReplacementTests).then(() => {
  console.log(`${passed}/${passed + failures.length} passed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length) process.exitCode = 1;
});

// ------------------------------------------- S10: the shared-school rule protects the FACT, not the token
//
// MEASURED (docs/concepts/audit/OUTPUT-1-quality.md): 6 of 10 alum emails had a
// damaged shared-school clause and 4 of those were created by the review - "a
// fellow Duke alum's school", "I'm writing as a fellow Duke alum's junior", "at
// Duke, where you're a fellow Duke alum". The cause is in the guard, not only
// the prompt: the rule keyed on a bare `\balum\w*`, so ANY reword that dropped
// the token read as dropping the shared school and the whole edit was thrown
// away. That taught the reviewer to keep the token at any cost to the sentence.
//
// The rule now asks whether the body still says the recipient went to the
// student's school: the school is named, and the same sentence says the
// recipient was there. FIX-GUARD flagged this as S10 and left it.

function sharedSchoolTests() {
  const duke: DraftPromptInput = {
    ...INPUT,
    studentSchool: "Duke University",
    alumniSchool: "Duke University",
    contactSchool: "Duke University",
    detectedOverlaps: ["Same school"],
    brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
  };
  const ALUM = "Hi Rachel,\n\nJeff Moreno suggested I write to you, and I am a fellow Duke alum.\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const say = (clause: string) => ({ subject: "s", body: ALUM.replace("and I am a fellow Duke alum", clause) });

  // The four phrasings the review reaches for when it is allowed to write the
  // sentence rather than preserve a token. Each says the fact; none says "alum".
  const kept = [
    ["you studied at Duke too", "and you studied at Duke too"],
    ["where you studied as well", "and I am at Duke, where you studied as well"],
    ["you and I both went to Duke", "and you and I both went to Duke"],
    ["your time at Duke", "and I would value hearing about your time at Duke"],
  ] as const;
  for (const [name, clause] of kept) {
    const r = guardRevision({ subject: "s", body: ALUM }, say(clause), duke);
    t(`guard: the shared school may be reworded as "${name}"`, r.ok, r);
  }

  // And the protection itself, which must survive the narrowing: the fact gone
  // is still the fact gone, whether the school is unnamed or named with nothing
  // said about the recipient.
  const dropped = guardRevision({ subject: "s", body: ALUM }, say("and I am a sophomore studying economics"), duke);
  t("guard: genuinely dropping the shared school is still rejected", !dropped.ok && /shared school/.test(dropped.reason), dropped);
  const nameOnly = guardRevision({ subject: "s", body: ALUM }, say("and I am a sophomore at Duke studying economics"), duke);
  t("guard: naming the school without saying the recipient went there is still a drop", !nameOnly.ok && /shared school/.test(nameOnly.reason), nameOnly);

  // The other half of the token bug: "the Duke alumni database" is how the
  // student FOUND them, not the shared school, and the lint tells the reviewer
  // to take it out ("says how the student found them"). Under the token rule
  // that removal read as dropping the shared school.
  const FOUND = "Hi Rachel,\n\nJeff Moreno suggested I write to you, and I found you in the Duke alumni database.\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const found = guardRevision(
    { subject: "s", body: FOUND },
    { subject: "s", body: FOUND.replace(", and I found you in the Duke alumni database", "") },
    duke,
  );
  t("guard: removing \"the alumni database\" is not dropping the shared school", found.ok, found);
}

// ------------------------------------------- the per-span guard (R1b)
//
// `guardRevision` judges a reviewer's edit AS A WHOLE, so one slip discards
// every other fix in it and the student is sent the raw, unreviewed draft. The
// review is what makes these emails sound human (MEASURED: 12 of 12 unreviewed
// drafts had zero contractions, every reviewed one three or more), so that is
// not a small loss. The evidence bar was pre-committed at >=2 rejections in 30
// drafts and measured 3, with 12 of 30 hitting a first-turn rejection (D23).
//
// `applyReviewEdit` aligns the edit to the draft sentence by sentence,
// validates each changed span on its own, and applies the ones that pass -
// behind a flag that is OFF by default. The fast path is `guardRevision`
// unchanged: an edit that passes whole never touches any of this.
//
// The governing instruction is "I do not want disjointed sentences. I would
// rather it take longer to load than it be less well written", so every
// assertion below that could go either way is pinned to the timid answer.

function spanGuardTests() {
  const ON = { spans: true };

  // --------------------------------------------------------------- the flag
  const flagged = applyReviewEdit(
    { subject: "s", body: DRAFT },
    { subject: "s", body: DRAFT.replace("panel.", "panel at Goldman.") },
    INPUT,
    [],
    undefined,
    { spans: false },
  );
  t("spans: off by default, so the whole-edit verdict stands", !flagged.ok && /Goldman/.test(flagged.reason), flagged);
  t("spans: the default really is off", SPAN_GUARD_DEFAULT === false, SPAN_GUARD_DEFAULT);

  // --------------------------------------------------------- the fast path
  const clean = applyReviewEdit({ subject: "s", body: DRAFT }, { subject: "s", body: reworded }, INPUT, [], undefined, ON);
  t("spans: an edit that passes whole is applied whole, untouched", clean.ok && clean.applied === "all" && clean.body === reworded, clean);

  // ------------------------------------------------------- THE MOTIVATING CASE
  // The incident in draft-pipeline.ts's own comment (5 October 2026): a review
  // that removed an invented opinion AND fixed the common ground, thrown away
  // whole for dropping "a fellow Duke alum". Here the third sentence adds a
  // firm nobody typed, which is a real fabrication and must not be applied -
  // and today it costs the two good fixes as well.
  const duke: DraftPromptInput = {
    ...INPUT,
    studentSchool: "Duke University",
    alumniSchool: "Duke University",
    contactSchool: "Duke University",
    detectedOverlaps: ["Same school"],
    brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
  };
  const M_BEFORE =
    "Hi Rachel,\n\n" +
    "Jeff Moreno thought you would be a great person for me to talk to about the group. " +
    "I am a sophomore at Duke, and I gather you also studied there. " +
    "I have been reading about restructuring all semester.\n\n" +
    "Would you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const M_AFTER =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I'm a sophomore at Duke, where you studied as well. " +
    "I've been reading about restructuring at Blackstone all semester.\n\n" +
    "Would you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const today = guardRevision({ subject: "s", body: M_BEFORE }, { subject: "s", body: M_AFTER }, duke);
  t("spans: today the whole motivating edit is thrown away", !today.ok && /Blackstone/.test(today.reason), today);
  const rescued = applyReviewEdit({ subject: "s", body: M_BEFORE }, { subject: "s", body: M_AFTER }, duke, [], undefined, ON);
  t(
    "spans: the two good fixes are kept and the invented firm is not",
    rescued.ok &&
      rescued.applied === "partial" &&
      /suggested I write to you/.test(rescued.body) &&
      /where you studied as well/.test(rescued.body) &&
      !/Blackstone/.test(rescued.body) &&
      /reading about restructuring all semester/.test(rescued.body),
    rescued,
  );
  t("spans: and the rescue is reported span by span", rescued.ok && rescued.spans?.accepted === 2 && rescued.spans?.total === 3, rescued.ok ? rescued.spans : rescued);

  // ------------------------------------- the hard invariants, span by span
  // Each of these is something the whole-edit guard blocks today, and each must
  // still be blocked - either because the span carrying it is rejected, or
  // because the assembled body cannot pass `guardRevision`.
  const invented = applyReviewEdit({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("panel.", "panel at Goldman.") }, INPUT, [], undefined, ON);
  t("spans: an invented firm never reaches the body", !/Goldman/.test(invented.ok ? invented.body : ""), invented);
  const numbered = applyReviewEdit({ subject: "s", body: DRAFT }, { subject: "s", body: DRAFT.replace("15 minutes", "20 minutes") }, INPUT, [], undefined, ON);
  t("spans: an added number never reaches the body", !/20 minutes/.test(numbered.ok ? numbered.body : ""), numbered);
  const greeted = applyReviewEdit(
    { subject: "s", body: DRAFT },
    { subject: "s", body: DRAFT.replace("Hi Rachel,", "Dear Rachel,").replace("and it was great to meet you", "and I was glad to meet you") },
    INPUT,
    [],
    undefined,
    ON,
  );
  t(
    "spans: a changed greeting is never applied, and no longer costs the rest of the edit",
    greeted.ok && /^Hi Rachel,/.test(greeted.body) && !/Dear Rachel/.test(greeted.body) && /I was glad to meet you/.test(greeted.body),
    greeted,
  );
  const held = DRAFT.replace("My resume is attached.", "My resume is attached [as a PDF].");
  const dropped = applyReviewEdit({ subject: "s", body: held }, { subject: "s", body: held.replace(" [as a PDF]", "") }, INPUT, [], undefined, ON);
  t("spans: a dropped [placeholder] is never applied", !dropped.ok || /\[as a PDF\]/.test(dropped.body), dropped);
  const gutted = applyReviewEdit({ subject: "s", body: DRAFT }, { subject: "s", body: "Hi Rachel,\n\nThanks.\n\nBest,\nAlex Rivera" }, INPUT, [], undefined, ON);
  t("spans: a gutted email is still refused", !gutted.ok, gutted);
  const askless = applyReviewEdit(
    { subject: "s", body: DRAFT },
    { subject: "s", body: DRAFT.replace("Would you have 15 minutes for a call? ", "") },
    INPUT,
    [],
    undefined,
    ON,
  );
  t("spans: the ask is still there, whatever else was kept", !askless.ok || ASK.test(askless.body), askless);
  const ALUM = "Hi Rachel,\n\nJeff Moreno suggested I write to you, and I am a fellow Duke alum.\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const schoolless = applyReviewEdit(
    { subject: "s", body: ALUM },
    { subject: "s", body: ALUM.replace("and I am a fellow Duke alum", "and I am a sophomore studying economics") },
    duke,
    [],
    undefined,
    ON,
  );
  t("spans: dropping the shared school is still refused", !schoolless.ok, schoolless);

  // ----------------------------------------- the two fixed false positives
  const pennFacts: DraftPromptInput = { ...INPUT, studentSchool: "Penn" };
  const PENN_SHORT = "Hi Rachel,\n\nI am a junior at Penn studying economics, and I would value ten minutes of your time.\n\nBest,\nMaya Patel";
  const penn = applyReviewEdit(
    { subject: "s", body: PENN_SHORT },
    { subject: "s", body: PENN_SHORT.replace("I am a junior at Penn", "I'm a junior at the University of Pennsylvania") },
    pennFacts,
    [],
    undefined,
    ON,
  );
  t("spans: Penn -> the University of Pennsylvania still passes on the fast path", penn.ok && penn.applied === "all", penn);
  const privateFacts: DraftPromptInput = { ...INPUT, brief: { conversationDetails: "she mentioned her divorce and the move" } };
  const PRIV_BEFORE = "Hi Rachel,\n\nThank you for the call. You mentioned your divorce and the move.\n\nBest,\nAlex Rivera";
  const PRIV_AFTER = "Hi Rachel,\n\nThank you for the call.\n\nBest,\nAlex Rivera";
  const priv = applyReviewEdit({ subject: "s", body: PRIV_BEFORE }, { subject: "s", body: PRIV_AFTER }, privateFacts, [
    { kind: "private", quote: "your divorce and the move", fix: "Removed it", needsStudent: true },
  ], undefined, ON);
  t("spans: a private removal from a short email still passes on the fast path", priv.ok && priv.applied === "all", priv);

  // ---------------------------------------------------- the cohesion GATE
  // A pronoun whose antecedent left with a dropped span. The reviewer removed
  // an invented opinion, which is a real fix - but the sentence after it starts
  // "He also said", and keeping that beside a dropped antecedent is exactly the
  // disjointed prose the governing instruction rules out. The whole edit goes
  // back; the student gets the draft as written.
  const C_BEFORE =
    "Hi Rachel,\n\n" +
    "Jeff Moreno thought you would be a great person for me to talk to. " +
    "He also said the group takes on the hardest situations. " +
    "I am a sophomore studying economics.\n\n" +
    "Would you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const C_AFTER =
    "Hi Rachel,\n\n" +
    "He also said the group takes on the hardest situations. " +
    "I'm a sophomore studying economics.\n\n" +
    "Would you have 15 minutes for a call?\n\nBest,\nAlex Rivera";
  const orphan = applyReviewEdit({ subject: "s", body: C_BEFORE }, { subject: "s", body: C_AFTER }, INPUT, [], undefined, ON);
  t("spans: a pronoun whose antecedent was dropped blocks the partial application", !orphan.ok && /disjointed/.test(orphan.reason), orphan);

  // A dangling "First" whose "Second" left with a dropped sentence.
  const F_BEFORE =
    "Hi Rachel,\n\n" +
    "I am a sophomore at Duke studying economics. " +
    "First, when does the process open for sophomores? " +
    "Second, does the team take sophomore interns at Blackstone?\n\n" +
    "Best,\nAlex Rivera";
  // The fabrication in the first sentence is what sends this down the span path
  // at all: an edit that passes whole is applied whole, and this one must not.
  const F_AFTER =
    "Hi Rachel,\n\n" +
    "I'm a sophomore at Duke studying economics at Evercore. " +
    "First, when does the process open for sophomores?\n\n" +
    "Best,\nAlex Rivera";
  const dangling = applyReviewEdit({ subject: "s", body: F_BEFORE }, { subject: "s", body: F_AFTER }, duke, [], undefined, ON);
  t("spans: a dangling \"First\" blocks the partial application", !dangling.ok && /disjointed/.test(dangling.reason), dangling);

  // ----------------------------------------------------- the reorder decision
  // `REVIEW_SYSTEM` permits reordering ("To vary sentence openings, reorder or
  // reword a sentence") and a monotone alignment cannot represent it, so a
  // reorder is handed back whole rather than guessed at.
  const R_BEFORE =
    "Hi Rachel,\n\n" +
    "I am a sophomore at Duke studying economics. " +
    "Jeff Moreno suggested I write to you about the group. " +
    "I have been reading about restructuring at Blackstone all semester.\n\n" +
    "Best,\nAlex Rivera";
  const R_AFTER =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I am a sophomore at Duke studying economics. " +
    "I have been reading about restructuring at Blackstone and Evercore all semester.\n\n" +
    "Best,\nAlex Rivera";
  const reorder = applyReviewEdit({ subject: "s", body: R_BEFORE }, { subject: "s", body: R_AFTER }, duke, [], undefined, ON);
  t("spans: a reorder falls back to the whole edit", !reorder.ok && /moves a sentence/.test(reorder.reason), reorder);

  // ------------------------------------------------------- the lint is a veto
  // Never a score: an empty lint on both sides is the normal case and is never
  // a reason to reject, and a span is never rewarded for reducing findings.
  const L_BEFORE =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I am a sophomore at Duke studying economics.\n\n" +
    "Would you have 15 minutes for a call? My resume is attached at Blackstone.\n\nBest,\nAlex Rivera";
  const L_AFTER =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I'm a sophomore at Duke studying economics - and I would value your time.\n\n" +
    "Would you have 15 minutes for a call? My resume is attached at Blackstone.\n\nBest,\nAlex Rivera";
  const vetoed = applyReviewEdit({ subject: "s", body: L_BEFORE }, { subject: "s", body: L_AFTER }, duke, [], undefined, ON);
  t("spans: a span that introduces a new finding category is vetoed", !vetoed.ok || !/economics - and/.test(vetoed.body), vetoed);

  // A contraction change, which is the edit the review makes on 12 of 12
  // drafts, must never be vetoed by a voice diagnostic.
  const V_BEFORE =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I am a sophomore at Duke and I am studying economics. " +
    "I have been reading about restructuring at Blackstone all semester.\n\n" +
    "Best,\nAlex Rivera";
  const V_AFTER =
    "Hi Rachel,\n\n" +
    "Jeff Moreno suggested I write to you about the group. " +
    "I'm a sophomore at Duke and I'm studying economics. " +
    "I have been reading about restructuring at Blackstone all semester.\n\n" +
    "Best,\nAlex Rivera";
  const voiced = applyReviewEdit({ subject: "s", body: V_BEFORE }, { subject: "s", body: V_AFTER }, duke, [], undefined, ON);
  t("spans: a contraction change is kept, not vetoed", voiced.ok && /I'm a sophomore at Duke and I'm studying/.test(voiced.body), voiced);

  // -------------------------------------------------------------- the aligner
  const seg = segment("Hi Rachel,\n\nI met Dr. Lee at the panel. She runs the desk.\n\nWould you have 15 minutes?");
  t("align: the greeting is never a sentence", seg.greeting === "Hi Rachel," && seg.paragraphs.length === 2, seg);
  t("align: an abbreviation does not end a sentence", seg.paragraphs[0].length === 2 && seg.paragraphs[0][0] === "I met Dr. Lee at the panel.", seg.paragraphs[0]);
  const held2 = segment("Hi Rachel,\n\nI want to ask [what you want to ask Dr. Lee]. Thank you.");
  t("align: a period inside a [placeholder] does not end a sentence", held2.paragraphs[0].length === 2, held2.paragraphs[0]);
  const splitAlign = alignBodies(
    "Hi Rachel,\n\nI am a sophomore at Duke studying economics and I would value fifteen minutes of your time.",
    "Hi Rachel,\n\nI'm a sophomore at Duke studying economics. I would value fifteen minutes of your time.",
  );
  t("align: one sentence becoming two is a split, not a delete plus an insert", splitAlign.ops.length === 1 && splitAlign.ops[0].kind === "split", splitAlign.ops.map((o) => o.kind));
  const mergeAlign = alignBodies(
    "Hi Rachel,\n\nI'm a sophomore at Duke studying economics. I would value fifteen minutes of your time.",
    "Hi Rachel,\n\nI am a sophomore at Duke studying economics and I would value fifteen minutes of your time.",
  );
  t("align: two sentences becoming one is a merge", mergeAlign.ops.length === 1 && mergeAlign.ops[0].kind === "merge", mergeAlign.ops.map((o) => o.kind));
}

// ------------------------------------------- the fixture table and the rescue rate
//
// Every row is an edit TODAY'S whole-edit guard rejects, so the student is sent
// the raw draft. The table is what the span guard does with each, and it is
// printed rather than hand-written so docs/concepts/audit/SPAN-GUARD.md cannot
// drift from the code. `expect` pins each verdict; the rate is reported, never
// asserted - a rate that has to be defended by an assertion is not a measurement.
//
//   npx tsx --conditions=react-server scripts/draft-review-test.ts --table

type Fixture = {
  name: string;
  facts: DraftPromptInput;
  before: string;
  after: string;
  problems?: ReviewProblemLike[];
  /** "partial" - spans rescued. "none" - handed back whole, the draft ships as written. */
  expect: "partial" | "none";
  why: string;
};
type ReviewProblemLike = { kind: "private" | "hateful" | "spelling" | "wrong_person" | "invented"; quote: string; fix: string; needsStudent: boolean };

function spanFixtureTable(): void {
  const duke: DraftPromptInput = {
    ...INPUT,
    studentSchool: "Duke University",
    alumniSchool: "Duke University",
    contactSchool: "Duke University",
    detectedOverlaps: ["Same school"],
    brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }] },
  };
  const typed: DraftPromptInput = {
    ...duke,
    brief: {
      fieldAnswers: [
        { prompt: "Referred by", value: "Jeff Moreno" },
        { prompt: "What stuck with the student", value: "your advice about staffing on live deals" },
      ],
    },
  };
  const pdf: DraftPromptInput = { ...duke, hasResumePdf: true };

  // One body shape throughout, so what differs between rows is the edit and not
  // the email. Three sentences in the first paragraph, an ask in the second.
  const body = (one: string, two: string, three: string, ask = "Would you have 15 minutes for a call?") =>
    `Hi Rachel,\n\n${one} ${two} ${three}\n\n${ask}\n\nBest,\nAlex Rivera`;
  const S1 = "Jeff Moreno thought you would be a great person for me to talk to about the group.";
  const S1_FIXED = "Jeff Moreno suggested I write to you about the group.";
  const S2 = "I am a sophomore at Duke, and I gather you also studied there.";
  const S2_FIXED = "I'm a sophomore at Duke, where you studied as well.";
  const S3 = "I have been reading about restructuring all semester.";
  const S3_FIXED = "I've been reading about restructuring all semester.";

  const fixtures: Fixture[] = [
    {
      name: "an invented firm beside two good fixes",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, S2_FIXED, "I've been reading about restructuring at Blackstone all semester."),
      expect: "partial",
      why: "the motivating case in draft-pipeline.ts's comment: the opinion and the common ground are fixed, the firm is not applied",
    },
    {
      name: "an invented number beside two good fixes",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, S2_FIXED, "I've been reading about restructuring for 11 weeks."),
      expect: "partial",
      why: "same shape, the other fabrication rule",
    },
    {
      name: "a changed greeting beside three good fixes",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, S2_FIXED, S3_FIXED).replace("Hi Rachel,", "Dear Rachel,"),
      expect: "partial",
      why: "the greeting is emitted from the original, which is strictly better than losing the edit over it",
    },
    {
      name: "two fabrications in two sentences, one clean fix",
      facts: duke,
      before: body(S1, S2, S3),
      after: body("Jeff Moreno at Blackstone suggested I write to you.", S2_FIXED, "I've been reading about restructuring at Evercore all semester."),
      expect: "partial",
      why: "only the common-ground fix survives; both fabricated spans are dropped",
    },
    {
      name: "a lint regression in one sentence",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, "I'm a sophomore at Duke - where you studied as well.", S3_FIXED),
      expect: "partial",
      why: "the span veto keeps the dash out and the other two fixes in",
    },
    {
      name: "a dropped typed detail in one sentence",
      facts: typed,
      before: body(S1, "Your advice about staffing on live deals stuck with me.", S3),
      after: body(S1_FIXED, "What you said about the work stuck with me.", S3_FIXED),
      expect: "partial",
      why: "the span that dropped the detail is given back by the whole-body check; the rest is kept",
    },
    {
      name: "two unknown proper nouns from an unread resume PDF",
      facts: pdf,
      before: body(S1, "I run an investment club.", S3),
      after: body(S1_FIXED, "I run the Pinecrest Fellows investment club.", S3_FIXED),
      expect: "partial",
      why: "M10: the two-word allowance is off, but the two voice fixes are not the guard's objection",
    },
    {
      name: "the ask dropped",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, S2_FIXED, S3_FIXED, "I hope to hear from you."),
      expect: "partial",
      why: "the ask sentence is given back; the three voice fixes survive",
    },
    {
      name: "the shared school dropped",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S1_FIXED, "I'm a sophomore studying economics.", S3_FIXED),
      expect: "partial",
      why: "S10: the span that dropped the fact is given back, the rest is kept",
    },
    {
      name: "a pronoun whose antecedent was dropped",
      facts: duke,
      before: body(S1, "He also said the group takes the hardest situations.", S3),
      after: body("", "He also said the group takes the hardest situations.", S3_FIXED).replace("  ", ""),
      expect: "none",
      why: "the cohesion gate: \"He also said\" would be left with nothing in front of it",
    },
    {
      name: "a dangling \"First\"",
      facts: duke,
      before: body("I'm a sophomore at Duke.", "First, when does the process open for sophomores?", "Second, does the team take sophomore interns?"),
      after: body("I'm a sophomore at Duke at Evercore.", "First, when does the process open for sophomores?", ""),
      expect: "none",
      why: "the cohesion gate: \"First\" promises a \"Second\" that left with the dropped span",
    },
    {
      name: "a cross-paragraph reorder",
      facts: duke,
      before: body(S1, S2, S3),
      after: body(S2, S1, "I have been reading about restructuring at Evercore all semester."),
      expect: "none",
      why: "a monotone alignment cannot represent a reorder, so the whole edit goes back",
    },
    {
      name: "the email gutted",
      facts: duke,
      before: body(S1, S2, S3),
      after: "Hi Rachel,\n\nThanks.\n\nBest,\nAlex Rivera",
      expect: "none",
      why: "an edit that keeps fewer than half the sentences is a replacement; there is no fix in it to rescue",
    },
    {
      name: "a [placeholder] dropped in one sentence",
      facts: duke,
      before: body(S1, "I would value hearing [what you want to ask about].", S3),
      after: body(S1_FIXED, "I would value hearing about your path.", S3_FIXED),
      expect: "partial",
      why: "the span that lost the placeholder is rejected by L1; the two voice fixes are kept",
    },
  ];

  const rows: string[] = [];
  let rejectedToday = 0;
  let rescued = 0;
  let spansKept = 0;
  let spansOffered = 0;
  for (const f of fixtures) {
    const problems = (f.problems ?? []) as Parameters<typeof guardRevision>[3];
    const todayVerdict = guardRevision({ subject: "s", body: f.before }, { subject: "s", body: f.after }, f.facts, problems);
    const now = applyReviewEdit({ subject: "s", body: f.before }, { subject: "s", body: f.after }, f.facts, problems, undefined, { spans: true });
    t(`fixture: today's guard rejects "${f.name}"`, !todayVerdict.ok, todayVerdict);
    if (!todayVerdict.ok) rejectedToday++;
    const got = now.ok ? now.applied : "none";
    t(`fixture: the span guard returns ${f.expect} for "${f.name}"`, got === f.expect, { got, now });
    if (got === "partial") rescued++;
    if (now.spans) {
      spansKept += now.spans.accepted;
      spansOffered += now.spans.total;
    }
    rows.push(
      `| ${f.name} | ${todayVerdict.ok ? "accept" : `reject (${todayVerdict.reason})`} | ${got}${now.ok && now.spans ? ` ${now.spans.accepted}/${now.spans.total}` : ""} | ${f.why} |`,
    );
  }
  const rate = rejectedToday === 0 ? 0 : (rescued / rejectedToday) * 100;
  if (process.argv.includes("--table")) {
    console.log("\n| fixture | today | span guard | why |\n|---|---|---|---|");
    for (const r of rows) console.log(r);
    console.log(
      `\nRESCUE RATE: ${rescued} of ${rejectedToday} edits rejected today return a usable partial (${rate.toFixed(1)}%).` +
        ` Across those, ${spansKept} of ${spansOffered} changed spans were kept.`,
    );
  }
  // Pinned so a regression in the mechanism shows up as a failing test and not
  // only as a number in a document nobody re-runs.
  t(`fixture: the rescue rate is ${rescued}/${rejectedToday} (${rate.toFixed(1)}%)`, rescued === 10 && rejectedToday === 14, { rescued, rejectedToday, rate });
}

// ------------------------------------------- the one property that makes this safe
//
// EVERY body the span guard returns must pass the UNCHANGED whole-edit
// `guardRevision`. That is not a nice-to-have: it is the whole argument that
// "everything the current guard blocks is still blocked". The per-span checks
// only decide WHICH spans are offered to it; if this property ever fails, the
// span path can ship something today's guard would refuse, and the mechanism
// has to come out.
//
// Swept rather than spot-checked, because a single fixture proves nothing about
// a search that gives spans back one at a time: every combination of mutations
// below is tried, and each accepted result is re-checked against the guard.

function spanSafetySweep(): void {
  const duke: DraftPromptInput = {
    ...INPUT,
    studentSchool: "Duke University",
    alumniSchool: "Duke University",
    contactSchool: "Duke University",
    detectedOverlaps: ["Same school"],
    brief: { fieldAnswers: [{ prompt: "Referred by", value: "Jeff Moreno" }, { prompt: "What stuck", value: "your advice about staffing on live deals" }] },
  };
  const SENTENCES = [
    "Jeff Moreno thought you would be a great person for me to talk to about the group.",
    "I am a sophomore at Duke, and I gather you also studied there.",
    "Your advice about staffing on live deals stuck with me.",
    "I have been reading about restructuring all semester.",
  ];
  // Each mutation is something a reviewer plausibly does: a good reword, a
  // fabrication, a deletion, a lint regression, a placeholder change.
  const MUTATIONS: ((s: string) => string)[] = [
    (s) => s,
    (s) => s.replace(/\bI am\b/, "I'm").replace(/\bI have\b/, "I've").replace("thought you would be a great person for me to talk to", "suggested I write to you"),
    (s) => `${s.replace(/\.$/, "")} at Blackstone.`,
    (s) => `${s.replace(/\.$/, "")} for 11 weeks.`,
    () => "",
    (s) => s.replace(", and", " -").replace(/, /, " - "),
    (s) => `${s.replace(/\.$/, "")} [and what you want to ask].`,
    (s) => `This also stuck with me. ${s}`,
  ];

  let tried = 0;
  let accepted = 0;
  let unsafe = 0;
  // The unselected rescue rate: of the edits today's guard throws away, how
  // many come back as a usable partial? The 14 fixtures are chosen cases and
  // will flatter the mechanism; this is every combination, flattering or not.
  let rejectedToday = 0;
  let rescued = 0;
  let seams = 0;
  let reorders = 0;
  // The denominator that means something. Most of the sweep's rejected edits
  // have NOTHING worth keeping - every change in them is a fabrication - and
  // for those "no span could be kept" is the right answer and identical to
  // today. The rate worth quoting is over the edits that contain at least one
  // span which is a genuine improvement.
  let worthRescuing = 0;
  let worthRescued = 0;
  const base = `Hi Rachel,\n\n${SENTENCES.join(" ")}\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera`;
  for (let a = 0; a < MUTATIONS.length; a++) {
    for (let b = 0; b < MUTATIONS.length; b++) {
      for (let c = 0; c < MUTATIONS.length; c++) {
        const edited = [MUTATIONS[a](SENTENCES[0]), MUTATIONS[b](SENTENCES[1]), MUTATIONS[c](SENTENCES[2]), SENTENCES[3]]
          .filter(Boolean)
          .join(" ");
        const after = `Hi Rachel,\n\n${edited}\n\nWould you have 15 minutes for a call?\n\nBest,\nAlex Rivera`;
        tried++;
        // "At least one real fix in it": the good-reword mutation, and only
        // where it actually changed that sentence - it is a no-op on the third,
        // which has no "I am", no "I have" and no referrer phrase.
        const worth = [a, b, c].some((x, k) => x === 1 && MUTATIONS[1](SENTENCES[k]) !== SENTENCES[k]);
        const todayVerdict = guardRevision({ subject: "s", body: base }, { subject: "s", body: after }, duke, []);
        if (!todayVerdict.ok) {
          rejectedToday++;
          if (worth) worthRescuing++;
        }
        const r = applyReviewEdit({ subject: "s", body: base }, { subject: "s", body: after }, duke, [], undefined, { spans: true });
        if (!r.ok) {
          if (/disjointed/.test(r.reason)) seams++;
          if (/moves a sentence/.test(r.reason)) reorders++;
          continue;
        }
        if (!todayVerdict.ok && r.applied === "partial") {
          rescued++;
          if (worth) worthRescued++;
        }
        accepted++;
        const recheck = guardRevision({ subject: "s", body: base }, { subject: "s", body: r.body }, duke, []);
        if (!recheck.ok) {
          unsafe++;
          if (unsafe === 1) failures.push(`span sweep: a returned body fails the whole-edit guard -> ${recheck.reason} :: ${JSON.stringify(r.body)}`);
        }
      }
    }
  }
  t(`span sweep: every one of ${accepted} accepted bodies passes the whole-edit guard (${tried} edits tried)`, unsafe === 0, { tried, accepted, unsafe });
  // And the sweep has to actually exercise the path, or the property above is vacuous.
  t(`span sweep: the sweep reaches the span path (${accepted} of ${tried} accepted)`, accepted > 20 && accepted < tried, { tried, accepted });
  // Pinned, so the number in SPAN-GUARD.md is the number the code produces.
  t(
    `span sweep: ${worthRescued} of ${worthRescuing} rejected edits that contain a real fix are rescued`,
    worthRescuing === 96 && worthRescued === 96,
    { worthRescuing, worthRescued },
  );
  if (process.argv.includes("--table")) {
    const pct = rejectedToday === 0 ? 0 : (rescued / rejectedToday) * 100;
    console.log(
      `\nSAFETY SWEEP: ${tried} edits tried, ${accepted} returned a body, ${unsafe} of those would fail the whole-edit guard.` +
        `\nUNSELECTED RESCUE RATE: ${rejectedToday} of ${tried} are rejected by today's guard; ${rescued} of those (${pct.toFixed(1)}%) come back as a partial.` +
        `\n  of the rejected, ${worthRescuing} contain at least one real fix; ${worthRescued} of those (${((worthRescued / Math.max(1, worthRescuing)) * 100).toFixed(1)}%) are rescued.` +
        `\n  of the rest: ${seams} blocked by the cohesion gate, ${reorders} handed back as a reorder.`,
    );
  }
}

// An edit is an edit, not a replacement: when most of the draft is simply gone,
// there is no fix in it to rescue, and a back-off search over the deletions
// assembles a third email nobody wrote. MEASURED while building the span guard:
// a reviewer that replaced a five-sentence body with "Thanks." came back, before
// this rule, as the same email missing only "My resume is attached." and
// "Thank you!" - and that body passed the whole-edit guard, which is why the
// whole-body check cannot be the only limit.
function spanReplacementTests(): void {
  const gut = applyReviewEdit(
    { subject: "s", body: DRAFT },
    { subject: "s", body: "Hi Rachel,\n\nThanks.\n\nBest,\nAlex Rivera" },
    INPUT,
    [],
    undefined,
    { spans: true },
  );
  t("spans: a replacement is not an edit, and no subset of it is applied", !gut.ok && /replacement and not an edit/.test(gut.reason), gut);
  // And the rule is a majority rule, not a ban on deleting: an edit that drops
  // one sentence of four and fixes another is still rescued.
  const ONE_LESS =
    "Hi Rachel,\n\nJeff Moreno suggested I write to you, and I was glad to meet you at the WITG x WUEC panel.\n\n" +
    "I'm a sophomore at the University of Pennsylvania. Would you have 15 minutes for a call? My resume is attached.\n\nBest,\nAlex Rivera";
  const trimmed = applyReviewEdit({ subject: "s", body: DRAFT }, { subject: "s", body: ONE_LESS }, INPUT, [], undefined, { spans: true });
  t("spans: dropping one sentence of several is still an edit", trimmed.ok, trimmed);
}
