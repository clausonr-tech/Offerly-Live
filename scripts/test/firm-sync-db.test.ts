// Firm catalog synchronisation, against a REAL database (in-memory PGlite,
// migrated by replaying drizzle/*.sql).
//
// Two halves. Ordinary firm reads must not touch the catalog at all - they
// used to call ensureFirmsSeeded(), which loaded and diffed all ~22.5k firms
// (9-13s against the remote database) before answering. And the explicit
// `npm run db:sync-firms` command that replaced it must be idempotent and
// non-destructive by default: it adds and updates, moves merged entities'
// dependants onto their parent brand, and removes nothing unless asked.
//
// NOTHING HERE TOUCHES PRODUCTION: DATABASE_URL is removed and there is no
// network.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import "./helpers/no-network";
import { count, eq, sql } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import {
  contactSourcingRuns,
  firmMonitoringSources,
  firmPrograms,
  firmRecruitingEvents,
  firms,
  monitoringCheckRuns,
  monitoringTiers,
  users,
  userTopFirms,
} from "@/db/schema";
import type { FirmSeed } from "@/lib/firm-content";
import { FIRM_DEPENDANTS, syncFirmCatalog } from "@/lib/firm-sync";
import {
  getFirmBySlug,
  getFirmsByIds,
  getFirmsForCategories,
  getRepresentativeFirmNames,
  searchFirmNames,
} from "@/lib/firms";

delete process.env.DATABASE_URL;

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

async function firmCount() {
  const [{ n }] = await h.db.select({ n: count() }).from(firms);
  return n;
}

async function clearFirms() {
  // parent_firm_id has no onDelete, so sources naming a firm as parent go first.
  await h.db.delete(firmMonitoringSources);
  await h.db.delete(firms);
}

function seed(slug: string, over: Partial<FirmSeed> = {}): FirmSeed {
  return {
    slug,
    name: `Firm ${slug}`,
    headquarters: "New York, NY",
    keyOffices: "New York, NY",
    website: `${slug}.example.com`,
    description: `About ${slug}.`,
    programs: [
      {
        category: "investment_banking",
        roleLabel: "Investment banking",
        timingGuidance: "Rolling.",
        careersUrl: `https://${slug}.example.com/careers`,
        recruitingChannelLabel: `${slug} - Careers`,
        recruitingChannelUrl: `https://${slug}.example.com/careers`,
      },
    ],
    ...over,
  };
}

const NO_REDIRECTS: ReadonlyMap<string, string> = new Map();

describe("ordinary firm reads", () => {
  test("never synchronise the catalog into the database", async () => {
    await clearFirms();
    const [firm] = await h.db
      .insert(firms)
      .values({ slug: "only-firm", name: "Only Firm", headquarters: "NY", keyOffices: "NY", website: "only.example.com", description: "x" })
      .returning();
    await h.db.insert(firmPrograms).values({
      firmId: firm.id,
      category: "investment_banking",
      roleLabel: "IB",
      timingGuidance: "t",
      careersUrl: "https://only.example.com",
      recruitingChannelLabel: "c",
      recruitingChannelUrl: "https://only.example.com",
    });

    assert.equal((await getFirmBySlug("only-firm"))?.id, firm.id);
    assert.equal((await getFirmsByIds([firm.id])).length, 1);
    assert.equal((await getFirmsForCategories(["investment_banking"])).length, 1);
    assert.deepEqual(
      (await searchFirmNames({ query: "Only" })).map((f) => f.name),
      ["Only Firm"],
    );
    assert.deepEqual(await getRepresentativeFirmNames(), ["Only Firm"]);
    // A catalog sync would have inserted ~22.5k rows by now.
    assert.equal(await firmCount(), 1);
  });
});

