/**
 * Seed example clubs, with the sample students as their members.
 *
 *   npx tsx --env-file=.env.local scripts/seed-sample-clubs.ts
 *   npx tsx --env-file=.env.local scripts/seed-sample-clubs.ts --remove
 *
 * Run after seed-sample-peers.ts - members are the sample students at each
 * club's school. Names are generic ("Investment Banking Club at USC") rather
 * than real organizations' names, because a real club's page with an invented
 * member list would misrepresent that club. Every club is clubs.is_sample and
 * shows a "Sample" tag. Re-running replaces them; --remove deletes them
 * (memberships cascade).
 */

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { clubMembers, clubs, schools, users } from "@/db/schema";

type SeedClub = { domain: string | null; name: string; description: string };

const CLUBS: SeedClub[] = [
  { domain: "usc.edu", name: "Investment Banking Club at USC", description: "Weekly technical sessions, mock superdays and alumni panels for students recruiting into investment banking. Open to all majors and class years." },
  { domain: "usc.edu", name: "Women in Finance at USC", description: "A community for women pursuing careers in banking, markets and investing - mentorship pairings, firm treks and a resume review before every recruiting cycle." },
  { domain: "upenn.edu", name: "Private Equity Club at Penn", description: "Case studies, LBO modeling workshops and conversations with investors for students interested in private equity and growth investing." },
  { domain: "upenn.edu", name: "Investment Banking Club at Penn", description: "Recruiting prep for banking: a sophomore training program, technical drills and networking nights with analysts from bulge brackets and boutiques." },
  { domain: "nyu.edu", name: "Investment Banking Club at NYU", description: "Workshops on accounting, valuation and M&A, plus peer mock interviews and a shared recruiting calendar for the upcoming cycle." },
  { domain: "umich.edu", name: "Finance Club at Michigan", description: "Michigan's home for students exploring finance careers - speaker series, sector deep dives and a mentorship program run by upperclassmen." },
  { domain: "georgetown.edu", name: "Investment Club at Georgetown", description: "A student-run portfolio with sector teams that pitch long and short ideas every week, alongside recruiting support for markets and banking roles." },
  { domain: "virginia.edu", name: "Investment Banking Club at UVA", description: "Technical training, resume workshops and alumni networking for students preparing for investment banking recruiting." },
  { domain: "cornell.edu", name: "Private Equity Club at Cornell", description: "Deal case competitions, modeling bootcamps and fireside chats with investors across buyout, growth and venture." },
  { domain: "nd.edu", name: "Investment Banking Club at Notre Dame", description: "Mock interviews, technical study groups and treks to New York and Chicago for students recruiting into banking." },
  { domain: "utexas.edu", name: "Finance Association at UT Austin", description: "Programming for every finance path - banking, markets, restructuring and corporate finance - with a strong Texas and New York alumni network." },
  { domain: "columbia.edu", name: "Investment Banking Club at Columbia", description: "Recruiting prep for banking with weekly technicals, industry group spotlights and small-group coffee chats with alumni." },
  { domain: null, name: "Intercollegiate Restructuring Society", description: "A multi-school group for students interested in restructuring and special situations - monthly case discussions and a shared reading list." },
];

const OFFICERS = ["President", "Vice President", "Treasurer", "Head of Recruiting", "Director of Education"];

const slugify = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const remove = process.argv.includes("--remove");
  const db = await getDb();

  const removed = await db.delete(clubs).where(eq(clubs.isSample, true)).returning();
  console.log(`Removed ${removed.length} sample clubs.`);
  if (remove) return;

  const domains = CLUBS.map((c) => c.domain).filter((d): d is string => !!d);
  const schoolRows = await db
    .select({ id: schools.id, domain: schools.emailDomain })
    .from(schools)
    .where(inArray(schools.emailDomain, domains));
  const schoolId = new Map(schoolRows.map((s) => [s.domain, s.id]));

  const samples = await db
    .select({ id: users.id, claimedSchoolId: users.claimedSchoolId, gradYear: users.gradYear, name: users.name })
    .from(users)
    .where(eq(users.isSample, true));
  if (!samples.length) throw new Error("No sample students - run seed-sample-peers.ts first.");

  let memberTotal = 0;
  for (const [i, c] of CLUBS.entries()) {
    const sid = c.domain ? schoolId.get(c.domain) ?? null : null;
    if (c.domain && !sid) {
      console.log(`Skipped ${c.name}: ${c.domain} not in schools.`);
      continue;
    }
    const [club] = await db
      .insert(clubs)
      .values({ slug: slugify(c.name), name: c.name, schoolId: sid, description: c.description, isSample: true })
      .returning();

    // Same school's sample students; the multi-school group takes a spread.
    const pool = sid
      ? samples.filter((s) => s.claimedSchoolId === sid)
      : samples.filter((_, j) => j % 5 === i % 5);
    // Seniors lead: officers are the earliest class years in the pool.
    const ordered = [...pool].sort((a, b) => (a.gradYear ?? 9999) - (b.gradYear ?? 9999));
    const officerCount = Math.min(OFFICERS.length, Math.max(1, Math.floor(ordered.length / 2)));
    if (ordered.length) {
      await db.insert(clubMembers).values(
        ordered.map((s, j) => ({ clubId: club.id, userId: s.id, title: j < officerCount ? OFFICERS[j] : null })),
      );
    }
    memberTotal += ordered.length;
    console.log(`${c.name}: ${ordered.length} members`);
  }

  const count = await db.select({ id: clubs.id }).from(clubs).where(and(eq(clubs.isSample, true)));
  console.log(`Seeded ${count.length} sample clubs, ${memberTotal} memberships.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
