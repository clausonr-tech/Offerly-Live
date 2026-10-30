// The boundary search, against a faked Internet Archive.
//
// This is the part of the Wayback feature that decides what date comes out,
// and it had no tests at all - the only way to reach it was over the network,
// so every rule in it was verified once by hand and never again. Those rules
// are not obvious, and each was added because a real window came out wrong:
//
//   - a year whose FIRST capture already has postings yields nothing, because
//     the opening happened before anything we can see. Without it, Kroll
//     produced "opens 2 January".
//   - a year whose LAST capture has no postings yields nothing, because there
//     is no boundary in the year at all.
//   - the search is a binary search, so a year of weekly captures costs about
//     six fetches rather than fifty-two.
//
// The fake archive here is a calendar of captures and a rule for what each one
// contained. No network, no sleeping.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findFirstInternshipSnapshot,
  deriveWindow,
  parseCdxTimestamp,
  cycleYearForDate,
  type Snapshot,
  type YearObservation,
} from "../../src/lib/monitoring/opening-history";

/** A capture on a given day of a given year. */
function snap(year: number, month: number, day: number): Snapshot {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    timestamp: `${year}${mm}${dd}120000`,
    original: "https://example.com/careers",
    digest: `${year}${mm}${dd}`,
  };
}

/** Weekly captures through a year. */
function weekly(year: number): Snapshot[] {
  const out: Snapshot[] = [];
  for (let week = 0; week < 52; week++) {
    const d = new Date(Date.UTC(year, 0, 1 + week * 7));
    out.push(snap(year, d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return out;
}

const BOARD = (...titles: string[]) =>
  `<html><body>${titles.map((t, i) => `<li><a href="/j/${i}">${t}</a></li>`).join("")}</body></html>`;

const EMPTY = BOARD("Vice President, Compliance", "Head of Operations");
const OPEN = BOARD("2027 Investment Banking Summer Analyst", "2027 Summer Associate - M&A");

/**
 * A fake archive: internships appear on `openFrom` and stay.
 *
 * Monotonic within a season, which is the assumption the binary search is
 * built on and is documented as an assumption rather than a fact.
 */
function archive(openFrom: string, html = OPEN) {
  const calls: string[] = [];
  const fetchHtml = async (s: Snapshot) => {
    calls.push(s.timestamp);
    return s.timestamp >= openFrom ? html : EMPTY;
  };
  return { fetchHtml, calls };
}

const run = (
  snapshots: Snapshot[],
  year: number,
  fetchHtml: (s: Snapshot) => Promise<string | null>,
  sector?: Parameters<typeof findFirstInternshipSnapshot>[2],
) => findFirstInternshipSnapshot(snapshots, year, sector, { fetchHtml, gapMs: 0 });

// -------------------------------------------------------------- the boundary

test("a clean boundary is found", async () => {
  const { fetchHtml } = archive("20250901");
  const found = await run(weekly(2025), 2025, fetchHtml);
  assert.ok(found);
  assert.equal(found.year, 2025);
  // The first capture at or after the opening, not an arbitrary one.
  assert.ok(found.firstSeen.getTime() >= Date.UTC(2025, 8, 1));
  assert.ok(found.firstSeen.getTime() < Date.UTC(2025, 8, 10));
});

test("the observation carries the title it was read from", async () => {
  const { fetchHtml } = archive("20250901");
  const found = await run(weekly(2025), 2025, fetchHtml);
  assert.match(found!.matched, /Summer/);
});

test("the observation carries a checkable archive URL", async () => {
  // Every claim quotes its evidence - a reviewer must be able to open the page
  // as it actually stood and disagree.
  const found = await run(weekly(2025), 2025, archive("20250901").fetchHtml);
  assert.match(found!.snapshotUrl, /web\.archive\.org/);
  assert.match(found!.snapshotUrl, /example\.com/);
});

test("a board that opens late in the year is still found", async () => {
  const found = await run(weekly(2025), 2025, archive("20251201").fetchHtml);
  assert.ok(found);
  assert.ok(found.firstSeen.getTime() >= Date.UTC(2025, 11, 1));
});

// ------------------------------------------------------------- the refusals

test("a year whose first capture already has postings yields nothing", async () => {
  // The Kroll rule. A boundary you cannot see inside your window is not a
  // boundary you get to report - without this the search returns the year's
  // first capture and calls it the opening, producing "opens 2 January".
  const { fetchHtml } = archive("20240101");
  assert.equal(await run(weekly(2025), 2025, fetchHtml), null);
});

test("a year whose last capture has no postings yields nothing", async () => {
  // Nothing opened in this year, so there is no boundary to find.
  const { fetchHtml } = archive("20990101");
  assert.equal(await run(weekly(2025), 2025, fetchHtml), null);
});

test("a year with no captures yields nothing", async () => {
  const { fetchHtml } = archive("20250901");
  assert.equal(await run(weekly(2025), 2023, fetchHtml), null);
});

test("an empty snapshot list yields nothing", async () => {
  assert.equal(await run([], 2025, archive("20250901").fetchHtml), null);
});

test("a year with a single capture yields nothing either way", async () => {
  // One capture cannot show a transition, whichever side of it we are on.
  for (const openFrom of ["20240101", "20250901", "20990101"]) {
    assert.equal(await run([snap(2025, 6, 1)], 2025, archive(openFrom).fetchHtml), null, openFrom);
  }
});

test("a snapshot that will not fetch counts as no postings", async () => {
  // A failed fetch must not read as "the board was open" - that would move the
  // boundary earlier on nothing but an Archive outage.
  const fetchHtml = async (s: Snapshot) => (s.timestamp >= "20250901" ? OPEN : null);
  const found = await run(weekly(2025), 2025, fetchHtml);
  assert.ok(found);
  assert.ok(found.firstSeen.getTime() >= Date.UTC(2025, 8, 1));
});

test("a year where every fetch fails yields nothing", async () => {
  assert.equal(await run(weekly(2025), 2025, async () => null), null);
});

// --------------------------------------------------------------- the cost

test("the search is logarithmic, not linear", async () => {
  // 52 captures answered in roughly six probes plus the two boundary checks.
  // A linear scan would cost 52 and answer the same question.
  const { fetchHtml, calls } = archive("20250901");
  await run(weekly(2025), 2025, fetchHtml);
  assert.ok(calls.length <= 10, `${calls.length} fetches`);
  assert.ok(calls.length >= 3, `${calls.length} fetches looks too few to be a search`);
});

test("the probe cap is honoured on a very dense year", async () => {
  // 365 daily captures must not become 365 requests.
  const daily: Snapshot[] = [];
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.UTC(2025, 0, 1 + i));
    daily.push(snap(2025, d.getUTCMonth() + 1, d.getUTCDate()));
  }
  const { fetchHtml, calls } = archive("20250901");
  await run(daily, 2025, fetchHtml);
  assert.ok(calls.length <= 12, `${calls.length} fetches`);
});

test("captures given out of order are sorted before searching", async () => {
  // CDX output order is not guaranteed, and a binary search over unsorted
  // input returns an arbitrary capture with total confidence.
  const shuffled = [...weekly(2025)].reverse();
  const found = await run(shuffled, 2025, archive("20250901").fetchHtml);
  assert.ok(found);
  assert.ok(found.firstSeen.getTime() >= Date.UTC(2025, 8, 1));
  assert.ok(found.firstSeen.getTime() < Date.UTC(2025, 8, 10));
});

test("captures from other years are ignored", async () => {
  const mixed = [...weekly(2024), ...weekly(2025), ...weekly(2026)];
  const found = await run(mixed, 2025, archive("20250901").fetchHtml);
  assert.ok(found);
  assert.equal(found.year, 2025);
});

// ------------------------------------------------------------ per industry

test("one industry's boundary is found independently of another's", async () => {
  // The whole reason the search takes an industry: a firm's banking programme
  // and its real estate programme are not one event.
  const fetchHtml = async (s: Snapshot) => {
    if (s.timestamp >= "20251101") {
      return BOARD("2027 Investment Banking Summer Analyst", "2027 Real Estate Summer Analyst");
    }
    if (s.timestamp >= "20250801") return BOARD("2027 Investment Banking Summer Analyst");
    return EMPTY;
  };

  const banking = await findFirstInternshipSnapshot(weekly(2025), 2025, "investment_banking", {
    fetchHtml,
    gapMs: 0,
  });
  const realEstate = await findFirstInternshipSnapshot(weekly(2025), 2025, "real_estate", {
    fetchHtml,
    gapMs: 0,
  });

  assert.ok(banking);
  assert.ok(realEstate);
  assert.ok(banking.firstSeen < realEstate.firstSeen, "banking opened first and should read earlier");
  assert.ok(banking.firstSeen.getTime() >= Date.UTC(2025, 7, 1));
  assert.ok(realEstate.firstSeen.getTime() >= Date.UTC(2025, 10, 1));
});

test("an industry never present yields nothing, even on a busy board", async () => {
  const fetchHtml = async (s: Snapshot) =>
    s.timestamp >= "20250801" ? BOARD("2027 Investment Banking Summer Analyst") : EMPTY;
  const found = await findFirstInternshipSnapshot(weekly(2025), 2025, "hedge_fund", {
    fetchHtml,
    gapMs: 0,
  });
  assert.equal(found, null);
});

test("the firm-wide search is not narrowed by an industry it was not given", async () => {
  const fetchHtml = async (s: Snapshot) =>
    s.timestamp >= "20250801" ? BOARD("2027 Summer Analyst") : EMPTY;
  // No sector: an unclassifiable title still counts as the firm posting.
  const anyIndustry = await run(weekly(2025), 2025, fetchHtml);
  assert.ok(anyIndustry, "firm-wide search should still find it");
  // With a sector: that title names no industry, so there is nothing to find.
  const banking = await findFirstInternshipSnapshot(weekly(2025), 2025, "investment_banking", {
    fetchHtml,
    gapMs: 0,
  });
  assert.equal(banking, null);
});

// ------------------------------------------- the search feeding deriveWindow

test("two searched years become a window", async () => {
  // Each year needs its OWN opening date: a fetcher that reports "open" for
  // all of 2025 would trip the first-capture rule and yield nothing, which is
  // correct behaviour and not what this test is about.
  const y2024 = await run(weekly(2024), 2024, async (s) =>
    s.timestamp >= "20240901" ? OPEN : EMPTY,
  );
  const y2025 = await run(weekly(2025), 2025, async (s) =>
    s.timestamp >= "20250903" ? OPEN : EMPTY,
  );
  assert.ok(y2024 && y2025);

  const window = deriveWindow([y2024, y2025], new Date("2026-06-01T00:00:00Z"));
  assert.ok(window, "two consistent Septembers should yield a window");
  assert.equal(window.opensStart.getUTCMonth(), 7, "padding should put the start in August");
  assert.equal(window.observations.length, 2);
});

test("two searched years that disagree wildly yield no window", async () => {
  const january = await run(weekly(2024), 2024, async (s) =>
    s.timestamp >= "20240115" ? OPEN : EMPTY,
  );
  const november = await run(weekly(2025), 2025, async (s) =>
    s.timestamp >= "20251101" ? OPEN : EMPTY,
  );
  assert.ok(january && november);
  // Ten months apart is a shrug with dates on it, not a prediction.
  assert.equal(deriveWindow([january, november], new Date("2026-06-01T00:00:00Z")), null);
});

test("a window derived from searched years quotes both snapshots", async () => {
  const a = await run(weekly(2024), 2024, async (s) => (s.timestamp >= "20240901" ? OPEN : EMPTY));
  const b = await run(weekly(2025), 2025, async (s) => (s.timestamp >= "20250908" ? OPEN : EMPTY));
  const window = deriveWindow([a!, b!], new Date("2026-06-01T00:00:00Z"));
  assert.ok(window);
  assert.match(window.evidence, /web\.archive\.org/);
  assert.equal((window.evidence.match(/web\.archive\.org/g) ?? []).length, 2);
});

// -------------------------------------------------------------- date helpers

test("a CDX timestamp is read as UTC", () => {
  const d = parseCdxTimestamp("20250918143000");
  assert.equal(d?.toISOString(), "2025-09-18T14:30:00.000Z");
});

const badTimestamps = ["", "2025", "not-a-timestamp", "20251301120000", "202509181430000"];
for (const ts of badTimestamps) {
  test(`a malformed timestamp is null, never a wrong date: ${JSON.stringify(ts)}`, () => {
    assert.equal(parseCdxTimestamp(ts), null);
  });
}

test("the cycle convention: autumn looks two summers ahead", () => {
  // Finance recruits roughly eighteen months out, which is why the axis starts
  // in the year before the internship.
  assert.equal(cycleYearForDate(new Date("2025-09-18T00:00:00Z")), 2027);
  assert.equal(cycleYearForDate(new Date("2026-01-15T00:00:00Z")), 2027);
});

test("the search and the cycle convention agree on a real September opening", () => {
  // A board opening in September 2025 is recruiting for Summer 2027, and the
  // window derived from it must say so - a window filed under the wrong cycle
  // is shown to the wrong students.
  const observation: YearObservation = {
    year: 2025,
    firstSeen: new Date("2025-09-18T00:00:00Z"),
    snapshotUrl: "https://web.archive.org/web/20250918120000id_/https://example.com/careers",
    matched: "2027 Summer Analyst",
  };
  const window = deriveWindow(
    [observation, { ...observation, year: 2024, firstSeen: new Date("2024-09-20T00:00:00Z") }],
    new Date("2026-06-01T00:00:00Z"),
  );
  assert.ok(window);
  assert.equal(window.cycleYear, cycleYearForDate(new Date("2026-06-01T00:00:00Z")));
});

// ------------------------------------- component rollover in CDX timestamps

const rollovers: [string, string][] = [
  ["month 13", "20251301120000"],
  ["month 00", "20250001120000"],
  ["day 32", "20250132120000"],
  ["day 00", "20250100120000"],
  ["31 February", "20250231120000"],
  ["hour 25", "20250101250000"],
  ["minute 61", "20250101126100"],
  ["second 61", "20250101120061"],
];
for (const [name, ts] of rollovers) {
  test(`a rolled-over component is refused, not silently corrected: ${name}`, () => {
    // Date.UTC does not validate - month 13 becomes January of the NEXT year,
    // day 32 becomes the 1st of the next month. None is NaN, so these were
    // returned as confident dates up to a year wrong, and that date becomes
    // the day the crawler starts watching a firm.
    assert.equal(parseCdxTimestamp(ts), null, ts);
  });
}

const validEdges: [string, string][] = [
  ["new year midnight", "20250101000000"],
  ["last second of the year", "20251231235959"],
  ["leap day", "20240229120000"],
  ["end of a 31-day month", "20250131120000"],
  ["end of a 30-day month", "20250430120000"],
];
for (const [name, ts] of validEdges) {
  test(`a real boundary date still parses: ${name}`, () => {
    // The validation must not start refusing legitimate timestamps - that
    // would silently drop real observations.
    assert.ok(parseCdxTimestamp(ts), ts);
  });
}

test("29 February in a non-leap year is refused", () => {
  assert.equal(parseCdxTimestamp("20250229120000"), null);
  assert.ok(parseCdxTimestamp("20240229120000"), "2024 is a leap year");
});
