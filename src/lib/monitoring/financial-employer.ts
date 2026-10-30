import "server-only";
import bulkFirmRows from "../firm-seeds-bulk.json";

/**
 * Is this employer a financial institution?
 *
 * WHY A PORTFOLIO BOARD NEEDS THIS AND NOTHING ELSE DOES
 * ------------------------------------------------------
 * Every other connector polls one employer's own board, so the employer is
 * whichever firm the source belongs to and the question never arises. A Getro
 * board is a venture fund's whole PORTFOLIO - HV Capital's carries 2,420 open
 * roles across 36 companies - and those companies are whatever the fund
 * happened to back. Measured on that board, the internship-filtered results
 * were largely German student warehouse and retail shifts.
 *
 * The product decision (19 September 2026) is that portfolio companies are in
 * scope only when they are themselves financial institutions. A fintech's
 * analyst internship is a finance internship; a logistics startup's warehouse
 * shift is not, however venture-backed the logistics startup is.
 *
 * TWO TESTS, THE FIRST MUCH BETTER THAN THE SECOND
 * ------------------------------------------------
 * 1. WHAT DOES THE FUND TAG IT AS? Getro carries `industry_tags` per
 *    portfolio company - the fund's own categorisation. This is the only
 *    test that identifies a fintech with an invented name, and nothing about
 *    the strings "Qonto" or "Upvest" says bank.
 *
 * 2. IS IT IN OUR OWN DIRECTORY? 22,575 rows of financial firms, already the
 *    definition of what this product covers. Weaker in practice than it
 *    sounds: those rows carry Form ADV LEGAL ENTITY names - "Blackstone
 *    Isg-i Advisors L.L.C.", not "Blackstone" - so an exact match fires only
 *    when a board uses the legal name. Certain when it fires, and rare.
 *
 * 3. DOES ITS NAME SAY SO? Only as a last fallback, and only on PHRASES rather
 *    than words. "Capital" alone is in half the startup names ever
 *    registered; "capital management" is not. This deliberately errs toward
 *    rejecting: a missed fintech costs one listing, while a loose rule
 *    reintroduces exactly the portfolio noise the filter exists to remove.
 */

type BulkFirmRow = { name: string; website: string | null };

/** Punctuation, casing and legal suffixes removed, so "Acme Capital, LLC" and
 *  "Acme Capital" are one name. */
