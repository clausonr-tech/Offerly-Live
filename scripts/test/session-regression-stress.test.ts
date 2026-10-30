// 500 generated cases each for the parts of the outreach and expected-roles
// work that the other stress suites reach only indirectly. Seeded: a failing
// case number is its seed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roleCycleKey, shiftTitleYears, shiftYears } from "@/lib/expected-postings";
import { firmResolver } from "@/lib/firm-name";
import { unreachedByFirm, type ContactRow } from "@/lib/generated-reminders";
import { LABEL_TONES, toneForNotification } from "@/lib/label-colors";
import { safeNotificationHref } from "@/lib/notifications";
import { readRows } from "../import-historical-releases";

const CASES = 500;
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

async function cases(t: { test: (name: string, fn: () => void) => Promise<void> }, check: (r: ReturnType<typeof rng>) => void) {
  for (let i = 1; i <= CASES; i++) await t.test(`case ${i}`, () => check(rng(i * 2654435761)));
}

test("A. Titles and dates carried across cycles come back unchanged, and stay the same role", async (t) => {
  const SHAPES = [
    "{Y} Summer Analyst - M&A",
    "Class of {G} Investment Banking Intern ('{g})",
    "Summer {Y} Associate Program – New York",
    "Investment Banking Analyst Intern (London), June - August",
    "{Y}/{G} Off-Cycle Internship",
  ];
  await cases(t, (r) => {
    const y = r.int(2024, 2031);
    const title = r
      .pick(SHAPES)
      .replaceAll("{Y}", String(y))
      .replaceAll("{G}", String(y + 1))
      .replaceAll("{g}", String((y + 1) % 100).padStart(2, "0"));
    const d = r.int(1, 3);
    const forward = shiftTitleYears(title, d);
    assert.equal(shiftTitleYears(forward, -d), title, "shifting back does not restore the title");
    assert.equal(roleCycleKey(forward, "New York"), roleCycleKey(title, "New York"), "a shifted title is a different role");
    assert.notEqual(roleCycleKey(title, "New York"), roleCycleKey(title, "London"), "two cities are one role");
    if (/\b20\d\d\b/.test(title)) assert.notEqual(forward, title);

    const date = new Date(Date.UTC(y, r.int(0, 11), r.int(1, 28)));
    const moved = shiftYears(date, d);
    assert.equal(moved.getUTCFullYear(), y + d);
    assert.equal(moved.getUTCMonth(), date.getUTCMonth());
    assert.equal(moved.getUTCDate(), date.getUTCDate());
    assert.equal(shiftYears(moved, -d).getTime(), date.getTime());
  });
});

