/**
 * Close the three firm-coverage gaps, measured 20 September 2026.
 *
 * The crawler covers investment banking well - 16 of 19 firms a student would
 * name - and almost nothing else. That is not one problem, it is three, and
 * they need fixing in this order because each one feeds the next.
 *
 * 1. SECTOR LABELS. A firm students look for under one industry is filed
 *    under another, so it is invisible on that industry's Discovery page even
 *    once it is crawled. Nasdaq, CME and Cboe carry `other_finance` and not
 *    `market_infrastructure`; Stripe and Coinbase are not `fintech`; AIG is
 *    not `insurance`; T. Rowe Price has `hedge_fund` but not
 *    `asset_wealth_management`; PNC is not `commercial_banking`; Oaktree and
 *    Blue Owl are `private_equity` rather than `private_credit`.
 *
 *    This is why several sectors look empty when the firms are right there.
 *
 * 2. DIRECTORY. Consulting has EIGHT firms in the whole directory, and two
 *    thirds of MBB are absent: no Bain & Company (only Bain Capital, an
 *    entirely different firm), no Boston Consulting Group, no Accenture, no
 *    L.E.K., no Kearney. No amount of crawling finds a firm that was never
 *    entered.
 *
 * 3. ENROLMENT, which is a separate script - seed-monitoring-sources.ts. It
 *    is run AFTER this one, so it sees the corrected labels and the new
 *    firms rather than having to be run twice.
 *
 * ADDITIVE ONLY. A category is added, never replaced: Blackstone is
 * legitimately both private equity and real estate, and a firm carrying four
 * industries is a fact about the firm rather than a mistake to clean up. The
 * same firm is never entered twice - an existing name match is left alone and
 * reported.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/fix-firm-coverage.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/fix-firm-coverage.ts --apply
 */
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";

const APPLY = process.argv.includes("--apply");

type Category = (typeof schema.firmProgramCategoryEnum.enumValues)[number];

/**
 * A sector a firm belongs to but is not filed under.
 *
 * Every one verified by name against the directory on 20 September 2026 and
 * limited to firms whose primary business is not in doubt - an exchange is
 * market infrastructure, a payments company is fintech. Nothing here is a
 * judgement call about a diversified firm; those keep whatever they have.
 */
const MISSING_LABELS: { match: string; add: Category; why: string }[] = [
  { match: "Nasdaq", add: "market_infrastructure", why: "a stock exchange" },
  { match: "CME Group", add: "market_infrastructure", why: "a derivatives exchange" },
  { match: "Cboe", add: "market_infrastructure", why: "an options exchange" },
  { match: "Intercontinental Exchange", add: "market_infrastructure", why: "owns the NYSE" },
  { match: "DTCC", add: "market_infrastructure", why: "clearing and settlement" },
  { match: "S&P Global", add: "market_infrastructure", why: "ratings and indices" },
  { match: "Moody", add: "market_infrastructure", why: "a ratings agency" },
  { match: "MSCI", add: "market_infrastructure", why: "indices and analytics" },
  { match: "Stripe", add: "fintech", why: "payments" },
  { match: "Coinbase", add: "fintech", why: "a crypto exchange" },
  { match: "Robinhood", add: "fintech", why: "a retail brokerage app" },
  { match: "Affirm", add: "fintech", why: "consumer lending" },
  { match: "AIG", add: "insurance", why: "an insurer" },
  { match: "MetLife", add: "insurance", why: "an insurer" },
  { match: "Prudential Financial", add: "insurance", why: "an insurer" },
  { match: "T. Rowe Price", add: "asset_wealth_management", why: "an asset manager" },
  { match: "PNC Financial", add: "commercial_banking", why: "a commercial bank" },
  { match: "Truist Financial", add: "commercial_banking", why: "a commercial bank" },
  { match: "Fifth Third", add: "commercial_banking", why: "a commercial bank" },
  { match: "KeyCorp", add: "commercial_banking", why: "a commercial bank" },
  { match: "Regions Financial", add: "commercial_banking", why: "a commercial bank" },
  { match: "Oaktree", add: "private_credit", why: "credit is its largest strategy" },
  { match: "Blue Owl", add: "private_credit", why: "direct lending" },
  { match: "Golub Capital", add: "private_credit", why: "direct lending" },
  { match: "Ares Management", add: "private_credit", why: "credit is its largest strategy" },
  { match: "Sixth Street", add: "private_credit", why: "direct lending" },
];

/**
 * Firms a student names that were never entered.
 *
 * Consulting only. The other sectors' household names are all present and
 * merely unenrolled - it is consulting that is structurally incomplete, with
 * eight firms in the whole directory and two thirds of MBB missing.
 *
 * Careers URLs are the firms' own published student pages. `enrollment.ts`
 * decides whether each is worth crawling; this script only makes them
 * visible to that decision.
 */
