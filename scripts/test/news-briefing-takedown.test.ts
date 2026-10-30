/**
 * A taken-down story leaves the stored daily briefing and markets wrap too.
 *
 * Both are written twice a day and then SERVED for up to 36 hours: the payload
 * in news_briefings holds the model's own sentences plus the links they cite.
 * The hiddenAt check applies when a piece is written, which does nothing for a
 * story hidden afterwards, so a rumour an admin took down - or three students
 * reported - kept being repeated to every student until the next run replaced
 * the piece. The stored per-student digest already filtered itself through
 * hiddenLinks on read for exactly this reason; these two did not.
 *
 * A REAL database: PGlite migrated by replaying drizzle/*.sql. No network, no
 * model - the payloads are written here as the pipeline would have stored them.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { newsBriefings, newsItems, newsSources } from "@/db/schema";
import { getBriefing, type BriefingPiece } from "@/lib/news/briefing";
import { getMarketWrap, type MarketWrap } from "@/lib/news/market-wrap";
import { hideEvent } from "@/lib/news/takedown";

let h: TestDatabase;
const NOW = new Date("2026-10-07T18:00:00Z");
const EDITION = "2026-10-07";

before(async () => {
  h = await createTestDb();
  await h.db.insert(newsSources).values({ id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" });
});
after(async () => {
  await h.close();
});

let seq = 0;
/** A story the pipeline collected, as a briefing would cite it. */
async function mkStory(title: string): Promise<{ id: string; link: string; title: string }> {
  seq += 1;
  const link = `https://wire.example/story-${seq}`;
  const [row] = await h.db
    .insert(newsItems)
    .values({ sourceId: "wire", urlHash: `b-${seq}`, url: link, title, publisher: "Wire", publishedAt: NOW, titleKey: `b-${seq}`, origin: "rss", status: "labeled" })
    .returning();
  return { id: row.id, link, title };
}

const cite = (s: { link: string; title: string }) => ({ title: s.title, link: s.link, publisher: "Wire" });

test("a story hidden after the briefing was written stops being cited by it", async () => {
  const rumour = await mkStory("Fund C said to weigh a sale");
  const real = await mkStory("Bank A buys Bank B");
  const piece: BriefingPiece = {
    scope: "general",
    generatedAt: NOW.toISOString(),
    headings: {
      deals: [
        { text: "Fund C is in talks to sell itself.", sources: [cite(rumour)] },
        { text: "Bank A agreed to buy Bank B.", sources: [cite(real)] },
      ],
      markets: [{ text: "The 10-year Treasury yield was 4.1% at the last close.", sources: [], data: ["US Treasury"] }],
    },
  };
  await h.db.insert(newsBriefings).values({ editionDate: EDITION, scope: "general", payload: piece, createdAt: NOW });

  const before_ = await getBriefing(h.db, [], NOW);
  assert.equal(before_?.sections.find((s) => s.key === "deals")?.bullets.length, 2);

  assert.equal(await hideEvent(h.db, rumour.id, "admin: wrong"), 1);

  const after_ = await getBriefing(h.db, [], NOW);
  const deals = after_?.sections.find((s) => s.key === "deals")?.bullets ?? [];
  assert.deepEqual(
    deals.map((b) => b.text),
    ["Bank A agreed to buy Bank B."],
    "the hidden story's bullet is gone, text and link together",
  );
  assert.ok(
    !JSON.stringify(after_).includes(rumour.link),
    "and nothing in what is served still links to the hidden story",
  );
  assert.equal(
    after_?.sections.find((s) => s.key === "markets")?.bullets.length,
    1,
    "a bullet standing on the day's official numbers cites no story and stays",
  );
});

test("a briefing whose every bullet was taken down is served as no briefing", async () => {
  const gone = await mkStory("Insurer D said to be weighing a deal");
  const piece: BriefingPiece = {
    scope: "insurance",
    generatedAt: NOW.toISOString(),
    headings: { deals: [{ text: "Insurer D is in talks.", sources: [cite(gone)] }] },
  };
  await h.db.insert(newsBriefings).values({ editionDate: EDITION, scope: "insurance", payload: piece, createdAt: NOW });
  assert.ok(await getBriefing(h.db, ["insurance"], NOW), "shown while the story stands");

  await hideEvent(h.db, gone.id, "reports");
  const served = await getBriefing(h.db, ["insurance"], NOW);
  const bullets = (served?.sections ?? []).flatMap((s) => s.bullets);
  assert.ok(
    bullets.every((b) => !b.sources.some((src) => src.link === gone.link)),
    "nothing left cites it",
  );
  assert.equal(
    served?.sections.some((s) => s.key === "deals"),
    false,
    "and a section with nothing left in it is not shown as an empty heading",
  );
});

test("a story hidden after the markets wrap was written stops being cited by it", async () => {
  const wrong = await mkStory("Oil said to be set for a squeeze");
  const right = await mkStory("The S&P 500 fell 0.4%");
  const wrap: MarketWrap = {
    slot: "close",
    generatedAt: NOW.toISOString(),
    bullets: [
      { text: "Oil is set for a squeeze, one report said.", sources: [cite(wrong)], data: [] },
      { text: "The S&P 500 fell 0.4%, Wire reported.", sources: [cite(right)], data: [] },
      { text: "The 10-year Treasury yield was 4.1% at the last close.", sources: [], data: ["US Treasury"] },
    ],
  };
  await h.db.insert(newsBriefings).values({ editionDate: EDITION, scope: "markets_close", payload: wrap, createdAt: NOW });
  assert.equal((await getMarketWrap(h.db, NOW))?.bullets.length, 3);

  await hideEvent(h.db, wrong.id, "admin: wrong");

  const served = await getMarketWrap(h.db, NOW);
  assert.deepEqual(
    served?.bullets.map((b) => b.text),
    ["The S&P 500 fell 0.4%, Wire reported.", "The 10-year Treasury yield was 4.1% at the last close."],
    "the bullet about the hidden story is gone; the data-only bullet stays",
  );
  assert.ok(!JSON.stringify(served).includes(wrong.link));
  assert.equal(served?.slot, "close", "and the wrap is otherwise untouched");
});
