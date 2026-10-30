/**
 * Work-email patterns, learned per firm and applied for free.
 *
 * Buying an address costs a credit each time. Buying ONE address teaches us
 * the shape every address at that firm takes, and the shape costs nothing to
 * apply to everybody else. Measured across Goldman, UBS and their alternate
 * domains, every corporate address observed was `first.last@domain` - twelve
 * for twelve. Patterns are stable because they are set by an IT department,
 * not by the people who hold them.
 *
 * A pattern is a FIRM-level fact, so the first student to search a firm pays
 * for it and every student after gets it free.
 *
 * NOTHING HERE PRODUCES A VERIFIED ADDRESS. A derived address is unverified,
 * and callers must carry that word all the way to the student. Being wrong
 * and saying the address is unverified costs a bounce; being wrong while
 * calling it confirmed costs their credibility with someone they wanted to
 * impress.
 */

/** The shapes a corporate local-part takes, in rough order of how common they are. */
export const PATTERN_SHAPES = [
  "first.last",
  "firstlast",
  "f.last",
  "flast",
  "first_last",
  "first-last",
  "last.first",
  "lastfirst",
  "lastf",
  "firstl",
  "first",
  "last",
] as const;

export type PatternShape = (typeof PATTERN_SHAPES)[number];

/** Name suffixes that are not part of anybody's email address. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "phd", "mba", "cfa", "cpa"]);

/**
 * Strip a display name down to the two parts an address is built from.
 *
 * Accents go (corporate mail is ASCII), middle names go, suffixes go, and a
 * hyphenated surname keeps its hyphen for now - the shapes decide what to do
 * with it.
 */
export function nameParts(fullName: string): { first: string; last: string } | null {
  const cleaned = fullName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w && !SUFFIXES.has(w.replace(/[^a-z]/g, "")));
  if (words.length < 2) return null;

  const strip = (w: string) => w.replace(/[^a-z]/g, "");
  return { first: strip(words[0]), last: strip(words[words.length - 1]) };
}

/**
 * Shapes that spell the surname out. A shape not listed here uses only its
 * initial, and an initial is all we need to write one of those correctly.
 */
const NEEDS_FULL_LAST = new Set<PatternShape>([
  "first.last", "firstlast", "f.last", "flast", "first_last", "first-last",
  "last.first", "lastfirst", "lastf", "last",
]);

/** The same, for the given name. */
const NEEDS_FULL_FIRST = new Set<PatternShape>([
  "first.last", "firstlast", "first_last", "first-last", "last.first",
  "lastfirst", "firstl", "first",
]);

function render(shape: PatternShape, first: string, last: string): string | null {
  const f = first[0];
  const l = last[0];
  if (!first || !last || !f || !l) return null;

  // An initial is not a name.
  //
  // A private profile shows its owner as "Alexander N." - the provider hands
  // that over verbatim, and a first.last pattern turned it into
  // alexander.n@barclays.com, which is a fabricated address that bounces. A
  // truncated surname is extremely common in this data, so this is not an
  // edge case; it was inventing addresses for real people whose surname we
  // simply do not know.
  //
  // Refusing is the right answer rather than guessing: the contact is still
  // saved and still reachable on LinkedIn, just without an address. And it is
  // only refused for shapes that need the whole name - "firstl" can be
  // written correctly from an initial, because an initial is all it uses.
  if (last.length < 2 && NEEDS_FULL_LAST.has(shape)) return null;
  if (first.length < 2 && NEEDS_FULL_FIRST.has(shape)) return null;

  switch (shape) {
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "f.last":
      return `${f}.${last}`;
    case "flast":
      return `${f}${last}`;
    case "first_last":
      return `${first}_${last}`;
    case "first-last":
      return `${first}-${last}`;
    case "last.first":
      return `${last}.${first}`;
    case "lastfirst":
      return `${last}${first}`;
    case "lastf":
      return `${last}${f}`;
    case "firstl":
      return `${first}${l}`;
    case "first":
      return first;
    case "last":
      return last;
  }
}