test("B. The history importer keeps exactly the readable rows and names every skipped one", async (t) => {
  await cases(t, (r) => {
    const lines = ["Firm,Role,Location,Program Year,Released On,Due On"];
    let good = 0;
    let bad = 0;
    const n = r.int(1, 12);
    for (let i = 0; i < n; i++) {
      const year = r.int(2024, 2029);
      const kind = r.int(0, 5);
      const released = `${year - 1}-0${r.int(6, 9)}-1${r.int(0, 9)}`;
      if (kind === 0) {
        lines.push(`,Summer Analyst,,${year},${released},`);
        bad++;
      } else if (kind === 1) {
        lines.push(`Evercore,Summer Analyst,,${year},not a date,`);
        bad++;
      } else if (kind === 2) {
        lines.push(`Evercore,Summer Analyst,,${year},${released},${year - 2}-01-01`);
        bad++;
      } else {
        // Quoted fields with commas must survive.
        lines.push(`"Moelis & Company","${year} Summer Analyst, Restructuring","New York, NY",${r.chance(0.5) ? year : ""},${released},`);
        good++;
      }
    }
    const { rows, skipped } = readRows(lines.join("\n"));
    assert.equal(rows.length, good);
    assert.equal(skipped.length, bad);
    for (const row of rows) {
      assert.match(row.releasedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(row.roleTitle.includes(","), "a quoted comma was split");
      assert.equal(row.location, "New York, NY");
      assert.ok(row.programYear >= 2024 && row.programYear <= 2029);
    }
    for (const s of skipped) assert.ok(s.line >= 2 && s.why.length > 0);
  });
});

test("C. Reminders count a firm once, however its contacts wrote its name", async (t) => {
  const resolve = firmResolver([
    { name: "Centerview Partners", aliases: ["CVP", "Centerview"] },
    { name: "Moelis & Company", aliases: ["Moelis"] },
  ]);
  const SPELLINGS = ["Centerview Partners", "CVP", "Centerview", "centerview partners ", "Moelis & Company", "Moelis"];
  await cases(t, (r) => {
    const now = new Date(Date.UTC(2026, 8, 24, 12));
    const rows: ContactRow[] = Array.from({ length: r.int(1, 10) }, (_, j) => ({
      id: `c${j}`,
      name: r.pick(["Jane Doe", "Sam Lee", "Ana Park"]),
      firm: r.pick(SPELLINGS),
      enrichedAt: new Date(now.getTime() - r.int(3, 10) * DAY),
      relationshipStatus: r.chance(0.3) ? "reached_out" : "not_contacted",
    }));
    const out = unreachedByFirm(rows, resolve, now);
    const keys = out.map((f) => f.firmKey);
    assert.equal(new Set(keys).size, keys.length, "one firm listed twice");
    assert.ok(keys.every((k) => k === resolve("Centerview Partners") || k === resolve("Moelis & Company")));
    for (const f of out) assert.ok(f.others >= 0 && f.others < 3, "a person counted twice");
  });
});

test("D. Every notification kind gets a colour, and the banner's colour is its chip's", async (t) => {
  const KINDS = ["outreach", "interview_prep", "follow_up", "thank_you", "firm_posting", "firm_event", "application_deadline", "", null, undefined, "something_new"];
  await cases(t, (r) => {
    const kind = r.pick(KINDS);
    const tone = toneForNotification(kind as string | null | undefined);
    const colours = LABEL_TONES[tone];
    assert.ok(colours, `no colours for ${String(kind)}`);
    for (const c of [colours.fg, colours.bg, colours.tint]) assert.match(c, /^#[0-9a-f]{6}$/);
    // The banner fill is the tint at 95% opacity: a valid 8-digit hex.
    assert.match(`${colours.tint}f2`, /^#[0-9a-f]{8}$/);
  });
});

test("E. A job's link is always a page: a path here or an http(s) address", async (t) => {
  const GOOD = ["/discovery/firm/pjt-partners", "/outreach/email?occasion=thanks&box=thanks.chat", "https://evercore.tal.net/apply?x=1", "http://example.com/jobs"];
  // The shapes a scheme check passes and the shared policy does not. A
  // notification's href is rendered in six places as `href={item.href}`, which
  // the link sweep accepts on the NAME rather than on a guard, so this function
  // is the only boundary those six have - it now calls externalHref rather than
  // a regular expression of its own.
  const BAD = ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "mailto:a@b.com", "//evil.com/x", "", "   ", "evercore.com", "vbscript:x",
    // A host disguised as a path by userinfo: the real host is attacker.example.
    "https://evercore.com@attacker.example/apply",
    // A bare address, a private suffix, a port no job board uses, an all-digit label.
    "http://10.0.0.5/jobs", "https://jenkins.internal/apply", "http://evercore.com:22/apply", "http://127.0.0.1.nip.io/x",
    // The in-app path shapes that a single-slash test lets through.
    "/\\evil.example/x", "/\tevil.example"];
  await cases(t, (r) => {
    const pad = r.pick(["", " ", "\t"]);
    if (r.chance(0.5)) {
      const g = r.pick(GOOD);
      assert.equal(safeNotificationHref(pad + g + pad), g);
    } else {
      assert.equal(safeNotificationHref(pad + r.pick(BAD) + pad), "/notifications");
    }
  });
});
