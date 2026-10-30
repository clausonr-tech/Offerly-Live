// 210 generated cases for the changes of 5 October 2026 that are pure rules:
// the firm reminders' names, the article-photo finder, WordPress originals,
// the standing training answer, the bell's names line, and Discovery's
// Internships route. Each is checked against an independent reference or an
// invariant. Seeded, so a failure is repeatable: the case number is the seed.
//
// The database-backed half is session-changes-stress-db.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { normalizeFirmName } from "@/lib/firm-name";
import {
  NAMES_SHOWN,
  generatedDetail,
  generatedTitle,
  peopleLine,
  unreachedByFirm,
  type ContactRow,
} from "@/lib/generated-reminders";
import { toNotificationList, type NotificationRow } from "@/lib/notifications";
import { articleImages, fullSizeUrl } from "@/lib/news/page-image";
import { TRAINING_STANDING_KINDS, standingTraining } from "@/lib/video-interview/consent";
import { VIDEO_POLICY_VERSION } from "@/lib/video-interview/types";

// nav-sections imports lucide-react; stubbed as in help-and-routing.test.ts.
{
  const lucidePath = require.resolve("lucide-react");
  const stub = new Module(lucidePath);
  stub.filename = lucidePath;
  stub.loaded = true;
  stub.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
  require.cache[lucidePath] = stub;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NAV_SECTIONS, sectionFor, subsectionFor } = require("../../src/lib/nav-sections") as typeof import("../../src/lib/nav-sections");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { helpFor } = require("../../src/lib/help-guide") as typeof import("../../src/lib/help-guide");

const DAY = 86_400_000;

/** mulberry32: small, fast, and the same sequence for the same seed. */
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
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
type R = ReturnType<typeof rng>;

async function cases(t: { test: (name: string, fn: () => void) => Promise<void> }, n: number, salt: number, check: (r: R, i: number) => void) {
  for (let i = 1; i <= n; i++) await t.test(`case ${i}`, () => check(rng(i * 7919 + salt), i));
}

// ---------------------------------------------------------------- 1. Firm reminders (50)

const NAMES = ["Jane Doe", "jane doe", " JANE DOE ", "Sam Lee", "Priya Nair", "Ana", "Luis  Ortega", "O'Brien Kelly", "Zoë Müller", "Li Wei", "Al Roe", "Bea Cho"];
const FIRMS = ["PJT Partners", "pjt partners", "Evercore", "Moelis & Company", "Lazard", "KBW (Keefe, Bruyette & Woods)"];

test("1. Firm reminders: every person left is listed once, lead first, and the title names the firm", async (t) => {
  await cases(t, 50, 1, (r) => {
    const now = new Date(Date.UTC(2026, 9, 5, 12));
    const rows: ContactRow[] = Array.from({ length: r.int(1, 16) }, (_, j) => ({
      id: `c${j}`,
      name: r.pick(NAMES),
      firm: r.pick(FIRMS),
      enrichedAt: r.chance(0.75) ? new Date(now.getTime() - r.int(0, 12) * DAY - r.int(0, 23) * 3_600_000) : null,
      relationshipStatus: r.chance(0.75) ? "not_contacted" : r.pick(["reached_out", "replied"]),
    }));
    const got = unreachedByFirm(rows, normalizeFirmName, now);
    for (const f of got) {
      // Reference: everyone at this firm, by person, not written to on any copy.
      const atFirm = rows.filter((x) => x.firm && normalizeFirmName(x.firm) === f.firmKey);
      const reached = new Map<string, boolean>();
      for (const x of atFirm) {
        const k = x.name.trim().toLowerCase();
        reached.set(k, (reached.get(k) ?? false) || x.relationshipStatus !== "not_contacted");
      }
      const left = [...reached].filter(([, v]) => !v).map(([k]) => k);
      const keys = f.people.map((p) => p.trim().toLowerCase());

      assert.equal(new Set(keys).size, keys.length, "nobody listed twice");
      assert.deepEqual([...keys].sort(), [...left].sort(), "exactly the people not yet written to");
      assert.equal(f.people.length, f.others + 1);
      assert.equal(f.people[0], f.lead.name, "the lead first, spelled as the lead's row");
      for (const p of f.people) {
        assert.equal(p, p.trim(), "no stray outer spaces");
        assert.ok(atFirm.some((x) => x.name.trim() === p), `"${p}" is a spelling a row actually has`);
      }

      const title = generatedTitle(f);
      assert.ok(title.endsWith(` at ${f.firmName}`), "names the firm");
      assert.equal(title, f.people.length === 1 ? `Email ${f.people[0]} at ${f.firmName}` : `Email ${f.people.length} people at ${f.firmName}`);
      const detail = generatedDetail(f);
      if (f.people.length === 1) assert.equal(detail, `You found them ${f.days} days ago`);
      else {
        assert.equal(detail, peopleLine(f.people));
        const shown = Math.min(f.people.length, NAMES_SHOWN);
        for (const p of f.people.slice(0, shown)) assert.ok(detail.includes(p), `${p} is named`);
        if (f.people.length > NAMES_SHOWN) assert.ok(detail.endsWith(`and ${f.people.length - NAMES_SHOWN} more`));
      }
    }
  });
});

