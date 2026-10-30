// Matching a student's coverage-group interest against a posting.
//
// "Industrials", "Healthcare", "TMT" are not sectors - the sector enum is
// investment_banking, private_equity and so on, and for a banking candidate
// that column matches practically every posting we crawl. The thing that
// actually narrows a banking student's list is their COVERAGE GROUP, which
// onboarding stores in users.nicheInterests as labels like "Industrials
// Coverage" or "Healthcare Coverage".
//
// That preference was captured and then only ever used as a soft ranking
// nudge, so a student who said "industrials" still had every sector's roles
// auto-tracked and listed.

/**
 * The keyword to look for in a role title, from an onboarding label.
 *
 *   "Industrials Coverage"              -> "industrials"
 *   "Equity Capital Markets (ECM)"      -> "equity capital markets"
 *   "Media & Telecom"                   -> "media & telecom"
 *
 * The trailing "Coverage"/"Group" has to come off: no firm titles a role
 * "Healthcare Coverage Summer Analyst", they title it "Healthcare Summer
 * Analyst", so matching the full label finds nothing - which is why the
 * existing ranking hint almost never fired.
 */
export function coverageKeyword(label: string): string {
  return label
    .split("(")[0]
    .replace(/\b(coverage|group|team)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Does this posting belong to one of the student's coverage groups?
 *
 * Checked against the role title and division only, never the full
 * description: a banking job description name-checks half a dozen industries
 * in its boilerplate ("our clients span healthcare, industrials, technology"),
 * so matching on description would make every posting match every interest and
 * quietly turn the filter back off.
 */
export function matchesCoverage(
  posting: { roleTitle: string; division?: string | null; categories?: string[] | null },
  nicheInterests: string[] | null | undefined,
): boolean {
  const wanted = interestGroups(nicheInterests);
  if (wanted.length === 0) return true; // no stated preference - nothing to narrow by

  // Compared as GROUPS, through the same classifier that labels the posting -
  // never as raw substrings of the onboarding label.
  //
  // Substring matching is what made this filter silently do nothing: the
  // student's interest reads "Healthcare Coverage", and the Moelis role that
  // genuinely is healthcare is titled "... Summer Associate - Life Sciences -
  // New York". The literal word "healthcare" appears nowhere in it, so nothing
  // matched, and a filter that matches nothing looks exactly like a filter
  // that is switched off.
  return wanted.includes(industryGroupOf(posting));
}

/** The student's coverage interests, as canonical group labels. */
export function interestGroups(nicheInterests: string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const label of nicheInterests ?? []) {
    const hit = GROUP_PATTERNS.find((g) => g.re.test(label));
    if (hit) out.add(hit.label);
  }
  // TMT is technology, media and telecom. The classifier labels a posting by
  // what its title names, and most say "Technology" or "Media" rather than
  // "TMT" - so a TMT student matched only the few titled TMT, and missed the
  // media and telecom roles onboarding no longer offers as a separate group.
  if (out.has("TMT")) for (const g of TMT_GROUPS) out.add(g);
  return [...out];
}

/**
 * The coverage groups a role title names, as short labels.
 *
 * Ordered most specific first so "Financial Institutions" is not reported as
 * "Technology" because the description happens to say fintech, and so the
 * two-word groups win over their own substrings.
 */
const TMT_GROUPS = ["Technology", "Media & Telecom"] as const;

const GROUP_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "Healthcare", re: /\b(healthcare|health care|life sciences|biotech|pharma|medtech)\b/i },
  { label: "Industrials", re: /\b(industrials?|manufacturing|aerospace|transport(ation)?|chemicals)\b/i },
  { label: "Technology", re: /\b(technology|tech|software|semiconductor|digital infrastructure|internet)\b/i },
  { label: "TMT", re: /\btmt\b/i },
  { label: "Media & Telecom", re: /\b(media|telecom(munications)?|entertainment)\b/i },
  { label: "Financial Institutions", re: /\b(fig|financial institutions?|insurance)\b/i },
  { label: "Energy & Power", re: /\b(energy|power|oil\s*&?\s*gas|utilities|renewables|energy transition)\b/i },
  { label: "Consumer & Retail", re: /\b(consumer|retail|food\s*&?\s*beverage|leisure)\b/i },
  { label: "Real Estate", re: /\b(real estate|reit|lodging|gaming)\b/i },
  { label: "Infrastructure", re: /\binfrastructure\b/i },
  { label: "Natural Resources", re: /\b(natural resources|mining|metals)\b/i },
  { label: "Restructuring", re: /\b(restructuring|distressed|special situations|liability management)\b/i },
  { label: "M&A", re: /\b(m&a|mergers?( and | & )acquisitions?|strategic advisory)\b/i },
  { label: "Leveraged Finance", re: /\b(leveraged finance|levfin|private credit|direct lending)\b/i },
  { label: "Capital Markets", re: /\b(ecm|dcm|equity capital markets|debt capital markets|capital markets)\b/i },
  { label: "Private Capital", re: /\b(private capital|secondaries|park hill|fund placement)\b/i },
  { label: "Equity Research", re: /\b(equity research|research)\b/i },
  { label: "Sales & Trading", re: /\b(sales\s*&?\s*trading|global markets|markets)\b/i },
  { label: "Public Finance", re: /\bpublic finance\b/i },
  { label: "Wealth Management", re: /\b(wealth management|private bank|private wealth)\b/i },
];

