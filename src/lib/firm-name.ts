// A firm's name reduced to one comparable form - "Moelis & Company" and
// "Moelis", "JPM" and "J.P. Morgan" - for matching free text against firms.
//
// Its own module with no imports, so server code, pure rules and their tests
// can all share it. Moved out of lib/network-coverage.ts, which re-exports it.

// Only genuinely legal/structural suffixes are stripped. Words like "Partners",
// "Capital", "Group" and "Securities" are load-bearing parts of a firm's
// identity - dropping them would collapse "Bain Capital" and "Bain & Company"
// onto each other, which is worse than missing a match.
const LEGAL_SUFFIXES =
  /\b(?:llc|inc|incorporated|corp|corporation|plc|llp|lp|ltd|limited|co|company|holdings)\b/g;

// Abbreviations students actually type. Keys and values are both in normalised
// form, so this runs after normalisation, not before.
//
// Several entries that used to live here - "goldman sachs and", "mckinsey and",
// "bain and", "kkr and" - were patching one bug per firm: stripping "Co." or
// "Company" off "X & Co." leaves a dangling "and", and every firm written that
// way needed its own line. normalizeFirmName now drops that trailing "and" for
// every firm, so those entries are gone and "Morgan Stanley & Co. LLC" and
// "Moelis & Company" - which never had a line - match too.
/**
 * Names students actually type for the same firm, grouped: every name in a
 * group normalises to the group's first one. Written in normalised form (the
 * output of the chain in normalizeFirmName, before this lookup), so "J.P.
 * Morgan" arrives here as "jpmorgan" and "Moelis & Company" as "moelis".
 *
 * Symmetric by construction: the firms table's own name normalises into the
 * same group as the nickname, so "Centerview", "CVP" and "Centerview Partners
 * LLC" all meet at "centerview".
 *
 * Deliberately NOT here: short aliases that are ordinary words in a calendar
 * title or a sentence - "am" (Alvarez & Marsal), "ga", "jump", "chase",
 * "wells", "vista", "advent" - because titles are matched against these too,
 * and "Coffee at 9 am" is not a meeting at A&M. And "bain", which is two
 * different firms. Each firm's own aliases in the firms table (see
 * firmResolver) cover the rest, per firm.
 */