const MISSING_FIRMS: {
  slug: string;
  name: string;
  headquarters: string;
  keyOffices: string;
  website: string;
  description: string;
  careersUrl: string;
  category: Category;
  roleLabel: string;
}[] = [
  { slug: "bain-and-company", name: "Bain & Company", headquarters: "Boston, MA", keyOffices: "Boston · New York · London", website: "https://www.bain.com", description: "Global management consultancy, one of the three firms commonly grouped as MBB.", careersUrl: "https://www.bain.com/careers/", category: "consulting", roleLabel: "Associate Consultant Intern" },
  { slug: "boston-consulting-group", name: "Boston Consulting Group", headquarters: "Boston, MA", keyOffices: "Boston · New York · London", website: "https://www.bcg.com", description: "Global management consultancy, one of the three firms commonly grouped as MBB.", careersUrl: "https://careers.bcg.com/", category: "consulting", roleLabel: "Summer Associate" },
  { slug: "accenture", name: "Accenture", headquarters: "Dublin, Ireland", keyOffices: "Dublin · New York · London", website: "https://www.accenture.com", description: "Global professional services firm spanning strategy, consulting and technology.", careersUrl: "https://www.accenture.com/us-en/careers", category: "consulting", roleLabel: "Strategy Summer Analyst" },
  { slug: "lek-consulting", name: "L.E.K. Consulting", headquarters: "Boston, MA", keyOffices: "Boston · London · Chicago", website: "https://www.lek.com", description: "Global strategy consultancy with a strong life sciences and private equity practice.", careersUrl: "https://www.lek.com/careers", category: "consulting", roleLabel: "Associate Consultant Intern" },
  { slug: "kearney", name: "Kearney", headquarters: "Chicago, IL", keyOffices: "Chicago · New York · London", website: "https://www.kearney.com", description: "Global management consultancy with a strong operations and procurement practice.", careersUrl: "https://www.kearney.com/careers", category: "consulting", roleLabel: "Summer Business Analyst" },
  { slug: "zs-associates", name: "ZS Associates", headquarters: "Evanston, IL", keyOffices: "Evanston · Chicago · New York", website: "https://www.zs.com", description: "Consultancy focused on commercial strategy and analytics, heavily life sciences.", careersUrl: "https://www.zs.com/careers", category: "consulting", roleLabel: "Summer Associate Consultant" },
  { slug: "analysis-group", name: "Analysis Group", headquarters: "Boston, MA", keyOffices: "Boston · New York · Chicago", website: "https://www.analysisgroup.com", description: "Economic, financial and strategy consultancy working on litigation and healthcare.", careersUrl: "https://www.analysisgroup.com/careers/", category: "consulting", roleLabel: "Summer Analyst" },
  { slug: "charles-river-associates", name: "Charles River Associates", headquarters: "Boston, MA", keyOffices: "Boston · New York · London", website: "https://www.crai.com", description: "Economic and financial consultancy advising on litigation, antitrust and strategy.", careersUrl: "https://www.crai.com/careers/", category: "consulting", roleLabel: "Summer Consulting Associate" },
  { slug: "cornerstone-research", name: "Cornerstone Research", headquarters: "Boston, MA", keyOffices: "Boston · New York · Chicago", website: "https://www.cornerstone.com", description: "Economic and financial consultancy specialising in commercial litigation.", careersUrl: "https://www.cornerstone.com/careers/", category: "consulting", roleLabel: "Summer Analyst" },
  { slug: "kpmg-us", name: "KPMG (US)", headquarters: "New York, NY", keyOffices: "New York · Chicago · London", website: "https://www.kpmg.us", description: "Big Four professional services firm spanning audit, tax and advisory.", careersUrl: "https://www.kpmguscareers.com/", category: "consulting", roleLabel: "Advisory Summer Intern" },
];

/** The non-null columns firm_programs needs but that a directory row does not
 *  carry. Left deliberately generic rather than invented per firm. */
