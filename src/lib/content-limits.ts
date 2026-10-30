// Language no student-typed text, and no email the app drafts, may contain:
// slurs and other hateful terms, and profanity. Both block.
//
// Checked in code rather than left to a prompt, so it holds whatever anyone
// types or a model writes. Every surface a student types into calls it before
// anything reaches a model or another person: email drafts, the chat assistant,
// posts, messages, profile and onboarding answers, practice answers, resume
// inputs, contacts and the schedule. The email draft is checked again on the
// way out.
//
// Whole words only, after undoing the usual disguises ("sh!t", "f u c k",
// "fuuck", "f*ck", "fu’ck", "ｆｕｃｋ", "fаggot"), so "Scunthorpe", "assessment",
// "cocktail", "Pakistan" and "fire retardant" all pass. A list can't see a hateful comment written in
// ordinary words ("women can't handle trading"); the drafting, review and chat
// prompts each carry a rule for that.
//
// Pure: the draft form uses it for a live warning, the server actions to block.

export type BlockedKind = "hateful" | "profanity";

// Slurs and hateful terms: racial and ethnic, antisemitic, anti-Muslim,
// homophobic and transphobic, sexist, ableist. Exact words (plus a plural "s").
const HATEFUL_WORDS = [
  "nigger", "nigga", "niggaz", "sandnigger", "chink", "gook", "spic", "spick", "wetback", "beaner",
  "kike", "kyke", "raghead", "towelhead", "coon", "paki", "redskin", "squaw", "porchmonkey", "junglebunny",
  "faggot", "fag", "faggy", "dyke", "tranny", "trannie", "shemale",
  "retard", "retarded", "feminazi", "whore", "slut", "slutty", "thot",
];
// Stems that make any word containing them hateful ("niggers", "faggots", compounds).
const HATEFUL_STEMS = ["nigger", "nigga", "faggot"];

const PROFANITY_WORDS = [
  "fuck", "fucked", "fucker", "fuckers", "fucking", "fuckin", "fuckup", "fck", "phuck",
  "shit", "shitty", "shitting", "shitted", "shithead", "shithole", "shitshow", "bullshit", "horseshit", "dipshit",
  "bitch", "bitches", "bitchy", "bitching", "bastard", "asshole", "ass", "dumbass", "jackass", "badass",
  "cunt", "twat", "prick", "piss", "pissed", "pissing", "cock", "dickhead", "wanker", "bollocks",
  "damn", "damned", "dammit", "goddamn", "goddammit", "tits", "titties", "jizz", "dildo", "porn", "porno",
  "wtf", "stfu", "milf",
];
const PROFANITY_STEMS = ["fuck"];

function matcher(words: string[], stems: string[]): RegExp {
  return new RegExp(`\\b(?:(?:${words.join("|")})s?|[a-z]*(?:${stems.join("|")})[a-z]*)\\b`, "i");
}
const HATEFUL = matcher(HATEFUL_WORDS, HATEFUL_STEMS);
const PROFANITY = matcher(PROFANITY_WORDS, PROFANITY_STEMS);

// Look-alike characters, swapped back only where they touch a letter, so "$55"
// and "great!" stay what they are while "sh!t" and "a$$hole" don't.
const LOOKALIKES: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i", "|": "i" };
const LOOKALIKE = /(?<=[a-z])[0134578@$!|]|[0134578@$!|](?=[a-z])/g;

// Characters that change how a word looks without changing what it says:
// zero-width spaces and joiners, the soft hyphen, tag characters (all Cf) and
// combining accents (Mn, Me). Dropped, not turned into a space, so "fu\u00adck"
// and "fu\u200bck" read as one word rather than two letters and a fragment.
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}]/gu;

// Letters of other alphabets drawn like Latin ones. Deliberately partial: with
// only these moving, an ordinary Greek or Cyrillic word still reads as itself
// ("\u0421\u0431\u0435\u0440\u0431\u0430\u043d\u043a" -> "cбepбaнк", which is no English word), while a Latin word
// with one letter swapped out reads as what it is ("f\u0430ggot" -> "faggot").
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0456": "i", "\u0445": "x", "\u0455": "s",
  "\u04cf": "l", "\u0501": "d", "\u0443": "u", "\u03bf": "o", "\u03b1": "a", "\u0131": "i", "\u0261": "g",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