// ---------------------------------------------------------------- 2. Article photos (60)

const HOST = "https://www.example-news.com";
const PAGE = `${HOST}/2026/10/apollo-expands-daily-pricing/`;

type Piece = { html: string; own?: string };

function photo(r: R, n: number): string {
  return `${r.pick(["https://cdn.example-news.com", HOST, ""])}/uploads/2026/10/photo-${n}.${r.pick(["jpg", "jpeg", "png", "webp"])}`;
}

/** An image tag, quoted or not, with a size the finder accepts. */
function img(r: R, src: string): string {
  const q = r.pick(['"', "'", ""]);
  return `<img src=${q}${src}${q} width="${r.int(600, 1600)}" height="${r.int(340, 900)}"${r.chance(0.3) ? ' alt="A trading floor"' : ""}>`;
}

/** A link around an own photo that still means "this photo": a lightbox or this same article. */
function ownLink(r: R, src: string): [string, string] {
  const abs = src.startsWith("http") ? src : `${HOST}${src}`;
  const href = r.pick([
    abs, // lightbox to the file itself
    `${abs}?w=2000`,
    PAGE,
    PAGE.replace(/\/$/, ""),
    PAGE.replace("https://www.", "https://"),
    `${PAGE}#comments`,
    `${PAGE}?utm_source=x`,
    "/2026/10/apollo-expands-daily-pricing/",
    "#top",
    "javascript:void(0)",
  ]);
  const q = r.pick(['"', "'", ""]);
  return [`<a href=${q}${href}${q}>`, "</a>"];
}

/** A link around a photo that sends the reader to some other page. */
function otherLink(r: R): [string, string] {
  const href = r.pick([
    `${HOST}/2026/10/baillie-gifford-tokenised-bond/`,
    "/2026/09/otcx-goes-live/",
    "/",
    "https://www.partner-site.com/promo",
    `${HOST}/category/markets/`,
    "/2026/09/otcx-goes-live", // no trailing slash
  ]);
  const q = r.pick(['"', "'", ""]);
  return [`<a href=${q}${href}${q}>`, "</a>"];
}

