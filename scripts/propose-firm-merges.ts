// Proposes firm merges for human review. Writes ./firm-merges.json; changes
// nothing in the database.
//
//   npx tsx --conditions=react-server scripts/propose-firm-merges.ts
//
// The directory mixes two grains. Form ADV and Form BD are filed per LEGAL
// ENTITY, so "Jpmorgan Distribution Services, Inc." and "Jpmorgan Funds
// Limited" are separate rows - correct as regulatory data, wrong as a list of
// employers a student browses. This groups entities under the brand that owns
// them so the directory can show one firm with a tab per division.
//
// It proposes; it does not decide. Name matching cannot see ownership, so a
// human reads the output and deletes what is wrong. The known failure mode is
// unrelated firms sharing a first word - "Goldman Lancaster, Inc." in Long
// Beach has nothing to do with Goldman Sachs - which is why matching is on
// whole-token prefixes rather than string prefixes: as raw strings, "capitalg"
// is a prefix of "capitalgenerationpartnersllp", and CapitalG (Alphabet's
// growth fund) is not the parent of Capital Generation Partners LLP.
import { readFileSync, writeFileSync } from "fs";
import { UNMERGED_FIRM_SEEDS } from "../src/lib/firm-content";

type Row = {
  slug: string;
  name: string;
  aum: number | null;
  headquarters: string;
  hasVerifiedProgram: boolean;
  categories: string[];
  programCount: number;
  secImported: boolean;
  tokens: string[];
  keys: string[][];
};

// Legal-form words. Stripped only from the END of a name, so "Trust Company of
// the West" keeps its first word.
const LEGAL = new Set([
  "llc", "l", "lp", "llp", "inc", "incorporated", "ltd", "limited", "plc", "corp",
  "corporation", "co", "company", "sa", "nv", "ag", "gmbh", "pte", "pty", "sarl",
  "spa", "ab", "as", "bv", "kg", "kk", "srl", "oy", "aps", "usa",
]);

function tokenize(name: string): string[] {
  const raw = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // Runs of single letters are rejoined, so an initialism survives whatever
  // punctuation it was written with. Without this "J.P. Morgan" tokenizes to
  // j/p/morgan and never matches "Jpmorgan Funds Limited" - the exact case
  // this script exists for.
  const out: string[] = [];
  let run = "";
  for (const t of raw) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) {
      out.push(run);
      run = "";
    }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

// Words that describe what a firm does, not which firm it is. A name made only
// of these ("Capital Management LLC" is a real row) must never be a sponsor -
// it would swallow every firm whose name happens to start the same way.
const GENERIC = new Set([
  "capital", "management", "managers", "partners", "advisors", "advisers", "advisory",
  "group", "financial", "finance", "investment", "investments", "investors", "asset",
  "assets", "wealth", "securities", "holdings", "associates", "ventures", "venture",
  "fund", "funds", "trust", "bank", "banking", "global", "international", "national",
  "american", "first", "private", "equity", "credit", "services", "solutions",
  "planning", "strategies", "resources", "family", "office", "companies",
]);

