// Tests for the language limits (src/lib/content-limits.ts): slurs and
// profanity are caught, disguised or not, and ordinary words that merely
// contain them are left alone. No API calls.
//
//   npx tsx scripts/content-limits-test.ts

import {
  blockedInForm,
  blockedLanguageError,
  findBlockedLanguage,
  findBlockedLanguageIn,
  settledText,
  withoutBlockedLanguage,
  type BlockedKind,
} from "../src/lib/content-limits";
import { draftFormLabels } from "../src/lib/draft-field-labels";
import { buildDraftPrompt } from "../src/lib/draft-prompt";
import { buildReviewPrompt } from "../src/lib/draft-review";
import { EMAIL_TYPES } from "../src/lib/draft-templates";

let passed = 0;
const failures: string[] = [];
function t(name: string, ok: boolean, got?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${got === undefined ? "" : ` -> ${JSON.stringify(got)}`}`);
}

// Blocked, as typed and disguised.
const HATEFUL = ["you fag", "that retard", "a kike", "go back, chink", "n1gger", "f a g g o t", "faggots", "sluts", "raghead"];
const PROFANE = [
  "what the fuck", "fuuuuck this", "f u c k", "f.u.c.k", "f*ck", "sh!t", "this is bullshit", "a$$hole", "b!tch",
  "motherfucker", "Damn it", "piss off", "shitty timing", "asssss", "wtf is this",
];
for (const s of HATEFUL) t(`hateful: "${s}"`, findBlockedLanguage(s) === "hateful", findBlockedLanguage(s));
for (const s of PROFANE) t(`profanity: "${s}"`, findBlockedLanguage(s) === "profanity", findBlockedLanguage(s));

// Allowed: words and names that only look like one of the above.
const CLEAN = [
  "Scunthorpe", "a thorough assessment", "the cocktail reception", "fire retardant", "shiitake mushrooms", "Pakistan",
  "a raccoon", "Dick's Sporting Goods", "a short position", "the hedge fund", "Sussex and Essex", "a classic case",
  "passion for markets", "John Hancock", "my therapist said", "spicy food", "Sean Spicer", "Fukuoka office", "a grasshopper",
  "bass guitar", "a compass", "Matsushita", "graduating in 2029", "$55,000 base", "I'm so excited!!!", "Great! Thanks",
  "a b c", "Class of 2029", "Hi Rachel, thank you for your time.", "the Cockburn fund", "Titusville", "a shellac finish",
];
for (const s of CLEAN) t(`clean: "${s}"`, findBlockedLanguage(s) === null, findBlockedLanguage(s));

// ---------------------------------------------------------------- Unicode
// The same words written with characters that look like Latin letters, or with
// characters that are not there at all. A disguise that costs the writer one
// keystroke should not cost the check anything (INPUT-3 F4, OUTPUT-3).
const ZWSP = "\u200b", ZWJ = "\u200d", SHY = "\u00ad", TAG_U = "\u{E0075}", VS16 = "\ufe0f";
const DISGUISED: [what: string, sample: string, kind: BlockedKind][] = [
  ["curly apostrophe inside the word", "fu\u2019ck this", "profanity"],
  ["straight apostrophe inside the word", "fu'ck this", "profanity"],
  ["apostrophes between every letter", "f\u2019u\u2019c\u2019k this", "profanity"],
  ["soft hyphen", `fu${SHY}ck this`, "profanity"],
  ["zero-width space", `fu${ZWSP}ck this`, "profanity"],
  ["zero-width joiner", `f${ZWJ}ucking hell`, "profanity"],
  ["tag character", `f${TAG_U}ck this`, "profanity"],
  ["variation selector", `fuck${VS16} this`, "profanity"],
  ["fullwidth forms", "\uff46\uff55\uff43\uff4b this", "profanity"],
  ["the ff ligature", "\ufb00uck this", "profanity"],
  ["combining accent", "fu\u0308ck this", "profanity"],
  ["precomposed accent", "f\u00fack this", "profanity"],
  ["mathematical bold", "\u{1D5F3}\u{1D5EE}\u{1D5F4}\u{1D5F4}\u{1D5FC}\u{1D601}", "hateful"],
  ["Cyrillic a", "f\u0430ggot", "hateful"],
  ["Cyrillic e", "r\u0435tard\u0435d", "hateful"],
  ["Cyrillic dze", "\u0455lut", "hateful"],
  ["Cyrillic c", "\u0441unt", "profanity"],
  ["Cyrillic u", "f\u0443ck this", "profanity"],
  ["Ukrainian i", "b\u0456tch", "profanity"],
  ["doubled by exactly two", "fuuck this", "profanity"],
  ["doubled by two, inflected", "fuuckers", "profanity"],
];
for (const [what, sample, kind] of DISGUISED) t(`disguised (${what}): "${sample}"`, findBlockedLanguage(sample) === kind, findBlockedLanguage(sample));

// The other half of the same change, and the half that matters more: undoing a
// disguise must not make an ordinary word read as a slur. A draft thrown away
// for a word nobody wrote is as bad as a word that gets through - the gate in
// draft-pipeline.ts runs this same function on every finished draft.
const CLEAN_UNICODE = [
  // Greek and Cyrillic words in ordinary use. Only some of their letters fold,
  // which is what keeps them readable as themselves.
  "\u0391\u03bb\u03ad\u03be\u03b1\u03bd\u03b4\u03c1\u03bf\u03c2 \u03a0\u03b1\u03c0\u03b1\u03b4\u03cc\u03c0\u03bf\u03c5\u03bb\u03bf\u03c2",
  "\u0398\u03b5\u03c3\u03c3\u03b1\u03bb\u03bf\u03bd\u03af\u03ba\u03b7", "\u039f\u03b4\u03c5\u03c3\u03c3\u03ad\u03b1\u03c2", "\u03b7 \u03b1\u03b3\u03bf\u03c1\u03ac \u03bf\u03bc\u03bf\u03bb\u03cc\u03b3\u03c9\u03bd",
  "\u041e\u043b\u0435\u0433 \u041f\u0435\u0442\u0440\u043e\u0432", "\u0421\u0431\u0435\u0440\u0431\u0430\u043d\u043a", "\u041c\u043e\u0441\u043a\u0432\u0430", "\u0443 \u043c\u0435\u043d\u044f \u0435\u0441\u0442\u044c \u0432\u043e\u043f\u0440\u043e\u0441",
  "\u0406\u0440\u0438\u043d\u0430 \u041a\u043e\u0432\u0430\u043b\u044c\u0447\u0443\u043a", "\u0410\u043b\u0435\u043a\u0441\u0430\u043d\u0434\u0440 \u0421\u043e\u043a\u043e\u043b\u043e\u0432", "\u043a\u0430\u0441\u0441\u0430",
  // Hyphenated and apostrophied names, and ordinary contractions.
  "Smith-Jones", "Jean-Luc Picard", "Anne-Marie Dupont", "Ms. O'Connor-Reyes", "O'Brien & Co",
  "D'Angelo", "Hawai'i Pacific", "y'all", "don't worry", "it's fine", "a 9 o'clock call",
  // Names carrying a letter the fold touches.
  "M\u00fcller", "\u00c7elik", "\u0141ukasz", "I\u015f\u0131k", "Jos\u00e9 Fern\u00e1ndez", "Fran\u00e7ois Mitterrand",
  "Beyonc\u00e9", "Banco de Bogot\u00e1", "Zo\u00eb", "\u00c1ngel", "Nguy\u1ec5n", "\u0130stanbul", "A\u00df",
  // Compatibility forms of ordinary text.
  "\ufb01nance and of\ufb01ce hours", "\uff27\uff4f\uff4c\uff44\uff4d\uff41\uff4e \uff33\uff41\uff43\uff48\uff53", "\u2116 5 Broad Street", "\u2163. Valuation",
  // Double letters, which the stretch readings now collapse one further.
  "the Mississippi barge deal", "a successful assessment", "Hassan", "Nassau", "Vassar",
  "coffee and a committee", "bookkeeping", "Hoover", "Essen", "Pessoa", "a glass of water",
  "shiitake and cocktails", "the boss said", "Butterfield", `ana${SHY}lyst`,
];
for (const s of CLEAN_UNICODE) t(`clean: "${s}"`, findBlockedLanguage(s) === null, findBlockedLanguage(s));

// Messages name the box and never repeat the word.
const err = blockedLanguageError([["Subject line", "Hello"], ["What you talked about", "his shit car"]]);
t("error names the box with profanity", err === '"What you talked about" contains profanity. Remove it to continue.', err);
t("error never echoes the word", !String(err).includes("shit"), err);
const hate = blockedLanguageError([["Notes", "that fag"]]);
t("hateful error message", Boolean(hate?.includes("slur or hateful")), hate);
t("clean fields pass", blockedLanguageError([["Notes", "great meeting"], ["Other", 42]]) === null);

const form = new FormData();
form.set("recipient", "contact-fuck"); // skipped: an id, not something typed
form.set("extraContext", "tell him this is bullshit");
t("form: skipped fields are ignored, typed ones checked", blockedInForm(form, { extraContext: "Anything else to include?" }, ["recipient"]) === '"Anything else to include?" contains profanity. Remove it to continue.', blockedInForm(form, { extraContext: "Anything else to include?" }, ["recipient"]));
const cleanForm = new FormData();
cleanForm.set("extraContext", "we talked about cars");
t("form: clean form passes", blockedInForm(cleanForm, {}) === null);

// ------------------------------------------------- what a model writes back
// The gate on a finished draft covers the subject and the body. Everything
// else a model writes and a student reads - the notes, a plan, a review
// problem's quote and fix - is a set of strings in an object, so one call gates
// the whole object rather than each call site listing its own fields.
t("deep: a string", findBlockedLanguageIn("that fag remark") === "hateful");
t("deep: clean string", findBlockedLanguageIn("Took that line out.") === null);
t("deep: an array of notes", findBlockedLanguageIn(["Attach your resume.", "Took out the word \"shit\" you typed."]) === "profanity");
t(
  "deep: nested objects and arrays",
  findBlockedLanguageIn({ plan: { people: [{ name: "Rachel", role: "VP" }], sentences: ["Open with the fag joke."] } }) === "hateful",
);
t(
  "deep: review problems",
  findBlockedLanguageIn([{ kind: "private", quote: "his divorce", fix: "Took out the bullshit line." }]) === "profanity",
);
t("deep: hateful wins over profanity", findBlockedLanguageIn(["this is bullshit", "that fag"]) === "hateful");
t("deep: ids, numbers, flags and dates cost nothing", findBlockedLanguageIn({ id: "contact-abc", n: 3, ok: true, when: new Date(), nothing: null }) === null);
t("deep: nothing to read", findBlockedLanguageIn(null) === null && findBlockedLanguageIn(undefined) === null && findBlockedLanguageIn([]) === null);
t("deep: a cycle does not hang it", (() => { const a: Record<string, unknown> = { note: "fine" }; a.self = a; return findBlockedLanguageIn(a) === null; })());

// Dropping the one note, rather than failing a draft the student already paid
// for, is what the pipeline wants.
t(
  "withoutBlockedLanguage keeps the clean notes in order",
  JSON.stringify(withoutBlockedLanguage(["Attach your resume.", "Took out the word \"shit\".", null, "", "Check the date."])) ===
    JSON.stringify(["Attach your resume.", "Check the date."]),
);
t("withoutBlockedLanguage keeps everything clean", withoutBlockedLanguage(["a", "b"]).length === 2);

// Text still arriving is the one thing this check cannot be pointed at: a
// half-delivered "Associate" reads as a word on the list. settledText is the
// part a streaming caller may check.
t("settledText holds back the word still arriving", settledText("He is an Ass") === "He is an");
t("settledText passes a finished word through", settledText("He is an Associate ") === "He is an Associate");
t("settledText: nothing settled yet", settledText("Assoc") === "");
t("a half-arrived word is not read as a slur", findBlockedLanguage(settledText("Dear Rachel, as an Ass")) === null);
t("the same word, finished, is still clean", findBlockedLanguage("Dear Rachel, as an Associate") === null);
t("a real one still fails once it is settled", findBlockedLanguage(settledText("you are an ass ")) === "profanity");

// -------------------------------------------- the error names the right box
// Every box the draft form can ask about gets its own label, derived from the
// question definitions, so a student is told which answer to fix rather than
// "One of your answers" (INPUT-1 F7).
const LABELS = draftFormLabels();
const asked = [...new Set(EMAIL_TYPES.flatMap((t) => (t.fields ?? []).map((f) => f.name)))];
const unlabelled = asked.filter((name) => !LABELS[name]);
t(`every question the form can ask has a label (${asked.length} questions)`, unlabelled.length === 0, unlabelled);
t("the custom occasion's only box is named", LABELS.purpose === "What is this email for?", LABELS.purpose);
t("a shared brief question is named", LABELS.financeInterest === "What part of finance draws you?", LABELS.financeInterest);
t("a type's own question is named", Boolean(LABELS.meetingWhen), LABELS.meetingWhen);
// The contrast, pinned: the hand-kept 23-name list is what made this error
// say nothing. `purpose` is the custom occasion's only box.
t(
  "a hand-kept label list leaves the box unnamed",
  (() => {
    const form = new FormData();
    form.set("purpose", "ask this bitch for a reference");
    return blockedInForm(form, { extraContext: "Anything else to include" }) === '"One of your answers" contains profanity. Remove it to continue.';
  })(),
);
const purposeForm = new FormData();
purposeForm.set("occasion", "other");
purposeForm.set("purpose", "ask this bitch for a reference");
t(
  "the gate names the box, not \"one of your answers\"",
  blockedInForm(purposeForm, LABELS, ["occasion"]) === '"What is this email for?" contains profanity. Remove it to continue.',
  blockedInForm(purposeForm, LABELS, ["occasion"]),
);

// The prompts carry a rule for hateful meaning a word list can't see.
const input = { studentName: "Maya Okafor", contactName: "Rachel Stein", type: "cold_email" as const, now: new Date("2026-09-20T12:00:00") };
t("drafting prompt rules out hateful or profane content", buildDraftPrompt(input).system.includes("NOTHING HATEFUL OR PROFANE"));
t("review prompt rules out hateful or profane content", buildReviewPrompt(input, { subject: "s", body: "Hi Rachel,\n\nHello.\n\nBest," }, []).system.includes("Nothing hateful or profane"));

console.log(`${passed}/${passed + failures.length} passed`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length) process.exitCode = 1;
