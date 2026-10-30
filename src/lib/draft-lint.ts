// Checks run on every finished draft without calling a model.
//
// Two kinds. The fluency checks are the patterns that made simulated combined
// emails read as stitched together: a "since" that isn't a cause, common ground
// tacked onto the end of a paragraph, congratulations after the ask. They are
// calibrated on the playbook's own Volume V emails, which pass them. The
// student checks catch what only the student can fix, like a greeting built
// from a name that isn't a first name.
//
// What they find goes to the review pass as things to fix, and to the student
// as notes when only the student can fix it. Pure, so the app, the review pass
// and the simulation scripts all share one set of rules.

import type { DraftPromptInput } from "./draft-prompt";

/**
 * The one request an email makes.
 *
 * This used to be four phrasings - "would you have", "would you be open",
 * "could we", "do you have time" - and it matched only 35 of the playbook's 192
 * example emails. Everything that reads the ask was therefore inert on about
 * four shapes in five: the guard could not tell that an edit had deleted the
 * email's only request, and the congratulations-ordering check below had no
 * "after the ask" to be after. The phrasings were real; they were just the
 * cold-email ones, and most types ask for something else in another way.
 *
 * The alternatives below are the families the playbook's own emails actually
 * use, read off the corpus. MEASURED on a hand-labelled sample of 40 bodies
 * (`scripts/draft-review-test.ts`): 27 of 30 real asks matched, and none of the
 * 10 bodies that ask for nothing - 90% recall at 100% precision, against 23.3%
 * recall before. Corpus-wide the rule now reaches 131 of 192 bodies.
 *
 * The line it holds: a request the recipient is meant to act on. An OFFER is
 * not an ask ("I am glad to send anything else", "please do not hesitate to
 * reach out"), and neither is a sentiment ("I would love to stay in touch") -
 * which is why the softened families below all require a request object (a
 * call, a time, an update, feedback) rather than keying on "I would love" or
 * "hear" alone.
 */
export const ASK = new RegExp(
  [
    // Asked outright.
    "\\bwould you (?:have|be (?:open|willing|free|comfortable|available)|prefer|mind)\\b",
    "\\bcould (?:we|you)\\b",
    "\\bdo you have (?:time|any time|a moment|availability)\\b",
    "\\bany chance you\\b",
    "\\bwould any of (?:the following|these|those)\\b",
    "\\byou would (?:feel comfortable|be willing|mind)\\b",
    // Softened into a conditional, which is how most of the corpus asks.
    "\\bif you (?:have|had|ever have|can spare|are able to find|find|do have)\\b[^.!?]{0,60}\\b(?:minutes?|moment|time|feedback)\\b",
    "\\bI(?:'d|\u2019d| would) (?:love|welcome|appreciate|be grateful|value)\\b[^.!?]{0,80}\\b(?:call|chat|talk|speak|hear|conversation|update|feedback|minutes?|perspectives?)\\b",
    "\\bwould (?:welcome|appreciate|be grateful for)\\b[^.!?]{0,60}\\b(?:call|chat|update|feedback|conversation|input)\\b",
    "\\bwhether\\b[^.!?]{0,60}\\b(?:call|chat|minutes?)\\b",
    // Asking them to reply or to answer one question. `let me know` alone was
    // the second-largest arm (37 gold bodies, sole trigger in 25) and about 21
    // of those sentences were the canned OFFER - "please let me know if there
    // is anything else you need from me" - which this rule's own line above
    // excludes, and which the voice work wants deleted. MEASURED (LOGIC-2 F3,
    // scripts/audit-probe/logic2/ask-probe.ts heldout): it fired on 10 of 31
    // held-out "no ask" bodies, 6 of them on nothing but that offer, and the
    // guard then rejected an edit whose only change was deleting the line, as
    // "dropped the ask". So the arm now needs a request OBJECT - a time, an
    // answer, a next step - and abstains when the object is "anything else you
    // need from me".
    "\\blet me know\\b(?![^.!?]{0,60}\\banything (?:else|further|more)\\b)(?![^.!?]{0,60}\\bif (?:I|there is|there's|there\u2019s) anything\\b)" +
      "[^.!?]{0,60}\\b(?:time|times|availability|available|free|works?|calendar|schedule|minutes?|day|week|whether|which|what|when|who|how|where|thoughts|next steps?|update|questions?|prefer|convenient|possible|open|right person|a good time)\\b",
    "\\bwanted to (?:ask|confirm)\\b",
    // The three families the rule could not represent at all, which is where
    // its missing recall sat (LOGIC-2 F3): the imperative request, "would X
    // work?", and the question named rather than asked. The "work" arm needs a
    // question mark so "I would love to work at the firm" is not a request.
    "\\bplease (?:just )?(?:name|send|point|share|confirm|pass along|put me)\\b",
    "\\bwould\\b[^?.!]{0,50}\\bwork\\b[^?.!]{0,20}\\?",
    "\\bmy (?:two |three )?questions? (?:were|are|was)\\b",
  ].join("|"),
  "i",
);