const ALIAS_GROUPS: string[][] = [
  // Bulge brackets and large banks
  ["goldman sachs", "gs", "goldman", "goldman sachs and", "goldman sachs group"],
  ["jpmorgan", "jpm", "jp morgan", "j p morgan", "jp morgan chase", "jpmorgan chase", "jpmorganchase", "jpmc", "jpmorgan securities", "jp morgan securities"],
  ["morgan stanley", "ms", "morgan stanley and"],
  ["bank of america", "bofa", "baml", "boa", "bofa securities", "bank of america merrill lynch", "bank of america securities", "merrill lynch", "merrill"],
  ["citigroup", "citi", "citibank", "citigroup global markets", "citi global markets"],
  ["deutsche bank", "db", "deutsche bank securities"],
  ["credit suisse", "cs"],
  ["barclays", "barclays capital", "barclays bank"],
  ["ubs", "ubs investment bank", "ubs securities"],
  ["wells fargo", "wells fargo securities", "wells fargo bank", "wfs"],
  ["rbc capital markets", "rbc", "rbccm", "royal bank of canada"],
  ["bmo capital markets", "bmo"],
  ["jefferies", "jefferies financial", "jefferies llc"],
  ["nomura", "nomura securities"],
  ["mizuho", "mizuho securities", "mizuho americas"],
  ["smbc", "smbc nikko", "sumitomo mitsui"],
  ["mufg", "mufg securities", "mitsubishi ufj"],
  ["td cowen", "td securities", "cowen", "cowen and"],
  ["hsbc", "hsbc securities"],
  ["societe generale", "socgen", "soc gen", "sg"],
  ["bnp paribas", "bnp", "bnp paribas securities"],
  // Advisory boutiques
  ["evercore", "evr", "evercore partners"],
  ["lazard", "lazard freres"],
  ["centerview", "centerview partners", "cvp"],
  ["pjt partners", "pjt"],
  ["moelis"],
  ["perella weinberg", "pwp", "perella weinberg partners", "perella"],
  ["guggenheim", "guggenheim securities", "guggenheim partners"],
  ["houlihan lokey", "hl", "houlihan"],
  ["greenhill", "greenhill and"],
  ["qatalyst", "qatalyst partners"],
  ["liontree", "lion tree"],
  ["rothschild", "rothschild and", "n m rothschild"],
  ["william blair", "william blair and"],
  ["harris williams", "harris williams and"],
  ["baird", "robert w baird", "rw baird", "robert w baird and"],
  ["piper sandler"],
  ["stifel", "stifel nicolaus", "kbw", "keefe bruyette and woods"],
  ["lincoln international", "lincoln intl"],
  ["raymond james"],
  // Private equity and credit
  ["kkr", "kohlberg kravis roberts"],
  ["blackstone", "bx"],
  ["apollo", "apollo global management", "apollo global"],
  ["carlyle"],
  ["tpg", "tpg capital", "texas pacific"],
  ["warburg pincus", "warburg"],
  ["bain capital"],
  ["hellman and friedman", "h and f"],
  ["silver lake", "silver lake partners"],
  ["thoma bravo"],
  ["vista equity partners", "vista equity"],
  ["general atlantic"],
  ["leonard green and partners", "leonard green", "lgp"],
  ["clayton dubilier and rice", "cd and r", "cdr"],
  ["hig capital", "hig", "h i g capital", "h i g"],
  ["ares management", "ares"],
  ["blue owl", "blue owl capital"],
  ["brookfield", "brookfield asset management"],
  // Hedge funds and trading
  ["citadel"],
  ["citadel securities"],
  ["jane street", "jane street capital"],
  ["two sigma", "two sigma investments"],
  ["d e shaw", "de shaw", "deshaw", "d e shaw and"],
  ["bridgewater", "bridgewater associates"],
  ["millennium", "millennium management"],
  ["point72", "point72 asset management", "point 72"],
  ["balyasny", "balyasny asset management", "bam"],
  ["elliott", "elliott management"],
  ["renaissance technologies", "rentec", "rentech"],
  ["susquehanna", "sig", "susquehanna international"],
  ["hudson river trading", "hrt"],
  ["imc", "imc trading"],
  ["jump trading"],
  ["tower research", "tower research capital"],
  ["aqr", "aqr capital management", "aqr capital"],
  // Asset management
  ["blackrock", "blk"],
  ["fidelity", "fidelity investments"],
  ["pimco"],
  ["wellington", "wellington management"],
  ["t rowe price", "t rowe"],
  // Consulting and advisory
  ["mckinsey", "mck"],
  ["boston consulting", "bcg"],
  ["pwc", "pricewaterhousecoopers"],
  ["ey", "ernst and young"],
  ["alvarez and marsal", "a and m"],
  ["fti consulting", "fti"],
];

/** Every firm the groups above know by its canonical name. */
const CANONICAL: ReadonlySet<string> = new Set(ALIAS_GROUPS.map(([canonical]) => canonical));

const ALIASES: Record<string, string> = Object.fromEntries(
  ALIAS_GROUPS.flatMap(([canonical, ...rest]) => [canonical, ...rest].map((name) => [name, canonical])),
);