describe("syncFirmCatalog", () => {
  test("a dry run reports what would change and writes nothing", async () => {
    await clearFirms();
    const report = await syncFirmCatalog({ seeds: [seed("a"), seed("b")], redirects: NO_REDIRECTS, dryRun: true });
    assert.equal(report.inserted, 2);
    assert.equal(await firmCount(), 0);
  });

  test("inserts the catalog, and a second run changes nothing", async () => {
    await clearFirms();
    const seeds = [seed("a"), seed("b", { aum: 5e9 })];
    const first = await syncFirmCatalog({ seeds, redirects: NO_REDIRECTS });
    assert.deepEqual([first.inserted, first.updated, first.programsReplaced], [2, 0, 2]);
    assert.equal(await firmCount(), 2);

    const second = await syncFirmCatalog({ seeds, redirects: NO_REDIRECTS });
    assert.deepEqual([second.inserted, second.updated, second.programsReplaced, second.unchanged], [0, 0, 0, 2]);
  });

  test("an edited seed updates its row in place, keeping a student's shortlist", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("a")], redirects: NO_REDIRECTS });
    const [before] = await h.db.select().from(firms).where(eq(firms.slug, "a"));
    const [student] = await h.db.insert(users).values({ email: `s-${Date.now()}@example.edu`, passwordHash: "x" }).returning();
    await h.db.insert(userTopFirms).values({ userId: student.id, firmId: before.id });

    const report = await syncFirmCatalog({ seeds: [seed("a", { description: "Rewritten." })], redirects: NO_REDIRECTS });
    assert.equal(report.updated, 1);
    const [after] = await h.db.select().from(firms).where(eq(firms.slug, "a"));
    assert.equal(after.id, before.id);
    assert.equal(after.description, "Rewritten.");
    assert.equal((await h.db.select().from(userTopFirms).where(eq(userTopFirms.userId, student.id))).length, 1);
  });

  test("keeps firms missing from the catalog unless pruning is asked for", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("a"), seed("gone")], redirects: NO_REDIRECTS });

    const kept = await syncFirmCatalog({ seeds: [seed("a")], redirects: NO_REDIRECTS });
    assert.deepEqual(kept.orphans, ["gone"]);
    assert.deepEqual(kept.removed, []);
    assert.equal(await firmCount(), 2);

    const pruned = await syncFirmCatalog({ seeds: [seed("a")], redirects: NO_REDIRECTS, pruneOrphans: true });
    assert.deepEqual(pruned.removed, ["gone"]);
    assert.equal(await firmCount(), 1);
  });

  test("moves a merged entity's shortlist entries onto its parent brand", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("parent"), seed("entity")], redirects: NO_REDIRECTS });
    const [entity] = await h.db.select().from(firms).where(eq(firms.slug, "entity"));
    const [student] = await h.db.insert(users).values({ email: `m-${Date.now()}@example.edu`, passwordHash: "x" }).returning();
    await h.db.insert(userTopFirms).values({ userId: student.id, firmId: entity.id });

    const report = await syncFirmCatalog({ seeds: [seed("parent")], redirects: new Map([["entity", "parent"]]) });
    assert.equal(report.mergedOrphans, 1);
    const [parent] = await h.db.select().from(firms).where(eq(firms.slug, "parent"));
    const shortlist = await h.db.select().from(userTopFirms).where(eq(userTopFirms.userId, student.id));
    assert.deepEqual(shortlist.map((r) => r.firmId), [parent.id]);
    // The emptied entity row itself stays until a pruning run.
    assert.equal(await firmCount(), 2);
  });

  test("a dry run reports the merged entity pruning would remove, even before its shortlist moves", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("parent"), seed("entity")], redirects: NO_REDIRECTS });
    const [entity] = await h.db.select().from(firms).where(eq(firms.slug, "entity"));
    const [student] = await h.db.insert(users).values({ email: `d-${Date.now()}@example.edu`, passwordHash: "x" }).returning();
    await h.db.insert(userTopFirms).values({ userId: student.id, firmId: entity.id });
    const redirects = new Map([["entity", "parent"]]);

    const preview = await syncFirmCatalog({ seeds: [seed("parent")], redirects, pruneOrphans: true, dryRun: true });
    assert.deepEqual([preview.removed, preview.kept], [["entity"], []]);
    assert.equal(await firmCount(), 2);
    const [still] = await h.db.select().from(userTopFirms).where(eq(userTopFirms.userId, student.id));
    assert.equal(still.firmId, entity.id);

    const real = await syncFirmCatalog({ seeds: [seed("parent")], redirects, pruneOrphans: true });
    assert.deepEqual(real.removed, preview.removed);
    assert.equal(await firmCount(), 1);
    assert.equal((await h.db.select().from(userTopFirms).where(eq(userTopFirms.userId, student.id))).length, 1);
  });
});

