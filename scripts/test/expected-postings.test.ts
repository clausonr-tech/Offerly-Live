import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expectedDueLabel,
  expectedLabel,
  careersLink,
  firmNameKey,
  isCarryableTitle,
  projectExpected,
  roleCycleKey,
  shiftTitleYears,
  shiftYears,
  stillAhead,
  type HistoricalRelease,
  type PastPosting,
} from "@/lib/expected-postings";
import { readDay, readRows } from "../import-historical-releases";

const DAY = 86_400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}

const FIRMS = [
  { id: "f1", name: "Evercore", slug: "evercore", website: "evercore.com" },
  { id: "f2", name: "Moelis & Company", slug: "moelis", website: "moelis.com" },
  { id: "f3", name: "Robert W. Baird", slug: "baird", website: "rwbaird.com" },
];
const ROLES = [
  "{Y} Summer Analyst - M&A",
  "Summer Analyst, Restructuring ({Y})",
  "Class of {G} Investment Banking Intern",
  "Investment Banking Summer Associate",
  "{Y} Capital Markets Summer Analyst Program - New York",
];
const CITIES = ["New York", "London", null, "Houston"];

test("500 cases: each role is carried forward once, from its newest cycle, with years and dates moved and nothing claimed open", async (t) => {
  for (let i = 1; i <= 500; i++) {
    await t.test(`case ${i}`, () => {
      const r = rng(i * 104729);
      const targetYear = r.int(2027, 2030);
      const past: PastPosting[] = Array.from({ length: r.int(0, 10) }, (_, j) => {
        const firm = r.pick(FIRMS);
        const programYear = targetYear - r.int(0, 3);
        const title = r.pick(ROLES).replace("{Y}", String(programYear)).replace("{G}", String(programYear + 1));
        const seen = new Date(Date.UTC(programYear - 1, r.int(5, 10), r.int(1, 28)));
        return {
          id: `p${i}-${j}`,
          firmId: firm.id,
          firmName: firm.name,
          firmSlug: firm.slug,
          firmWebsite: firm.website,
          roleTitle: title,
          location: r.pick(CITIES),
          categories: ["investment_banking"],
          programYear,
          eligibleGradYears: r.chance(0.5) ? [] : [programYear + 1],
          deadlineStatus: r.pick(["confirmed", "tbd", "rolling", "closed"]),
          deadlineDate: r.chance(0.6) ? new Date(seen.getTime() + r.int(-10, 90) * DAY) : null,
          opensAt: r.chance(0.3) ? new Date(seen.getTime() - r.int(0, 20) * DAY) : null,
          firstSeenAt: seen,
          descriptionFull: "An analyst class in M&A.",
          requirementsFull: null,
          careersUrl: r.chance(0.5) ? "https://careers.example.com" : null,
        };
      });
      const existing = past.filter(() => r.chance(0.15)).map((p) => ({
        firmId: p.firmId,
        roleTitle: shiftTitleYears(p.roleTitle, targetYear - p.programYear),
        location: p.location,
      }));
      const history: HistoricalRelease[] = past
        .filter(() => r.chance(0.3))
        .map((p) => ({
          firmName: r.chance(0.5) ? p.firmName.toUpperCase() : p.firmName,
          roleTitle: p.roleTitle,
          location: p.location,
          programYear: p.programYear,
          releasedOn: `${p.programYear - 1}-0${r.int(6, 9)}-1${r.int(0, 9)}`,
          dueOn: r.chance(0.5) ? `${p.programYear - 1}-11-15` : null,
        }));

      const out = projectExpected({ past, existing, targetYear, history });
      const keyOf = (firmId: string, title: string, loc: string | null) => `${firmId}#${roleCycleKey(title, loc)}`;
      const takenKeys = new Set([
        ...existing.map((e) => keyOf(e.firmId, e.roleTitle, e.location)),
        ...past.filter((p) => p.programYear === targetYear).map((p) => keyOf(p.firmId, p.roleTitle, p.location)),
      ]);
      const seenKeys = new Set<string>();

      for (const e of out) {
        const src = past.find((p) => p.id === e.sourcePostingId)!;
        const k = keyOf(src.firmId, src.roleTitle, src.location);
        assert.ok(!takenKeys.has(k), "projected over a real posting for this cycle");
        assert.ok(!seenKeys.has(k), "the same role twice");
        seenKeys.add(k);
        assert.ok(src.programYear < targetYear, "carried from the same or a later cycle");
        const newest = Math.max(
          ...past.filter((p) => p.programYear < targetYear && keyOf(p.firmId, p.roleTitle, p.location) === k).map((p) => p.programYear),
        );
        assert.equal(src.programYear, newest, "not from the newest cycle");

        const delta = targetYear - src.programYear;
        assert.equal(e.programYear, targetYear);
        assert.equal(e.roleTitle, shiftTitleYears(src.roleTitle, delta));
        assert.ok(!new RegExp(`\\b${src.programYear}\\b`).test(e.roleTitle) || delta === 0 || src.roleTitle.includes(String(targetYear)), `old year left in "${e.roleTitle}"`);
        assert.deepEqual(e.eligibleGradYears, src.eligibleGradYears.map((y) => y + delta));
        assert.ok(e.id.startsWith("expected:"), "an expected id can never be taken for a posting id");
        assert.ok(e.careersUrl.startsWith("https://"), e.careersUrl);

        const hist = history
          .filter((h) => h.programYear < targetYear && firmNameKey(h.firmName) === firmNameKey(src.firmName) && roleCycleKey(h.roleTitle, h.location) === roleCycleKey(src.roleTitle, src.location))
          .sort((a, b) => b.programYear - a.programYear)[0];
        if (e.basis === "history") {
          assert.ok(hist, "history basis without a history row");
          assert.equal(e.expectedOpensAt!.toISOString().slice(5, 10), hist!.releasedOn.slice(5, 10), "history date not kept");
        } else if (e.basis === "posted_dates") {
          assert.ok(!hist && src.opensAt);
          assert.equal(e.expectedOpensAt!.getTime(), shiftYears(src.opensAt!, delta).getTime());
        } else {
          assert.ok(!hist && !src.opensAt);
          assert.equal(e.expectedOpensAt!.getTime(), shiftYears(src.firstSeenAt, delta).getTime());
          assert.match(expectedLabel(e), /Expected to open by /, "a first-seen date is promised as 'by'");
        }
        if (e.expectedDueAt && e.expectedOpensAt) assert.ok(e.expectedDueAt >= e.expectedOpensAt, "due before it opens");
        const label = `${expectedLabel(e)} ${expectedDueLabel(e) ?? ""}`;
        assert.match(label, new RegExp(`based on ${e.basedOnYear}`));
        assert.doesNotMatch(label, /\bopen now\b|\bapply\b|is open/i, "an expected role reads as open");
      }
      // Everything carryable is carried.
      const carryable = new Set(past.filter((p) => p.programYear < targetYear).map((p) => keyOf(p.firmId, p.roleTitle, p.location)).filter((k) => !takenKeys.has(k)));
      assert.equal(out.length, carryable.size);
    });
  }
});

