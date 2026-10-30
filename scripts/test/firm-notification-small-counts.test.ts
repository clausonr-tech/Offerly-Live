/**
 * Migration 0047 removes exactly the firm notifications that name a group of
 * one to four students, and nothing else.
 *
 * WHY A CODE FIX WAS NOT ENOUGH. These rows are written with
 * `onConflictDoNothing` on (firm_id, dedupe_key), and flooring the counts did
 * not change the dedupe keys - so a row already saying "1 apply click so far"
 * can never be replaced by the corrected wording. It stays, and every approved
 * account at that firm is served it, newest first, with no age cut-off.
 *
 * WHY THIS TEST LOOKS LIKE THIS. The first version of the migration matched
 * invented patterns against `body`, and the first version of this test built a
 * grid of bodies and checked them against it. Both were wrong the same way: the
 * grid was a guess at what the old generator wrote, so the two agreed with each
 * other and not with the code. Reading the generator out of git instead shows
 * that the headline leak lives in `title`, that one clause could not match any
 * row that has ever existed, and that one matched the FIXED generator's own
 * output - deleting correct rows on every replay.
 *
 * So this test generates the rows from the generator rather than from
 * imagination. `src/lib/firm-insights-rules.ts` has existed in exactly four
 * versions; the templates below are read from them, and two of the leaks only
 * the earliest two could write. The counts run either side of the floor, and
 * the posting and event titles include ones that themselves contain small
 * numbers - "Analyst Program 2" is the case that makes a loose rule unsafe.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb } from "./helpers/test-db";

const TAG = "0047_firm_notification_small_counts";
const MIGRATION = readFileSync(`drizzle/${TAG}.sql`, "utf8");
/** The statements of the migration, as the deploy will run them. */
const statements = MIGRATION.split("--> statement-breakpoint")
  .map((p) => p.trim())
  .filter(Boolean);
/** The migration with its comments stripped - what actually runs. */
const SQL_ONLY = MIGRATION.replace(/^\s*--.*$/gm, "").trim();

/** Every version of the generator, oldest first. */
const VERSIONS = ["27d812b", "cf3fd3a", "7300929", "613637a~1"] as const;
const sourceOf = (rev: string): string =>
  execFileSync("git", ["show", `${rev}:src/lib/firm-insights-rules.ts`], {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });

const MIN_GROUP = 5;
/** The pre-fix number formatter: the real count, always. */
const plural = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
/** The post-fix one: the real count, or the words. */
const label = (n: number) => (n === 0 || n >= MIN_GROUP ? n.toLocaleString("en-US") : `Fewer than ${MIN_GROUP}`);

/** Firm-authored titles, including ones carrying their own small numbers. */
const FIRM_TITLES = [
  "Summer Analyst",
  "Analyst Program 2",
  "2027 Summer Analyst",
  "Coffee Chat 3",
  "Spring Week - 4 days",
];

type Row = { kind: string; title: string; body: string; leaks: boolean };