/**
 * The shape that turns this name into this address, if any of them do.
 *
 * Returns the domain too, because that is the other half of what we learn -
 * and it is not always the domain we thought. Goldman's people are at gs.com,
 * not goldmansachs.com, and only one of those two answers a verifier.
 */
export function detectPattern(
  fullName: string,
  email: string,
): { shape: PatternShape; domain: string } | null {
  const parts = nameParts(fullName);
  if (!parts) return null;

  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return null;

  for (const shape of PATTERN_SHAPES) {
    if (render(shape, parts.first, parts.last) === local) return { shape, domain };
  }
  return null;
}

/** This name, in this firm's shape. Null when the name is too thin to use. */
export function applyPattern(
  fullName: string,
  shape: PatternShape,
  domain: string,
): string | null {
  const parts = nameParts(fullName);
  if (!parts) return null;
  const local = render(shape, parts.first, parts.last);
  return local ? `${local}@${domain}` : null;
}

export type FirmPattern = {
  shape: PatternShape;
  domain: string;
  /** How many real addresses agreed on this shape. One is enough to use, not enough to trust blindly. */
  samples: number;
};

/**
 * The pattern a set of known addresses agrees on.
 *
 * Disagreement is real - a firm can run two shapes after an acquisition - so
 * the winner is the most common one, and `samples` says how much of the
 * evidence it actually had.
 */
export function learnPattern(
  observed: { name: string; email: string }[],
): FirmPattern | null {
  const votes = new Map<string, { shape: PatternShape; domain: string; count: number }>();

  for (const { name, email } of observed) {
    const found = detectPattern(name, email);
    if (!found) continue;
    const key = `${found.shape}@${found.domain}`;
    const entry = votes.get(key) ?? { ...found, count: 0 };
    entry.count += 1;
    votes.set(key, entry);
  }

  const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
  return best ? { shape: best.shape, domain: best.domain, samples: best.count } : null;
}


// ---------------------------------------------------------------- evidence --

/**
 * How many agreeing records retire a firm's pattern from ever being bought
 * again.
 *
 * Every sample costs one credit (~$0.30 at the measured rate), so this is a
 * one-time spend of a few dollars per firm, shared by every student who ever
 * searches it. Ten is the point where a wrong shape stops being plausible:
 * corporate mail formats are set by an IT department, not chosen per person,
 * so ten in agreement is not ten coincidences.
 *
 * It is deliberately NOT one. Goldman was learned from a single record and that
 * record happened to sit on goldmansachs.com - the domain whose mail server
 * never confirms - when gs.com was the better answer. One sample cannot be
 * outvoted; ten can.
 */
export const PATTERN_CONFIRMED_SAMPLES = 10;

/**
 * The share of evidence the winner must hold to count as settled. A firm that
 * runs two formats after an acquisition should keep being sampled, not have
 * the first past ten declared correct.
 */
const PATTERN_MAJORITY = 0.8;

/**
 * Agreeing samples needed before a pattern is allowed to invent an address.
 *
 * Two, not one, and the reason is on record. At Barclays the first person the
 * provider could resolve had a business email at narrativ.com - a different
 * company entirely, presumably carried over from a previous job or simply
 * stale. One sample was enough to make that Barclays' pattern, and four other
 * Barclays contacts were handed manufactured @narrativ.com addresses marked
 * "inferred". A student would have emailed them.
 *
 * A second agreeing sample is cheap insurance: an unmatched lookup is free,
 * and a matched one costs a single credit at a firm nobody has settled yet.
 * PATTERN_CONFIRMED_SAMPLES is a different threshold for a different job -
 * this one says "safe to use", that one says "stop paying to check".
 */
export const PATTERN_MIN_SAMPLES = 2;

/**
 * How many agreeing addresses before the shape is applied to others. One: a
 * single real address on the firm's domain spelled from the person's name is
 * the firm's convention, and derived addresses are labelled "predicted" all
 * the way to the student. PATTERN_MIN_SAMPLES is separate - it is when a run
 * stops buying more addresses, because verified ones beat predicted ones.
 */
