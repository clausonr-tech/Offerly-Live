/**
 * Seed 100 example students so Meet Peers and Connect have people in them.
 *
 *   npx tsx --env-file=.env.local scripts/seed-sample-peers.ts
 *   npx tsx --env-file=.env.local scripts/seed-sample-peers.ts --remove
 *
 * Realistic names and onboarding answers drawn from the same option lists the
 * wizard offers, plus target firms from the directory. Every row is
 * users.is_sample = true and shows a "Sample" tag, so a real student never
 * mistakes one for a person they can reach. None can sign in (the stored
 * password is not a hash) or be mailed (the address is on the reserved
 * .invalid TLD). Re-running replaces them; --remove deletes them, and their
 * target firms go with them (cascade).
 *
 * Deterministic: the same 100 people every run.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { firms, schools, users, userTopFirms } from "@/db/schema";
import { TARGET_LOCATIONS } from "@/lib/locations";
import { QUIZ_SPECIALTIES } from "@/lib/question-bank/specialties";

const COUNT = 100;
const NO_LOGIN = "!sample-account-no-login";

// mulberry32 - small, seeded, good enough to shuffle names.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const some = <T,>(xs: readonly T[], min: number, max: number): T[] => {
  const n = min + Math.floor(rand() * (max - min + 1));
  return [...xs].sort(() => rand() - 0.5).slice(0, Math.min(n, xs.length));
};
const weighted = <T,>(pairs: [T, number][]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};

const FIRST = [
  "James", "Olivia", "Ethan", "Sophia", "Michael", "Emma", "Daniel", "Ava", "Matthew", "Isabella",
  "Ryan", "Mia", "Jack", "Charlotte", "Andrew", "Amelia", "Lucas", "Harper", "Nathan", "Evelyn",
  "Tyler", "Abigail", "Brandon", "Emily", "Kevin", "Madison", "Justin", "Chloe", "Aaron", "Grace",
  "Jason", "Hannah", "Eric", "Natalie", "David", "Lily", "Samuel", "Zoe", "William", "Ella",
  "Arjun", "Priya", "Rohan", "Ananya", "Wei", "Mei", "Jun", "Yuna", "Diego", "Sofia",
  "Mateo", "Camila", "Omar", "Layla", "Malik", "Aaliyah", "Andre", "Jasmine", "Connor", "Claire",
];
const LAST = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor",
  "Thomas", "Moore", "Martin", "Jackson", "Thompson", "White", "Harris", "Clark", "Lewis", "Walker",
  "Hall", "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson",
  "Patel", "Shah", "Gupta", "Kumar", "Chen", "Wang", "Li", "Zhang", "Kim", "Park",
  "Nguyen", "Tran", "Garcia", "Martinez", "Rodriguez", "Lopez", "Hernandez", "Gonzalez", "Rivera", "Torres",
  "Murphy", "Sullivan", "Kelly", "Reilly", "Cohen", "Levine", "Friedman", "Okafor", "Mensah", "Brooks",
];

/** Target schools, by email domain - looked up, skipped if not in the table. */
const SCHOOL_DOMAINS: [string, number][] = [
  ["upenn.edu", 8], ["usc.edu", 8], ["nyu.edu", 7], ["umich.edu", 7], ["columbia.edu", 5],
  ["harvard.edu", 4], ["georgetown.edu", 5], ["virginia.edu", 5], ["cornell.edu", 5], ["duke.edu", 4],
  ["nd.edu", 5], ["utexas.edu", 5], ["berkeley.edu", 4], ["uchicago.edu", 4], ["stanford.edu", 3],
  ["yale.edu", 3], ["princeton.edu", 3], ["northwestern.edu", 4], ["bc.edu", 4], ["emory.edu", 3],
  ["vanderbilt.edu", 3], ["wustl.edu", 3], ["ucla.edu", 4], ["bu.edu", 3], ["fordham.edu", 3],
  ["iu.edu", 4], ["rice.edu", 2], ["wisc.edu", 3],
];

const MAJORS = [
  "Finance", "Economics", "Business Administration", "Accounting", "Economics and Mathematics",
  "Applied Mathematics", "Computer Science", "Statistics", "Political Science", "Finance and Accounting",
  "Mathematical Economics", "Industrial Engineering", "History", "Philosophy, Politics and Economics",
];
const HOMETOWNS = [
  "New York, NY", "Chicago, IL", "Dallas, TX", "Houston, TX", "Los Angeles, CA", "San Francisco, CA",
  "Boston, MA", "Atlanta, GA", "Charlotte, NC", "Miami, FL", "Seattle, WA", "Denver, CO",
  "Philadelphia, PA", "Washington, DC", "Nashville, TN", "Phoenix, AZ", "Minneapolis, MN", "Columbus, OH",
  "Short Hills, NJ", "Greenwich, CT", "Toronto, ON", "London, UK", "Mumbai, India", "Seoul, South Korea",
];