test("only internship-shaped titles are carried, never a careers-site placeholder", () => {
  for (const ok of ["2027 Summer Analyst - M&A", "Investment Banking Summer Associate", "Class of 2028 Intern", "Off-Cycle Internship Programme"]) {
    assert.ok(isCarryableTitle(ok), ok);
  }
  for (const bad of ["Join our Talent Community!", "2028 Boston, Massachusetts Investment Banking Apply Now", "General Application - Investment Banking", "Vice President, Coverage"]) {
    assert.ok(!isCarryableTitle(bad), bad);
  }
});

test("a careers link is only ever an http(s) address", () => {
  assert.equal(careersLink("https://careers.pjt.com/jobs", "pjt.com"), "https://careers.pjt.com/jobs");
  assert.equal(careersLink("javascript:alert(1)", "pjt.com"), "https://pjt.com");
  assert.equal(careersLink(" JAVASCRIPT:alert(1)", null), "");
  assert.equal(careersLink("mailto:jobs@pjt.com", "https://pjt.com"), "https://pjt.com");
  assert.equal(careersLink("/careers", "not a site"), "");
  assert.equal(careersLink(null, "evercore.com"), "https://evercore.com");
});

test("dates move whole years and keep their day, Feb 29 landing on Feb 28", () => {
  assert.equal(shiftYears(new Date("2027-08-03T00:00:00Z"), 1).toISOString().slice(0, 10), "2028-08-03");
  assert.equal(shiftYears(new Date("2028-02-29T00:00:00Z"), 1).toISOString().slice(0, 10), "2029-02-28");
  assert.equal(shiftTitleYears("2027 Summer Analyst, Class of 2028 ('28)", 2), "2029 Summer Analyst, Class of 2030 ('30)");
});

