// Seeds the `schools` allowlist - the table that decides which email domains
// count as proof of school affiliation. Idempotent: re-running updates the
// name for an existing domain rather than inserting a duplicate.
//
// Run against local dev (embedded PGlite in ./local-data):
//   npx tsx scripts/seed-schools.ts
// Run against a real database (production/staging):
//   DATABASE_URL=postgresql://... npx tsx scripts/seed-schools.ts
//
// Stop the dev server before running locally - PGlite is not safe for
// concurrent access from two processes.
//
// Adding a school is deliberately a code change rather than a UI action: the
// contents of this table are the trust boundary for school affiliation, so a
// new domain should get the same review as any other commit.
//
// The bulk of the list is generated rather than typed - see
// scripts/data/us-schools.json and the regenerate script beside it. Its source
// is IPEDS, the US Department of Education's own directory of institutions,
// which is public domain and authoritative for both the name and the web
// address. Nothing here is guessed: a domain nobody published is a domain
// nobody should be able to verify against.
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { readFileSync } from "fs";
import { join } from "path";

// Mirrors the driver switch in src/db/client.ts: DATABASE_URL set -> real
// Postgres over the network, unset -> the local PGlite directory. This does
// not reuse getDb() because that caches a singleton for the app's lifetime,
// where a one-shot script needs a handle it can close and exit on.
async function connect() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { createPostgresClient } = await import("../src/db/connection");
    const client = createPostgresClient(process.env.DATABASE_URL, { pooling: "as-configured", max: 10 }).sql;
    return { db: drizzle(client, { schema }), close: () => client.end() };
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(process.env.PGLITE_DATA_DIR || "./local-data/pglite");
  return { db: drizzle(client, { schema }), close: () => client.close() };
}

type School = { name: string; emailDomain: string };

// Hand-checked names, which WIN over the generated list below.
//
// Not a convenience - IPEDS names the row behind a domain after whichever
// institution happens to hold it, and for a handful of the schools that matter
// most here that is the wrong one: columbia.edu comes back as "Teachers
// College at Columbia University" and iu.edu as "Indiana University-
// Indianapolis". Several others are formatted for a data file rather than for
// a student reading a dropdown ("University of California-Berkeley",
// "Middlebury"). These 44 are the finance targets, so they are the ones worth
// correcting by hand.
//
// Only the registrable domain is needed - subdomains the school also issues
// from (seas.upenn.edu, wharton.upenn.edu, college.harvard.edu) match the
// parent automatically, so they don't need their own rows. Add a sub-domain
// row only when it should resolve to a *different* name than the parent.
const CURATED: School[] = [
  // ---- Ivy League ----
  { name: "University of Pennsylvania", emailDomain: "upenn.edu" },
  { name: "Harvard University", emailDomain: "harvard.edu" },
  { name: "Yale University", emailDomain: "yale.edu" },
  { name: "Princeton University", emailDomain: "princeton.edu" },
  { name: "Columbia University", emailDomain: "columbia.edu" },
  { name: "Brown University", emailDomain: "brown.edu" },
  { name: "Dartmouth College", emailDomain: "dartmouth.edu" },
  { name: "Cornell University", emailDomain: "cornell.edu" },

  // ---- Other common finance/consulting targets ----
  { name: "Massachusetts Institute of Technology", emailDomain: "mit.edu" },
  { name: "Stanford University", emailDomain: "stanford.edu" },
  { name: "University of Chicago", emailDomain: "uchicago.edu" },
  { name: "Duke University", emailDomain: "duke.edu" },
  { name: "Northwestern University", emailDomain: "northwestern.edu" },
  { name: "New York University", emailDomain: "nyu.edu" },
  { name: "Georgetown University", emailDomain: "georgetown.edu" },
  { name: "University of Virginia", emailDomain: "virginia.edu" },
  { name: "University of Michigan", emailDomain: "umich.edu" },
  { name: "University of California, Berkeley", emailDomain: "berkeley.edu" },
  { name: "University of California, Los Angeles", emailDomain: "ucla.edu" },
  { name: "Carnegie Mellon University", emailDomain: "cmu.edu" },
  { name: "Vanderbilt University", emailDomain: "vanderbilt.edu" },
  { name: "Washington University in St. Louis", emailDomain: "wustl.edu" },
  { name: "Emory University", emailDomain: "emory.edu" },
  { name: "University of Notre Dame", emailDomain: "nd.edu" },
  { name: "Boston College", emailDomain: "bc.edu" },
  { name: "Rice University", emailDomain: "rice.edu" },
  { name: "University of Texas at Austin", emailDomain: "utexas.edu" },
  { name: "University of North Carolina at Chapel Hill", emailDomain: "unc.edu" },
  { name: "Indiana University Bloomington", emailDomain: "iu.edu" },
  { name: "University of Southern California", emailDomain: "usc.edu" },
  { name: "Johns Hopkins University", emailDomain: "jhu.edu" },
  { name: "Tufts University", emailDomain: "tufts.edu" },
  { name: "University of Illinois Urbana-Champaign", emailDomain: "illinois.edu" },
  { name: "Ohio State University", emailDomain: "osu.edu" },
  { name: "Villanova University", emailDomain: "villanova.edu" },
  { name: "Lehigh University", emailDomain: "lehigh.edu" },
  { name: "Bucknell University", emailDomain: "bucknell.edu" },
  { name: "Babson College", emailDomain: "babson.edu" },
  { name: "Bentley University", emailDomain: "bentley.edu" },
  { name: "Fordham University", emailDomain: "fordham.edu" },
  { name: "Amherst College", emailDomain: "amherst.edu" },
  { name: "Williams College", emailDomain: "williams.edu" },
  { name: "Middlebury College", emailDomain: "middlebury.edu" },
  { name: "Claremont McKenna College", emailDomain: "cmc.edu" },

  // ---- Named by hand because IPEDS names them for the directory, not the
  // student. Baruch is a real feeder for this industry and reads as "CUNY
  // Bernard M Baruch College" in the source; the CUNY parent row, which is
  // what a bare @cuny.edu address falls back to, comes out as just "CUNY".
  { name: "Baruch College (CUNY)", emailDomain: "baruch.cuny.edu" },
  { name: "City University of New York", emailDomain: "cuny.edu" },
];

