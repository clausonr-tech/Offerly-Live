/**
 * Resolve every school's exact search names ahead of time.
 *
 * Each school is otherwise resolved on its first student's first contact
 * search, which costs that student a few seconds. This does all of them up
 * front. Free: /company/identify bills nothing. Slow on purpose: up to nine
 * lookups a school, paced to stay under the provider's rate limit.
 *
 * Resumable. A school resolved in the last 90 days is skipped, and one whose
 * lookups were rate-limited is not saved, so running this again picks up
 * exactly what is left.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/resolve-school-search-names.ts [--limit N] [--pause-ms 1500] [--force]
 */
import { and, asc, isNull, lt, or } from "drizzle-orm";

import { getDb } from "../src/db/client";
import { schools } from "../src/db/schema";
import { businessSchoolNames } from "../src/lib/school-search-names";
import { resolveSchoolSearchNames } from "../src/lib/school-search-resolution";

const arg = (flag: string, fallback: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

async function main() {
  const limit = arg("--limit", Infinity);
  const pauseMs = arg("--pause-ms", 1500);
  const staleBefore = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const db = await getDb();
  const todo = await db
    .select({ id: schools.id, name: schools.name, emailDomain: schools.emailDomain })
    .from(schools)
    // --force redoes every school - after the resolution rule itself changes.
    .where(
      process.argv.includes("--force")
        ? undefined
        : or(isNull(schools.searchNamesCheckedAt), lt(schools.searchNamesCheckedAt, staleBefore)),
    )
    .orderBy(asc(schools.name));
  const batch = todo.slice(0, Number.isFinite(limit) ? limit : undefined);
  console.log(`${todo.length} schools need names; doing ${batch.length}, pausing ${pauseMs}ms between lookups`);

  let found = 0;
  let withBusiness = 0;
  let unsaved = 0;
  const savedSince = async (id: string, since: number) => {
    const saved = await db.query.schools.findFirst({
      where: (s, { eq }) => and(eq(s.id, id)),
      columns: { searchNamesCheckedAt: true },
    });
    return !!saved?.searchNamesCheckedAt && saved.searchNamesCheckedAt.getTime() >= since;
  };

  for (const [i, row] of batch.entries()) {
    // A lookup that failed is almost always the rate limit: back off and try
    // the same school again rather than leave it for another pass. Measured -
    // at a 700ms pace, 24 of the first 61 schools hit it.
    let names: string[] = [];
    let wasSaved = false;
    for (let attempt = 0; attempt < 3 && !wasSaved; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 60_000 * attempt));
      const t = Date.now();
      // A dropped connection (a laptop sleeping mid-sweep: EADDRNOTAVAIL) is
      // one school's problem, not the sweep's - it used to end the run 315
      // schools in. Wait, and try this school again.
      try {
        names = await resolveSchoolSearchNames(row, null, { pauseMs });
        wasSaved = await savedSince(row.id, t);
      } catch (err) {
        console.log(`  ${row.name}: ${(err as Error).message.split("\n")[0]} - retrying`);
      }
    }
    if (!wasSaved) unsaved++;
    if (names.length) found++;
    const business = businessSchoolNames(names);
    if (business.length) withBusiness++;
    console.log(
      `[${i + 1}/${batch.length}] ${row.name} (${row.emailDomain}): ${names.length} names` +
        (business.length ? `, business: ${business.slice(0, 2).join(" | ")}` : "") +
        (wasSaved ? "" : "  [NOT SAVED - lookup failed, rerun to retry]"),
    );
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  console.log(
    `DONE ${batch.length} schools: ${found} with names, ${withBusiness} with a business school, ${unsaved} not saved (rerun for those)`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
