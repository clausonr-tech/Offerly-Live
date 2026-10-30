import "server-only";

/**
 * Removes direct identifiers from text before it enters the training corpus.
 *
 * The privacy policy makes a specific promise - that a student's name and
 * contact details, and the name, email and employer of anyone a draft is
 * addressed to, are removed before the content is used for training. This
 * module is where that promise is either kept or broken, so it is written to
 * fail toward over-redaction: a training example with an extra placeholder in
 * it is a slightly worse example, while one with a real analyst's email in it
 * is a broken promise.
 *
 * Placeholders are STABLE and typed ([STUDENT], [CONTACT], [FIRM]) rather than
 * blanked out. A model trained on "Hi [CONTACT], I'm a [SCHOOL] student" still
 * learns the shape of an opening line; one trained on "Hi ___, I'm a ___
 * student" learns to write blanks.
 *
 * What this is NOT: anonymisation. Free text can always carry an identifying
 * detail no rule catches ("we met at the Thursday dinner your dad hosted"),
 * and nothing here should be described to anyone as making the corpus
 * anonymous. It removes direct identifiers, which is what was promised.
 */

/** Longest-first so "Jonathan Smith" is replaced before "Jon". */
function byLengthDesc(a: string, b: string) {
  return b.length - a.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every name a person might be written as: the full string, and each
 * individual word of it long enough to be worth matching on its own.
 *
 * Two-character-and-under fragments are skipped deliberately - initials and
 * particles ("de", "van", "J") match half the English language, and replacing
 * them turns a sentence into placeholder soup for no privacy gain.
 */
function nameVariants(fullName: string): string[] {
  const trimmed = fullName.trim();
  if (!trimmed) return [];
  // Hyphens and dashes split too: "Anne-Marie Okonkwo-Reed" is written as
  // "Anne", "Marie" and "Reed" as often as it is written whole.
  const parts = trimmed.split(/[\s‐-―-]+/).filter((p) => p.length > 2);
  return withQuoteVariants([trimmed, ...parts]);
}

/**
 * Both apostrophes, for every needle that has one.
 *
 * A contact saved as "O'Brien" from a typed form and written as "O’Brien" by
 * the model (or the reverse - phones and editors substitute the curly one) is
 * the same name and two different strings, and matching only the stored
 * spelling left the other in the corpus.
 */
function withQuoteVariants(needles: string[]): string[] {
  const out = new Set<string>();
  for (const n of needles) {
    out.add(n);
    if (/['’]/.test(n)) {
      out.add(n.replace(/’/g, "'"));
      out.add(n.replace(/'/g, "’"));
    }
  }
  return [...out];
}

/**
 * The tail a firm is written with about as often as without: its legal form
 * ("& Co.", "LLC") and the descriptor after the name itself ("Partners",
 * "Group"). A contact saved as "Evercore Partners LLC" has to match a draft
 * that just says "Evercore".
 *
 * Stripped from the END only, and never down to a single generic word - see
 * GENERIC_FIRM_WORDS below.
 */
const FIRM_TAILS = new Set([
  // legal forms
  "inc", "inc.", "incorporated", "llc", "l.l.c.", "llp", "l.l.p.", "lp", "l.p.",
  "ltd", "ltd.", "limited", "corp", "corp.", "corporation", "co", "co.", "company",
  "plc", "p.l.c.", "sa", "s.a.", "nv", "n.v.", "ag", "gmbh", "pte", "pty", "sarl",
  // what the firm calls itself after its own name
  "group", "holdings", "holding", "partners", "capital", "advisors", "advisers",
  "securities", "management", "markets", "ventures", "associates", "international",
  "bank", "trust",
  "&", "and", ",",
]);

/**
 * Ordinary words that are never worth matching on their own, even when a firm
 * name strips down to one of them.
 *
 * This module prefers over-redaction, but "Global Partners Ltd" stripping to
 * "Global" would replace an adjective in every sentence it appears in, which
 * is the one cost that is not worth paying: the full name still matches, and
 * placeholder soup is a training example nobody can learn from.
 */
const GENERIC_FIRM_WORDS = new Set([
  "the", "global", "capital", "partners", "advisors", "advisers", "securities",
  "management", "asset", "assets", "bank", "banking", "finance", "financial",
  "investment", "investments", "holdings", "holding", "group", "company",
  "associates", "international", "national", "trust", "equity", "ventures",
  "venture", "markets", "market",
]);

/**
 * Every way a firm might be written: the stored string, and the same string
 * with its corporate tail removed when what is left still identifies someone.
 */
function firmVariants(firm: string): string[] {
  const trimmed = firm.trim();
  if (!trimmed) return [];
  let words = trimmed.split(/\s+/);
  while (words.length > 1 && FIRM_TAILS.has(words[words.length - 1].replace(/,$/, "").toLowerCase())) {
    words = words.slice(0, -1);
  }
  const stripped = words.join(" ").replace(/[,&]+$/, "").trim();
  const out = [trimmed];
  const keepStripped =
    stripped &&
    stripped.toLowerCase() !== trimmed.toLowerCase() &&
    stripped.length > 3 &&
    !(words.length === 1 && GENERIC_FIRM_WORDS.has(stripped.toLowerCase()));
  if (keepStripped) out.push(stripped);
  return withQuoteVariants(out);
}

/**
 * The letters and digits a needle may NOT be sitting inside.
 *
 * This replaced `\b`, which is defined on ASCII [A-Za-z0-9_] even with the i
 * flag - so a needle that starts or ends on anything else had no boundary to
 * find beside a space, a comma or the end of the string, and never matched at
 * all. "José", "Zoë", "Émile" and any firm ending in a period ("Goldman Sachs
 * & Co.") were therefore left in the corpus verbatim. Unicode property
 * lookarounds hold the original intent - "Kai" must not gut "Kaiser" - without
 * the ASCII assumption.
 */
const BEFORE = "(?<![\\p{L}\\p{N}_])";
const AFTER = "(?![\\p{L}\\p{N}_])";

function replaceAll(text: string, needle: string, placeholder: string): string {
  if (!needle.trim()) return text;
  const pattern = new RegExp(`${BEFORE}${escapeRegExp(needle)}${AFTER}`, "giu");
  return text.replace(pattern, placeholder);
}

/** Anything shaped like an email address, whether or not we know the person. */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Phone numbers, loosely. Deliberately greedy: a false positive redacts a
 * number that was not a phone number, which costs nothing, while a false
 * negative leaves a real one in the corpus.
 */
const PHONE_RE = /(\(?\+?\d[\d\s().-]{7,}\d)/g;

/** Links to a person's profile, which identify as directly as a name does. */
const LINKEDIN_RE = /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/[\w\-/%.]+/gi;

export type Identities = {
  /** The student the content belongs to. */
  student?: { name?: string | null; email?: string | null };
  /** The person a draft is addressed to, when there is one. */
  contact?: { name?: string | null; email?: string | null; firm?: string | null };
  /** The student's school, replaced with a type rather than removed - see
   *  the note on stable placeholders above. */
  school?: string | null;
};

/**
 * Redacts one string.
 *
 * Order matters, and it is structural rather than arbitrary: the pattern
 * sweeps run BEFORE the name replacements because names are embedded inside
 * URLs and email addresses. Replacing names first turned
 * "linkedin.com/in/jonathan-reed-1234" into "[LINKEDIN][CONTACT]-[CONTACT]-1234"
 * - still fully redacted, but noisy text to train on, and the whole reason for
 * typed placeholders is that the result stays readable.
 */
function deidentifyText(text: string, ids: Identities): string {
  let out = text;

  // Whole-token sweeps first. Each of these swallows any name inside it, so
  // the name passes below never see the fragments.
  out = out.replace(LINKEDIN_RE, "[LINKEDIN]");
  out = out.replace(EMAIL_RE, "[EMAIL]");
  out = out.replace(PHONE_RE, (match) =>
    // Re-checked here rather than tightened in the pattern: the loose version
    // also matches dates, prices and "2026-2027", and those should survive.
    match.replace(/\D/g, "").length >= 10 ? "[PHONE]" : match,
  );

  // Then the known identities, for anything written out in prose. Longest
  // first, so "Goldman Sachs & Co." is replaced whole before the plain
  // "Goldman Sachs" inside it can leave a stray " & Co." behind.
  for (const variant of firmVariants(ids.contact?.firm ?? "").sort(byLengthDesc)) {
    out = replaceAll(out, variant, "[FIRM]");
  }
  for (const variant of firmVariants(ids.school ?? "").sort(byLengthDesc)) {
    out = replaceAll(out, variant, "[SCHOOL]");
  }

  // Contact before student: a draft says the recipient's name far more often,
  // and if the two share a surname the recipient is the one that matters.
  for (const variant of nameVariants(ids.contact?.name ?? "").sort(byLengthDesc)) {
    out = replaceAll(out, variant, "[CONTACT]");
  }
  for (const variant of nameVariants(ids.student?.name ?? "").sort(byLengthDesc)) {
    out = replaceAll(out, variant, "[STUDENT]");
  }

  return out;
}

/** Walks a JSON-ish value, redacting every string inside it. */
export function deidentifyDeep<T>(value: T, ids: Identities): T {
  if (typeof value === "string") return deidentifyText(value, ids) as T;
  if (Array.isArray(value)) return value.map((v) => deidentifyDeep(v, ids)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deidentifyDeep(v, ids);
    return out as T;
  }
  return value;
}