/** Every (title, body) the historical generators could produce. */
function historicalRows(): Row[] {
  const out: Row[] = [];
  const counts = [0, 1, 2, 3, 4, 5, 6, 10, 11, 50, 51, 120, 1000];
  for (const firm of FIRM_TITLES) {
    for (const n of counts) {
      const small = n >= 1 && n <= 4;
      // apply milestone: the line is 10 and up, so the count is too - but the
      // shape is the deadline body's, so it is generated for every count.
      out.push({
        kind: "milestone",
        title: `${firm} passed 10 apply clicks`,
        body: `${plural(n, "apply click")} so far.`,
        leaks: small,
      });
      // deadline
      out.push({
        kind: "deadline",
        title: `${firm} closes in ${plural(7, "day")}`,
        body: `${plural(n, "apply click")} so far. Edit the deadline if it has moved.`,
        leaks: small,
      });
      // reach, in the two earliest versions only
      out.push({
        kind: "reach",
        title: `${firm} reached ${plural(n, "matched student")}`,
        body: "Everyone matched with your firm who can apply was notified.",
        leaks: small,
      });
      // event saves milestone: the saves half is at or above the line, the
      // clicks half is not bounded below at all
      for (const clicks of counts) {
        out.push({
          kind: "milestone",
          title: `${plural(Math.max(MIN_GROUP, n), "student")} saved ${firm}`,
          body: `${plural(Math.max(MIN_GROUP, n), "calendar save")} and ${plural(clicks, "click")} so far.`,
          leaks: clicks >= 1 && clicks <= 4,
        });
      }
      // event_soon, earliest wording
      out.push({
        kind: "event_soon",
        title: `${firm} is coming up`,
        body: n > 0 ? `${plural(n, "student")} saved it to their calendar.` : "No calendar saves yet.",
        leaks: small,
      });
      // event_soon, later wording - the floor with the plural taken from the
      // real number, so only exactly one gives itself away
      out.push({
        kind: "event_soon",
        title: `${firm} is coming up`,
        body: n > 0 ? `${label(n)} ${n === 1 ? "student" : "students"} saved it to their calendar.` : "No calendar saves yet.",
        leaks: n === 1,
      });
      // surge
      out.push({
        kind: "surge",
        title: "Engagement is surging this week",
        body:
          n > 0
            ? `${plural(40, "click")} so far this week, against ${n.toLocaleString("en-US")} all of last week.`
            : `${plural(40, "click")} so far this week, up from none last week.`,
        leaks: small,
      });
      // weekly - the leak in the TITLE that body-matching could never see
      for (const pct of [null, 0, 3, 50, 200]) {
        out.push({
          kind: "weekly",
          title: `Last week: ${plural(n, "click")} on your posts`,
          body: pct === null ? "Apply clicks, event clicks and calendar saves combined." : `Up ${pct}% on the week before.`,
          leaks: small,
        });
      }
      // students milestone and team: never a small count
      out.push({
        kind: "students",
        title: `${Math.max(50, n).toLocaleString("en-US")} students have matched with your firm`,
        body: `${plural(Math.max(50, n), "student")} have you on their top-firms list.`,
        leaks: false,
      });
      out.push({
        kind: "team",
        title: "A Recruiter is waiting for approval",
        body: "Approve them on the Team page if they work with you.",
        leaks: false,
      });
    }
  }
  return out;
}

/** Every (title, body) the CURRENT generator can produce. None may be deleted. */
function currentRows(): Row[] {
  const out: Row[] = [];
  const counts = [0, 1, 2, 3, 4, 5, 6, 10, 50, 120];
  const mid = (n: number, noun: string) => {
    const t = `${label(n)} ${noun}`;
    return t.charAt(0).toLowerCase() + t.slice(1);
  };
  for (const firm of FIRM_TITLES) {
    for (const n of counts) {
      out.push({ kind: "milestone", title: `${firm} passed 10 apply clicks`, body: `${label(n)} apply clicks so far.`, leaks: false });
      out.push({
        kind: "deadline",
        title: `${firm} closes in ${plural(3, "day")}`,
        body: `${label(n)} apply clicks so far. Edit the deadline if it has moved.`,
        leaks: false,
      });
      out.push({
        kind: "reach",
        title: `${firm} reached ${n < MIN_GROUP ? `fewer than ${MIN_GROUP} matched students` : plural(n, "matched student")}`,
        body: "Everyone matched with your firm who can apply was notified.",
        leaks: false,
      });
      for (const clicks of counts) {
        out.push({
          kind: "milestone",
          title: `${plural(Math.max(MIN_GROUP, n), "student")} saved ${firm}`,
          body: `${label(n)} calendar saves and ${mid(clicks, "clicks")} so far.`,
          leaks: false,
        });
      }
      out.push({
        kind: "event_soon",
        title: `${firm} is coming up`,
        body: n > 0 ? `${label(n)} students saved it to their calendar.` : "No calendar saves yet.",
        leaks: false,
      });
      out.push({
        kind: "surge",
        title: "Engagement is surging this week",
        body: `${label(40)} clicks so far this week, against ${mid(n, "in all of last week")}.`,
        leaks: false,
      });
      for (const pct of [null, 3, 50]) {
        out.push({
          kind: "weekly",
          title: `Last week: ${label(n)} clicks on your posts`,
          body: pct === null ? "Apply clicks, event clicks and calendar saves combined." : `Up ${pct}% on the week before.`,
          leaks: false,
        });
      }
    }
  }
  return out;
}