test("500 cases: the importer reads every accepted date shape and nothing else", async (t) => {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let i = 1; i <= 500; i++) {
    await t.test(`case ${i}`, () => {
      const r = rng(i * 7);
      const d = new Date(Date.UTC(r.int(2020, 2030), r.int(0, 11), r.int(1, 28)));
      const iso = d.toISOString().slice(0, 10);
      const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
      assert.equal(readDay(iso), iso);
      assert.equal(readDay(`${m}/${day}/${y}`), iso);
      assert.equal(readDay(`${MON[m - 1]} ${day}, ${y}`), iso);
      assert.equal(readDay(`${m}/${day}/${String(y).slice(2)}`), iso);
      assert.equal(readDay(`${y}-${m}-${day + 40}`), null, "an impossible day");
      assert.equal(readDay("soon"), null);
    });
  }
});

test("the importer keeps good rows and says why it skipped the rest", () => {
  const { rows, skipped } = readRows(
    [
      "Firm,Role,Location,Program Year,Released On,Due On",
      "Evercore,2027 Summer Analyst - M&A,New York,2027,8/3/2026,11/15/2026",
      "Moelis & Company,Summer Analyst 2027,,,2026-07-20,",
      ",No firm,,2027,2026-07-20,",
      "Lazard,Analyst,,2027,someday,",
      "PJT Partners,Analyst,,,2026-07-20,",
      "Baird,2027 Analyst,,2027,2026-09-01,2026-08-01",
    ].join("\n"),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    firmName: "Evercore",
    roleTitle: "2027 Summer Analyst - M&A",
    location: "New York",
    programYear: 2027,
    releasedOn: "2026-08-03",
    dueOn: "2026-11-15",
  });
  assert.equal(rows[1].programYear, 2027, "the year read from the title");
  assert.deepEqual(
    skipped.map((s) => s.why),
    ["no firm", 'released date "someday" not readable', "no program year (column or a year in the role)", "due before it was released"],
  );
});

test("an expected role is upcoming only while its opening is today or later, or unknown", () => {
  const at = (day: string) => ({ expectedOpensAt: new Date(`${day}T00:00:00Z`) });
  assert.equal(stillAhead(at("2026-09-13"), "2026-09-25"), false);
  assert.equal(stillAhead(at("2026-09-24"), "2026-09-25"), false);
  assert.equal(stillAhead(at("2026-09-25"), "2026-09-25"), true);
  assert.equal(stillAhead(at("2026-10-01"), "2026-09-25"), true);
  assert.equal(stillAhead({ expectedOpensAt: null }, "2026-09-25"), true);
  // Late on the opening day in UTC is still that day.
  assert.equal(stillAhead({ expectedOpensAt: new Date("2026-09-25T23:30:00Z") }, "2026-09-25"), true);
});