export const PATTERN_DERIVE_MIN_SAMPLES = 1;

/**
 * Whether an address's domain plausibly belongs to this firm.
 *
 * The narrativ.com guard. Exact membership of the firm's known domain list is
 * too strict to be usable - JPMorgan's site is jpmorgan.com but its mail is
 * jpmorganchase.com, and rejecting that would throw away a correct pattern -
 * so this asks the weaker question: does the mail domain share a name with
 * the firm or with any domain the firm is known to own?
 *
 * "jpmorganchase" contains "jpmorgan"           -> yes
 * "goldmansachs" is one of Goldman's domains    -> yes
 * "narrativ" against Barclays' names            -> no
 *
 * `knownDomains` comes from the provider's own record of the company (see
 * resolveCompany). With none supplied, the firm's name alone is used.
 */
export function domainBelongsToFirm(
  emailDomain: string,
  firmName: string,
  knownDomains: string[] = [],
): boolean {
  const whole = (d: string) => d.trim().toLowerCase().replace(/^www\./, "");
  // An exact match against a domain the provider says the firm owns is the
  // strongest evidence there is, and it has to be checked before anything
  // else: Goldman's mail really is at gs.com and Deutsche Bank's at db.com,
  // and the name heuristic below would throw both away as too short to judge.
  if (knownDomains.some((d) => whole(d) === whole(emailDomain))) return true;

  const label = (d: string) => whole(d).split(".")[0].replace(/[^a-z0-9]/g, "");
  const wanted = label(emailDomain);
  if (wanted.length < 3) return false;

  const candidates = new Set<string>();
  for (const d of knownDomains) {
    const l = label(d);
    if (l.length >= 3) candidates.add(l);
  }
  // The firm's own name, minus the words every firm shares. "Barclays (US)"
  // becomes "barclays"; "Deutsche Bank (US)" becomes "deutsche" and "bank".
  for (const word of firmName.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) candidates.add(word);
  }
  // And the whole name run together, for firms whose domain drops the spaces.
  const joined = firmName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (joined.length >= 4) candidates.add(joined);

  for (const c of candidates) {
    if (wanted === c || wanted.includes(c) || c.includes(wanted)) return true;
  }
  return false;
}

/** Words that appear in so many firm names they prove nothing. */
const STOP_WORDS = new Set([
  "bank", "banking", "group", "capital", "partners", "securities", "financial",
  "finance", "holdings", "advisors", "advisers", "management", "global",
  "international", "america", "american", "united", "national", "first",
  "corp", "corporation", "company", "incorporated", "limited",
]);

/** Every shape/domain we have actually observed at one firm, and how often. */
export type PatternTally = Record<string, number>;

const tallyKey = (shape: PatternShape, domain: string) => `${shape}|${domain}`;

export function recordObservation(
  tally: PatternTally,
  shape: PatternShape,
  domain: string,
): PatternTally {
  const key = tallyKey(shape, domain);
  return { ...tally, [key]: (tally[key] ?? 0) + 1 };
}

/** The shape the evidence favours, with how much of it agreed. */
export function winnerOf(
  tally: PatternTally,
): { shape: PatternShape; domain: string; samples: number; total: number } | null {
  const entries = Object.entries(tally).filter(([, n]) => n > 0);
  if (!entries.length) return null;

  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const [key, samples] = entries.sort((a, b) => b[1] - a[1])[0];
  const [shape, domain] = key.split("|");

  return { shape: shape as PatternShape, domain, samples, total };
}

/**
 * Whether this firm still needs paying for.
 *
 * Once true, `applyPattern` answers every future contact at the firm and no
 * enrichment credit is ever spent there again - by this student or any other.
 */
export function isPatternConfirmed(tally: PatternTally): boolean {
  const best = winnerOf(tally);
  if (!best) return false;
  return best.samples >= PATTERN_CONFIRMED_SAMPLES && best.samples / best.total >= PATTERN_MAJORITY;
}