export function normalizeFirmName(raw: string): string {
  const base = raw
    // "Société Générale" as "Societe Generale": accents are how the firm writes
    // itself, not how a student types it, and left in they became spaces.
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // A bracketed note is not the name: the firms table says "Barclays (US)"
    // and "Bank of America (BofA Securities)", students say "Barclays".
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    // Dotted initials as one word: "J.P." is "jp", "L.P." is "lp" - not "j p".
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();

  // A leading "The" and a trailing "Group" are decoration rather than identity:
  // "The Blackstone Group" and "Blackstone" are the same firm, and a student
  // will write either. Both are anchored so they only strip at the ends -
  // "Boston Consulting Group" loses its suffix, while a firm with "group" in
  // the middle of its name keeps it.
  // Stripped at the end, over and over until nothing changes, because the
  // endings stack in any order: "UBS Group AG", "Goldman Sachs Group, Inc.",
  // "Mizuho Securities USA LLC". What goes:
  //  - "group": decoration, not identity ("The Blackstone Group" is Blackstone);
  //  - "and": the residue of "X & Co." once the "Co." has gone - no firm name
  //    ends in "and", and "morgan stanley and" matched nothing on earth;
  //  - foreign legal forms (AG, SA, SE, NV, GmbH, N.A.) and a trailing "USA".
  // Once the result is stable, running it again gives the same answer.
  let trimmed = base.replace(/^the\s+/, "");
  for (let previous = ""; previous !== trimmed; ) {
    previous = trimmed;
    trimmed = trimmed.replace(/\s+(?:group|and|ag|sa|se|nv|gmbh|na|usa)$/, "").trim();
  }

  return ALIASES[trimmed] ?? trimmed;
}

/**
 * Resolves free-text firm names against a known set of firms: their names,
 * every alias the firms table holds for each (its "doing business as" names),
 * and the built-in groups above - to the one key for that firm.
 *
 * Beyond an exact match, a name that is the leading words of exactly one
 * known firm resolves to it - "Jane Street" to "Jane Street Capital",
 * "Lazard" to "Lazard Freres & Co." - so long as no other known firm starts
 * the same way. Ambiguity resolves to nothing rather than to a guess.
 */
/** Words a firm's name can end in without changing which firm it is. */
const GENERIC_TAIL = new Set(["partners", "advisors", "advisers", "associates", "securities", "international", "intl", "trading", "and"]);

export function firmResolver(
  firms: readonly { name: string; aliases?: readonly string[] | null }[],
): (raw: string | null | undefined) => string {
  // Every firm's own name first, then aliases: a firm's name always means
  // that firm, whatever order the list came in and whichever other firm
  // lists it as an alias ("Bain" on Bain Capital never takes Bain & Company).
  const byKey = new Map<string, string>();
  for (const f of firms) {
    const canonical = normalizeFirmName(f.name);
    if (canonical && !byKey.has(canonical)) byKey.set(canonical, canonical);
  }
  for (const f of firms) {
    const canonical = normalizeFirmName(f.name);
    if (!canonical) continue;
    for (const alias of f.aliases ?? []) {
      const key = normalizeFirmName(alias);
      if (key && !byKey.has(key)) byKey.set(key, canonical);
    }
  }
  const known = [...new Set(byKey.values())];
  // The same free-text name is resolved over and over - every row of an
  // imported file against every row already on the tracker - and each call is
  // an NFKD pass, nine regexes, a loop of suffix strips and, short of an exact
  // hit, a scan of the known-firm list. The answer only depends on the string,
  // so it is worked out once per distinct string. The cache lives as long as
  // the resolver does (one request), so it cannot grow past the names that
  // request handled.
  const resolved = new Map<string, string>();
  return (raw) => {
    const cached = raw ? resolved.get(raw) : undefined;
    if (cached !== undefined) return cached;
    const answer = resolveOne(raw);
    if (raw) resolved.set(raw, answer);
    return answer;
  };

  function resolveOne(raw: string | null | undefined): string {
    const key = raw ? normalizeFirmName(raw) : "";
    if (!key) return "";
    const exact = byKey.get(key);
    if (exact) return exact;
    // A firm we know by name is that firm, never a longer one it happens to
    // start: "Citadel" is not Citadel Securities, even when only the latter
    // is on the list.
    if (CANONICAL.has(key)) return key;
    // Only when what is left is a generic tail - "Partners", "Advisors",
    // "Securities". "Capital", "Management" and "Group" are part of who a firm
    // is: "Bain" (Bain & Company) is not Bain Capital.
    const starting = known.filter((k) => {
      if (!k.startsWith(`${key} `)) return false;
      return k
        .slice(key.length + 1)
        .split(" ")
        .every((w) => GENERIC_TAIL.has(w));
    });
    return starting.length === 1 ? starting[0] : key;
  }
}
