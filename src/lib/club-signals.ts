/**
 * Clubs and activities, gathered from every place we hold them and reduced to
 * one clean list.
 *
 * Clubs are the second-strongest warm-intro signal after a shared school, and
 * unlike a school they are specific: thousands of people went to USC, but the
 * people who ran its investing society are a room of thirty. That is why this
 * is worth doing carefully rather than passing the raw free-text field along.
 *
 * Two rules do most of the work here:
 *
 * 1. A full name can be turned into its acronym safely - "Trojan Investing
 *    Society" is unambiguously "TIS". The reverse is NOT safe: "TIS" could be
 *    anything, so an acronym only expands when we actually know it. That
 *    asymmetry is why KNOWN_ABBREVIATIONS is a curated list rather than
 *    something we infer.
 *
 * 2. Both spellings travel. A search that only knows "Trojan Investing
 *    Society" misses every profile that wrote "TIS", and vice versa.
 */

/**
 * Names that mean the same club, grouped. Matching ANY member emits ALL of
 * them, so it does not matter which spelling either side wrote.
 *
 * This exists for the names a machine cannot derive. "Trojan Investing
 * Society" -> "TIS" needs no help, but nothing about the letters in "Pi Kappa
 * Alpha" produces "Pike", and Pike is what its members actually write on a
 * profile. A derived acronym nobody uses matches nobody.
 *
 * Deliberately conservative - a wrong pairing sends the search after the wrong
 * people, which is worse than sending one spelling. Extend freely; it is data,
 * not logic.
 */
const CLUB_ALIASES: readonly (readonly string[])[] = [
  // Student finance and business organisations.
  ["Trojan Investing Society", "TIS"],
  ["Model United Nations", "MUN"],
  ["Student Managed Investment Fund", "SMIF"],
  ["Student Investment Fund", "SIF"],
  ["Women in Business", "WIB"],
  ["Society of Women Engineers", "SWE"],
  ["National Society of Black Engineers", "NSBE"],
  ["Society of Hispanic Professional Engineers", "SHPE"],
  ["Association of Latino Professionals For America", "ALPFA"],
  ["Management Leadership for Tomorrow", "MLT"],
  ["Sponsors for Educational Opportunity", "SEO"],
  ["Future Business Leaders of America", "FBLA"],

  // Professional and honour fraternities.
  ["Alpha Kappa Psi", "AKPsi"],
  ["Delta Sigma Pi", "DSP"],
  ["Beta Alpha Psi", "BAP"],
  ["Sigma Eta Pi", "SEP"],

  // Social fraternities, where the nickname is what gets written and the
  // initials are what do not.
  ["Pi Kappa Alpha", "Pike"],
  ["Sigma Phi Epsilon", "SigEp"],
  ["Sigma Alpha Epsilon", "SAE"],
  ["Phi Gamma Delta", "FIJI"],
  ["Phi Delta Theta", "Phi Delt"],
  ["Kappa Sigma", "Kappa Sig"],
  ["Delta Tau Delta", "Delt"],
  ["Lambda Chi Alpha", "Lambda Chi"],
  ["Alpha Epsilon Pi", "AEPi"],
  ["Zeta Beta Tau", "ZBT"],
];

/**
 * Words naming what KIND of organisation it is, when the name is already
 * complete without them. "Pi Kappa Alpha Fraternity" is Pi Kappa Alpha.
 *
 * "Society" and "Club" are deliberately absent: they are part of the name in
 * "Trojan Investing Society", whose acronym really is TIS.
 */
const ORG_SUFFIXES = new Set(["fraternity", "sorority", "chapter", "inc", "incorporated"]);

/** Every alias, keyed by every spelling in its group. */
const ALIAS_LOOKUP = new Map<string, readonly string[]>();
for (const group of CLUB_ALIASES) {
  for (const name of group) ALIAS_LOOKUP.set(coreKey(name), group);
}

/** Words that carry no weight in an acronym. */
const STOPWORDS = new Set(["of", "the", "and", "at", "for", "in", "on", "a", "an", "&"]);