function piece(r: R, n: number): Piece {
  const src = photo(r, n);
  switch (r.int(0, 6)) {
    case 0:
      return { html: `<figure>${img(r, src)}<figcaption>Caption</figcaption></figure>`, own: src };
    case 1: {
      const [o, c] = ownLink(r, src);
      return { html: `<figure>${o}${img(r, src)}${c}</figure>`, own: src };
    }
    case 2: {
      // A related-stories tile: an image linking to another story, in a rail
      // whose class names say nothing.
      const [o, c] = otherLink(r);
      return { html: `<div class="c-other-events-box"><ol class="c-list"><li class="c-item">${o}${img(r, src)}${c}</li></ol></div>` };
    }
    case 3: {
      const [o, c] = otherLink(r);
      return { html: `<p>${o}${img(r, src)}${c}</p>` };
    }
    case 4:
      return { html: `<div class="${r.pick(["ad-slot", "related-posts", "js-slider", "swiper-wrapper", "newsletter-signup"])}">${img(r, src)}</div>` };
    case 5:
      return { html: `<p>${r.pick(["Apollo said on Monday it would expand", "The firm declined to comment", "Shares rose 2%"])}...</p>` };
    default:
      return { html: `<aside>${img(r, src)}</aside>` };
  }
}

test("2. Article photos: the article's own photos in order, never another story's tile, an ad or a rail", async (t) => {
  await cases(t, 60, 2, (r) => {
    const pieces = Array.from({ length: r.int(1, 9) }, (_, j) => piece(r, j));
    const html = `<html><head><title>x</title></head><body><nav><a href="/"><img src="/logo.png" width="900" height="400"></a></nav>` +
      `<main class="l-main"><article>${pieces.map((p) => p.html).join("\n")}</article></main></body></html>`;
    const want = [...new Set(pieces.filter((p) => p.own).map((p) => new URL(p.own!, PAGE).toString()))].slice(0, 6);
    const got = articleImages(html, PAGE).map((c) => c.url);
    assert.deepEqual(got, want);
  });
});

// ---------------------------------------------------------------- 3. WordPress originals (30)

test("3. WordPress originals: a sized copy leads to its upload, anything else to nothing", async (t) => {
  await cases(t, 30, 3, (r) => {
    const stem = r.pick(["bond-markets-target-intraday-pricing-e1493324931690", "photo", "iStock-528903376", "Depositphotos_85317600_l-2015", "a-300x200-chart", "scaled-image-scaled"]);
    const ext = r.pick(["jpg", "JPG", "jpeg", "png", "webp", "avif"]);
    const host = r.pick(["https://www.marketsmedia.com", "https://i0.wp.com/site.com", "http://cdn.example.org"]);
    const query = r.pick(["", "?ver=2", "?resize=150%2C150&ssl=1"]);
    const sized = r.chance(0.7);
    const w = r.int(10, 2560);
    const h = r.int(10, 2560);
    const url = `${host}/wp-content/uploads/2014/09/${stem}${sized ? `-${w}x${h}` : ""}.${ext}${query}`;
    const got = fullSizeUrl(url);
    if (!sized) {
      // "a-300x200-chart" carries a size mid-name, not at the end: not a copy.
      assert.equal(got, null, url);
      return;
    }
    assert.equal(got, `${host}/wp-content/uploads/2014/09/${stem}.${ext}`, url);
    assert.ok(!got!.includes("?"), "the query was for the copy");
  });
});

// ---------------------------------------------------------------- 4. Standing training answer (30)

test("4. Standing training answer: the newest standing row under the current policy, nothing else", async (t) => {
  const KINDS = ["analysis_granted", "training_granted", "training_revoked", TRAINING_STANDING_KINDS.yes, TRAINING_STANDING_KINDS.no] as const;
  await cases(t, 30, 4, (r) => {
    const base = Date.UTC(2026, 9, 1);
    const rows = Array.from({ length: r.int(0, 10) }, (_, j) => ({
      kind: r.pick(KINDS),
      version: r.chance(0.7) ? VIDEO_POLICY_VERSION : r.pick(["2026-09-29", "2025-01-01"]),
      at: new Date(base - j * 3_600_000), // newest first, as getConsentState orders them
    }));
    const ref = rows.find((x) => (x.kind === TRAINING_STANDING_KINDS.yes || x.kind === TRAINING_STANDING_KINDS.no) && x.version === VIDEO_POLICY_VERSION);
    const got = standingTraining(rows);
    if (!ref) return assert.equal(got, null);
    assert.deepEqual(got, { choice: ref.kind === TRAINING_STANDING_KINDS.yes ? "yes" : "no", decidedAt: ref.at.toISOString() });
  });
});