/** Tokens with trailing legal-form words removed, for comparing brands. */
function brandTokens(name: string): string[] {
  const t = tokenize(name);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/**
 * Every spelling of a brand worth matching on.
 *
 * "J.P. Morgan" and "JPMorgan" are one firm written two ways, and the file
 * contains both. Tokenizing gives jp/morgan for one and jpmorgan for the other,
 * so a second form glues a short leading initialism to the word after it.
 *
 * Deliberately not a general "squash everything" rule: as one string "capitalg"
 * is a prefix of "capitalgenerationpartnersllp", and CapitalG has nothing to do
 * with Capital Generation Partners LLP.
 */
function brandKeys(name: string): string[][] {
  const t = brandTokens(name);
  const keys = [t];
  if (t.length >= 2 && t[0].length <= 3) keys.push([t[0] + t[1], ...t.slice(2)]);
  return keys;
}

// Fund vehicles, GP entities and SPVs. Nobody applies for a job at "Bregal
// Sagemount Basecamp I General Partner Jersey Limited" - it is a holding
// structure that files its own Form ADV as an exempt reporting adviser.
const VEHICLE_PATTERNS: [RegExp, string][] = [
  [/\bgeneral partner\b/i, "general partner entity"],
  [/\bgp\b/i, "GP entity"],
  [/\b(feeder|master|offshore|onshore)\b/i, "fund structure"],
  [/\bclo\b/i, "CLO vehicle"],
  [/\bspv\b/i, "SPV"],
  [/\bco[- ]?invest(ment)?s?\b/i, "co-investment vehicle"],
  [/\b(fund|partners|holdings|vehicle|trust)\s+(?:[ivx]+|\d+)\b/i, "numbered fund"],
  [/\b(jersey|cayman|guernsey|luxembourg)\b/i, "offshore domicile"],
];

// Merges rejected by hand after reading them. Name matching cannot tell that
// Campbell Lutyens (a placement agent) has nothing to do with Campbell &
// Company (a managed-futures shop), or that Benchmark Community Bank is not
// Benchmark the venture firm - only knowing the firms does. Kept as a list
// rather than as a cleverer rule because that is what it honestly is.
const MANUAL_EXCLUSIONS = new Set([
  "benchmark-bank",
  "benchmark-community-bank",
  "benchmark-plus-management",
  "benchmark-financial-wealth-advisors-llc",
  "campbell-newman-asset-management-inc",
  "campbell-deegan-financial",
  "campbell-financial-services-llc",
  "campbell-lutyens-co-inc",
  "nationwide-planning-associates-inc",
  "wilshire-quinn-capital-inc",
  "wilshire-lane-capital",
  "wilshire-pacific-capital-advisors-llc",
  // Bill Ackman's hedge fund is not BNY's clearing broker.
  "pershing-square-capital-management",
  // KKR is not Kohlberg & Company - Jerome Kohlberg founded the latter after
  // LEAVING the former, which is exactly why the names collide.
  "kohlberg-kravis-roberts-co-l-p",
]);

/**
 * Community banks share generic names and are not the same institution.
 *
 * "Commercial Bank of California", "Commercial Bank of New York" and
 * "Commercial Bank of Texas" are three separate FDIC charters that a brand
 * prefix cannot tell apart, and the directory holds dozens of these. A place
 * name or a "& Trust" / "National Association" qualifier is the signal that two
 * similarly-named banks are distinct charters rather than one firm's divisions.
 */
function isDistinctBankCharter(parent: Row, child: Row): boolean {
  const bothBanks =
    parent.categories.includes("commercial_banking") &&
    child.categories.includes("commercial_banking");
  if (!bothBanks) return false;
  return (
    /\bof\s+\w/i.test(child.name) ||
    /(\band\b|&)\s*trust\b/i.test(child.name) ||
    /\bnational association\b/i.test(child.name) ||
    /\b(puerto rico|southwest|northwest|southeast|northeast|central)\b/i.test(child.name)
  );
}

function vehicleReason(name: string): string | null {
  for (const [re, why] of VEHICLE_PATTERNS) if (re.test(name)) return why;
  return null;
}

/** Is `a` a whole-token prefix of `b`, and shorter? */
function isTokenPrefix(a: string[], b: string[]): boolean {
  if (a.length >= b.length) return false;
  return a.every((t, i) => t === b[i]);
}

function sameBrand(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function main() {
  // Read from the seeds, not the database: the proposal must be reproducible
  // from source, and reading a database that already has merges applied would
  // make the second run see nothing left to merge.
  const firms = UNMERGED_FIRM_SEEDS;

  // Rows carrying a `kind` came from SEC filings; the rest were hand-researched.
  // A one-word brand we never curated ("Integral Corporation") has not earned
  // the right to absorb anything - see the low-confidence rule below.
  const secSlugs = new Set<string>(
    (JSON.parse(readFileSync("./src/lib/firm-seeds-bulk.json", "utf8")) as {
      slug: string;
      kind?: string | null;
    }[])
      .filter((r) => r.kind)
      .map((r) => r.slug),
  );

  const rows: Row[] = firms.map((f) => ({
    slug: f.slug,
    name: f.name,
    aum: f.aum ?? null,
    headquarters: f.headquarters,
    hasVerifiedProgram: f.hasVerifiedStudentProgram !== false,
    categories: [...new Set(f.programs.map((p) => p.category))],
    programCount: f.programs.length,
    secImported: secSlugs.has(f.slug),
    tokens: brandTokens(f.name),
    keys: brandKeys(f.name),
  }));

  // Sponsors are ranked so the best-known row wins a tie: a firm students can
  // actually apply to beats a legal entity with the same brand.
  const sponsorScore = (r: Row) =>
    (r.hasVerifiedProgram ? 1000 : 0) +
    (r.secImported ? 0 : 500) +
    r.programCount * 20 +
    r.categories.length * 10 -
    r.tokens.length;

  /** Deterministic "which of these two is the real brand row". */
  const outranks = (a: Row, b: Row) => {
    const d = sponsorScore(a) - sponsorScore(b);
    return d !== 0 ? d > 0 : a.slug < b.slug;
  };

  // A brand of one short token ("apex", "one") collides with everything, so a
  // sponsor needs either two tokens or one long distinctive one - and at least
  // one token that names the firm rather than its line of business.
  const distinctive = (t: string[]) => t.filter((x) => !GENERIC.has(x));
  const eligible = rows.filter(
    (r) =>
      !vehicleReason(r.name) &&
      (r.tokens.length >= 2 || r.tokens[0]?.length >= 8) &&
      distinctive(r.tokens).length > 0,
  );

  // Indexed under the first token of every spelling, so a sponsor is findable
  // whichever way the child firm wrote the brand.
  const byFirstToken = new Map<string, Row[]>();
  for (const r of eligible) {
    for (const k of r.keys) {
      const head = k[0];
      if (!head) continue;
      if (!byFirstToken.has(head)) byFirstToken.set(head, []);
      const bucket = byFirstToken.get(head)!;
      if (!bucket.includes(r)) bucket.push(r);
    }
  }

  const parentOf = new Map<string, { parent: Row; confidence: string; reason: string }>();

  // Two ways to be the same firm. A longer name extending a brand
  // ("Morgan Stanley Distribution" under "Morgan Stanley"), and the same brand
  // spelled two ways - "JPMorgan" and "J.P. Morgan" are equal-length token
  // lists, so neither is a prefix of the other and the richer row has to win on
  // rank instead. That second case is why the directory still showed two
  // separate JPMorgan rows after the first pass.
  const matches = (parent: Row, child: Row) =>
    parent.keys.some((pk) =>
      child.keys.some(
        (ck) => isTokenPrefix(pk, ck) || (sameBrand(pk, ck) && outranks(parent, child)),
      ),
    );

  for (const r of rows) {
    if (MANUAL_EXCLUSIONS.has(r.slug)) continue;
    const pool = new Set<Row>();
    for (const k of r.keys) for (const c of byFirstToken.get(k[0]) ?? []) pool.add(c);
    const candidates = [...pool].filter((c) => c.slug !== r.slug && matches(c, r));
    if (!candidates.length) continue;
    // Longest matching brand wins: "Morgan Stanley Investment Management" should
    // attach to "Morgan Stanley", not to a hypothetical "Morgan".
    candidates.sort((a, b) => b.tokens.length - a.tokens.length || sponsorScore(b) - sponsorScore(a));
    const parent = candidates[0];
    // A single-word brand only absorbs others if we curated it. This is the
    // rule that keeps "Integral Corporation" - an SEC row whose name happens to
    // start with a common word - from swallowing five unrelated firms.
    const thinBrand = distinctive(parent.tokens).length < 2;
    if (thinBrand && parent.secImported && !vehicleReason(r.name)) continue;
    if (isDistinctBankCharter(parent, r)) continue;
    const vehicle = vehicleReason(r.name);
    // A one-word sponsor ("Benchmark", "Integral") is the shakiest kind of
    // match - plenty of unrelated firms open with the same word - so it is
    // called out for review rather than mixed in with the confident ones.
    const thin = thinBrand;
    parentOf.set(r.slug, {
      parent,
      confidence: vehicle ? "high" : thin ? "low" : "medium",
      reason: vehicle
        ? `${vehicle} of ${parent.name}`
        : `brand extension of ${parent.name}${thin ? " (single-word brand - verify)" : ""}`,
    });
  }

  // Collapse chains so a grandchild lands on the ultimate brand.
  const rootOf = (slug: string): string => {
    const seen = new Set<string>();
    let cur = slug;
    while (parentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur)!.parent.slug;
    }
    return cur;
  };

  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const clusters = new Map<string, string[]>();
  for (const r of rows) {
    const root = rootOf(r.slug);
    if (root === r.slug) continue;
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(r.slug);
  }

  const proposals = [...clusters.entries()]
    .map(([rootSlug, memberSlugs]) => {
      const root = bySlug.get(rootSlug)!;
      const members = memberSlugs.map((s) => bySlug.get(s)!);
      const all = [root, ...members];
      const confidences = memberSlugs.map((s) => parentOf.get(s)!.confidence);
      return {
        canonicalName: root.name,
        canonicalSlug: rootSlug,
        // Summed across the entities that make up the firm, so the headline
        // reflects everything the brand runs rather than whichever single
        // filing happened to be largest.
        //
        // The caveat, since it is invisible in the number: entities that report
        // assets their parent ALSO reports - feeder funds, share classes, a
        // distributor of the same funds - get counted twice, so some merged
        // firms read high. Null only when no entity in the cluster reported
        // anything, which is a real category: pure advisory shops file no ADV.
        headlineAum: all.reduce<number | null>(
          (sum, r) => (r.aum == null ? sum : (sum ?? 0) + r.aum),
          null,
        ),
        // Union, so a merged firm still appears under every sector it recruits
        // for - the whole point of keeping Goldman in both IB and PE.
        categories: [...new Set(all.flatMap((r) => r.categories))].sort(),
        confidence: confidences.every((c) => c === "high")
          ? "high"
          : confidences.some((c) => c === "low")
            ? "low"
            : "medium",
        divisions: members.map((m) => ({
          slug: m.slug,
          name: m.name,
          headquarters: m.headquarters,
          aum: m.aum,
          categories: m.categories,
          confidence: parentOf.get(m.slug)!.confidence,
          reason: parentOf.get(m.slug)!.reason,
        })),
      };
    })
    .sort((a, b) => b.divisions.length - a.divisions.length || a.canonicalName.localeCompare(b.canonicalName));

  writeFileSync("./firm-merges.json", JSON.stringify(proposals, null, 2));

  const absorbed = proposals.reduce((n, p) => n + p.divisions.length, 0);
  const tier = (t: string) => proposals.filter((p) => p.confidence === t).length;
  const high = tier("high");
  console.log(`firms in directory:      ${rows.length}`);
  console.log(
    `clusters proposed:       ${proposals.length}  (high ${high} / medium ${tier("medium")} / low ${tier("low")})`,
  );
  console.log(`rows absorbed:           ${absorbed}`);
  console.log(`directory after merge:   ${rows.length - absorbed}`);
  console.log(`\nwrote ./firm-merges.json\n`);
  console.log("largest clusters:");
  for (const p of proposals.slice(0, 15)) {
    console.log(`  ${p.canonicalName}  (+${p.divisions.length}, ${p.confidence})`);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