/** Separators a student might use in one free-text answer. */
const SPLIT = /[,;\n\r•|]+|\s+\/\s+/;

/** Casing and punctuation differences are not different clubs. */
function key(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** As `key`, with a trailing organisation-type word dropped. */
function coreKey(name: string): string {
  const words = key(name).split(" ").filter(Boolean);
  while (words.length > 1 && ORG_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * The acronym for a full name, or null when one cannot be formed responsibly.
 *
 * Requires three significant words: two-word names produce noise ("Business
 * Club" -> "BC" matches nothing useful and collides with everything).
 */
export function acronymFor(name: string): string | null {
  const words = coreKey(name)
    .split(" ")
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));

  if (words.length < 3) return null;

  const letters = words.map((w) => w[0].toUpperCase()).join("");
  return letters.length >= 3 && letters.length <= 6 ? letters : null;
}

/**
 * One written club name, expanded into every spelling worth searching for.
 *
 * "Trojan Investing Society (TIS)" -> both, from the parenthetical.
 * "Trojan Investing Society"       -> both, from the derived acronym.
 * "TIS"                            -> both, from the known list.
 * "QRS"                            -> just "QRS" - no expansion is inferred.
 */
export function expandClub(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const out: string[] = [];

  // A parenthetical is the student telling us the pairing themselves.
  const paren = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    out.push(paren[1].trim(), paren[2].trim());
  } else {
    out.push(trimmed);
  }

  for (const name of [...out]) {
    const group = ALIAS_LOOKUP.get(coreKey(name));
    if (group) out.push(...group);

    // The derived acronym travels TOO, not instead. A known nickname and the
    // initials are both things a real profile might say - "Pike" and "PKA" are
    // each worth searching for, and neither is worth dropping for the other.
    const acronym = acronymFor(name);
    if (acronym) out.push(acronym);
  }

  return dedupe(out);
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const k = key(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(name.trim());
  }
  return out;
}

/** How many club spellings are worth sending. Past this it is noise. */
const MAX_CLUBS = 12;

/**
 * Every club we hold for one student, from all sources, as one list.
 *
 * Sources today are the onboarding answer and the resume. LinkedIn is listed
 * in the signature because that is where this should also read from - but we
 * do not fetch anyone's LinkedIn, including the student's, so it only ever
 * arrives from a file the student exported and uploaded themselves. Nothing
 * populates it yet; the parameter is the seam.
 */
export function clubSignals(input: {
  offerly?: string | null;
  resume?: string[] | null;
  linkedin?: string[] | null;
}): string[] {
  const written = [
    ...(input.offerly ?? "").split(SPLIT),
    ...(input.resume ?? []),
    ...(input.linkedin ?? []),
  ];

  const expanded = written.flatMap((entry) => expandClub(entry));
  return dedupe(expanded).slice(0, MAX_CLUBS);
}

/**
 * The same clubs as clubSignals, but one GROUP per club: every spelling of a
 * club together ("Trojan Investing Society" with "TIS"). Groups that share any
 * spelling are merged, so a student who wrote both names gets one group.
 *
 * The contact search runs one affinity search per club, not per spelling -
 * paying twice to search for the same club under two names buys nothing.
 */
export function clubGroups(input: {
  offerly?: string | null;
  resume?: string[] | null;
  linkedin?: string[] | null;
}): string[][] {
  const written = [
    ...(input.offerly ?? "").split(SPLIT),
    ...(input.resume ?? []),
    ...(input.linkedin ?? []),
  ];
  const groups: string[][] = [];
  for (const entry of written) {
    const spellings = expandClub(entry);
    if (!spellings.length) continue;
    const keys = new Set(spellings.map(key));
    const hit = groups.find((g) => g.some((s) => keys.has(key(s))));
    if (hit) hit.splice(0, hit.length, ...dedupe([...hit, ...spellings]));
    else groups.push(dedupe(spellings));
  }
  return groups;
}