test("the generator has had exactly the four versions this migration was written against", () => {
  const log = execFileSync("git", ["log", "--format=%h", "--follow", "--", "src/lib/firm-insights-rules.ts"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  // The fix itself, plus the four this migration enumerates. A fifth earlier
  // version means a template nobody has read, so the enumeration has to be
  // redone rather than assumed still complete.
  assert.ok(log.length <= 5, `the generator has ${log.length} versions; 0047 was written against 4 plus the fix`);
  for (const rev of VERSIONS) {
    assert.match(sourceOf(rev), /export type InsightSnapshot = \{/, `${rev} does not hold the generator`);
  }
});

test("exactly the leaking rows are deleted, and no row the fixed generator writes", async () => {
  const rows = [...historicalRows(), ...currentRows()];
  const leaking = rows.filter((r) => r.leaks);
  assert.ok(leaking.length > 300, `only ${leaking.length} leaking rows generated - the grid is not covering`);
  assert.ok(rows.length - leaking.length > 500, "not enough clean rows to prove the migration is narrow");

  const h = await createTestDb();
  try {
    const { rows: firms } = await h.client.query<{ id: string }>(
      `INSERT INTO firms (slug, name, headquarters, key_offices, website, description)
       VALUES ('leaky-bank', 'Leaky Bank', 'New York, NY', '{}', 'leakybank.test', 'A firm.')
       RETURNING id`,
    );
    const firmId = firms[0].id;

    for (const [i, r] of rows.entries()) {
      await h.client.query(
        `INSERT INTO firm_notifications (firm_id, dedupe_key, kind, title, body, href)
         VALUES ($1, $2, $3, $4, $5, '/firms/analytics')`,
        [firmId, `row-${i}`, r.kind, r.title, r.body],
      );
    }
    for (const statement of statements) await h.client.query(statement);

    const left = new Set(
      (await h.client.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM firm_notifications`)).rows.map(
        (r) => r.dedupe_key,
      ),
    );

    const survived = rows.filter((r, i) => r.leaks && left.has(`row-${i}`));
    assert.deepEqual(
      survived.slice(0, 5).map((r) => `${r.kind}: ${r.title} / ${r.body}`),
      [],
      `${survived.length} leaking rows survived`,
    );

    const wronglyDeleted = rows.filter((r, i) => !r.leaks && !left.has(`row-${i}`));
    assert.deepEqual(
      wronglyDeleted.slice(0, 5).map((r) => `${r.kind}: ${r.title} / ${r.body}`),
      [],
      `${wronglyDeleted.length} rows that leak nothing were deleted`,
    );

    // A replay is a no-op, which is what makes the migration safe to re-run:
    // the fixed generator cannot write any of these shapes, so there is nothing
    // left in range however long after the first run it happens.
    const before = left.size;
    for (const statement of statements) await h.client.query(statement);
    assert.equal(
      (await h.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM firm_notifications`)).rows[0].n,
      before,
      "a replay removed something the first run had left standing",
    );
    assert.doesNotMatch(SQL_ONLY, /now\(\)|current_timestamp/i, "no clock: the patterns alone decide, on any run");
  } finally {
    await h.close();
  }
});

test("the fixed generator floors every count it prints, in titles as well as bodies", () => {
  // The migration cleans up the past; this keeps the future clean, and its
  // absence is why the leak in the weekly TITLE went unnoticed through two
  // passes. Every count about students goes through
  // counted/countedMid/countLabel/reach - never plural(), which prints the real
  // number and is for things that are not about students, like days remaining.
  const current = readFileSync("src/lib/firm-insights-rules.ts", "utf8");
  const countThroughPlural = /plural\(\s*[A-Za-z0-9_.]*(click|student|save|appl)[A-Za-z0-9_.]*\s*,/i;
  assert.doesNotMatch(
    current,
    countThroughPlural,
    "a count about students is going through plural(), which prints the real number",
  );
  // Every pre-fix version must fail that check, or it proves nothing.
  for (const rev of VERSIONS) {
    assert.match(sourceOf(rev), countThroughPlural, `${rev} should fail this check - otherwise it is vacuous`);
  }
});
