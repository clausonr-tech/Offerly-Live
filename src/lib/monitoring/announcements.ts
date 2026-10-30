import "server-only";

/**
 * Finding an opening on a page that has no job board.
 *
 * WHY THIS EXISTS
 * ---------------
 * Of 110 monitored firms, 64 have no parseable board and a good share of those
 * never will. LionTree and Qatalyst point their careers links at a contact
 * form; Allen & Company points at their homepage. These are not broken URLs -
 * they are how a twenty-analyst boutique recruits. No connector reaches them.
 *
 * But the opening is still announced. The page goes from "We recruit annually
 * through campus programs" to "Applications for our Summer 2028 Analyst
 * Program are now open", and that sentence is the whole event. There is
 * nothing to parse into a posting, and there is something worth telling a
 * student.
 *
 * WHAT IT PRODUCES
 * ----------------
 * An `opening_signal`, never an `internship_posting`. The distinction is the
 * point: a signal is a dated claim about when a programme opens, carrying the
 * sentence it was read out of, and the resolver already ranks it against
 * student reports and our own predictions. A posting claims a specific role
 * exists with a title and a link, and we have none of that here. Manufacturing
 * one would be inventing the thing this system refuses to invent.
 *
 * WHY IT DIFFS RATHER THAN MATCHES
 * --------------------------------
 * Matching phrases against the whole page finds the same evergreen sentence
 * every check, forever - "we recruit annually", "applications open in the
 * fall" - and each one looks like news. Only text that APPEARED since the last
 * check can be an announcement. That also means the first check of a source
 * can never fire: there is no previous text to diff against, and a page that
 * has said the same thing for a year is not an event.
 */

/** Phrases that mark an opening as having HAPPENED. Present or perfect tense
 *  only - see FUTURE_MARKERS for why that matters. */
const OPENING_PHRASES: RegExp[] = [
  /\bapplications?\s+(?:are\s+|is\s+)?(?:now\s+)?open\b/i,
  /\bnow\s+accepting\s+applications?\b/i,
  /\b(?:we\s+are|we're)\s+accepting\s+applications?\b/i,
  /\bapplications?\s+(?:for|to)\b[^.]{0,80}\b(?:are\s+)?(?:now\s+)?(?:open|live)\b/i,
  /\bapply\s+(?:now|today)\b/i,
  /\bnow\s+(?:recruiting|hiring)\s+for\b/i,
  /\b(?:openings?|positions?|roles?)\s+(?:are\s+)?(?:now\s+)?available\b/i,
  /\bapplication\s+(?:window|period)\s+(?:is\s+)?(?:now\s+)?open\b/i,
  /\bsubmit\s+your\s+application\b/i,
  /**
   * The subject-first form: "<programme> is open for applications".
   *
   * Every pattern above puts "applications" first - "applications are open",
   * "applications for X are now open" - and a careers page just as often
   * writes it the other way round: "Our 2028 Summer Analyst Programme is open
   * for applications." That sentence named the programme AND the cycle, which
   * is the highest-confidence shape this detector recognises, and it was read
   * as nothing at all. Found by announcements.test.ts.
   */
  /\b(?:is|are)\s+(?:now\s+)?open\s+for\s+(?:applications?|submissions?)\b/i,
  /**
   * "Applications are invited for our 2028 programme."
   *
   * The standard British phrasing, and this directory is not only American -
   * every rule in this codebase written against American English has cost a
   * real posting somewhere.
   */
  /\bapplications?\s+(?:are\s+)?(?:now\s+)?invited\b/i,
];

/**
 * Statements about a FUTURE opening.
 *
 * "Applications will open in September" is the single most common sentence on
 * these pages, and it must never be read as "open now" - that would send
 * students to a page that cannot take them.
 *
 * But it is not noise either. It is the firm saying, in its own words, when
 * its programme opens, which is the strongest kind of claim this system can
 * hold: `firm_announcement` outranks what we saw live, a student's report and
 * our own prediction. So it is captured rather than discarded, with the WHEN
 * extracted for parseWindow.
 */
const FUTURE_MARKERS =
  /\b(will\s+open|will\s+be\s+(?:open|accepting|available)|opens?\s+(?:in|on)\b|opening\s+(?:soon|shortly)|check\s+back|coming\s+soon|applications?\s+open\s+(?:in|on)\b)/i;

/**
 * The words naming when it opens, for parseWindow.
 *
 * Deliberately returns the firm's own phrasing rather than a parsed date.
 * parseWindow turns "September" into 1-30 September and "early March" into its
 * first third, and returns null for anything it cannot read confidently -
 * "vague stays vague" is the rule the signals table is built on, and the way
 * to honour it is to hand over the words, not a guess at what they mean.
 */
function whenPhraseIn(sentence: string): string | null {
  const m =
    // "the fall" is listed FIRST and the month alternative is case-sensitive:
    // with /i on a leading [A-Z][a-z]+, "the fall" matched as the bare word
    // "the", which parseWindow cannot read.
    /\b(?:open|opens|opening|available|accepting|live)\b[^.]{0,20}?\b(?:in|on|from|during|beginning|starting)\s+(?:(the\s+(?:fall|autumn|spring|summer|winter))|((?:early|mid|late)\s+)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+20\d{2})?))/.exec(
      sentence,
    );
  if (!m) return null;
  return (m[1] ?? `${m[2] ?? ""}${m[3] ?? ""}`).trim();
}

/** Statements that a window has CLOSED. Also not an opening, and worth
 *  detecting separately so a closure is never misread as news of one. */
