/**
 * Three students take a story down - three MAILBOXES, not three strings.
 *
 * recordReport hides a story for everyone once three verified school addresses
 * have reported it. It used to count the addresses with only a "+tag" removed,
 * and school verification only checks that the exact lowercased string is not
 * already verified on another account. So one person who receives mail at
 * several spellings of one inbox - dots on a Google-hosted school domain, the
 * first.last and netid aliases a school issues, a sub-domain of an allowlisted
 * domain - could verify each spelling on its own account and count as several
 * people, and three of those could hide any story for every student.
 *
 * A REAL database: PGlite migrated by replaying drizzle/*.sql, so the schools
 * allowlist and the reports table are the real ones. No network, no model.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { newsClusters, newsItems, newsSources, schools, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { readTab } from "@/lib/news/read";
import { REPORTS_TO_HIDE, mailboxKey, recordReport } from "@/lib/news/takedown";

let h: TestDatabase;
const NOW = new Date();

before(async () => {
  h = await createTestDb();
  await h.db.insert(newsSources).values({ id: "wire", name: "Wire", domain: "wire.example", tier: "major", sectors: [], kind: "rss", url: "https://wire.example/feed" });
  await h.db.insert(schools).values([
    { name: "Example University", emailDomain: "x.edu" },
    { name: "Other University", emailDomain: "y.edu" },
  ]);
});
after(async () => {
  await h.close();
});

let seq = 0;

async function mkUser(schoolEmail: string): Promise<string> {
  seq += 1;
  const [u] = await h.db
    .insert(users)
    .values({
      email: `rep-${seq}-${Date.now()}@example.com`,
      passwordHash: "x",
      name: `Student ${seq}`,
      schoolEmail,
      schoolEmailVerifiedAt: NOW,
    })
    .returning({ id: users.id });
  return u.id;
}

async function mkStory(title: string): Promise<{ id: string; link: string }> {
  seq += 1;
  const link = `https://wire.example/r-${seq}`;
  const [row] = await h.db
    .insert(newsItems)
    .values({ sourceId: "wire", urlHash: `r-${seq}`, url: link, title, publisher: "Wire", publishedAt: NOW, titleKey: `r-${seq}`, origin: "rss", status: "labeled" })
    .returning();
  const [cluster] = await h.db
    .insert(newsClusters)
    .values({ leadItemId: row.id, sectors: ["investment_banking"], firstSeenAt: NOW, lastSeenAt: NOW, scores: { main: 1 + seq / 100 } })
    .returning();
  await h.db.update(newsItems).set({ clusterId: cluster.id }).where(eq(newsItems.id, row.id));
  return { id: row.id, link };
}

const onMain = async () => (await readTab(h.db, null, 50, NOW)).map((s) => s.link);

test("the spellings of one inbox reduce to one mailbox key", () => {
  const allowed = new Set(["x.edu", "y.edu"]);
  const one = mailboxKey("a.b@x.edu", allowed);
  assert.equal(mailboxKey("ab@x.edu", allowed), one, "dots in the local part are not a different inbox");
  assert.equal(mailboxKey("a.b+report@x.edu", allowed), one, "nor is a +tag");
  assert.equal(mailboxKey("A.B@X.EDU", allowed), one, "nor is the case");
  assert.equal(mailboxKey("a.b@dept.x.edu", allowed), one, "nor a sub-domain the school also issues from");
  assert.equal(mailboxKey("a.b@x.edu.", allowed), one, "nor a trailing dot");

  assert.notEqual(mailboxKey("c.d@x.edu", allowed), one, "a different student is still a different mailbox");
  assert.notEqual(mailboxKey("a.b@y.edu", allowed), one, "and so is the same name at another school");
  assert.equal(
    mailboxKey("a.b@notx.edu", allowed),
    "ab@notx.edu",
    "a domain on no school's list keeps its whole host - guessing which part is registrable would merge two schools",
  );
  assert.equal(mailboxKey("a.b@sub.notx.edu", allowed), "ab@sub.notx.edu");
});

test("one inbox under several spellings cannot take a story down", async () => {
  const story = await mkStory("Real news, targeted");
  for (const spelling of ["a.b@x.edu", "ab@x.edu", "a.b+1@x.edu", "a.b@dept.x.edu", "AB@x.edu"]) {
    await recordReport(h.db, await mkUser(spelling), story.id, "wrong");
  }
  assert.ok((await onMain()).includes(story.link), "five accounts, one mailbox, the story stands");
});

test(`${REPORTS_TO_HIDE} students at the same school still take a story down`, async () => {
  const rumour = await mkStory("Fund C said to weigh sale");
  assert.deepEqual(await recordReport(h.db, await mkUser("first.student@x.edu"), rumour.id, "wrong"), { hidden: false });
  assert.deepEqual(await recordReport(h.db, await mkUser("second.student@x.edu"), rumour.id, "wrong"), { hidden: false });
  assert.ok((await onMain()).includes(rumour.link), "two is not enough, as before");
  assert.deepEqual(await recordReport(h.db, await mkUser("third.student@x.edu"), rumour.id, "offensive"), { hidden: true });
  assert.ok(!(await onMain()).includes(rumour.link));
});

test("students at different schools, and sub-domain addresses, still count as themselves", async () => {
  const story = await mkStory("Another rumour");
  await recordReport(h.db, await mkUser("one@x.edu"), story.id, "wrong");
  await recordReport(h.db, await mkUser("one@y.edu"), story.id, "wrong");
  assert.ok((await onMain()).includes(story.link));
  // A real student whose school issues from a sub-domain is a third person.
  assert.deepEqual(await recordReport(h.db, await mkUser("two@dept.y.edu"), story.id, "wrong"), { hidden: true });
});