export function normalizeEmployerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    /**
     * Dotted legal suffixes, collapsed BEFORE the word-level strip below.
     *
     * Removing punctuation first turns "L.L.C." into "l l c", which no longer
     * matches `\bllc\b` - so "Acme Capital L.L.C." and "Acme Capital"
     * normalised to different names and would never match each other. Not a
     * hypothetical form: the directory carries "Blackstone Isg-i Advisors
     * L.L.C." exactly like that.
     *
     * Anchored at the END of the name, because that is where a legal suffix
     * lives. Mid-name initials ("J P Morgan") are somebody's name, not a
     * suffix, and must survive.
     */
    .replace(/\b(l l c|l l p|l p|p l c|s a r l|b v|n v|s a|p c)\s*$/g, " ")
    .replace(
      /\b(llc|llp|lp|inc|ltd|plc|corp|corporation|company|co|gmbh|sarl|bv|nv|ag|sa|pte|pty|holdings?|group)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Built once. 22,575 rows is trivial to hold and the alternative is a
 *  linear scan per listing per check. */
let directoryNames: Set<string> | null = null;
function directory(): Set<string> {
  if (!directoryNames) {
    directoryNames = new Set(
      (bulkFirmRows as BulkFirmRow[])
        .map((row) => normalizeEmployerName(row.name))
        .filter((name) => name.length >= 4),
    );
  }
  return directoryNames;
}

/**
 * Phrases that identify a financial institution on their own.
 *
 * Phrases, never bare words. The single-word version of this list was the
 * first thing tried and it accepts "Bolt Capital", "Northern Trust Logistics"
 * and anything with "partners" in it - which is most of the venture universe.
 */
const FINANCIAL_PHRASES = [
  "asset management",
  "investment management",
  "capital management",
  "wealth management",
  "investment bank",
  "merchant bank",
  "private equity",
  "venture capital",
  "private credit",
  "hedge fund",
  "asset manager",
  "securities",
  "brokerage",
  "broker dealer",
  "investment advisors",
  "investment advisers",
  "financial services",
  "financial group",
  "capital markets",
  "credit union",
  "insurance",
  "reinsurance",
  "bancorp",
  "bancshares",
  "savings bank",
  "national bank",
  "trust company",
  "fintech",
  "payments",
  "neobank",
  "mortgage",
  "lending",
  "exchange group",
  "clearing house",
];

/** Words that make a name financial when they stand as their own token -
 *  narrow on purpose. "Bank" as a whole word is a strong signal; "banking"
 *  inside "Open Banking Logistics" is not, which is why this is token-exact
 *  rather than a substring test. */
const FINANCIAL_TOKENS = new Set(["bank", "banque", "bancaria", "sparkasse", "asset", "securities"]);

/**
 * Industry tags that count as financial, matched EXACTLY.
 *
 * Exactly, because a substring test on "financial" also matches the tag
 * "Other Services (B2C Non-Financial)" - which is how a campervan rental and
 * a veterinary service were both classified as financial institutions on the
 * first run. A rule that reads a tag saying NOT financial as financial is
 * worse than no rule.
 */
const FINANCIAL_TAGS = new Set(
  [
    "finance",
    "financial services",
    "financial software",
    "financial management",
    "fintech",
    "banking",
    "investment banking",
    "investment services",
    "investment management",
    "asset management",
    "wealth management",
    "venture capital",
    "private equity",
    "hedge funds",
    "insurance",
    "insurtech",
    "health insurance",
    "payments",
    "lending",
    "credit",
    "trading",
    "capital markets",
    "cryptocurrency",
    "decentralized finance (defi)",
    "blockchain and cryptocurrency",
    "other financial services",
    "accounting",
  ].map((t) => t.toLowerCase()),
);

/**
 * How many financial tags make an employer a financial institution.
 *
 * Two, not one, and the difference is measured rather than chosen. On HV
 * Capital's board a single tag admits Holidu - a holiday rentals marketplace
 * carrying "Venture Capital" because it is venture BACKED - and Finn, a car
 * subscription service carrying "Financial Services" because it does leasing.
 * Every real financial institution on that board carried at least two:
 * Scalable Capital 2 of 3, Upvest 4, Qonto 5, HV Capital 3 of 3.
 */
const MIN_FINANCIAL_TAGS = 2;

export type EmployerVerdict =
  | { financial: true; because: string }
  | { financial: false; reason: string };

/**
 * `industryTags` is the best evidence available and is checked first.
 *
 * They come from the fund's own categorisation of its portfolio rather than
 * from us guessing at a name, and they are the only thing that identifies a
 * fintech with an invented name - nothing about the strings "Qonto" or
 * "Upvest" says bank, and both are.
 */
export function classifyEmployer(rawName: string, industryTags?: string[]): EmployerVerdict {
  const name = normalizeEmployerName(rawName);
  if (!name) return { financial: false, reason: "no employer name" };

  if (industryTags?.length) {
    const matched = industryTags.filter((tag) => FINANCIAL_TAGS.has(tag.trim().toLowerCase()));
    if (matched.length >= MIN_FINANCIAL_TAGS) {
      return { financial: true, because: `industry tags: ${matched.slice(0, 3).join(", ")}` };
    }
    // One stray financial tag on an otherwise unrelated company is not
    // evidence - it usually means "venture backed" or "we offer financing".
    if (matched.length === 1 && industryTags.length > 4) {
      return {
        financial: false,
        reason: `only one financial tag ("${matched[0]}") among ${industryTags.length} - venture-backed or offers financing, not a financial institution`,
      };
    }
  }

  if (directory().has(name)) {
    return { financial: true, because: "in the firm directory" };
  }

  for (const phrase of FINANCIAL_PHRASES) {
    if (name.includes(phrase)) {
      return { financial: true, because: `name contains "${phrase}"` };
    }
  }

  const tokens = name.split(" ");
  for (const token of tokens) {
    if (FINANCIAL_TOKENS.has(token)) {
      return { financial: true, because: `name includes the word "${token}"` };
    }
  }

  return {
    financial: false,
    reason: "not in the firm directory and its name does not identify a financial institution",
  };
}

export function isFinancialEmployer(rawName: string, industryTags?: string[]): boolean {
  return classifyEmployer(rawName, industryTags).financial;
}