const CLOSED_MARKERS =
  /\b(applications?\s+(?:are\s+)?closed|no\s+longer\s+accepting|closed\s+for\s+the\s+(?:season|cycle|year)|deadline\s+has\s+passed)\b/i;

/** Page furniture that changes on its own and is never an announcement. */
const NOISE =
  /\b(cookie|privacy|copyright|©|all rights reserved|last updated|sign in|log ?in|subscribe|newsletter|follow us|share this)\b/i;

type AnnouncementKind =
  /** The programme is open now - "applications are now open". */
  | "open_now"
  /** The firm has said WHEN it will open - "applications open in September". */
  | "opens_later";

export type Announcement = {
  kind: AnnouncementKind;
  /** The sentence, verbatim. This is the evidence the signal carries. */
  sentence: string;
  /** The programme year it names, when it names one. */
  cycleYear: number | null;
  /**
   * For `opens_later`, the words naming when - "September", "early October",
   * "the fall". Passed to parseWindow, which turns a month into that whole
   * month rather than its first day: the firm said a month, so the stored
   * claim says a month.
   */
  whenPhrase: string | null;
  /**
   * The calendar year the whenPhrase belongs to.
   *
   * NOT the cycle year, and the difference matters. Applications for Summer
   * 2028 open in autumn 2027 - finance recruits roughly eighteen months ahead,
   * which is why the recruiting timeline axis starts in January of the year
   * BEFORE the internship. Anchoring "September" to 2028 would store a window
   * a full year after the thing actually happens.
   *
   * January to March fall inside the internship year itself; everything else
   * belongs to the year before.
   */
  whenYear: number | null;
  /** How sure the deterministic pass is. Below AMBIGUOUS_BELOW it is worth a
   *  second opinion rather than a signal. */
  confidence: number;
};

/**
 * Sentences present in `current` that were not in `previous`.
 *
 * Compared on a normalised form so that whitespace, case and punctuation churn
 * do not register as new text - career sites reflow constantly and every
 * reflow would otherwise look like an announcement.
 */
export function addedSentences(previous: string, current: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const split = (s: string) =>
    s
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[a-z0-9])\s*[•·|]\s*/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 25 && x.length <= 400);

  const before = new Set(split(previous).map(norm));
  return split(current).filter((s) => !before.has(norm(s)));
}

/** A four-digit year near a cycle word, same rule the classifier uses. */
function cycleYearIn(sentence: string): number | null {
  const m =
    /\b(20\d{2})\b[^.]{0,40}\b(summer|spring|analyst|associate|intern|internship|program|programme|class)\b/i.exec(sentence) ??
    /\b(summer|spring|analyst|associate|intern|internship|program|programme|class(?:\s+of)?)\b[^.]{0,40}\b(20\d{2})\b/i.exec(sentence);
  if (!m) return null;
  const year = /^\d{4}$/.test(m[1]) ? m[1] : m[2];
  return /^\d{4}$/.test(year) ? Number(year) : null;
}

/** Below this the deterministic pass is not confident enough to write a
 *  signal on its own - the caller may ask a model, or do nothing. */
export const AMBIGUOUS_BELOW = 0.6;

/**
 * The strongest opening announcement in the added text, or null.
 *
 * Deterministic and cheap: it runs on every check of every board-less source
 * and costs nothing. A model is only worth reaching for on what this cannot
 * decide, and the caller decides that - see monitor-run.
 */
export function detectAnnouncement(
  previousText: string | null,
  currentText: string,
): Announcement | null {
  // No previous text means this is the first sighting. A page that has said
  // the same thing for a year is not news, and we cannot tell the difference
  // yet, so the honest answer is to record the text and wait.
  if (!previousText) return null;

  let best: Announcement | null = null;

  for (const sentence of addedSentences(previousText, currentText)) {
    if (NOISE.test(sentence)) continue;
    // A closure is real information, but it is not an opening and this
    // function does not claim to model it. Skipped rather than misreported.
    if (CLOSED_MARKERS.test(sentence)) continue;

    const isFuture = FUTURE_MARKERS.test(sentence);
    const opens = OPENING_PHRASES.some((p) => p.test(sentence));
    // A future sentence need not match an "open now" phrase to be useful:
    // "applications open in September" is a schedule, not a status.
    if (!opens && !isFuture) continue;

    const cycleYear = cycleYearIn(sentence);
    const mentionsProgramme =
      /\b(summer analyst|summer associate|internship|intern|analyst program|off[- ]cycle|insight|spring week|placement)\b/i.test(
        sentence,
      );
    const whenPhrase = isFuture ? whenPhraseIn(sentence) : null;
    const whenYear =
      whenPhrase && cycleYear
        ? /\b(jan|feb|mar)/i.test(whenPhrase)
          ? cycleYear
          : cycleYear - 1
        : null;

    // An opening phrase alone is weak - "apply now" appears beside a general
    // careers mailbox on half these pages. It earns a signal when it also
    // names the programme or the cycle.
    let confidence = 0.4;
    if (mentionsProgramme) confidence += 0.3;
    if (cycleYear) confidence += 0.3;
    // A future claim with no stated month is not a schedule anyone can use.
    if (isFuture && !whenPhrase) confidence -= 0.2;

    const rounded = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
    if (!best || rounded > best.confidence) {
      best = {
        kind: isFuture ? "opens_later" : "open_now",
        sentence: sentence.slice(0, 300),
        cycleYear,
        whenPhrase,
        whenYear,
        confidence: rounded,
      };
    }
  }

  return best;
}