/**
 * Every US institution IPEDS lists as an active, degree-granting, four-year-or
 * -above school with a .edu address - 2,362 of them after collapsing campuses
 * that share one domain.
 *
 * Three filters shape it, and each one is a decision worth keeping:
 *
 *  - .edu ONLY. About 110 institutions publish a .com or .org address instead,
 *    and they are excluded deliberately. This table decides who is allowed to
 *    claim a school, and a .edu cannot be bought by someone who is not one; a
 *    .com can. That costs a small number of seminaries and specialist schools
 *    the ability to verify, which is the right side to err on for a trust
 *    boundary. They can be added by hand to CURATED after a look.
 *  - FOUR-YEAR AND ABOVE, because that is where the recruiting this product
 *    covers actually happens.
 *  - DEGREE-GRANTING, which drops the 53 rows that are system and central
 *    offices - "University of Alabama System Office" is a real .edu domain and
 *    not a school anyone attends.
 */
type GeneratedSchool = { name: string; emailDomain: string; state: string };

const GENERATED: GeneratedSchool[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "data", "us-schools.json"), "utf8"),
);

/** Curated names override generated ones on the same domain. */
function buildList(): School[] {
  const byDomain = new Map<string, School>();
  for (const s of GENERATED) {
    byDomain.set(s.emailDomain.toLowerCase(), { name: s.name, emailDomain: s.emailDomain.toLowerCase() });
  }
  for (const s of CURATED) {
    byDomain.set(s.emailDomain.toLowerCase(), { name: s.name, emailDomain: s.emailDomain.toLowerCase() });
  }
  return [...byDomain.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const { db, close } = await connect();
  const schools = buildList();

  console.log(
    process.env.DATABASE_URL
      ? "Seeding remote database from DATABASE_URL."
      : "Seeding local PGlite database in ./local-data/pglite.",
  );

  // Read the whole table once and diff in memory. The previous version issued
  // a SELECT per school, which was fine for 44 rows and is 2,362 round trips
  // on a single in-process connection now.
  const existing = await db.select().from(schema.schools);
  const byDomain = new Map(existing.map((s) => [s.emailDomain.toLowerCase(), s]));

  const toInsert: School[] = [];
  const toRename: { id: string; name: string }[] = [];
  for (const school of schools) {
    const found = byDomain.get(school.emailDomain);
    if (!found) toInsert.push(school);
    else if (found.name !== school.name) toRename.push({ id: found.id, name: school.name });
  }

  // Chunked because a single insert of a few thousand rows exceeds the
  // parameter limit on the postgres-js driver.
  const CHUNK = 250;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    await db.insert(schema.schools).values(toInsert.slice(i, i + CHUNK));
  }
  for (const r of toRename) {
    await db.update(schema.schools).set({ name: r.name }).where(eq(schema.schools.id, r.id));
  }

  console.log(
    `schools: ${toInsert.length} inserted, ${toRename.length} renamed, ${schools.length} total in seed list.`,
  );
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