/** Fallback labels for the broad sector column, when the title names no group. */
const SECTOR_LABELS: Record<string, string> = {
  investment_banking: "Investment Banking",
  private_equity: "Private Equity",
  venture_capital: "Venture Capital",
  private_credit: "Private Credit",
  real_estate: "Real Estate",
  hedge_fund: "Hedge Fund",
  sales_trading: "Sales & Trading",
  asset_wealth_management: "Asset & Wealth Management",
  commercial_banking: "Commercial Banking",
  insurance: "Insurance",
  fintech: "Fintech",
  market_infrastructure: "Market Infrastructure",
  consulting: "Consulting",
  other_finance: "Finance",
};

/**
 * Does this posting name a coverage group at all?
 *
 * The distinction industryGroupOf cannot express, because it always returns a
 * label: "Healthcare Summer Analyst" states its group, while "Investment
 * Banking Summer Analyst" does not and only gets the sector name back as a
 * stand-in. Those are opposite situations for a student with a stated
 * interest. A role in a group that is not theirs is a role they did not ask
 * for; a role in NO group is the generalist programme nearly every bulge
 * bracket runs, where coverage is assigned after the offer - so a healthcare
 * student applies to it precisely to get into healthcare.
 */
export function namesCoverageGroup(posting: {
  roleTitle: string;
  division?: string | null;
}): boolean {
  const hay = `${posting.roleTitle} ${posting.division ?? ""}`;
  return GROUP_PATTERNS.some((g) => g.re.test(hay));
}

/**
 * A short industry-group label for a posting, e.g. "Healthcare".
 *
 * Read from the role title and division, because that is the only place the
 * group is actually stated - the sector column is `investment_banking` for
 * nearly everything here and says nothing a banking student doesn't know.
 * Falls back to the sector label when the title names no group, which is the
 * common case for bulge brackets: they post one generic "Investment Banking -
 * Summer Analyst" and assign coverage after the offer.
 */
export function industryGroupOf(posting: {
  roleTitle: string;
  division?: string | null;
  categories?: string[] | null;
}): string {
  const hay = `${posting.roleTitle} ${posting.division ?? ""}`;
  const hit = GROUP_PATTERNS.find((g) => g.re.test(hay));
  if (hit) return hit.label;
  const sector = posting.categories?.[0];
  return (sector && SECTOR_LABELS[sector]) || "Finance";
}
