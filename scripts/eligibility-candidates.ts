// Dump the sentences that might state who may apply, for listings whose
// eligibility came back blank.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/eligibility-candidates.ts [--limit N]
//
// WHY THIS EXISTS SEPARATELY FROM backfill-eligibility.ts
// ------------------------------------------------------
// That script hands each posting to a model and costs money per listing. This
// one costs nothing and does the part that does not need a model: finding
// WHERE in five thousand characters of firm boilerplate the eligibility
// sentence might be, and grouping listings that share one.
//
// The grouping matters more than it sounds. Kroll posts "Intern, Valuation
// Services" in seven cities with byte-identical copy, so reading the posting
// once and applying the answer to all seven is not a shortcut - it is the
// correct unit of work. Whatever reads the output, model or person, then faces
// distinct postings rather than duplicates.
//
// Output is grouped by description hash, with each group's candidate sentences
// and the listing ids that share them.
import { createHash } from "crypto";
import { getDb } from "../src/db/client";
import { detectedListings, firmMonitoringSources, firms } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import type { Classification } from "../src/lib/monitoring/classify";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? 500 : Number(process.argv[limitArg + 1]);

/**
 * Words that appear in a sentence stating who may apply.
 *
 * Deliberately generous. This decides what gets READ, not what gets believed,
 * so a false positive costs a sentence of attention and a false negative
 * costs the posting. "two years away from completing their undergraduate
 * degree" - the sentence the previous pass verified against - matches on
 * "degree" and "completing", neither of which is a year or a class.
 */
const ELIGIBILITY_HINT =
  /\b(graduat\w*|class of|rising|undergraduate|degree|enrolled|pursuing|matriculat\w*|sophomore|junior|senior|penultimate|final year|first year|second year|third year|freshman|MBA|master'?s|bachelor'?s|eligib\w*|must be|candidates? should|anticipated|expected)\b/i;

/** Sentences, roughly. Job descriptions are not prose and have no reliable
 *  punctuation, so bullets and newlines count as breaks too. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+|(?:\s[•·▪]\s)/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 25 && s.length <= 400);
}

async function main() {
  await assertExclusiveDbAccess();
  const db = await getDb();

  const rows = await db
    .select({
      id: detectedListings.id,
      title: detectedListings.title,
      desc: detectedListings.descriptionRaw,
      cls: detectedListings.classification,
      firm: firms.name,
    })
    .from(detectedListings)
    .innerJoin(firmMonitoringSources, eq(firmMonitoringSources.id, detectedListings.sourceId))
    .innerJoin(firms, eq(firms.id, firmMonitoringSources.firmId))
    .where(
      inArray(detectedListings.reviewStatus, ["auto_approved", "approved", "pending_review"]),
    );

  const blanks = rows.filter((r) => {
    const c = r.cls as Classification | null;
    return c?.relevant && !c.eligibility?.gradYears?.length;
  });

  // Group by the text itself, not by title: the same programme under two firm
  // rows, or in seven cities, is one posting to read.
  const groups = new Map<
    string,
    { hash: string; listings: { id: string; firm: string; title: string }[]; hits: string[]; cycle: number | null; descLen: number }
  >();

  for (const r of blanks) {
    const desc = r.desc ?? "";
    const c = r.cls as Classification;
    const hash = createHash("sha256").update(desc).digest("hex").slice(0, 12);
    if (!groups.has(hash)) {
      const hits = sentences(desc).filter((s) => ELIGIBILITY_HINT.test(s));
      groups.set(hash, {
        hash,
        listings: [],
        hits: [...new Set(hits)].slice(0, 6),
        cycle: c.recruitingCycle ?? null,
        descLen: desc.length,
      });
    }
    groups.get(hash)!.listings.push({ id: r.id, firm: r.firm, title: r.title });
  }

  const all = [...groups.values()];
  const withHits = all.filter((g) => g.hits.length > 0);
  const noHits = all.filter((g) => g.hits.length === 0);

  console.log(
    `${blanks.length} listing(s) with blank eligibility -> ${all.length} distinct description(s).\n` +
      `${withHits.length} have a sentence worth reading; ${noHits.length} have none.\n`,
  );

  for (const g of withHits.slice(0, limit)) {
    console.log("=".repeat(96));
    console.log(`hash ${g.hash}  cycle ${g.cycle ?? "?"}  ${g.listings.length} listing(s), ${g.descLen} chars`);
    for (const l of g.listings.slice(0, 4)) console.log(`   ${l.firm} · ${l.title.slice(0, 70)}`);
    if (g.listings.length > 4) console.log(`   ...and ${g.listings.length - 4} more`);
    console.log("   ---");
    for (const h of g.hits) console.log(`   > ${h}`);
  }

  console.log("\n" + "=".repeat(96));
  console.log(
    `${noHits.length} description(s) contain no eligibility-shaped sentence at all. ` +
      `Those are correct blanks: the posting does not say.`,
  );
  console.log(`  (${noHits.reduce((a, g) => a + g.listings.length, 0)} listings)`);
  process.exit(0);
}

main();
