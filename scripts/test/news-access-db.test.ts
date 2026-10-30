/**
 * The student's paid sources, against a REAL database: PGlite migrated by
 * replaying drizzle/*.sql. No network, no model.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { newsClusters, newsItems, newsSources } from "@/db/schema";
import { readTab } from "@/lib/news/read";

let h: TestDatabase;
const NOW = new Date();
let seq = 0;

before(async () => {
  h = await createTestDb();
  await h.db.insert(newsSources).values([
    { id: "wsj-src", name: "WSJ", domain: "wsj.com", tier: "major", sectors: [], kind: "google_site", url: "site:wsj.com" },
    { id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" },
  ]);
});
after(async () => {
  await h.close();
});

/** One event on Main: a lead story from `leadDomain`, plus copies from `copies`. */
async function mkEvent(title: string, score: number, leadDomain: string, copies: string[] = []) {
  seq += 1;
  const rows = [];
  for (const [i, domain] of [leadDomain, ...copies].entries()) {
    const [row] = await h.db
      .insert(newsItems)
      .values({
        sourceId: domain === "wsj.com" ? "wsj-src" : "wire",
        urlHash: `${seq}-${i}`,
        url: `https://${domain}/${seq}-${i}`,
        title: `${title} (${domain})`,
        publisher: domain,
        publisherDomain: domain,
        publishedAt: new Date(NOW.getTime() - (10 - i) * 60_000),
        titleKey: `${seq}-${i}`,
        origin: "rss",
        status: "labeled",
      })
      .returning();
    rows.push(row);
  }
  const [cluster] = await h.db
    .insert(newsClusters)
    .values({ leadItemId: rows[0].id, sectors: ["investment_banking"], firstSeenAt: NOW, lastSeenAt: NOW, scores: { main: score } })
    .returning();
  for (const r of rows) await h.db.update(newsItems).set({ clusterId: cluster.id }).where(eq(newsItems.id, r.id));
}

test("a paid story the student cannot read shows a free outlet's copy; one with no free copy moves down and is marked", async () => {
  await mkEvent("Big deal", 0.9, "wsj.com", ["reuters.com"]);
  await mkEvent("Scoop", 0.8, "wsj.com");
  await mkEvent("Free story", 0.6, "reuters.com");

  const asIs = await readTab(h.db, null, 30, NOW);
  assert.deepEqual(asIs.map((s) => s.source), ["wsj.com", "wsj.com", "reuters.com"], "no student: ranked as it stands");

  const freeOnly = await readTab(h.db, null, 30, NOW, []);
  assert.deepEqual(freeOnly.map((s) => `${s.source}${s.locked ? " (locked)" : ""}`), ["reuters.com", "reuters.com", "wsj.com (locked)"]);
  assert.equal(freeOnly[0].title, "Big deal (reuters.com)", "the same event, through the free copy");

  const subscriber = await readTab(h.db, null, 30, NOW, ["wsj"]);
  assert.deepEqual(subscriber.map((s) => `${s.source}${s.locked ? " (locked)" : ""}`), ["wsj.com", "wsj.com", "reuters.com"], "a subscriber sees the WSJ itself");
});

test("only a quarter of a tab can be stories the student cannot open", async () => {
  for (let i = 0; i < 6; i++) await mkEvent(`Paid only ${i}`, 0.95, "wsj.com");
  const tab = await readTab(h.db, null, 8, NOW, []);
  assert.ok(tab.filter((s) => s.locked).length <= 2, `${tab.filter((s) => s.locked).length} locked of ${tab.length}`);
});
