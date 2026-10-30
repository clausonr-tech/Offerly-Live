// Add proposed firms to the bulk directory, in the shape the rest of the app
// already expects.
//
// Kept separate from the script that PROPOSES them, on the same principle as
// discover-boards.ts and apply-discovered-boards.ts: finding candidates is a
// measurement, and editing seed data is a write that somebody should have to
// ask for. `npm run db:sync-firms` reconciles the firms table against this
// file, and with --prune-orphans deletes firm rows a careless edit here left
// behind (only those nothing else references).
//
//   npx tsx --conditions=react-server scripts/merge-proposed-firms.ts --in scripts/data/proposed-real-estate-firms.json
//   ... --apply
//
// No network, no database - it rewrites src/lib/firm-seeds-bulk.json.
import { readFileSync, writeFileSync, copyFileSync } from "fs";

const SEEDS = "src/lib/firm-seeds-bulk.json";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const IN = arg("in") ?? "scripts/data/proposed-real-estate-firms.json";
const APPLY = process.argv.includes("--apply");

type SeedRow = {
  slug: string;
  name: string;
  headquarters: string;
  keyOffices: string;
  website: string;
  description: string;
  hasVerifiedStudentProgram: boolean;
  category: string;
  roleLabel: string;
  timingKey: string;
  careersUrl: string;
  recruitingChannelLabel: string;
  recruitingChannelUrl: string;
};

type Proposed = {
  name: string;
  website: string;
  category: string;
  crd: string | null;
  state: string | null;
  employees: number | null;
  aum: number | null;
};

/**
 * The registrable domain, roughly: the last two labels.
 *
 * Needed because a firm's filed "website" is often a SUBDOMAIN of a parent
 * already in the directory - Apollo Real Estate Fund Adviser files
 * ir.apollo.com (Apollo's investor relations site) and Sound Point Commercial
 * Real Estate files cre.soundpointcap.com. Added as new firms these would be
 * a second row for a company we already track, pointed at a page that is not
 * a careers page.
 *
 * Deliberately approximate - it treats "co.uk" style suffixes as two labels
 * and so keeps one label too few for those. That errs toward SKIPPING a
 * proposal, which is the safe direction for a script that edits seed data.
 */
function registrableDomain(host: string): string {
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/** Title case from the SHOUTED legal names Form ADV uses. "BAIN CAPITAL REAL
 *  ESTATE, LP" is what the SEC has; it is not what anyone should read. */
function presentableName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b([a-z])([a-z]*)/g, (_, first: string, rest: string) => first.toUpperCase() + rest)
    // Legal suffixes stay upper case, which is how firms write them.
    .replace(/\b(Llc|L\.l\.c\.|Lp|L\.p\.|Llp|Inc|Reit|Bx|Us|Ii|Iii)\b/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Per-category defaults that mirror the existing rows exactly - a new row
 *  that differs in shape from its neighbours breaks the directory pages that
 *  read these fields without anyone noticing which row did it. */
const CATEGORY_DEFAULTS: Record<string, { roleLabel: string; timingKey: string }> = {
  real_estate: { roleLabel: "Real estate investment", timingKey: "RE_INVESTING_TIMING" },
};

function main() {
  const proposal = JSON.parse(readFileSync(IN, "utf8")) as { firms: Proposed[]; source?: string };
  const seeds = JSON.parse(readFileSync(SEEDS, "utf8")) as SeedRow[];

  const bySlug = new Set(seeds.map((row) => row.slug));
  const byRegistrable = new Set<string>();
  const byDomain = new Set(
    seeds
      .map((row) => {
        try {
          return new URL(/^https?:/i.test(row.website) ? row.website : `https://${row.website}`)
            .hostname.toLowerCase()
            .replace(/^www\./, "");
        } catch {
          return null;
        }
      })
      .filter(Boolean) as string[],
  );
  for (const domain of byDomain) byRegistrable.add(registrableDomain(domain));

  const added: SeedRow[] = [];
  const skipped: string[] = [];

  for (const firm of proposal.firms) {
    const defaults = CATEGORY_DEFAULTS[firm.category];
    if (!defaults) {
      skipped.push(`${firm.name}: no defaults defined for category "${firm.category}"`);
      continue;
    }

    const name = presentableName(firm.name);
    const slug = slugify(name);
    const domain = firm.website.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

    if (bySlug.has(slug)) {
      skipped.push(`${name}: slug already in the directory`);
      continue;
    }
    if (byDomain.has(domain)) {
      skipped.push(`${name}: ${domain} already in the directory under another name`);
      continue;
    }
    if (byRegistrable.has(registrableDomain(domain))) {
      skipped.push(
        `${name}: ${domain} is a subdomain of ${registrableDomain(domain)}, already in the directory`,
      );
      continue;
    }

    const row: SeedRow = {
      slug,
      name,
      headquarters: firm.state ? `${firm.state}, United States` : "United States",
      keyOffices: firm.state ? `${firm.state}, United States` : "United States",
      website: domain,
      // Says where the row came from and what has NOT been checked, in the
      // same voice as the existing bulk rows.
      description:
        `Real estate investment. Listed from SEC Form ADV` +
        `${firm.crd ? ` (CRD ${firm.crd})` : ""}` +
        `${firm.employees ? `, ${firm.employees} employees` : ""}` +
        `${firm.aum ? `, $${Math.round(firm.aum / 1e9)}B regulatory AUM` : ""}` +
        `; recruiting pages not yet verified.`,
      hasVerifiedStudentProgram: false,
      category: firm.category,
      roleLabel: defaults.roleLabel,
      timingKey: defaults.timingKey,
      careersUrl: `https://${domain}`,
      recruitingChannelLabel: `${name} - Company site`,
      recruitingChannelUrl: `https://${domain}`,
    };

    added.push(row);
    bySlug.add(slug);
    byDomain.add(domain);
    byRegistrable.add(registrableDomain(domain));
  }

  console.log(`${added.length} firm(s) to add, ${skipped.length} skipped.\n`);
  for (const row of added) console.log(`  + ${row.name.padEnd(42)} ${row.website}`);
  if (skipped.length) {
    console.log("\nskipped:");
    for (const reason of skipped) console.log(`  - ${reason}`);
  }

  if (!APPLY) {
    console.log("\nDry run - pass --apply to write.");
    return;
  }

  // A backup before rewriting seed data, because the catalog sync reconciles
  // the firms table against this file and, when pruning, deletes firm rows.
  copyFileSync(SEEDS, `${SEEDS}.bak`);

  /**
   * APPENDED, not sorted, and written with the file's own indentation.
   *
   * The first version did `sort()` and `JSON.stringify(..., null, 2)`. Adding
   * five firms then produced a diff of +229,865 / -217,877 lines - the entire
   * file rewritten, because sorting moved every row and the indent went from
   * one space to two.
   *
   * That is not a cosmetic problem. A 450,000-line diff cannot be reviewed,
   * so the five real changes inside it are invisible, and `git blame` on any
   * of 22,575 rows now points at this commit instead of at whoever actually
   * wrote the row.
   */
  const merged = [...seeds, ...added];
  writeFileSync(SEEDS, JSON.stringify(merged, null, 1));
  console.log(`\nwrote ${merged.length} rows to ${SEEDS} (previous version at ${SEEDS}.bak)`);
}

main();
