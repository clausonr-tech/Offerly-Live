/**
 * 300 simulated students through the News page, on a TEST database with real
 * stories. Each student gets a random mix of industries, specialties, top
 * firms and paid news sources; their digest, briefing and tabs are built by
 * the same code the page runs, and checked against the rules the page promises.
 *
 *   DATABASE_URL= PGLITE_DATA_DIR=<test copy> npx tsx --env-file-if-exists=.env.local \
 *     --conditions=react-server scripts/news-eval/student-sim.ts [--students 300] [--seed 7]
 *
 * It creates throwaway students and hides a few stories while it runs, and
 * removes both at the end. It refuses to run against Postgres - a test copy only.
 */
process.env.OFFERLY_DB_POOL ??= "3";

import { eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { openDb } from "../../src/db/open";
import { firms, newsBriefings, newsClusters, newsItemFirms, newsItems, userTopFirms, users } from "../../src/db/schema";
import { PAID_PUBLISHERS, LOCKED_PER_ROW, LOCKED_SHARE, canRead } from "../../src/lib/news/access";
import { getBriefing, type BriefingPiece } from "../../src/lib/news/briefing";
import { getDigest, type Digest, type DigestStory } from "../../src/lib/news/digest";
import { readTab } from "../../src/lib/news/read";
import { hideEvent, unhideEvent } from "../../src/lib/news/takedown";
import { SECTORS, SPECIALTIES_BY_SECTOR, type Sector } from "../../src/lib/news/types";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const STUDENTS = arg("students", 300);
const SEED = arg("seed", 7);

// A seeded generator, so a failing student can be re-run exactly.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => rand() - 0.5).slice(0, Math.max(0, Math.min(n, xs.length)));
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

type Check = { name: string; pass: number; fail: number; examples: string[] };
const checks = new Map<string, Check>();
// How often each situation came up, so a check that passed was actually exercised.
const seen = { firmSections: 0, lockedStories: 0, swappedToReadable: 0, banners: 0, briefings: 0, industrySections: 0, photos: 0, tiles: 0, cards: 0 };
function check(name: string, ok: boolean, detail: () => string) {
  const c = checks.get(name) ?? { name, pass: 0, fail: 0, examples: [] };
  if (ok) c.pass++;
  else {
    c.fail++;
    if (c.examples.length < 5) c.examples.push(detail());
  }
  checks.set(name, c);
}

async function main() {
  const opened = await openDb();
  if (opened.backend !== "pglite") {
    console.error(`REFUSING: this creates throwaway students; run it on a test copy (PGlite), not ${opened.backend}.`);
    process.exit(1);
  }
  const db = opened.db;
  const now = new Date();
  const prefix = `sim-${SEED}-${Date.now()}`;

  // Firms that have news this week, so firm sections actually get tested.
  const newsFirms: { id: string; name: string }[] = await db
    .selectDistinct({ id: firms.id, name: firms.name })
    .from(newsItemFirms)
    .innerJoin(firms, eq(firms.id, newsItemFirms.firmId))
    .limit(400);
  const otherFirms: { id: string; name: string }[] = await db.select({ id: firms.id, name: firms.name }).from(firms).limit(400);

  // Take five of the day's top events down; none may appear anywhere.
  const topEvents: { itemId: string }[] = await db
    .select({ itemId: newsClusters.leadItemId })
    .from(newsClusters)
    .where(sql`${newsClusters.scores} ? 'main'`)
    .orderBy(sql`(${newsClusters.scores} ->> 'main')::float desc`)
    .limit(40);
  const hiddenIds = pick(topEvents.map((e) => e.itemId), 5);
  for (const id of hiddenIds) await hideEvent(db, id, "admin: student-sim");
  const hiddenLinks = new Set<string>(
    (await db.select({ url: newsItems.url }).from(newsItems).where(isNotNull(newsItems.hiddenAt))).map((r: { url: string }) => r.url),
  );

  const pieces = (await db.select({ scope: newsBriefings.scope, payload: newsBriefings.payload }).from(newsBriefings)).map((p) => ({ scope: p.scope, payload: p.payload as BriefingPiece }));
  const linksOf = (scope: string, keys: string[]) =>
    new Set(pieces.filter((p) => p.scope === scope).flatMap((p) => keys.flatMap((k) => (p.payload.headings[k] ?? []).flatMap((b) => b.sources.map((s) => s.link)))));

  const started = Date.now();
  try {
    for (let i = 0; i < STUDENTS; i++) {
      // ---- a random student
      const sectors = rand() < 0.1 ? [] : pick(SECTORS, int(1, 5));
      const specialties = sectors.flatMap((s) => pick(SPECIALTIES_BY_SECTOR[s], int(0, 2)));
      const accessRoll = rand();
      const access = accessRoll < 0.3 ? null : accessRoll < 0.6 ? [] : pick(PAID_PUBLISHERS.map((p) => p.id), int(1, 4));
      const drawn = rand() < 0.15 ? [] : [...pick(newsFirms, int(1, 6)), ...pick(otherFirms, int(0, 4))];
      const myFirms = drawn.filter((f, k) => drawn.findIndex((x) => x.id === f.id) === k);
      const label = `#${i} sectors=[${sectors.join(",")}] access=${JSON.stringify(access)} firms=${myFirms.length}`;

      const [user] = await db
        .insert(users)
        .values({ email: `${prefix}-${i}@example.test`, passwordHash: "x", name: `Sim ${i}`, preferredCategories: sectors, nicheInterests: specialties, newsAccess: access })
        .returning({ id: users.id });
      if (myFirms.length) await db.insert(userTopFirms).values(myFirms.map((f, rank) => ({ userId: user.id, firmId: f.id, matchScore: 100 - rank })));
      const readable = (s: DigestStory) => canRead(s.sourceDomain, access ?? []);

      // ---- the digest
      const digest: Digest = await getDigest(db, user.id, now);
      const industrySections = digest.sections.filter((s) => s.kind === "sector");
      check("1. digest shows only the student's industries, in their order", industrySections.every((s) => sectors.includes(s.sector as Sector)) && isOrdered(industrySections.map((s) => s.sector as Sector), sectors), () => `${label}: ${industrySections.map((s) => s.sector).join(",")}`);
      check("2. no section holds more than 4 stories", digest.sections.every((s) => s.stories.length <= 4), () => `${label}: ${digest.sections.map((s) => `${s.title}=${s.stories.length}`).join(" ")}`);
      const all = [digest.main, ...digest.sections.flatMap((s) => s.stories)].filter((s): s is DigestStory => Boolean(s));
      check("3. no story appears twice (banner included)", new Set(all.map((s) => s.link)).size === all.length, () => `${label}: duplicate links`);
      check("4. at most 1 locked story per section", digest.sections.every((s) => s.stories.filter((x) => x.locked).length <= LOCKED_PER_ROW), () => `${label}`);
      check("5. every locked tag is right for this student's sources", all.every((s) => Boolean(s.locked) === !readable(s)), () => `${label}: ${all.filter((s) => Boolean(s.locked) !== !readable(s)).map((s) => s.sourceDomain).join(",")}`);
      check("6. the banner is a story the student can open whenever one exists", !digest.main?.locked || all.every((s) => s.locked), () => `${label}: main ${digest.main?.sourceDomain}`);
      check("7. no taken-down story appears", all.every((s) => !hiddenLinks.has(s.link)), () => `${label}`);
      check("8. every card has a photo or a firm/sector/masthead tile", all.every((s) => s.imageUrl || s.firmDomain || s.sector || s.sourceDomain), () => `${label}`);
      check("9. every link is a web address, and every photo comes through the checked-image route", all.every((s) => /^https?:\/\//.test(s.link) && (!s.imageUrl || s.imageUrl.startsWith("/api/news-image/"))), () => `${label}: ${all.map((s) => s.imageUrl).filter((u) => u && !u.startsWith("/api/news-image/")).slice(0, 2)}`);
      seen.cards += all.length;
      seen.photos += all.filter((s) => s.imageUrl).length;
      seen.tiles += all.filter((s) => !s.imageUrl).length;
      seen.lockedStories += all.filter((s) => s.locked).length;
      seen.swappedToReadable += all.filter((s) => s.paywall === false && !s.locked && s.outlets > 1).length;
      seen.banners += digest.main ? 1 : 0;
      seen.industrySections += industrySections.length;
      const firmNames = new Set(myFirms.map((f) => f.name));
      const firmSection = digest.sections.find((s) => s.kind === "firms");
      if (firmSection) seen.firmSections++;
      check("10. 'Your firms' holds only the student's firms", !firmSection || firmSection.stories.every((s) => s.because && firmNames.has(s.because)), () => `${label}: ${firmSection?.stories.map((s) => s.because).join(",")}`);
      if (sectors.length === 0 && myFirms.length === 0) {
        check("11. a student with no interests gets only the day's top stories", digest.sections.every((s) => s.kind === "top"), () => `${label}`);
      }

      // ---- the same edition read again: stored, and identical
      const again: Digest = await getDigest(db, user.id, now);
      const sig = (d: Digest) => JSON.stringify([d.main?.link, d.sections.map((s) => [s.title, s.stories.map((x) => x.link)])]);
      check("12. the stored edition reads back the same", sig(again) === sig(digest), () => `${label}`);

      // ---- changing industries mid-day rebuilds it
      if (i % 5 === 0) {
        const newSectors = pick(SECTORS.filter((s) => !sectors.includes(s)), int(1, 3));
        await db.update(users).set({ preferredCategories: newSectors, nicheInterests: [] }).where(eq(users.id, user.id));
        const changed: Digest = await getDigest(db, user.id, now);
        const shown = changed.sections.filter((s) => s.kind === "sector").map((s) => s.sector as Sector);
        check("13. new industries replace the old ones the same day", shown.every((s) => newSectors.includes(s)) && isOrdered(shown, newSectors), () => `${label} -> [${newSectors}] shown [${shown}]`);
        await db.update(users).set({ preferredCategories: sectors, nicheInterests: specialties }).where(eq(users.id, user.id));
      }

      // ---- the briefing
      const briefing = await getBriefing(db, sectors, now);
      if (briefing) {
        seen.briefings++;
        const own = sectors.length ? new Set(sectors.flatMap((s) => [...linksOf(s, ["deals", "markets", "trends"])])) : linksOf("general", ["deals", "markets"]);
        const personal = briefing.sections.filter((s) => s.key === "deals" || s.key === "markets").flatMap((s) => s.bullets.flatMap((b) => b.sources.map((x) => x.link)));
        check("14. briefing deals and markets come only from the student's industries", personal.every((l) => own.has(l)), () => `${label}`);
        const general = linksOf("general", ["economy_us", "economy_global", "policy", "recruiting"]);
        const rest = briefing.sections.filter((s) => !["deals", "markets"].includes(s.key)).flatMap((s) => s.bullets.flatMap((b) => b.sources.map((x) => x.link)));
        check("15. briefing economy, policy and recruiting come from the general piece", rest.every((l) => general.has(l)), () => `${label}`);
        check("16. every briefing bullet is short and sourced", briefing.sections.every((s) => s.bullets.every((b) => b.sources.length > 0 && b.text.split(" ").length <= 32)), () => `${label}`);
      }

      // ---- the tabs, as this student sees them
      const sector = sectors[0] ?? pick(SECTORS, 1)[0];
      const tab = await readTab(db, sector, 24, now, access ?? []);
      const main = await readTab(db, null, 30, now, access ?? []);
      check("17. a sector page keeps locked stories to a quarter", tab.filter((s) => s.locked).length <= Math.ceil(24 * LOCKED_SHARE), () => `${label} ${sector}: ${tab.filter((s) => s.locked).length}`);
      check("18. Top stories keeps locked stories to a quarter", main.filter((s) => s.locked).length <= Math.ceil(30 * LOCKED_SHARE), () => `${label}`);
      check("19. tab locked tags are right for this student's sources", [...tab, ...main].every((s) => s.locked === !canRead(s.sourceDomain, access ?? [])), () => `${label}`);
      check("20. no taken-down story on a tab", [...tab, ...main].every((s) => !hiddenLinks.has(s.link)), () => `${label}`);

      if ((i + 1) % 50 === 0) console.log(`  ${i + 1} students (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  } finally {
    const simUsers = await db.select({ id: users.id }).from(users).where(like(users.email, `${prefix}-%`));
    if (simUsers.length) await db.delete(users).where(inArray(users.id, simUsers.map((u: { id: string }) => u.id)));
    for (const id of hiddenIds) await unhideEvent(db, id);
    await opened.close?.();
  }

  const list = [...checks.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const students = STUDENTS;
  const failedStudents = list.reduce((n, c) => n + c.fail, 0);
  console.log(`\n${students} students, ${list.reduce((n, c) => n + c.pass + c.fail, 0)} checks:`);
  for (const c of list) console.log(`  ${c.fail ? "FAIL" : "ok  "} ${c.name.padEnd(68)} ${c.pass}/${c.pass + c.fail}`);
  console.log(`\nexercised: ${Object.entries(seen).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const c of list.filter((x) => x.fail)) console.log(`\n${c.name}:\n${c.examples.map((e) => `    ${e}`).join("\n")}`);
  process.exit(failedStudents ? 1 : 0);
}

/** Whether `shown` keeps the order `picked` has. */
function isOrdered<T>(shown: T[], picked: T[]): boolean {
  const pos = shown.map((s) => picked.indexOf(s));
  return pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