// ---------------------------------------------------------------- dependants
//
// Pruning used to check only postings and shortlists before deleting a firm, so
// a firm with monitoring sources, crawl history, contact-sourcing runs or
// events was deleted and every one of those cascaded away with it.

describe("firm dependants", () => {
  let tierId: string;
  before(async () => {
    const [tier] = await h.db
      .insert(monitoringTiers)
      .values({ name: `test-${Date.now()}`, description: "test", sortOrder: 99 })
      .returning();
    tierId = tier.id;
  });

  async function firmId(slug: string) {
    const [f] = await h.db.select({ id: firms.id }).from(firms).where(eq(firms.slug, slug));
    return f.id;
  }
  async function student() {
    const [u] = await h.db.insert(users).values({ email: `dep-${Math.random()}@example.edu`, passwordHash: "x" }).returning();
    return u;
  }
  async function monitoringSource(firm: string, over: Partial<typeof firmMonitoringSources.$inferInsert> = {}) {
    const [src] = await h.db
      .insert(firmMonitoringSources)
      .values({
        firmId: firm,
        careersUrl: "https://example.com/careers",
        sourceType: "generic_html",
        connectorId: "generic",
        sectorCategory: "investment_banking",
        tierId,
        ...over,
      })
      .returning();
    return src;
  }
  async function event(firm: string, eventUrl: string) {
    const [e] = await h.db.insert(firmRecruitingEvents).values({ firmId: firm, title: "Info session", eventUrl }).returning();
    return e;
  }

  test("every column that references firms has a merge and pruning policy", async () => {
    const fks = await h.db.execute(sql`
      select cl.relname as "table", a.attname as "column"
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'firms'::regclass`);
    const rows = ((fks as unknown as { rows?: { table: string; column: string }[] }).rows ?? fks) as {
      table: string;
      column: string;
    }[];
    const inSchema = rows.map((r) => `${r.table}.${r.column}`).sort();
    const covered = [...FIRM_DEPENDANTS.map((d) => `${d.table}.${d.column}`), "firm_programs.firm_id"].sort();
    assert.deepEqual(inSchema, covered);
  });

  test("a monitoring source, its crawl history and an event block pruning", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("kept"), seed("monitored")], redirects: NO_REDIRECTS });
    const id = await firmId("monitored");
    const src = await monitoringSource(id);
    await h.db.insert(monitoringCheckRuns).values({ sourceId: src.id });
    await event(id, "https://monitored.example.com/event");

    const report = await syncFirmCatalog({ seeds: [seed("kept")], redirects: NO_REDIRECTS, pruneOrphans: true });
    assert.deepEqual(report.removed, []);
    assert.deepEqual(report.kept, ["monitored"]);
    assert.deepEqual(report.orphanDetails[0].blocking, {
      "firm_monitoring_sources.firm_id": 1,
      "firm_recruiting_events.firm_id": 1,
    });
    assert.equal(report.orphanDetails[0].outcome, "blocked");
    assert.equal((await h.db.select().from(monitoringCheckRuns).where(eq(monitoringCheckRuns.sourceId, src.id))).length, 1);
    assert.equal(await firmCount(), 2);
  });

  test("contact-sourcing history blocks pruning, and moves with a merge", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("parent"), seed("sourced"), seed("entity")], redirects: NO_REDIRECTS });
    const u = await student();
    await h.db.insert(contactSourcingRuns).values({ userId: u.id, firmId: await firmId("sourced"), creditsSpent: 0 });
    const [run] = await h.db.insert(contactSourcingRuns).values({ userId: u.id, firmId: await firmId("entity"), creditsSpent: 0 }).returning();

    const report = await syncFirmCatalog({
      seeds: [seed("parent")],
      redirects: new Map([["entity", "parent"]]),
      pruneOrphans: true,
    });
    const bySlug = Object.fromEntries(report.orphanDetails.map((o) => [o.slug, o]));
    assert.deepEqual(bySlug.sourced.blocking, { "contact_sourcing_runs.firm_id": 1 });
    assert.equal(bySlug.sourced.outcome, "blocked");
    assert.deepEqual(bySlug.entity.moved, { "contact_sourcing_runs.firm_id": 1 });
    assert.equal(bySlug.entity.outcome, "removed");
    const [after] = await h.db.select().from(contactSourcingRuns).where(eq(contactSourcingRuns.id, run.id));
    assert.equal(after.firmId, await firmId("parent"));
  });

  test("a merge moves monitoring sources, including ones that name the entity as their parent firm", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("parent"), seed("entity"), seed("subsidiary")], redirects: NO_REDIRECTS });
    const entity = await firmId("entity");
    const own = await monitoringSource(entity);
    const child = await monitoringSource(await firmId("subsidiary"), { parentFirmId: entity });
    await h.db.insert(monitoringCheckRuns).values({ sourceId: own.id });

    const report = await syncFirmCatalog({
      seeds: [seed("parent"), seed("subsidiary")],
      redirects: new Map([["entity", "parent"]]),
      pruneOrphans: true,
    });
    const parent = await firmId("parent");
    assert.deepEqual(report.orphanDetails[0].moved, {
      "firm_monitoring_sources.firm_id": 1,
      "firm_monitoring_sources.parent_firm_id": 1,
    });
    assert.deepEqual(report.removed, ["entity"]);
    const [ownAfter] = await h.db.select().from(firmMonitoringSources).where(eq(firmMonitoringSources.id, own.id));
    const [childAfter] = await h.db.select().from(firmMonitoringSources).where(eq(firmMonitoringSources.id, child.id));
    assert.equal(ownAfter.firmId, parent);
    assert.equal(childAfter.parentFirmId, parent);
    assert.equal((await h.db.select().from(monitoringCheckRuns).where(eq(monitoringCheckRuns.sourceId, own.id))).length, 1);
  });

  test("an event the parent already lists stays on the entity and blocks deletion; the dry run says so and writes nothing", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("parent"), seed("entity")], redirects: NO_REDIRECTS });
    const parent = await firmId("parent");
    const entity = await firmId("entity");
    await event(parent, "https://example.com/shared");
    const clash = await event(entity, "https://example.com/shared");
    const unique = await event(entity, "https://example.com/only-entity");
    const redirects = new Map([["entity", "parent"]]);

    const preview = await syncFirmCatalog({ seeds: [seed("parent")], redirects, pruneOrphans: true, dryRun: true });
    const expected = {
      mergedInto: "parent",
      moved: { "firm_recruiting_events.firm_id": 1 },
      blocking: { "firm_recruiting_events.firm_id": 1 },
      outcome: "blocked",
    };
    const pick = (o: (typeof preview.orphanDetails)[number]) => ({
      mergedInto: o.mergedInto,
      moved: o.moved,
      blocking: o.blocking,
      outcome: o.outcome,
    });
    assert.deepEqual(pick(preview.orphanDetails[0]), expected);
    const [uniqueBefore] = await h.db.select().from(firmRecruitingEvents).where(eq(firmRecruitingEvents.id, unique.id));
    assert.equal(uniqueBefore.firmId, entity, "the dry run moved a row");

    const real = await syncFirmCatalog({ seeds: [seed("parent")], redirects, pruneOrphans: true });
    assert.deepEqual(pick(real.orphanDetails[0]), expected);
    const [clashAfter] = await h.db.select().from(firmRecruitingEvents).where(eq(firmRecruitingEvents.id, clash.id));
    const [uniqueAfter] = await h.db.select().from(firmRecruitingEvents).where(eq(firmRecruitingEvents.id, unique.id));
    assert.equal(clashAfter.firmId, entity);
    assert.equal(uniqueAfter.firmId, parent);
    assert.equal(await firmCount(), 2);
  });

  test("a failure part-way through leaves the database as it was", async () => {
    await clearFirms();
    await syncFirmCatalog({ seeds: [seed("existing")], redirects: NO_REDIRECTS });
    // The second "dup" insert violates the unique slug after "fresh" and the
    // first "dup" have already been written inside the transaction.
    await assert.rejects(
      syncFirmCatalog({
        seeds: [seed("existing", { description: "Changed." }), seed("fresh"), seed("dup"), seed("dup")],
        redirects: NO_REDIRECTS,
      }),
    );
    const rows = await h.db.select({ slug: firms.slug, description: firms.description }).from(firms);
    assert.deepEqual(rows, [{ slug: "existing", description: "About existing." }]);
  });
});
