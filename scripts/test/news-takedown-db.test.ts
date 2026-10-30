/**
 * Taking news stories down, against a REAL database: PGlite migrated by
 * replaying drizzle/*.sql, so migration 0033 is exercised on a fresh database
 * too. No network, no model.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { newsClusters, newsItems, newsReports, newsSources, users } from "@/db/schema";
import { readTab } from "@/lib/news/read";
import { REPORTS_PER_DAY, REPORTS_TO_HIDE, findStory, hiddenLinks, hideEvent, recordReport, unhideEvent } from "@/lib/news/takedown";

let h: TestDatabase;
before(async () => {
  h = await createTestDb();
  await h.db.insert(newsSources).values({ id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" });
});
after(async () => {
  await h.close();
});

const NOW = new Date();
let seq = 0;

/** A student; verified with a school email unless told otherwise. */
async function mkUser(opts: { schoolEmail?: string | null; verified?: boolean } = {}): Promise<string> {
  seq += 1;
  const schoolEmail = opts.schoolEmail === undefined ? `student${seq}@school.edu` : opts.schoolEmail;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `news-${seq}-${Date.now()}@example.com`,
      passwordHash: "x",
      name: `Student ${seq}`,
      schoolEmail,
      schoolEmailVerifiedAt: opts.verified === false || !schoolEmail ? null : new Date(),
    })
    .returning({ id: users.id });
  return u.id;
}

/** One event on Main, reported by `copies` outlets. Returns the item ids, lead first. */
async function mkEvent(title: string, copies = 1): Promise<{ ids: string[]; links: string[] }> {
  seq += 1;
  const rows = [];
  for (let i = 0; i < copies; i++) {
    const url = `https://wire.example/${seq}-${i}`;
    const [row] = await h.db
      .insert(newsItems)
      .values({ sourceId: "wire", urlHash: `${seq}-${i}`, url, title: `${title} (${i})`, publisher: "Wire", publishedAt: NOW, titleKey: `${seq}-${i}`, origin: "rss", status: "labeled" })
      .returning();
    rows.push(row);
  }
  const [cluster] = await h.db
    .insert(newsClusters)
    .values({ leadItemId: rows[0].id, sectors: ["investment_banking"], firstSeenAt: NOW, lastSeenAt: NOW, scores: { main: 1 + seq / 100 } })
    .returning();
  for (const r of rows) await h.db.update(newsItems).set({ clusterId: cluster.id }).where(eq(newsItems.id, r.id));
  return { ids: rows.map((r) => r.id), links: rows.map((r) => r.url) };
}

const onMain = async () => (await readTab(h.db, null, 30, NOW)).map((s) => s.link);

test("an admin hide takes every outlet's copy of the event off the tab, and unhide puts it back", async () => {
  const deal = await mkEvent("Bank A buys Bank B", 2);
  assert.ok((await onMain()).includes(deal.links[0]));

  const story = await findStory(h.db, deal.links[1]);
  assert.equal(story?.id, deal.ids[1], "found by the link as the page shows it");
  assert.equal(await hideEvent(h.db, deal.ids[1], "admin: wrong"), 2, "both copies hidden, from either one");
  assert.ok(!(await onMain()).includes(deal.links[0]));
  assert.deepEqual([...(await hiddenLinks(h.db, deal.links))].sort(), [...deal.links].sort());

  assert.equal(await unhideEvent(h.db, deal.ids[0]), 2);
  assert.ok((await onMain()).includes(deal.links[0]));
});

test(`${REPORTS_TO_HIDE} different students hide a story; one student reporting twice counts once`, async () => {
  const rumour = await mkEvent("Fund C said to weigh sale");
  const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];

  assert.deepEqual(await recordReport(h.db, a, rumour.ids[0], "wrong"), { hidden: false });
  assert.deepEqual(await recordReport(h.db, a, rumour.ids[0], "not_finance"), { hidden: false }, "a repeat is not a second report");
  assert.deepEqual(await recordReport(h.db, b, rumour.ids[0], "wrong"), { hidden: false });
  assert.ok((await onMain()).includes(rumour.links[0]), "two reports leave it up");

  assert.deepEqual(await recordReport(h.db, c, rumour.ids[0], "offensive"), { hidden: true });
  assert.ok(!(await onMain()).includes(rumour.links[0]));
  const [item] = await h.db.select().from(newsItems).where(eq(newsItems.id, rumour.ids[0]));
  assert.equal(item.hiddenReason, "reports");

  // An admin restoring it clears the reports, so the old ones cannot hide it again.
  await unhideEvent(h.db, rumour.ids[0]);
  assert.equal((await h.db.select().from(newsReports).where(eq(newsReports.itemId, rumour.ids[0]))).length, 0);
  assert.deepEqual(await recordReport(h.db, a, rumour.ids[0], "wrong"), { hidden: false });
});

test("a report on a story that does not exist changes nothing", async () => {
  const user = await mkUser();
  assert.deepEqual(await recordReport(h.db, user, "00000000-0000-4000-8000-000000000000", "wrong"), { hidden: false });
});

test("unverified accounts and +tag copies of one school address cannot take a story down", async () => {
  const story = await mkEvent("Real news, targeted");
  for (let i = 0; i < 5; i++) await recordReport(h.db, await mkUser({ verified: false }), story.ids[0], "wrong");
  assert.ok((await onMain()).includes(story.links[0]), "five unverified reports leave it up");
  for (const tag of ["", "+1", "+2"]) await recordReport(h.db, await mkUser({ schoolEmail: `sameperson${tag}@school.edu` }), story.ids[0], "wrong");
  assert.ok((await onMain()).includes(story.links[0]), "one school inbox counts once");
  assert.equal((await h.db.select().from(newsReports).where(eq(newsReports.itemId, story.ids[0]))).length, 8, "every report is still kept for review");
});

test(`one account can file at most ${REPORTS_PER_DAY} reports a day`, async () => {
  const user = await mkUser();
  for (let i = 0; i < REPORTS_PER_DAY; i++) {
    const s = await mkEvent(`Story ${i}`);
    assert.equal((await recordReport(h.db, user, s.ids[0], "not_finance")).limited, undefined);
  }
  const extra = await mkEvent("One too many");
  assert.deepEqual(await recordReport(h.db, user, extra.ids[0], "not_finance"), { hidden: false, limited: true });
});