// ---------------------------------------------------------------- 5. The bell's names line (20)

test("5. Bell: only an open firm reminder carries a names line, and it is its own detail", async (t) => {
  await cases(t, 20, 5, (r) => {
    const rows = Array.from({ length: r.int(1, 8) }, (_, j) => {
      const kind = r.pick(["outreach", "thank_you", "interview_prep", "application_deadline"] as const);
      const key = kind === "outreach" ? r.pick(["generated:kkr", "generated:moelis", "outreach:kkr:2026-10-09", "apply:kkr:2026-10-09"]) : `${kind}:${j}`;
      return {
        id: `n${j}`,
        userId: "u",
        kind,
        dedupeKey: `${key}#${j}`.replace(/#\d+$/, j % 2 ? "" : ""),
        subjectKey: null,
        title: `Title ${j}`,
        body: r.pick(["Forrest Liu, Jessica Zhang and 3 more", "", "You found them 4 days ago"]),
        href: "/x",
        createdAt: new Date(0),
        bumpedAt: new Date(1000 * j),
        readAt: null,
        doneAt: r.chance(0.2) ? new Date() : null,
        doneSource: null,
        expiresAt: null,
      } as unknown as NotificationRow;
    });
    const list = toNotificationList(rows);
    for (const item of list.open) {
      const row = rows.find((x) => x.id === item.id)!;
      const want = row.kind === "outreach" && row.dedupeKey.startsWith("generated:") && row.body ? row.body : null;
      assert.equal(item.subline, want);
    }
    assert.ok(list.open.every((i) => !rows.find((x) => x.id === i.id)!.doneAt), "done rows are not listed");
  });
});

// ---------------------------------------------------------------- 6. Discovery's Internships route (20)

test("6. Routes: Internships and tracking light up Internships; firms light up Firms; nothing else leaks", async (t) => {
  const discovery = NAV_SECTIONS.find((s) => s.href === "/discovery")!;
  assert.deepEqual(discovery.children!.map((c) => c.label), ["Internships", "Firms"], "Internships sits above Firms");
  await cases(t, 20, 6, (r) => {
    const path = r.pick([
      "/discovery/internships",
      "/discovery/internships/",
      "/tracking",
      "/tracking/abc",
      "/discovery/firms",
      "/discovery/firm/evercore",
      "/discovery",
      "/discovery/investment_banking",
      "/discovery/investment_banking/internships",
      "/discovery/internshipsx",
      "/trackingx",
    ]);
    const clean = path.length > 1 ? path.replace(/\/$/, "") : path;
    const section = sectionFor(clean);
    const want: Record<string, [string | null, string | null, string | null]> = {
      // path: [section, subsection, help href]
      "/discovery/internships": ["Discovery", "Internships", "/discovery/internships"],
      "/tracking": ["Discovery", "Internships", "/discovery/internships"],
      "/tracking/abc": ["Discovery", "Internships", "/discovery/internships"],
      "/discovery/firms": ["Discovery", "Firms", "/discovery/firms"],
      "/discovery/firm/evercore": ["Discovery", "Firms", "/discovery/firms"],
      "/discovery": ["Discovery", null, "/discovery"],
      "/discovery/investment_banking": ["Discovery", null, "/discovery"],
      "/discovery/investment_banking/internships": ["Discovery", null, "/discovery"],
      "/discovery/internshipsx": ["Discovery", null, "/discovery"],
      "/trackingx": [null, null, null],
    };
    const [s, sub, help] = want[clean];
    assert.equal(section?.label ?? null, s, clean);
    assert.equal(section ? subsectionFor(section, clean)?.label ?? null : null, sub, clean);
    assert.equal(helpFor(path)?.href ?? null, help, path);
  });
});
