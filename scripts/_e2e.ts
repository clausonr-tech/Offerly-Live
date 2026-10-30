import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { contacts, contactSourcingRuns, firms, schools, users } from "../src/db/schema";
import { runContactSourcing } from "../src/lib/contact-sourcing-run";
import { sameSchool } from "../src/lib/school-name";

const CASES: [string, "investment_banking" | "private_equity", string][] = [
  ["uchicago.edu", "investment_banking", "william-blair"],
];
const USD_PER_CREDIT = Number(process.env.CRUSTDATA_USD_PER_CREDIT);
const TAG = `offerly-e2e-${Date.now()}`;

// Every Crustdata response's own billing header, summed per case.
let billed = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
  if (url.includes("crustdata.com")) billed += Number(res.headers.get("x-credits-used") ?? 0) || 0;
  return res;
}) as typeof fetch;

async function main() {
  const db = await getDb();
  const made: string[] = [];
  let total = 0;
  try {
    for (const [i, [domain, category, slug]] of CASES.entries()) {
      const school = await db.query.schools.findFirst({ where: eq(schools.emailDomain, domain) });
      const firm = await db.query.firms.findFirst({ where: eq(firms.slug, slug) });
      if (!school || !firm) { console.log("CASE " + JSON.stringify({ i, domain, slug, error: "missing school or firm row" })); continue; }
      const [u] = await db.insert(users).values({
        email: `${TAG}-${i}@example.invalid`, passwordHash: "x", name: "Test Student", school: school.name,
        claimedSchoolId: school.id, gradYear: 2028, major: "Economics", plan: "pro",
        preferredCategories: [category], targetLocations: ["New York City"],
      } as typeof users.$inferInsert).returning();
      made.push(u.id);
      billed = 0;
      const t0 = Date.now();
      let result: Awaited<ReturnType<typeof runContactSourcing>> | null = null;
      let error: string | null = null;
      try { result = await runContactSourcing({ user: { id: u.id, email: `${TAG}-${i}@example.invalid` }, firmId: firm.id }); }
      catch (e) { error = (e as Error).message; }
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      total += billed;
      const saved = await db.select().from(contacts).where(eq(contacts.userId, u.id));
      const schoolRow = await db.query.schools.findFirst({ where: eq(schools.id, school.id) });
      const names = new Set((schoolRow?.searchNames ?? []).map((n) => n.toLowerCase()));
      const row = {
        i, student: school.name, category, firm: firm.name, secs,
        ok: result?.ok ?? false, error: error ?? (result && !result.ok ? result.error : null),
        status: result?.ok ? result.status : null,
        credits: +billed.toFixed(2), usd: +(billed * USD_PER_CREDIT).toFixed(2),
        overBudget: billed * USD_PER_CREDIT > 2 + 1e-9,
        contacts: saved.map((c) => ({
          who: c.name.split(" ")[0] + " " + (c.name.split(" ").at(-1)?.[0] ?? "") + ".",
          title: c.role, school: c.school,
          sameSchool: !!c.school && (names.has(c.school.toLowerCase()) || sameSchool(school.name, c.school)),
          email: c.email, conf: c.emailConfidence, reject: c.emailRejectionReason,
        })),
      };
      console.log("CASE " + JSON.stringify(row));
    }
  } finally {
    // Remove every test account and what it created. Learned email patterns
    // and firm identities stay - they are facts about the firms.
    if (made.length) {
      await db.delete(contacts).where(inArray(contacts.userId, made));
      await db.delete(contactSourcingRuns).where(inArray(contactSourcingRuns.userId, made));
      await db.delete(users).where(like(users.email, `${TAG}-%`));
    }
    const left = await db.select({ id: users.id }).from(users).where(like(users.email, `${TAG}-%`));
    console.log("TOTAL " + JSON.stringify({ cases: CASES.length, credits: +total.toFixed(2), usd: +(total * USD_PER_CREDIT).toFixed(2), testAccountsLeft: left.length }));
    process.exit(0);
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
