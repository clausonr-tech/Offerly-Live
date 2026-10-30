// Real estate firms the directory is missing, proposed from SEC filings.
//
// The gap: 487 real estate firms, 13 with a careers URL - the thinnest
// category in the directory that anyone actually wants covered.
//
// WHERE THESE COME FROM
// ---------------------
// Form ADV. Real estate private equity and REIT advisers register as
// investment advisers, so they are in the same feed that already sized 79% of
// the existing real estate rows. No scraping, no paid list, and every row
// carries a headcount and an AUM from the firm's own filing.
//
// WHAT IT WILL NOT REACH
// ----------------------
// Private brokerages and property managers, which do not file Form ADV at
// all. Public REITs are reachable separately through EDGAR's SIC codes and
// are not included here, because EDGAR gives no website and a firm with no
// website cannot be probed, crawled or enrolled - it would be a directory row
// that looks like coverage and is not.
//
// WHY THE DOMAIN IS VERIFIED AGAINST THE NAME
// -------------------------------------------
// Form ADV Item 1.I collects "website addresses", and filers list podcasts,
// investor portals and affiliates alongside their own site. Measured on this
// feed: Blackstone Real Estate Advisors lists blackstone.podbean.com, FS REIT
// Advisor lists open.spotify.com, DivcoWest lists yaleusa.com.
//
// For SIZING that does not matter - a wrong domain simply fails to match a
// directory row and the firm goes unsized. For ADDING a firm it matters
// completely: the domain becomes the row's website, which is what discovery
// probes and what the crawler fetches. So a proposed row must have a domain
// that agrees with the firm's own name, or it is not proposed.
//
//   npx tsx --conditions=react-server scripts/propose-real-estate-firms.ts
//
// Reads two JSON files, writes one. No network, no database.
import { writeFileSync, readFileSync } from "fs";
import bulkFirmRows from "../src/lib/firm-seeds-bulk.json";

const ADV_PATH = "scripts/data/form-adv-firms.json";
const OUT = "scripts/data/proposed-real-estate-firms.json";

type AdvFirm = {
  crd: string | null;
  name: string;
  domain: string | null;
  state: string | null;
  employees: number | null;
  aum: number | null;
};

/** Names that identify a real estate manager. Phrases, because "property" and
 *  "capital" on their own are in half the directory. */
const REAL_ESTATE = /\b(real\s*estate|realty|reit|properties|multifamily|self\s*storage|industrial\s*properties)\b/i;

/** The size floors from enrollment.ts. A firm below both is one nobody will
 *  ever crawl, so proposing it adds a row and no coverage. */
const EMPLOYEE_FLOOR = 50;
const AUM_FLOOR = 1_000_000_000;

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 4 &&
        // Words shared by half the filings identify nobody.
        !["real", "estate", "realty", "fund", "funds", "advisors", "advisers", "management",
          "capital", "partners", "group", "company", "holdings", "investment", "investments",
          "llc", "lp", "inc", "trust", "properties", "property"].includes(word),
    );
}

/**
 * Does this domain plausibly belong to this firm?
 *
 * True when a distinctive word from the name appears in the domain. "BAIN
 * CAPITAL REAL ESTATE, LP" -> baincapitalrealestate.com passes on "bain";
 * "FS REIT ADVISOR, LLC" -> open.spotify.com has nothing in common and fails.
 *
 * Deliberately strict. A firm proposed with the wrong website is worse than a
 * firm not proposed: the row looks like coverage, gets probed, gets crawled,
 * and reports on somebody else.
 */
export function domainAgreesWithName(name: string, domain: string): boolean {
  const host = domain.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = tokens(name);
  if (!words.length) return false;
  return words.some((word) => host.includes(word));
}

function main() {
  const adv = (JSON.parse(readFileSync(ADV_PATH, "utf8")) as { firms: AdvFirm[] }).firms;
  const directory = bulkFirmRows as { name: string; website: string | null; category: string }[];

  const domainOf = (raw: string | null) => {
    if (!raw) return null;
    try {
      return new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`).hostname
        .toLowerCase()
        .replace(/^www\./, "");
    } catch {
      return null;
    }
  };

  const known = new Set(directory.map((row) => domainOf(row.website)).filter(Boolean) as string[]);

  const candidates = adv.filter((firm) => {
    if (!REAL_ESTATE.test(firm.name)) return false;
    if (!firm.domain || known.has(firm.domain)) return false;
    if (!domainAgreesWithName(firm.name, firm.domain)) return false;
    return (firm.employees ?? 0) >= EMPLOYEE_FLOOR || (firm.aum ?? 0) >= AUM_FLOOR;
  });

  // One row per domain - affiliates file separately ("... Real Estate
  // Advisors L.P." and "... Real Estate Special Situations") and share a site.
  const byDomain = new Map<string, AdvFirm>();
  for (const firm of candidates) {
    const existing = byDomain.get(firm.domain!);
    if (!existing || (firm.aum ?? 0) > (existing.aum ?? 0)) byDomain.set(firm.domain!, firm);
  }

  const proposed = [...byDomain.values()].sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0));

  const rejectedForDomain = adv.filter(
    (f) =>
      REAL_ESTATE.test(f.name) &&
      f.domain &&
      !known.has(f.domain) &&
      !domainAgreesWithName(f.name, f.domain),
  ).length;

  console.log(`${proposed.length} real estate firms proposed (one per domain).`);
  console.log(
    `${rejectedForDomain} more were found but rejected: their filed website does not agree with ` +
      "their name, so we cannot say it is theirs.\n",
  );

  for (const firm of proposed.slice(0, 25)) {
    console.log(
      `  ${String(firm.employees ?? "?").padStart(5)} staff  ` +
        `$${String(Math.round((firm.aum ?? 0) / 1e9)).padStart(4)}B  ` +
        `${firm.name.slice(0, 44).padEnd(44)} ${firm.domain}`,
    );
  }
  if (proposed.length > 25) console.log(`  ... and ${proposed.length - 25} more`);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "SEC Form ADV Part 1A",
        category: "real_estate",
        note: "Domains verified against firm names. Private brokerages do not file ADV and are absent.",
        firms: proposed.map((f) => ({
          name: f.name,
          website: `https://${f.domain}`,
          category: "real_estate",
          crd: f.crd,
          state: f.state,
          employees: f.employees,
          aum: f.aum,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwritten to ${OUT}`);
}

main();