const CATEGORIES: [string, number][] = [
  ["investment_banking", 10], ["private_equity", 7], ["hedge_fund", 3], ["sales_trading", 2],
  ["asset_wealth_management", 2], ["venture_capital", 2], ["private_credit", 2], ["real_estate", 1],
];
const IB_TIERS = ["Bulge Bracket", "Elite Boutique", "Middle-Market"];
const PE_TIERS = ["Mega-Fund", "Middle-Market", "Growth Equity", "Venture Capital"];

/** Directory names, exact - see the firm lookup below. */
const IB_FIRMS = [
  "Goldman Sachs", "Morgan Stanley", "JPMorgan", "Evercore", "Lazard", "Centerview Partners",
  "PJT Partners", "Moelis & Company", "Perella Weinberg Partners", "Houlihan Lokey", "Jefferies",
  "William Blair", "Qatalyst Partners", "Guggenheim Securities", "Bank of America", "Citigroup",
];
const PE_FIRMS = ["Blackstone", "KKR", "Apollo Global Management", "Carlyle Group", "Warburg Pincus"];

async function main() {
  const remove = process.argv.includes("--remove");
  const db = await getDb();

  const removed = await db.delete(users).where(eq(users.isSample, true)).returning();
  console.log(`Removed ${removed.length} sample students.`);
  if (remove) return;

  const schoolRows = await db
    .select({ id: schools.id, name: schools.name, domain: schools.emailDomain })
    .from(schools)
    .where(inArray(schools.emailDomain, SCHOOL_DOMAINS.map(([d]) => d)));
  const byDomain = new Map(schoolRows.map((s) => [s.domain, s]));
  const schoolWeights = SCHOOL_DOMAINS.filter(([d]) => byDomain.has(d));
  console.log(`Schools found: ${schoolWeights.length} of ${SCHOOL_DOMAINS.length}.`);

  const firmRows = await db
    .select({ id: firms.id, name: firms.name })
    .from(firms)
    .where(and(inArray(firms.name, [...IB_FIRMS, ...PE_FIRMS]), eq(firms.isDemo, false)));
  const firmId = new Map(firmRows.map((f) => [f.name, f.id]));
  const ib = IB_FIRMS.filter((n) => firmId.has(n));
  const pe = PE_FIRMS.filter((n) => firmId.has(n));

  const used = new Set<string>();
  let topFirmRows = 0;
  for (let i = 0; i < COUNT; i++) {
    let name = "";
    do name = `${pick(FIRST)} ${pick(LAST)}`;
    while (used.has(name));
    used.add(name);

    const school = byDomain.get(weighted(schoolWeights))!;
    const gradYear = weighted<number>([[2027, 3], [2028, 4], [2029, 3], [2030, 1]]);
    const categories = [...new Set([weighted(CATEGORIES), ...(rand() < 0.5 ? [weighted(CATEGORIES)] : [])])];
    const niche = categories.flatMap((c) => some(QUIZ_SPECIALTIES[c as keyof typeof QUIZ_SPECIALTIES] ?? [], 1, 3));
    const locations = rand() < 0.1 ? [TARGET_LOCATIONS.at(-1)!] : some(TARGET_LOCATIONS.slice(0, 7), 1, 3);
    const created = new Date(Date.now() - Math.floor(rand() * 60) * 86_400_000);

    const [u] = await db
      .insert(users)
      .values({
        email: `${name.toLowerCase().replace(/\W+/g, ".")}.${i}@sample-peers.invalid`,
        passwordHash: NO_LOGIN,
        name,
        school: school.name,
        claimedSchoolId: school.id,
        gradYear,
        targetInternshipYear: gradYear - 1,
        degreeLevel: "bachelors",
        major: pick(MAJORS),
        hometown: pick(HOMETOWNS),
        preferredCategories: categories,
        nicheInterests: niche,
        ibTierPreferences: categories.includes("investment_banking") ? some(IB_TIERS, 1, 2) : null,
        peTierPreferences: categories.includes("private_equity") ? some(PE_TIERS, 1, 2) : null,
        targetLocations: locations,
        sponsorshipNeeded: rand() < 0.1 ? "Yes" : "No",
        onboardingCompletedAt: created,
        createdAt: created,
        isSample: true,
      })
      .returning();

    // Target firms that fit what they said they want.
    const pool = [
      ...(categories.includes("investment_banking") ? ib : []),
      ...(categories.includes("private_equity") ? pe : []),
    ];
    const targets = pool.length ? some(pool, 2, 5) : some(ib, 1, 2);
    if (targets.length) {
      await db
        .insert(userTopFirms)
        .values(targets.map((n) => ({ userId: u.id, firmId: firmId.get(n)!, source: "manual" })))
        .onConflictDoNothing();
      topFirmRows += targets.length;
    }
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isSample, true));
  console.log(`Seeded ${n} sample students with ${topFirmRows} target firms.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