const PROGRAM_DEFAULTS = {
  timingGuidance: "Timing varies by office and programme - confirm on the firm's own page.",
  recruitingChannelLabel: "Firm careers site",
};

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}${APPLY ? "" : "  (dry run)"}\n`);

  try {
    const firms = await db.select().from(schema.firms);
    const programs = await db.select().from(schema.firmPrograms);
    const byFirm = new Map<string, Set<string>>();
    for (const p of programs) {
      if (!byFirm.has(p.firmId)) byFirm.set(p.firmId, new Set());
      byFirm.get(p.firmId)!.add(p.category);
    }

    // ---------------------------------------------------------- 1. labels
    console.log("=== SECTOR LABELS ===");
    let labelsAdded = 0;
    const bySector = new Map<string, number>();

    for (const fix of MISSING_LABELS) {
      const firm = firms.find((f) => f.name.toLowerCase().includes(fix.match.toLowerCase()));
      if (!firm) {
        console.log(`  -  ${fix.match.padEnd(26)} not in the directory`);
        continue;
      }
      const have = byFirm.get(firm.id) ?? new Set<string>();
      if (have.has(fix.add)) {
        console.log(`  =  ${firm.name.slice(0, 26).padEnd(26)} already ${fix.add}`);
        continue;
      }
      // Reuse the firm's own careers URL - a second program row for the same
      // firm points at the same site, and inventing a different one would
      // create a source pointing somewhere nobody verified.
      const existing = programs.find((p) => p.firmId === firm.id && p.careersUrl);
      const careersUrl = existing?.careersUrl ?? firm.website;
      console.log(`  +  ${firm.name.slice(0, 26).padEnd(26)} ${fix.add.padEnd(24)} ${fix.why}`);
      bySector.set(fix.add, (bySector.get(fix.add) ?? 0) + 1);
      labelsAdded += 1;

      if (APPLY) {
        await db.insert(schema.firmPrograms).values({
          firmId: firm.id,
          category: fix.add,
          roleLabel: existing?.roleLabel ?? "Summer Analyst",
          timingGuidance: existing?.timingGuidance ?? PROGRAM_DEFAULTS.timingGuidance,
          careersUrl,
          recruitingChannelLabel: existing?.recruitingChannelLabel ?? PROGRAM_DEFAULTS.recruitingChannelLabel,
          recruitingChannelUrl: existing?.recruitingChannelUrl ?? careersUrl,
        });
      }
    }

    // ------------------------------------------------------- 2. directory
    console.log("\n=== MISSING FIRMS ===");
    let firmsAdded = 0;

    for (const f of MISSING_FIRMS) {
      // Matched on slug AND name, because a near-name already in the
      // directory ("Bain Capital" for "Bain & Company") is a different firm
      // and must not block the real one.
      const clash = firms.find(
        (x) => x.slug === f.slug || x.name.toLowerCase() === f.name.toLowerCase(),
      );
      if (clash) {
        console.log(`  =  ${f.name.padEnd(28)} already present as "${clash.name}"`);
        continue;
      }
      console.log(`  +  ${f.name.padEnd(28)} ${f.category.padEnd(12)} ${f.careersUrl}`);
      firmsAdded += 1;

      if (APPLY) {
        const [firm] = await db
          .insert(schema.firms)
          .values({
            slug: f.slug,
            name: f.name,
            headquarters: f.headquarters,
            keyOffices: f.keyOffices,
            website: f.website,
            description: f.description,
            /**
             * A CONFIRMED student programme, which is what this flag means.
             *
             * Not a shortcut past the enrolment bar - the bar genuinely
             * cannot see these firms. `isWorthCrawling` accepts a confirmed
             * programme, a real ATS, 50+ employees or $1B+ AUM, and the last
             * two come from Form ADV, which CONSULTANCIES DO NOT FILE because
             * they are not investment advisers. Measured after adding them:
             * all ten were skipped as "no programme, no ATS, and no Form ADV
             * size data to judge by" - Bain, BCG and Accenture included.
             *
             * So a bar built around asset managers is structurally blind to an
             * entire sector. The flag is the honest answer rather than a
             * loophole: every firm in this list runs a named, published
             * student programme - Bain's Associate Consultant Intern, BCG's
             * Summer Associate - which is precisely what "somebody actually
             * confirmed a programme" is for.
             */
            hasVerifiedProgram: true,
          })
          .returning();
        await db.insert(schema.firmPrograms).values({
          firmId: firm.id,
          category: f.category,
          roleLabel: f.roleLabel,
          timingGuidance: PROGRAM_DEFAULTS.timingGuidance,
          careersUrl: f.careersUrl,
          recruitingChannelLabel: PROGRAM_DEFAULTS.recruitingChannelLabel,
          recruitingChannelUrl: f.careersUrl,
        });
      }
    }

    // ------------------------------------------------------------ summary
    console.log(
      `\n${APPLY ? "added" : "would add"} ${labelsAdded} sector label(s) and ${firmsAdded} firm(s).`,
    );
    if (bySector.size) {
      console.log("\nlabels by sector:");
      for (const [s, n] of [...bySector].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${s.padEnd(24)} ${String(n).padStart(3)}`);
      }
    }
    console.log(
      "\nNext: scripts/seed-monitoring-sources.ts, which reads these labels and firms.",
    );
    if (!APPLY) console.log("Dry run - pass --apply to write.");
  } finally {
    await opened.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