/**
 * A closing on its own line, by SHAPE rather than by the literal "Best,".
 * `finishDraft` rewrites every closing to "Best,", so in the pipeline the
 * pre-review draft always has one - but the reviewer's raw edit does not, and
 * both the guard (which must keep the rebuilt signature out of judgement) and
 * the checks below read that raw text. MEASURED (LOGIC-1 S6): a reviewer that
 * wrote "Best regards," made the guard judge the signature and reject the edit
 * for "adding" the class year the pipeline writes itself.
 */
const SIGN_OFF =
  /^(?:best|best regards|kind regards|warm regards|warmest regards|regards|sincerely|thanks|thanks again|thank you|many thanks|cheers|all the best|best wishes|warmly|respectfully|yours truly|take care)[,.]?(?:\s+[A-Z][\w'’.-]*){0,2}$/i;

/**
 * Where the sign-off is, or -1. Only the last eight lines are considered, as
 * `finishDraft` does, so a "Thanks," that opens a paragraph mid-email is not
 * mistaken for the end of the body.
 */
export function signOffLine(lines: string[]): number {
  let at = -1;
  lines.forEach((l, i) => {
    if (i >= lines.length - 8 && SIGN_OFF.test(l.trim())) at = i;
  });
  return at;
}

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The checked box ids and typed answers behind a draft, when the check knows them (the simulations do). */
export type FluencyContext = { ids: string[]; answered: Record<string, string> } | null;

/**
 * What makes an email read as stitched together, or as not written by a
 * person. `main` is the body without the greeting or sign-off.
 */
export function fluencyIssues(main: string, ctx: FluencyContext): string[] {
  const issues: string[] = [];
  const paragraphs = main.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences = sentencesOf(main);
  const clip = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}…` : s);

  // Too much in one sentence. Questions and quoted blurbs run long by design.
  for (const s of sentences) {
    if (s.includes("?") || s.startsWith("“")) continue;
    const n = s.split(/\s+/).length;
    if (n > 50) issues.push(`long sentence (${n} words): "${clip(s)}"`);
    const joins = s.match(/, and /g)?.length ?? 0;
    if (joins >= 2) issues.push(`${joins + 1} clauses strung together with ", and": "${clip(s)}"`);
    if (/\balso\b/i.test(s) && /\btoo\b/i.test(s)) issues.push(`"also" and "too" in one sentence: "${clip(s)}"`);
  }
  // A connector claiming a cause that isn't one.
  for (const re of [
    /,\s*so (I was|it was|I am|I'm) (glad|happy|a nice surprise|excited)\b[^.!?]*/i,
    /\bsince (she|he|they|[A-Z][a-z]+) (interned|is|was|works|worked)\b[^.!?]*/,
    /\bstuck with me,? (since|because)\b[^.!?]*/i,
  ]) {
    const m = main.match(re);
    if (m) issues.push(`connector that isn't a cause: "${clip(m[0])}"`);
  }
  if (/\bto then\b/i.test(main)) issues.push('split "to then"');
  // Common ground as an afterthought at the end of a paragraph.
  for (const p of paragraphs) {
    const ss = sentencesOf(p);
    const last = ss[ss.length - 1];
    if (ss.length >= 2 && last.split(/\s+/).length < 14 && /\b(both from|like me|same hometown|fellow (\w+ )?alum|also (studied|went))\b/i.test(last)) {
      issues.push(`common ground tacked onto a paragraph: "${last}"`);
    }
  }
  // Common ground said awkwardly (5 October 2026, from the live drafts): the
  // student is a current student, never an alum; a shared trait is stated
  // once, not announced as a discovery or doubled with "too" or "like you".
  for (const [re, what] of [
    [/\bwe(?:'re| are) both [\w ]{0,30}?alum(?:s|ni|nae)?\b|\bboth (?:\w+ ){0,3}alums\b/i, "calls the student an alum; they are a current student and the recipient is the alum"],
    [/\bI (?:noticed|saw|gather|learned|was glad to learn|realized) (?:that )?we(?:'re| are) both\b/i, "announces the common ground as a discovery; just state it"],
    [/\b(?:too|also)\b[^.!?]{0,40}\blike (?:you|me)\b|\blike (?:you|me)\b(?=[.,!])/i, "common ground doubled or tacked on with \"like you\"/\"like me\""],
    [/\bboth\b[^.!?]{0,60}\b(?:too|as well)\b/i, "\"both\" doubled with \"too\"/\"as well\""],
    [/, and thank you\b/i, "a statement and a thank-you joined with \", and\"; make the thanks its own sentence"],
  ] as const) {
    const m = main.match(re);
    if (m) issues.push(`${what}: "${clip(m[0])}"`);
  }
  // Order: nothing warm after the ask, and not a string of thank-yous.
  const askAt = sentences.findIndex((s) => ASK.test(s));
  const congratsAt = sentences.map((s) => /congratulat/i.test(s)).lastIndexOf(true);
  if (askAt >= 0 && congratsAt > askAt) issues.push("congratulations come after the ask");
  const thanks = sentences.filter((s) => /^Thank you\b/.test(s)).length;
  if (thanks > 3) issues.push(`${thanks} sentences start "Thank you"`);
  // Mechanics.
  if (/[^\n] {2,}\S/.test(main)) issues.push("double space");
  if (/ [,.!?;:]/.test(main)) issues.push("space before punctuation");
  const repeated = main.match(/\b(\w+) \1\b/i);
  if (repeated && !/^(that|had)$/i.test(repeated[1])) issues.push(`repeated word: "${repeated[0]}"`);
  const lower = sentences.find((s) => /^[a-z]/.test(s));
  if (lower) issues.push(`sentence starts in lowercase: "${clip(lower)}"`);
  const colon = main.match(/\bquestions?: [A-Z]\w*/);
  if (colon) issues.push(`capital after a colon: "${colon[0]}"`);

  if (!ctx) return issues;
  if (!Object.values(ctx.answered).some((v) => /\b(said|thought|told)\b/i.test(v))) {
    const m = main.match(/\b(she|he|they|Emily|Marcus|Ben)\b (thought|said|mentioned|felt)( that)? you('d| would| were| are)\b/i);
    if (m) issues.push(`relays an opinion nobody typed: "${m[0]}"`);
  }
  const connected = ctx.ids.some((id) => ["first.referred", "first.met", "first.conference", "first.pointed"].includes(id));
  if (connected && /\bfound you (on|in|through)\b/i.test(main)) issues.push("says how the student found them, beside a real connection");
  if (ctx.ids.includes("first.recruiter") && sentences.some((s) => ASK.test(s) && /\b(call|chat|meeting|minutes)\b/i.test(s))) {
    issues.push("asks a recruiter for a call on top of the questions");
  }
  if (ctx.ids.some((id) => id.startsWith("first.")) && !/Pinecrest|investment club|screening model|dividend/i.test(main)) {
    issues.push("the student's background dropped out");
  }
  return issues;
}

/**
 * The ordinary words the playbook's own emails use everywhere. A typed detail
 * made only of these says almost nothing specific, so they are weighted down
 * when the guard asks whether a detail survived an edit; a word NOT in here is
 * an anchor, and losing an anchor is losing the detail.
 *
 * Generated, not hand-written, so it is auditable: the tokens of four or more
 * letters, carrying no digit and outside the content-word stop list, that
 * appear LOWERCASE in at least 10% of the 192 bodies in `email-examples.ts`
 * (19.2, so 20 bodies). Lowercase only, because that is what keeps the
 * playbook's invented names - "Marchbank", "Nadia", "Ridgemont" - and its
 * months and weekdays out of a list of words that mean nothing in particular.
 * `scripts/draft-review-test.ts` regenerates it and fails if it has drifted.
 */
export const DETAIL_COMMON: ReadonlySet<string> = new Set(
  ("again answer anything appreciate appreciated around attached back call conversation doing else email finance " +
    "finds firm first flexible forward glad great happy hear hope interest junior know last look love minutes " +
    "morning move name next offer please point process rather reach really reference resume schedule send since " +
    "sophomore spent spoke still studying summer taking team thank through time understand useful want wanted week " +
    "weeks well were whether will work worked year years").split(" "),
);

// What kind of problem a finding is, as the guard compares two drafts by kind
// rather than by count. The findings above are sentences written for a reviewer
// to read, so the kind has to be recovered from the text; the order here is the
// order draft-lint.ts produces them in, and `scripts/draft-review-test.ts`
// asserts nothing the corpus produces falls through to "other".
const FINDING_KINDS: [RegExp, string][] = [
  [/^long sentence \(/, "long sentence"],
  [/clauses strung together with/, "clauses strung together"],
  [/^"also" and "too"/, "also and too"],
  [/^connector that isn't a cause/, "connector that isn't a cause"],
  [/^split "to then"/, "split to then"],
  [/^common ground tacked onto a paragraph/, "common ground tacked on"],
  [/calls the student an alum/, "student called an alum"],
  [/announces the common ground as a discovery/, "common ground as a discovery"],
  [/common ground doubled or tacked on/, "common ground doubled"],
  [/"both" doubled with/, "both doubled"],
  [/joined with ", and"/, "thank-you joined with and"],
  [/^congratulations come after the ask/, "congratulations after the ask"],
  [/sentences start "Thank you"/, "thank-you openers"],
  [/^double space$/, "double space"],
  [/^space before punctuation$/, "space before punctuation"],
  [/^repeated word:/, "repeated word"],
  [/^sentence starts in lowercase/, "lowercase sentence start"],
  [/^capital after a colon/, "capital after a colon"],
  [/^relays an opinion nobody typed/, "invented opinion"],
  [/^says how the student found them/, "how the student found them"],
  [/^asks a recruiter for a call/, "call asked of a recruiter"],
  [/^the student's background dropped out/, "background dropped out"],
  [/^filler phrase:/, "filler phrase"],
  [/^comma splice before/, "comma splice"],
  [/^dash used as punctuation/, "dash as punctuation"],
  [/class year is already in the signature/, "class year in the signature"],
];

/** The kind of problem a `forReview` finding reports, or "other" if it is new. */
export function findingCategory(finding: string): string {
  return FINDING_KINDS.find(([re]) => re.test(finding))?.[1] ?? "other";
}

/**
 * Findings the reviewer is told about but that are NOT grounds to throw its
 * whole edit away.
 *
 * `comma splice` is here because it is measurably wrong far more often than it
 * is right, and the guard's veto turns one false positive into a discarded
 * edit and a wasted model call. MEASURED (LOGIC-2 F2,
 * `scripts/audit-probe/logic2/splice-probe.ts` and `tier-probe.ts`): 10 of 10
 * ordinary introductory phrases are reported as splices ("To answer your
 * question, I am...", "Having read the fund's latest letter, I came away..."),
 * 9 of 10 constructed real splices are missed, and 4 of the 5 bodies it fires
 * on in the playbook's own 234 emails are its own false positives. A check
 * with roughly one true positive in five has no business vetoing anything. It
 * stays in `forReview`, where a reviewer reads it and judges for itself, and
 * it comes back into the veto set when a structural test replaces its two word
 * lists and its false-positive rate on gold is 0.
 */
export const DIAGNOSTIC_CATEGORIES: ReadonlySet<string> = new Set(["comma splice"]);

/** "15550101234" and "555.010.1234" as "(555) 010-1234". Anything that isn't a plain US number stays as typed. */
export function formatPhone(raw: string): string {
  const typed = raw.trim();
  if (!/^[\d\s().+-]+$/.test(typed)) return typed;
  const digits = typed.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  return ten ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : typed;
}

// Words a resume's filename carries that aren't anyone's name.
const RESUME_WORDS = /^(resume|résumé|cv|final|draft|updated|update|new|copy|finance|banking|ib|pe|version|of|and|the|for)$/i;

/**
 * Whether a resume's filename names someone other than the student, e.g.
 * "Aidan Matus-Enochs - Resume 1.docx" on Alex Rivera's profile. Only a clear
 * mismatch counts: a filename with no name in it, or with either of the
 * student's names, never does.
 */
export function resumeLooksLikeSomeoneElses(filename: string, studentName: string): boolean {
  const mine = studentName.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (mine.length === 0) return false;
  const words = filename.replace(/\.[a-z0-9]+$/i, "").split(/[^A-Za-zÀ-ÿ'’-]+/).filter(Boolean);
  if (words.some((w) => w.toLowerCase().split("-").some((part) => mine.includes(part)) || mine.includes(w.toLowerCase()))) return false;
  const nameLike = words.filter((w) => /^[A-Z][A-Za-z'’-]+$/.test(w) && !RESUME_WORDS.test(w));
  return nameLike.length >= 2;
}

// A private or sensitive topic about a person: a health matter, an addiction, a
// death, a divorce, immigration or legal trouble, money trouble. A student
// sometimes types one as "what we talked about"; it doesn't belong in a
// networking email, even softened. A warning to the student, and one of the
// things that corroborates a removal the reviewer says it was told to make -
// never, on its own, a reason to let a typed detail be deleted (see
// `draft-review.ts`, rule 5).
//
// Why this is two groups rather than one word list. The old rule was 20 stems
// with `\w*` suffixes, and this app's domain is finance recruiting, where
// several of the plainest words for a sensitive subject are ordinary coverage
// vocabulary. MEASURED (LOGIC-2 F1, `scripts/audit-probe/logic2/misc-probe.ts
// private`): it missed 20 of 20 hand-written sensitive disclosures - illness,
// in recovery, a custody battle, immigration status, HIV, indicted,
// subpoenaed - and fired on 14 of 15 benign finance sentences, because
// `bankrupt\w*` caught the bankruptcy of Hertz, `diagnos\w*` a diagnostics
// company, `chemo\w*` a chemotherapy pipeline and `divorc\w*` a thesis on
// divorce rates. One word flipped the guard's protection of a typed detail.
//
// PLAIN below names a private matter whoever it is about and has no business
// homonym. IN CONTEXT is the rest: those count only beside a person - a
// possessive ("her divorce"), a personal predicate ("he was diagnosed") -
// which is how a student types a disclosure and not how a deal is described.
// Each alternative captures the word to report, so the note still reads
// "mentions \"divorce\"" rather than quoting the whole phrase.
const PERSONAL = "(?:his|her|their|my|your|our)";
// The nouns that turn one of these words from somebody's life into somebody's
// job: "divorce rates", "cancer research", "the bankruptcy market".
const TOPIC_NOT_PERSON =
  "rates?|law|laws|lawyers?|attorneys?|filings?|statistics|data|research|drug|drugs|care|cent(?:re|er)s?|institute|" +
  "franchise|pipeline|portfolio|coverage|screening|therapeutics|diagnostics|market|markets|industry|sector|space|fund|funds|deal|deals|trends?|economics|practice|vertical|company|companies|business";
const PRIVATE_TOPICS: RegExp[] = [
  // ---- plain
  /\b(rehab(?:ilitation)?)\b(?!-)/gi,
  /\b(miscarr\w*|suicid\w*|overdos\w*|antidepressants?|tumou?rs?|illness|abortion)\b/gi,
  /\b(HIV|AIDS|ADHD|IVF|DUI)\b(?!-)/gi,
  /\b(mental health|immigration status|visa status|green card|hospital stay|eating disorder|restraining order)\b/gi,
  /\b(?:in|entering|out of) (recovery)\b/gi,
  /\b(?:been|is|was|stayed|staying|years?) (sober)\b|\b(sobriety)\b/gi,
  /\b(custody) (?:battle|case|hearing|dispute|fight|arrangement)\b/gi,
  /\b(treatment cent(?:re|er)|treatment facility)\b/gi,
  /\b(passed away|funeral|death in (?:his|her|their|my|the) family)\b/gi,
  /\blos(?:ing|t) (?:his|her|their|my) (?:son|daughter|wife|husband|partner|mother|father|brother|sister|child|parent|mom|dad)\b/gi,
  /\b(?:was|were|been|got) (let go|fired)\b|\b(laid off)\b/gi,
  /\b(?:goes to|attends|attending) (synagogue|mosque|church|temple)\b|\b(?:he|she|they|I) (voted)\b/gi,
  // ---- in context: a person, not a deal
  new RegExp(`\\b${PERSONAL}\\s+(gambling)\\b|\\b(gambling) (?:addiction|problem|debts?|habit)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(?:[\\w'\u2019]+\\s+){0,2}(addict(?:ion|ions|ed|s)?)\\b|\\b(?:struggl\\w+ with|recovering from|battle with) (?:[\\w'\u2019]+ ){0,2}(addict\\w*)\\b`, "gi"),
  // A business noun AFTER the word is what tells a disclosure from a sector:
  // "the divorce" and "the cancer" are someone's life, "divorce rates" and
  // "cancer research" are a thesis and a job. That is the cheaper half of the
  // distinction, and it keeps the definite article - "I am sorry to hear about
  // the divorce" is how a student writes it, and requiring a possessive there
  // denied the credit and left the divorce in the email.
  new RegExp(`\\b(divorc(?:e|ed|ing))\\b(?!\\s+(?:${TOPIC_NOT_PERSON}))`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(separation)\\b|\\bgoing through a (separation)\\b`, "gi"),
  new RegExp(`\\b(cancer)\\b(?!\\s+(?:${TOPIC_NOT_PERSON}))`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(chemo\\w*)\\b|\\b(?:on|started|finished|during|after) (chemo(?:therapy)?)\\b`, "gi"),
  /\b(diagnos(?:ed|is))\b/gi,
  new RegExp(`\\b${PERSONAL}\\s+(bankruptcy)\\b|\\b(?:he|she|they|I) (?:filed for|declared|went) (?:personal )?(bankrupt\\w*)\\b|\\b(personal bankruptcy)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(pregnan\\w*)\\b(?!-)|\\b(?:is|was|being) (pregnant)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(therap(?:y|ist))\\b|\\b(?:in|started|starting|sees a|saw a|seeing a|going to) (therap(?:y|ist))\\b`, "gi"),
  new RegExp(`\\b(?:he|she|they|I) (?:was|were|had been|got) (arrested)\\b|\\b${PERSONAL}\\s+(arrest)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(lawsuit)\\b|\\b(?:is|was|been|being) (sued)\\b|\\b(suing)\\b`, "gi"),
  new RegExp(`\\b(?:${PERSONAL}|with)\\s+(depression)\\b|\\b(?:is|was|been) (depressed)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(anxiety)\\b|\\b(?:struggl\\w+ with|suffers? from|dealing with) (?:[\\w'\u2019]+ ){0,2}(anxiety)\\b`, "gi"),
  new RegExp(`\\b${PERSONAL}\\s+(disabilit\\w*)\\b|\\bon (disability)\\b`, "gi"),
  /\b(?:was|were|been|got) (indicted|subpoenaed)\b|\b(?:his|her|their|my) (indictment|subpoena)\b/gi,
];

/** The private or sensitive topics a piece of text mentions, lowercased, in the order they appear. */
export function privateTopicsIn(text: string): string[] {
  const found: { at: number; topic: string }[] = [];
  for (const re of PRIVATE_TOPICS) {
    for (const m of text.matchAll(re)) {
      const topic = (m.slice(1).find(Boolean) ?? m[0]).trim().toLowerCase();
      if (!topic) continue;
      found.push({ at: (m.index ?? 0) + Math.max(0, m[0].toLowerCase().indexOf(topic)), topic });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.topic))];
}

/**
 * A value that must never be in a networking email: a Social Security number,
 * a bank, routing or card number, what someone is paid, another person's phone
 * number, a home address. `draft-prompt.ts` forbids exactly this list in the
 * email it asks for, and nothing checked the email it got back. MEASURED
 * (OUTPUT-3): the reviewer removing an SSN was rejected either way - labelled
 * `other` the removal was punished as dropping a typed detail, and labelled
 * nothing at all the shrink floor caught it - so the number shipped.
 *
 * Precision, which is the whole difficulty: every one of these shapes has an
 * innocent twin in a finance email. So
 * - money is only a PAY figure when a pay word sits beside a personal-scale
 *   amount ($95,000, 85k, $30 an hour). A deal size is quoted in millions or
 *   billions and never matches; a percentage never matches; a year never
 *   matches, because a bare number is not evidence of anything.
 * - a phone number is only sensitive when a THIRD person owns it ("his cell",
 *   "Jeff's number"). The student's own number, and a number the recipient
 *   gave the student to use ("your line", "the number you sent"), are not
 *   disclosures of anyone else's business.
 * - an address needs a house number AND a street word AND either a unit or a
 *   postcode. "Marlow Coffee on Chandler Street" is where a coffee is, not
 *   where someone lives.
 * - a nine-digit run is a CUSIP, an order id or a zip+4 as often as an SSN, so
 *   the SSN rule wants the 3-2-4 separators or the words.
 */
export const SENSITIVE_VALUES: [RegExp, string][] = [
  [/\b(?:ssn|social security(?: number| no\.?| #)?)\b[^.\n]{0,24}?\b\d{3}[- ]?\d{2}[- ]?\d{4}\b|\b\d{3}-\d{2}-\d{4}\b/i, "a Social Security number"],
  [/\b(?:\d{4}[ -]){3}\d{1,4}\b|\b(?:card|credit card|debit)(?: number| no\.?| #)?\s*(?:is|:)?\s*\d{12,19}\b/i, "a card number"],
  [/\b(?:routing|account|acct\.?|iban|sort code)(?: number| no\.?| #)?\s*(?:is|:)?\s*[A-Z]{0,4}\d{6,}\b/i, "a bank account or routing number"],
  [
    /\b(?:salary|salaries|base pay|base salary|my pay|take[- ]home|bonus|compensation|comp|stipend|hourly rate|paid)\b[^.\n]{0,30}?(?:\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{1,3}(?:\.\d+)?\s?k\b|\b\d{2,3}k\b|\$\s?\d+(?:\.\d+)?\s*(?:an? |per |\/)\s*(?:hour|hr|year|yr|month|week))|(?:\$\s?\d{1,3}(?:,\d{3})+|\b\d{2,3}k\b)[^.\n]{0,24}?\b(?:salary|base|bonus|compensation|stipend|a year|an hour)\b/i,
    "what someone is paid",
  ],
  [
    /\b\d{1,5}\s+(?:[A-Z][\w.'’-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Circle|Cir)\b\.?(?:[^.\n]{0,30}?\b(?:Apt|Apartment|Unit|Suite|#)\b|[^.\n]{0,40}?\b\d{5}(?:-\d{4})?\b)|\b(?:my|his|her|their) (?:home )?address is\b[^.\n]{0,10}\d/i,
    "a home address",
  ],
  [
    /\b(?:his|her|their|[A-Z][\w'’]+'s|[A-Z][\w'’]+’s)\s+(?:cell|mobile|phone|number|line)\b[^.\n]{0,24}?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b|\breach (?:him|her|them)(?: at| on)\b[^.\n]{0,24}?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/,
    "someone else's phone number",
  ],
];

/** Which of the forbidden values a piece of text contains, named for a note. */
export function sensitiveValuesIn(text: string): string[] {
  return SENSITIVE_VALUES.filter(([re]) => re.test(text)).map(([, what]) => what);
}

// A comma joining two full sentences: "Thank you again for connecting me with Ben,
// we had our call this week." The live evaluation caught the review pass writing
// these. What follows the comma starts its own subject and verb; what comes before
// it is a full clause, not an introductory phrase ("This summer, I built") or a
// short aside ("and, like you, I'm from Atlanta").
const SPLICE_START =
  /,\s+(?:(?:I|we|he|she|they)(?:'m|'s|'re|'ve|'d)?\s+[a-z]+|it's always|it's been|it was|what stuck with me|that's why)\b/g;
const INTRODUCTORY =
  /^(?:since|this|that|these|those|last|next|at|in|on|if|when|after|before|as|given|because|while|although|though|for|with|over|during|once|earlier|later|today|yesterday|however|still|so|then|whatever|whenever|until|unless|now|back|by|from|besides|following|honestly|meanwhile|otherwise|instead|overall|personally|ideally)\b/i;
const SUBORDINATE = /\b(?:if|when|because|since|while|although|though|as|after|before|once|until|whenever|whether|the more|so that)\b/i;

/** Comma splices in the text, as the words that follow the comma. */
export function commaSplices(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(text)) {
    for (const m of sentence.matchAll(SPLICE_START)) {
      const before = sentence.slice(0, m.index).trim();
      const lastSegment = before.split(",").pop()!.trim();
      if (before.split(/\s+/).length < 3 || lastSegment.split(/\s+/).length <= 3) continue;
      if (INTRODUCTORY.test(before) || SUBORDINATE.test(lastSegment)) continue;
      found.push(m[0].replace(/^,\s+/, ""));
    }
  }
  return found;
}

const FILLER = [
  /\bI (?:just )?wanted to (?:reach out|follow up|say|touch base)\b/i,
  /\bI hope this (?:email|message|note) finds you well\b/i,
  /\b(?:made all the difference|exactly what I needed|even more excited)\b/i,
];
const TEAM = /\b(team|recruiting|recruitment|careers|talent|inbox|office|committee)\b/i;
const TITLED = /^(professor|prof\.?|dr\.?|dean)\s/i;

/**
 * The checks for one finished draft. `forReview` is what the review pass is
 * told to fix; `forStudent` becomes "Before you send" notes, because only the
 * student knows the answer.
 */
export function draftChecks(
  input: Pick<DraftPromptInput, "contactName" | "contactFirm" | "gmailSignature" | "studentGradYear" | "brief" | "purpose" | "extraContext">,
  body: string,
): { forReview: string[]; forStudent: string[] } {
  const lines = body.split("\n");
  const signOff = signOffLine(lines);
  const main = (signOff >= 0 ? lines.slice(0, signOff) : lines).join("\n").trim();
  const greeting = main.split("\n")[0]?.trim() ?? "";
  const text = main.split("\n").slice(1).join("\n").trim();

  const forReview = fluencyIssues(text, null);
  for (const re of FILLER) {
    const m = text.match(re);
    if (m) forReview.push(`filler phrase: "${m[0]}"`);
  }
  for (const splice of commaSplices(text)) forReview.push(`comma splice before "${splice}"`);
  // A spaced hyphen standing in for a dash ("No reply needed - thank you"). finishDraft only removes real dashes.
  const dash = text.match(/[A-Za-z,.!?] - [A-Za-z]/);
  if (dash) forReview.push(`dash used as punctuation: "${dash[0]}"`);
  // An opinion put in someone's mouth ("Emily thought you'd be great to talk to") that the student never typed.
  const typed = [JSON.stringify(input.brief ?? {}), input.purpose ?? "", input.extraContext ?? ""].join(" ");
  if (!/\b(said|thought|told|mentioned|recommended)\b/i.test(typed)) {
    const opinion = text.match(/\b(?:she|he|they|[A-Z][a-z]+) (?:thought|said|mentioned|felt|believes?)(?: that)? you(?:'d| would| were| are| might| could)\b/);
    if (opinion) forReview.push(`relays an opinion nobody typed: "${opinion[0]}"`);
  }
  const classYear = text.match(/\(\s*Class of \d{4}\s*\)/i);
  if (classYear && !input.gmailSignature && input.studentGradYear) {
    forReview.push(`the class year is already in the signature: "${classYear[0]}"`);
  }

  const forStudent: string[] = [];
  const name = input.contactName.trim();
  const greeted = greeting.match(/^(?:Hi|Hello|Dear)\s+([^,]+),$/);
  if (greeted && !TEAM.test(name) && !TITLED.test(name)) {
    const words = name.replace(/\([^)]*\)|<[^>]*>/g, " ").split(",")[0].trim().split(/\s+/).filter(Boolean);
    const firmWords = (input.contactFirm ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (firmWords.includes(greeted[1].trim().toLowerCase())) {
      forStudent.push(`The email opens "${greeting}", which is part of the firm's name. Check the name of the person you're emailing.`);
    } else if (words.length === 1) {
      forStudent.push(`There's only one name on file for the person you're emailing, so the email opens "${greeting}". Make sure that's their first name.`);
    }
  }
  for (const what of sensitiveValuesIn(text)) {
    forStudent.push(`This email looks like it contains ${what}. Take it out before you send - an email is not a safe place for it.`);
  }
  const privateTopics = privateTopicsIn(text);
  if (privateTopics.length) {
    forStudent.push(
      `This email mentions ${privateTopics.map((w) => `"${w}"`).join(", ")}. Private or sensitive details usually don't belong in a networking email.`,
    );
  }
  return { forReview, forStudent };
}