// An apostrophe inside a word, in any of its shapes. "fu\u2019ck" says what "fuck"
// says; "don\u2019t" and "O\u2019Connor" say what "dont" and "OConnor" say, and
// neither of those is a word on either list.
const MIDWORD_APOSTROPHE = /(?<=[a-z])['\u2018\u2019\u02bc\u00b4`](?=[a-z])/g;

// Whether the fold below can change anything at all: a line of plain ASCII
// with no apostrophe in it folds to itself, and most text is exactly that.
const FOLDABLE = /[^\x00-\x7f]|['`\u00b4]/;

/**
 * The text with Unicode disguises undone: compatibility forms decomposed
 * (fullwidth "\uff46\uff55\uff43\uff4b", the "\ufb00" ligature, mathematical bold "\u{1D5F3}\u{1D5EE}\u{1D5F4}\u{1D5F4}\u{1D5FC}\u{1D601}"),
 * invisible characters dropped, look-alike letters folded to Latin, and a
 * mid-word apostrophe removed. Always an extra reading, never a replacement for
 * the text as typed, so nothing the plain reading catches can stop being caught.
 */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(INVISIBLE, "")
    .replace(CONFUSABLE, (c) => CONFUSABLES[c])
    .replace(MIDWORD_APOSTROPHE, "");
}

/** The ways a disguised word might read once undone. Each is checked. */
function readings(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const base of FOLDABLE.test(lower) ? [lower, fold(lower)] : [lower]) {
    let t = base;
    // Twice, so a run like "$$" next to a letter is fully swapped.
    for (let i = 0; i < 2; i++) t = t.replace(LOOKALIKE, (c) => LOOKALIKES[c]);
    // Letters spaced, dotted or apostrophed apart: "f u c k", "s.h.i.t", "f\u2019u\u2019c\u2019k".
    t = t.replace(/\b(?:[a-z][\s.\-_'\u2019]+){2,}[a-z]\b/g, (m) => m.replace(/[\s.\-_'\u2019]+/g, ""));
    // "fuuck" and "fuuuck" alike; "asssss" also read as "ass". Collapsing every
    // double is safe because both lists are matched as whole words (only
    // "fuck", "nigger", "nigga" and "faggot" match inside a word), so
    // "shiitake" -> "shitake" and "assessment" -> "asesment" are still words
    // of their own and still pass.
    const stretchedToOne = t.replace(/([a-z])\1+/g, "$1"); // "fuuck", "fuuuck" -> "fuck"
    const stretchedToTwo = t.replace(/([a-z])\1{2,}/g, "$1$1"); // "asssss" -> "ass"
    const starred = (s: string) => [s.replace(/(?<=[a-z])\*+(?=[a-z])/g, ""), ..."aeiou".split("").map((v) => s.replace(/(?<=[a-z])\*+(?=[a-z])/g, v))];
    for (const r of [t, stretchedToOne, stretchedToTwo].flatMap(starred)) out.add(r);
  }
  return [...out];
}

/** Whether the text contains a slur or hateful term, profanity, or neither. Hateful wins when both appear. */
export function findBlockedLanguage(text: string | null | undefined): BlockedKind | null {
  if (!text?.trim()) return null;
  const all = readings(text);
  if (all.some((r) => HATEFUL.test(r))) return "hateful";
  if (all.some((r) => PROFANITY.test(r))) return "profanity";
  return null;
}

// Every string inside a model-written value, however nested. Ids, numbers,
// flags and dates are not strings a person reads, so they cost nothing; a
// cycle or a freak depth stops the walk rather than hanging it.
function stringsIn(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) return [];
  if (value instanceof Date || value instanceof RegExp) return [];
  seen.add(value);
  const next = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return next.flatMap((v) => stringsIn(v, depth + 1, seen));
}

/**
 * The blocked language anywhere inside something a model wrote - a string, an
 * array of them, or an object of either, however nested - or null.
 *
 * The draft pipeline's own gate covers the subject and the body. Everything
 * else a model writes and a student then reads ("Before you send" notes, the
 * plan, a review problem's quote and fix) is a set of strings in an object, and
 * this is how a caller gates all of them in one line instead of listing fields
 * it will later forget to update.
 *
 * One thing it cannot be pointed at: text that is still arriving. A
 * half-delivered "Associate" ends in a word that is on the list, and failing a
 * draft over it is worse than letting the finished string be checked a moment
 * later - see settledText.
 */
export function findBlockedLanguageIn(value: unknown): BlockedKind | null {
  const texts = stringsIn(value);
  if (texts.some((t) => findBlockedLanguage(t) === "hateful")) return "hateful";
  if (texts.some((t) => findBlockedLanguage(t) !== null)) return "profanity";
  return null;
}

/**
 * The strings in a list that carry nothing blocked, in order, blanks dropped.
 * For a caller that should lose the one note rather than the whole draft: the
 * email is clean, and a note is not worth failing a draft the student has
 * already paid for.
 */
export function withoutBlockedLanguage(texts: readonly (string | null | undefined)[]): string[] {
  return texts.filter((t): t is string => Boolean(t?.trim()) && findBlockedLanguage(t) === null);
}

/**
 * The part of a string still being streamed that is safe to check: everything
 * up to the last whitespace, because the word after it may be half of a longer
 * one. "He is an Ass" is "He is an" until the rest of "Associate" arrives.
 *
 * A gate that runs per delta must check this rather than the raw partial text.
 * The cost of getting this wrong is not a miss - the finished string is checked
 * too - it is a clean draft destroyed after the student was charged for it.
 */
export function settledText(partial: string): string {
  const cut = partial.search(/\s+\S*$/);
  return cut < 0 ? "" : partial.slice(0, cut);
}

/** The message to show for the first labelled field with blocked language, or null when all are fine. The word itself is never repeated back. */
export function blockedLanguageError(fields: [label: string, value: unknown][]): string | null {
  for (const [label, value] of fields) {
    if (typeof value !== "string") continue;
    const kind = findBlockedLanguage(value);
    if (kind === "hateful") return `"${label}" contains a slur or hateful language. Remove it to continue.`;
    if (kind === "profanity") return `"${label}" contains profanity. Remove it to continue.`;
  }
  return null;
}

/** blockedLanguageError over every text value a form submitted, except the named fields (ids, choices, flags). */
export function blockedInForm(formData: FormData, labels: Record<string, string>, skip: string[] = []): string | null {
  const fields: [string, unknown][] = [];
  for (const [name, value] of formData.entries()) {
    if (skip.includes(name) || typeof value !== "string") continue;
    fields.push([labels[name] ?? "One of your answers", value]);
  }
  return blockedLanguageError(fields);
}
