// Adversarial tests for the help guide, the links the app builds into the
// drafter, the copy-counts-as-send rule, the bell's pure rules and the time
// zone cookie.
//
// The point of these is the seams: a help link to a page that does not exist,
// a query string a page silently ignores, a key that does not survive its own
// round trip, a cookie that throws. Pure, no database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import Module from "node:module";
import type { HelpSection } from "../../src/lib/help-guide";
import { SEND_COPY_SHARE, copyCountsAsSend } from "../../src/lib/copy-send";
import { autoCloseable, toNotificationList, type NotificationRow } from "../../src/lib/notifications";
import {
  MAX_EMAILS,
  followUpHref,
  followUpNotificationKey,
  followUpSubjectKey,
  ordinal,
  parseFollowUpSubject,
} from "../../src/lib/outreach-ladder";
import { thankYouHref, thankYouKey, thankYouSubjectKey } from "../../src/lib/thank-you";
import { OCCASIONS, boxById, occasionById } from "../../src/lib/draft-occasions";
import { QUIZ_CATEGORIES } from "../../src/lib/question-bank/types";
import { CATEGORY_LABELS as NEWS_CATEGORY_LABELS } from "../../src/lib/firm-metadata";
import { DEFAULT_TIME_ZONE, parseTimeZone, timeZoneCookieString, TZ_COOKIE } from "../../src/lib/time-zone";
import { readFileSync } from "node:fs";

// help-guide imports nav-sections, which imports lucide-react for the sidebar
// icons. Under --conditions=react-server (needed for "server-only" in
// notifications.ts) lucide's createContext does not exist, so the icons are
// stubbed before the guide is loaded. The guide never touches them.
{
  const lucidePath = require.resolve("lucide-react");
  const stub = new Module(lucidePath);
  stub.filename = lucidePath;
  stub.loaded = true;
  stub.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
  require.cache[lucidePath] = stub;
}
// require(), not import: the lucide stub above has to be in the cache before
// these modules load, and a static import would be hoisted above it.
const { HELP_SECTIONS, RECRUITING_PATH, helpFor, searchHelp } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/lib/help-guide") as typeof import("../../src/lib/help-guide");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NAV_SECTIONS } = require("../../src/lib/nav-sections") as typeof import("../../src/lib/nav-sections");

// ---------------------------------------------------------------------------
// Routes on disk
// ---------------------------------------------------------------------------

const APP_DIR = join(process.cwd(), "src", "app", "(app)");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (name === "page.tsx" || name === "page.ts") out.push(full);
  }
  return out;
}

/** One regex per routable page, following Next's folder rules. */
const ROUTES: { pattern: RegExp; path: string }[] = pageFiles(APP_DIR)
  .map((file) => relative(APP_DIR, file).split(sep).slice(0, -1))
  // A folder starting with "_" is private: not a route.
  .filter((segs) => !segs.some((s) => s.startsWith("_")))
  .map((segs) => {
    const kept = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    const re = kept
      .map((s) => {
        if (s.startsWith("[[...")) return "(?:/.*)?";
        if (s.startsWith("[...")) return "/.+";
        if (s.startsWith("[")) return "/[^/]+";
        return "/" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return { pattern: new RegExp(`^${re || "/"}$`), path: "/" + kept.join("/") };
  });

function isRoute(pathname: string): boolean {
  return ROUTES.some((r) => r.pattern.test(pathname));
}

const SCHEDULE_SRC = readFileSync(join(APP_DIR, "schedule", "page.tsx"), "utf8");
const PREFILL_TYPES: string[] = (() => {
  const m = /const PREFILL_TYPES = \[([\s\S]*?)\]/.exec(SCHEDULE_SRC);
  assert.ok(m, "PREFILL_TYPES not found in schedule/page.tsx");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();

// Discovery's tabs are gone; `?tab=` survives only as the legacy values the
// hub still forwards to where each view lives now. Read from the page so a
// forward that is dropped fails here rather than silently landing on the hub.
const DISCOVERY_SRC = readFileSync(join(APP_DIR, "discovery", "page.tsx"), "utf8");
const DISCOVERY_TABS = [...DISCOVERY_SRC.matchAll(/tab === "([a-z_]+)"/g)].map((m) => m[1]);

const NEWS_CATEGORIES = Object.keys(NEWS_CATEGORY_LABELS);

/** What is wrong with this help href, or null. */
function hrefProblem(href: string): string | null {
  if (!href.startsWith("/")) return "not absolute";
  if (/\s|#/.test(href)) return "has whitespace or a fragment";
  const url = new URL(href, "https://offerly.test");
  if (url.pathname !== "/" && url.pathname.endsWith("/")) return "trailing slash";
  if (!isRoute(url.pathname)) return `no page at ${url.pathname}`;
  for (const [k, v] of url.searchParams) {
    const where = `${url.pathname}?${k}=${v}`;
    if (url.pathname === "/learn") {
      if (k !== "category") return `${where}: /learn reads only category`;
      if (!(QUIZ_CATEGORIES as readonly string[]).includes(v)) return `${where}: not a quiz category`;
    } else if (url.pathname === "/schedule") {
      if (k !== "type" && k !== "title") return `${where}: /schedule reads only type/title`;
      if (k === "type" && !PREFILL_TYPES.includes(v)) return `${where}: not a PREFILL_TYPE`;
    } else if (url.pathname === "/news") {
      if (k !== "category") return `${where}: /news reads only category`;
      if (!NEWS_CATEGORIES.includes(v)) return `${where}: not a news category`;
    } else if (url.pathname === "/discovery") {
      if (k === "tab" && !DISCOVERY_TABS.includes(v)) return `${where}: not a Discovery tab`;
    } else {
      return `${where}: this page reads no query string the guide knows about`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sanity of the harness itself (so a broken matcher cannot pass everything)
// ---------------------------------------------------------------------------

test("harness: the route matcher knows real pages and rejects made-up ones", () => {
  assert.ok(isRoute("/dashboard"));
  assert.ok(isRoute("/contacts/123"));
  assert.ok(isRoute("/discovery/firm/evercore"));
  assert.ok(!isRoute("/_home"), "private folder is not a route");
  assert.ok(!isRoute("/contacts/123/edit"));
  assert.ok(!isRoute("/alerts"));
  assert.ok(!isRoute("/networking/contact"));
});

test("harness: read the schedule prefill types and discovery tabs from source", () => {
  assert.ok(PREFILL_TYPES.includes("interview"));
  assert.ok(PREFILL_TYPES.includes("coffee_chat"));
  assert.ok(DISCOVERY_TABS.includes("firms"));
  assert.ok(DISCOVERY_TABS.includes("contacts"));
  assert.ok(DISCOVERY_TABS.includes("internships"));
  assert.ok(NEWS_CATEGORIES.includes("investment_banking"));
});

// ---------------------------------------------------------------------------
// HELP_SECTIONS / RECRUITING_PATH integrity
// ---------------------------------------------------------------------------

for (const section of HELP_SECTIONS) {
  test(`help integrity: every link in "${section.label}" (${section.href}) goes to a real page with params it reads`, () => {
    const problems = [section.href, ...section.tasks.map((t) => t.href)]
      .map((h) => [h, hrefProblem(h)] as const)
      .filter(([, p]) => p);
    assert.deepEqual(problems, []);
  });
}

for (const step of RECRUITING_PATH) {
  test(`recruiting path: "${step.title}" links to a real page (${step.href})`, () => {
    assert.equal(hrefProblem(step.href), null);
  });
}

test("help integrity: no section repeats a task label", () => {
  for (const s of HELP_SECTIONS) {
    const labels = s.tasks.map((t) => t.label.toLowerCase());
    assert.equal(new Set(labels).size, labels.length, `duplicate label in ${s.label}`);
  }
});

test("help integrity: no two sections share an href, and none has an empty label/summary/task list", () => {
  const hrefs = HELP_SECTIONS.map((s) => s.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const s of HELP_SECTIONS) {
    assert.ok(s.label.trim(), s.href);
    assert.ok(s.summary.trim(), s.href);
    assert.ok(s.tasks.length > 0, s.href);
    for (const t of s.tasks) assert.ok(t.label.trim() && t.href.trim(), `${s.href}: blank task`);
  }
});

test("help integrity: alsoCovers never claims another section's own href", () => {
  const own = new Set(HELP_SECTIONS.map((s) => s.href));
  for (const s of HELP_SECTIONS) {
    for (const p of s.alsoCovers ?? []) {
      assert.ok(!own.has(p), `${s.href} alsoCovers ${p}, which is its own section`);
      assert.ok(p.startsWith("/") && !p.endsWith("/"), `${s.href} alsoCovers malformed ${p}`);
    }
  }
});

test("help integrity: every alsoCovers prefix has at least one real page under it", () => {
  for (const s of HELP_SECTIONS) {
    for (const p of s.alsoCovers ?? []) {
      assert.ok(
        ROUTES.some((r) => r.path === p || r.path.startsWith(p + "/")),
        `${s.href} alsoCovers ${p}, but no page lives there`,
      );
    }
  }
});

test("help integrity: every NAV_SECTIONS entry (and child) has its own help section", () => {
  const all = NAV_SECTIONS.flatMap((s) => [s, ...(s.children ?? [])]);
  for (const n of all) {
    const h = helpFor(n.href);
    assert.ok(h, `${n.href} has no help`);
    assert.equal(h.href, n.href, `${n.href} falls back to ${h.href}'s help`);
    assert.equal(h.label, n.label, `${n.href}: help calls it "${h.label}", the sidebar "${n.label}"`);
  }
});

test("help integrity: every routable page except admin and help itself has help", () => {
  const uncovered = ROUTES.map((r) => r.path)
    .filter((p) => !p.startsWith("/admin") && p !== "/help")
    // A concrete path for each dynamic page.
    .map((p) => p.replace(/\[[^\]]+\]/g, "x"))
    .filter((p) => !helpFor(p));
  assert.deepEqual(uncovered, []);
});

test("help integrity: recruiting path steps have titles and bodies, and are not duplicated", () => {
  const titles = RECRUITING_PATH.map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length);
  for (const s of RECRUITING_PATH) assert.ok(s.title.trim() && s.body.trim());
});

// ---------------------------------------------------------------------------
// helpFor
// ---------------------------------------------------------------------------

const hrefOf = (p: string) => helpFor(p)?.href ?? null;

test("helpFor: each section's own href maps to itself", () => {
  for (const s of HELP_SECTIONS) assert.equal(hrefOf(s.href), s.href);
});

test("helpFor: /newsletter is not News, /newsroom is not News", () => {
  assert.equal(hrefOf("/newsletter"), null);
  assert.equal(hrefOf("/newsroom"), null);
});

test("helpFor: /learning, /schedules, /outreachy, /dashboards, /profiles do not borrow a section by prefix", () => {
  for (const p of ["/learning", "/schedules", "/outreachy", "/dashboards", "/profiles", "/notificationsx"]) {
    assert.equal(hrefOf(p), null, p);
  }
});

test("helpFor: alsoCovers prefixes do not leak either (/drafting, /settingsx, /users, /contactsheet)", () => {
  for (const p of ["/drafting", "/settingsx", "/users", "/contactsheet", "/messagesx", "/trackingx", "/applicationsx"]) {
    assert.equal(hrefOf(p), null, p);
  }
});

test("helpFor: longest prefix wins for nested networking pages", () => {
  assert.equal(hrefOf("/networking/peers"), "/networking/peers");
  assert.equal(hrefOf("/networking/compose"), "/networking");
  assert.equal(hrefOf("/networking/post"), "/networking");
});

test("helpFor: a lookalike child path falls back to the hub, not the child", () => {
  assert.equal(hrefOf("/networking/peersx"), "/networking");
  assert.equal(hrefOf("/networking/messagesque"), "/networking");
});

test("helpFor: alsoCovers maps to the owning section", () => {
  assert.equal(hrefOf("/drafts"), "/outreach");
  assert.equal(hrefOf("/drafts/abc"), "/outreach");
  assert.equal(hrefOf("/tracking"), "/discovery/internships");
  assert.equal(hrefOf("/applications/new"), "/dashboard");
  assert.equal(hrefOf("/applications/123"), "/dashboard");
  assert.equal(hrefOf("/settings"), "/profile");
  assert.equal(hrefOf("/u/123"), "/networking");
  // Contacts' pages get Industry Contacts' own help, not Internal Network's.
  assert.equal(hrefOf("/contacts/new"), "/contacts");
  assert.equal(hrefOf("/contacts/company/evercore"), "/contacts");
});

test("helpFor: profile sub-pages get the account help", () => {
  assert.equal(hrefOf("/profile/interests"), "/profile");
  assert.equal(hrefOf("/profile/connections"), "/profile");
});

test("helpFor: discovery sub-pages get the discovery help", () => {
  assert.equal(hrefOf("/discovery/investment_banking"), "/discovery");
  assert.equal(hrefOf("/discovery/investment_banking/internships"), "/discovery");
  assert.equal(hrefOf("/discovery/firm/evercore"), "/discovery/firms");
  assert.equal(hrefOf("/discovery/internships"), "/discovery/internships");
});

test("helpFor: a trailing slash still matches", () => {
  assert.equal(hrefOf("/news/"), "/news");
  assert.equal(hrefOf("/contacts/"), "/contacts");
});

test("helpFor: root, empty and junk paths return null without throwing", () => {
  for (const p of ["", "/", "//", "dashboard", " /dashboard", "/%2Fdashboard", "?x=1", "#top", "/help", "/admin/monitoring"]) {
    assert.equal(hrefOf(p), null, JSON.stringify(p));
  }
});

test("helpFor: case matters - Next paths are case-sensitive", () => {
  assert.equal(hrefOf("/Dashboard"), null);
  assert.equal(hrefOf("/NEWS"), null);
});

test("helpFor: returns the same object as HELP_SECTIONS (no copies)", () => {
  const h = helpFor("/schedule");
  assert.ok(HELP_SECTIONS.includes(h as HelpSection));
});

test("helpFor: a pathname is never matched against a query-string href", () => {
  // No section's href or alsoCovers carries a query - helpFor takes pathnames.
  for (const s of HELP_SECTIONS) {
    for (const p of [s.href, ...(s.alsoCovers ?? [])]) assert.ok(!p.includes("?"), p);
  }
});

test("helpFor: a conversation page (/messages/<id>) gets the Messages help, not the hub's", () => {
  // /messages/[userId] is one conversation. The Messages section's summary is
  // "Your conversations with other students"; the hub's talks about the feed.
  assert.equal(hrefOf("/messages/9b2f1c1e-0000-4000-8000-000000000000"), "/networking/messages");
});

// ---------------------------------------------------------------------------
// searchHelp
// ---------------------------------------------------------------------------

const labels = (q: string, limit?: number) => searchHelp(q, limit).map((r) => r.task.label);

/** Independent oracle: tokenize both sides the same way. */
function oracleMatches(query: string): Set<string> {
  const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (!words.length) return out;
  for (const s of HELP_SECTIONS) {
    for (const t of s.tasks) {
      const parts = tok(`${t.label} ${t.keywords ?? ""} ${s.label}`);
      if (words.every((w) => parts.some((p) => p.startsWith(w)))) out.add(`${t.label}|${t.href}`);
    }
  }
  return out;
}

test("searchHelp: empty and whitespace-only queries return nothing", () => {
  for (const q of ["", " ", "\t\n", "     "]) {
    //   matches \s in JS, so it too is whitespace.
    assert.deepEqual(searchHelp(q), [], JSON.stringify(q));
  }
});

test("searchHelp: 'int' finds interviews and internships by word prefix", () => {
  const got = labels("int", 50);
  assert.ok(got.includes("Add an interview"));
  assert.ok(got.includes("Browse open internships"));
});

test("searchHelp: 'view' does not find 'interview' (mid-word is not a prefix)", () => {
  assert.ok(!labels("view", 50).includes("Add an interview"));
});

test("searchHelp: case-insensitive", () => {
  // Built from whatever the guide says today, so rewording it does not break
  // this: the first word of the first task, in three cases.
  const task = HELP_SECTIONS.flatMap((s) => s.tasks)[0];
  const word = task.label.split(/\s+/).find((w) => w.length > 3) ?? task.label;
  const mixed = [...word].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("");
  assert.deepEqual(labels(word.toUpperCase()), labels(word.toLowerCase()));
  assert.ok(labels(mixed).includes(task.label));
});

test("searchHelp: every word must match (AND, not OR)", () => {
  const got = labels("news calendar", 50);
  assert.deepEqual(got, [], "no task is about both");
});

test("searchHelp: word order does not matter", () => {
  assert.deepEqual(new Set(labels("contact add", 50)), new Set(labels("add contact", 50)));
});

test("searchHelp: a task listed under two sections appears once", () => {
  const got = labels("add a contact", 50);
  assert.equal(got.filter((l) => l === "Add a contact").length, 1);
});

test("searchHelp: never returns duplicates for any single-letter query", () => {
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") {
    const got = searchHelp(c, 1000).map((r) => `${r.task.label}|${r.task.href}`);
    assert.equal(new Set(got).size, got.length, c);
  }
});

test("searchHelp: default limit is 8, and an explicit limit is honoured", () => {
  assert.ok(searchHelp("a").length <= 8);
  assert.equal(searchHelp("a").length, 8, "'a' matches far more than 8 tasks");
  assert.equal(searchHelp("a", 3).length, 3);
  assert.deepEqual(searchHelp("a", 0), []);
});

test("searchHelp: the limit cuts the lowest-ranked, not arbitrary ones", () => {
  const all = searchHelp("a", 1000).map((r) => r.task.label);
  assert.deepEqual(labels("a", 5), all.slice(0, 5));
});

test("searchHelp: label hits rank above keyword-only hits", () => {
  const got = labels("calendar", 50);
  assert.equal(got[0], "Connect Google Calendar");
  assert.ok(got.includes("Add an interview"), "keyword-only hit still listed");
});

test("searchHelp: more label words matched ranks higher", () => {
  const got = labels("private equity", 50);
  assert.equal(got[0], "Private equity prep");
});

test("searchHelp: a section label counts as a match (every Schedule task for 'schedule')", () => {
  const got = new Set(labels("schedule", 50));
  const sched = HELP_SECTIONS.find((s) => s.href === "/schedule")!;
  for (const t of sched.tasks) assert.ok(got.has(t.label), t.label);
});

test("searchHelp: results agree with an independent oracle for many queries (with no limit)", () => {
  for (const q of ["a", "int", "contact", "add", "ib", "pe", "news", "write", "see", "find students", "resume", "prep", "follow", "google", "email"]) {
    const got = new Set(searchHelp(q, 1000).map((r) => `${r.task.label}|${r.task.href}`));
    assert.deepEqual(got, oracleMatches(q), q);
  }
});

test("searchHelp: ranking is non-increasing in label-word hits", () => {
  for (const q of ["add contact", "write email", "find", "see your", "track internship"]) {
    const words = q.split(" ");
    const score = (l: string) =>
      words.filter((w) => l.toLowerCase().split(/[^a-z0-9&]+/).some((p) => p.startsWith(w))).length;
    const s = searchHelp(q, 1000).map((r) => score(r.task.label));
    for (let i = 1; i < s.length; i++) assert.ok(s[i - 1] >= s[i], `${q}: ${s}`);
  }
});

test("searchHelp: regex metacharacters and hostile input do not throw", () => {
  for (const q of ["(", "[", "*", "\\", "a|b", ".*", "$^", "?", "+", "{2}", "%", "\u0000", "😀", "résumé"]) {
    assert.doesNotThrow(() => searchHelp(q), q);
  }
  assert.deepEqual(searchHelp(".*"), []);
});

test("searchHelp: a very long query returns quickly and empty", () => {
  const q = "x".repeat(100_000) + " " + "y ".repeat(10_000);
  const t0 = Date.now();
  assert.deepEqual(searchHelp(q), []);
  assert.ok(Date.now() - t0 < 1000);
});

test("searchHelp: tabs and newlines separate words like spaces", () => {
  assert.deepEqual(labels("connect\tcalendar"), labels("connect calendar"));
  assert.deepEqual(labels("connect\ncalendar"), labels("connect calendar"));
});

test("searchHelp: 'ib' finds both investment banking tasks", () => {
  const got = labels("ib", 50);
  assert.ok(got.includes("News for investment banking"));
  assert.ok(got.includes("Investment banking prep"));
});

test("searchHelp: '&' survives tokenising (no crash, no false hit)", () => {
  assert.deepEqual(searchHelp("&"), []);
});

test("searchHelp: every result carries the section it came from", () => {
  for (const r of searchHelp("a", 1000)) assert.ok(r.section.tasks.includes(r.task));
});

test("searchHelp: a hyphenated query matches the hyphenated label ('follow-up')", () => {
  // The label says "Write a follow-up". The haystack is split on "-", the query
  // is not, so "follow-up" is compared against "follow" and "up" and misses.
  assert.ok(labels("follow-up", 50).includes("Write a follow-up"));
});

test("searchHelp: 'thank-you' finds the thank-you note", () => {
  assert.ok(labels("thank-you", 50).includes("Write a thank-you note"));
});

test("searchHelp: an apostrophe in the query matches ('you're')", () => {
  assert.ok(labels("you're targeting", 50).includes("Add a firm you're targeting"));
});

test("searchHelp: trailing punctuation does not kill the match ('resume?')", () => {
  assert.ok(labels("resume?", 50).includes("Upload your resume"));
});

// ---------------------------------------------------------------------------
// copyCountsAsSend
// ---------------------------------------------------------------------------

test("copy: the share is 80%", () => {
  assert.equal(SEND_COPY_SHARE, 0.8);
});

test("copy: whole body counts, one sentence does not", () => {
  const body = "Hi Dana,\n\nI'm a sophomore at Michigan and would love 15 minutes of your time.\n\nBest,\nKai";
  assert.equal(copyCountsAsSend(body, body), true);
  assert.equal(copyCountsAsSend("would love 15 minutes of your time.", body), false);
});

test("copy: empty or whitespace-only body never counts", () => {
  for (const b of ["", " ", "\n\n", "\t \r\n"]) {
    assert.equal(copyCountsAsSend("anything", b), false, JSON.stringify(b));
    assert.equal(copyCountsAsSend(b, b), false, JSON.stringify(b));
  }
});

test("copy: empty or whitespace selection never counts on a real body", () => {
  assert.equal(copyCountsAsSend("", "Hello there"), false);
  assert.equal(copyCountsAsSend("     \n   ", "Hello there"), false);
});

test("copy: exactly 80% counts, one character less does not", () => {
  const body = "x".repeat(10);
  assert.equal(copyCountsAsSend("x".repeat(8), body), true);
  assert.equal(copyCountsAsSend("x".repeat(7), body), false);
});

test("copy: exact-80% boundary holds for every body length up to 5000 (no float drift)", () => {
  for (let n = 5; n <= 5000; n += 5) {
    const body = "y".repeat(n);
    assert.equal(copyCountsAsSend("y".repeat((n * 4) / 5), body), true, `n=${n}`);
    assert.equal(copyCountsAsSend("y".repeat((n * 4) / 5 - 1), body), false, `n=${n}`);
  }
});

test("copy: padding the selection with whitespace does not push it over", () => {
  const body = "x".repeat(10);
  assert.equal(copyCountsAsSend("   " + "x".repeat(7) + "\n\n\n", body), false);
});

test("copy: surrounding whitespace in the body is not counted against the selection", () => {
  const body = "\n\n\n\n\n\n\n\n\n\n" + "x".repeat(10) + "          ";
  assert.equal(copyCountsAsSend("x".repeat(8), body), true);
});

test("copy: emoji and non-Latin text are measured the same on both sides", () => {
  const body = "😀".repeat(10);
  assert.equal(copyCountsAsSend("😀".repeat(8), body), true);
  assert.equal(copyCountsAsSend("😀".repeat(7), body), false);
  const zh = "谢谢您的时间我很期待".repeat(3);
  assert.equal(copyCountsAsSend(zh, zh), true);
});

test("copy: a selection that is more than the body (subject + body) is not the body", () => {
  // Only copies out of the body textarea are checked (Composer.onCopy), so a
  // copy carrying text the body does not contain is not a copy of the email.
  const body = "Thanks for your time today, it was great to hear about the group.";
  assert.equal(copyCountsAsSend(`Thank you\n\n${body}`, body), false);
});

test("copy: CRLF body copied back as LF (textarea .value normalises) still counts for a normal email", () => {
  const lf = "Hi Dana,\n\nThanks again for the call on Tuesday. The deal story was great.\n\nBest,\nKai";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(copyCountsAsSend(lf, crlf), true);
  assert.equal(copyCountsAsSend(crlf, lf), true);
});

test("copy: line-ending style does not change the count", () => {
  // \r\n and \n are one line break either way: a short CRLF body's own LF
  // copy is the whole email.
  const crlf = "Hi,\r\n\r\nYes\r\n\r\nKai";
  const lf = crlf.replace(/\r\n/g, "\n");
  assert.equal(copyCountsAsSend(lf, crlf), true);
});

test("copy: copying the Subject field of a short body is not sending the email", () => {
  // Composer.onCopy reads any <input> inside the composer, the Subject and To
  // fields included. Text that is not in the body at all is not the email.
  const body = "Hi Dana, still free Tuesday?";
  const subject = "Following up on our coffee chat - Alex Rivera, Michigan '28";
  assert.equal(copyCountsAsSend(subject, body), false);
});

test("copy: pure function - same answer twice, no state", () => {
  const body = "abcdefghij";
  assert.equal(copyCountsAsSend("abcdefgh", body), copyCountsAsSend("abcdefgh", body));
});

// ---------------------------------------------------------------------------
// notifications (pure parts)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-22T12:00:00Z");

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n1",
    userId: "u1",
    kind: "outreach",
    dedupeKey: "outreach:evercore:2026-10-05",
    subjectKey: "evercore",
    title: "Email Evercore",
    body: "2 contacts still to email",
    href: "/contacts?q=Evercore",
    expiresAt: null,
    createdAt: NOW,
    bumpedAt: NOW,
    readAt: null,
    doneAt: null,
    doneSource: null,
    ...over,
  };
}

test("autoCloseable: zero remaining closes as auto", () => {
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 0]]), NOW), [{ id: "n1", source: "auto" }]);
});

test("autoCloseable: a subject missing from the map never closes", () => {
  assert.deepEqual(autoCloseable([row()], new Map(), NOW), []);
});

test("autoCloseable: remaining > 0 does not close", () => {
  assert.deepEqual(autoCloseable([row()], new Map([["evercore", 1]]), NOW), []);
});

test("autoCloseable: expiry exactly now counts as expired; one ms later does not", () => {
  assert.deepEqual(autoCloseable([row({ expiresAt: NOW })], new Map(), NOW), [{ id: "n1", source: "expired" }]);
  assert.deepEqual(autoCloseable([row({ expiresAt: new Date(NOW.getTime() + 1) })], new Map(), NOW), []);
});

test("autoCloseable: finished beats expired", () => {
  const got = autoCloseable([row({ expiresAt: new Date(0) })], new Map([["evercore", 0]]), NOW);
  assert.deepEqual(got, [{ id: "n1", source: "auto" }]);
});

test("autoCloseable: already-done rows are skipped even if finished and expired", () => {
  const got = autoCloseable([row({ doneAt: NOW, expiresAt: new Date(0) })], new Map([["evercore", 0]]), NOW);
  assert.deepEqual(got, []);
});

test("autoCloseable: a null or empty subject key never reads the map", () => {
  const m = new Map([["", 0]]);
  assert.deepEqual(autoCloseable([row({ subjectKey: null }), row({ id: "n2", subjectKey: "" })], m, NOW), []);
});

test("autoCloseable: rows sharing a subject all close together, each once", () => {
  const got = autoCloseable([row({ id: "a" }), row({ id: "b" })], new Map([["evercore", 0]]), NOW);
  assert.deepEqual(got.map((g) => g.id), ["a", "b"]);
});

test("toNotificationList: done rows drop out and counts match", () => {
  const list = toNotificationList([row({ id: "a" }), row({ id: "b", doneAt: NOW }), row({ id: "c", readAt: NOW })]);
  assert.deepEqual(list.open.map((i) => i.id), ["a", "c"]);
  assert.equal(list.openCount, 2);
  assert.equal(list.unreadCount, 1);
});

test("toNotificationList: newest bump first", () => {
  const list = toNotificationList([
    row({ id: "old", bumpedAt: new Date("2026-09-01") }),
    row({ id: "new", bumpedAt: new Date("2026-09-20") }),
    row({ id: "mid", bumpedAt: new Date("2026-09-10") }),
  ]);
  assert.deepEqual(list.open.map((i) => i.id), ["new", "mid", "old"]);
});

test("toNotificationList: zero-total progress is null; real progress is done/total", () => {
  const list = toNotificationList(
    [row({ id: "a", subjectKey: "x" }), row({ id: "b", subjectKey: "y" }), row({ id: "c", subjectKey: null })],
    new Map([
      ["x", { remaining: 0, total: 0 }],
      ["y", { remaining: 2, total: 5 }],
    ]),
  );
  const byId = new Map(list.open.map((i) => [i.id, i.progress]));
  assert.equal(byId.get("a"), null);
  assert.deepEqual(byId.get("b"), { done: 3, total: 5 });
  assert.equal(byId.get("c"), null);
});

test("toNotificationList: empty input gives an empty list", () => {
  assert.deepEqual(toNotificationList([]), { open: [], openCount: 0, unreadCount: 0 });
});

// ---------------------------------------------------------------------------
// outreach ladder keys and links
// ---------------------------------------------------------------------------

const UUID = "3f2b8c1e-9a7d-4e6f-8b2a-1c0d9e8f7a6b";

test("ladder keys: subject key round-trips for every real rung", () => {
  for (let step = 1; step <= MAX_EMAILS; step++) {
    assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(UUID, step)), { contactId: UUID, step });
  }
});

test("ladder keys: dedupe key and subject key differ, and do not parse as each other", () => {
  assert.notEqual(followUpNotificationKey(UUID, 2), followUpSubjectKey(UUID, 2));
  assert.equal(parseFollowUpSubject(followUpNotificationKey(UUID, 2)), null);
});

test("ladder keys: distinct (contact, step) give distinct keys", () => {
  const other = "3f2b8c1e-9a7d-4e6f-8b2a-1c0d9e8f7a6c";
  const keys = [followUpSubjectKey(UUID, 2), followUpSubjectKey(UUID, 3), followUpSubjectKey(other, 2)];
  assert.equal(new Set(keys).size, 3);
  const nkeys = [followUpNotificationKey(UUID, 2), followUpNotificationKey(UUID, 3), followUpNotificationKey(other, 2)];
  assert.equal(new Set(nkeys).size, 3);
});

test("ladder keys: parse rejects other subjects (firm, quiz, thanks, garbage)", () => {
  for (const k of ["evercore", "quiz:investment_banking", `thanks:${UUID}`, "", "ladder:", `ladder:${UUID}`, `ladder:${UUID}:`, `ladder:${UUID}:x`]) {
    assert.equal(parseFollowUpSubject(k), null, k);
  }
});

test("ladder keys: parse is anchored - no trailing newline, prefix or suffix", () => {
  for (const k of [`ladder:${UUID}:2\n`, ` ladder:${UUID}:2`, `ladder:${UUID}:2 `, `xladder:${UUID}:2`, `ladder:${UUID}:22`]) {
    assert.equal(parseFollowUpSubject(k), null, JSON.stringify(k));
  }
});

test("ladder keys: short or long ids are rejected", () => {
  assert.equal(parseFollowUpSubject(`ladder:${UUID.slice(1)}:2`), null);
  assert.equal(parseFollowUpSubject(`ladder:${UUID}a:2`), null);
});

test("ladder keys: step 0 and step 4 survive the round trip (single digits)", () => {
  assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(UUID, 0)), { contactId: UUID, step: 0 });
  assert.deepEqual(parseFollowUpSubject(followUpSubjectKey(UUID, 4)), { contactId: UUID, step: 4 });
});

test("ladder keys: an uppercase uuid is not a ladder subject (ids from Postgres are lowercase)", () => {
  // Pinning: Postgres renders uuid columns lowercase, so this is the only form
  // the app ever writes. An uppercase one would never auto-close.
  assert.equal(parseFollowUpSubject(followUpSubjectKey(UUID.toUpperCase(), 2)), null);
});

test("ordinal: rungs read 1st/2nd/3rd, anything else 'th'", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(4), "4th");
  assert.equal(ordinal(0), "0th");
});

// ---------------------------------------------------------------------------
// Occasion links: every ?occasion=&box= the app builds must exist in the picker
// ---------------------------------------------------------------------------

function checkOccasionHref(href: string) {
  const url = new URL(href, "https://offerly.test");
  assert.equal(url.pathname, "/outreach", href);
  assert.ok(isRoute(url.pathname), href);
  const occasion = url.searchParams.getAll("occasion");
  const box = url.searchParams.getAll("box");
  assert.equal(occasion.length, 1, `${href}: one occasion`);
  assert.equal(box.length, 1, `${href}: one box`);
  const o = occasionById(occasion[0]);
  assert.ok(o, `${href}: no occasion ${occasion[0]}`);
  assert.ok(boxById(box[0]), `${href}: no box ${box[0]}`);
  const inIt = o.sections.some((s) => s.boxes.some((b) => b.id === box[0]));
  assert.ok(inIt, `${href}: box ${box[0]} is not in occasion ${occasion[0]}`);
  return url;
}

test("occasion links: followUpHref for every rung names a real follow_up box", () => {
  for (let step = 1; step <= MAX_EMAILS + 1; step++) checkOccasionHref(followUpHref(UUID, step));
});

test("occasion links: 2nd email is the first follow-up, 3rd the final one", () => {
  const box = (s: number) => new URL(followUpHref(UUID, s), "https://x").searchParams.get("box");
  assert.equal(box(2), "follow.first");
  assert.equal(box(3), "follow.final");
  assert.equal(boxById("follow.first")?.typeId, "follow_up_1");
  assert.equal(boxById("follow.final")?.typeId, "follow_up_2");
});

test("occasion links: followUpHref carries the contact id intact", () => {
  const url = checkOccasionHref(followUpHref(UUID, 2));
  assert.equal(url.searchParams.get("contact"), UUID);
});

test("occasion links: thankYouHref with and without a contact names thanks/thanks.chat", () => {
  checkOccasionHref(thankYouHref(null));
  const url = checkOccasionHref(thankYouHref({ id: UUID, name: "Dana Reed" }));
  assert.equal(url.searchParams.get("contact"), UUID);
  assert.equal(new URL(thankYouHref(null), "https://x").searchParams.has("contact"), false);
});

test("occasion links: a contact's name never leaks into the thank-you link", () => {
  const href = thankYouHref({ id: UUID, name: "Dana Reed & Co <script>" });
  assert.ok(!href.includes("Dana"));
});

test("occasion links: thanks.chat is a chat box, not an interview one", () => {
  assert.equal(boxById("thanks.chat")?.typeId, "thank_you_chat");
});

test("occasion links: every box id in OCCASIONS is unique (boxById is unambiguous)", () => {
  const ids = OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes.map((b) => b.id)));
  assert.equal(new Set(ids).size, ids.length);
});

test("occasion links: every box id is prefixed consistently within its occasion", () => {
  for (const o of OCCASIONS) {
    const prefixes = new Set(o.sections.flatMap((s) => s.boxes.map((b) => b.id.split(".")[0])));
    assert.equal(prefixes.size, 1, `${o.id}: mixed prefixes ${[...prefixes]}`);
  }
});

// ---------------------------------------------------------------------------
// thank-you keys
// ---------------------------------------------------------------------------

test("thank-you keys: thankYouKey namespaces the source key", () => {
  assert.equal(thankYouKey("offerly:abc"), "thank_you:offerly:abc");
  assert.equal(thankYouKey("google:abc"), "thank_you:google:abc");
  assert.notEqual(thankYouKey("offerly:abc"), thankYouKey("google:abc"));
});

test("thank-you keys: subject key is not mistaken for a ladder subject or a firm", () => {
  const k = thankYouSubjectKey(UUID);
  assert.equal(k, `thanks:${UUID}`);
  assert.equal(parseFollowUpSubject(k), null);
  assert.ok(k.startsWith("thanks:"), "notifications.ts excludes thanks: from firm progress by this prefix");
});

test("thank-you keys: subject and dedupe keys never collide with each other", () => {
  assert.notEqual(thankYouSubjectKey(UUID), thankYouKey(UUID));
});

// ---------------------------------------------------------------------------
// parseTimeZone on hostile cookies
// ---------------------------------------------------------------------------

test("tz: missing values fall back to the default", () => {
  for (const v of [undefined, null, ""]) assert.equal(parseTimeZone(v), DEFAULT_TIME_ZONE);
});

test("tz: a real zone comes back as is", () => {
  assert.equal(parseTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(parseTimeZone("Europe/London"), "Europe/London");
});

test("tz: the encoded form the cookie writer produces decodes back", () => {
  const cookie = timeZoneCookieString("America/Argentina/Buenos_Aires");
  assert.ok(cookie.startsWith(`${TZ_COOKIE}=`));
  const value = cookie.slice(TZ_COOKIE.length + 1).split(";")[0];
  assert.equal(parseTimeZone(value), "America/Argentina/Buenos_Aires");
});

test("tz: UTC and Etc/GMT+5 are accepted", () => {
  assert.equal(parseTimeZone("UTC"), "UTC");
  assert.equal(parseTimeZone("Etc/GMT+5"), "Etc/GMT+5");
});

test("tz: junk zones fall back to the default", () => {
  for (const v of ["Mars/Olympus", "not a zone", "America/", "/", "null", "undefined", "0"]) {
    assert.equal(parseTimeZone(v), DEFAULT_TIME_ZONE, v);
  }
});

test("tz: path-traversal strings fall back to the default", () => {
  for (const v of ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "America/../../etc/passwd", "%2e%2e%2f"]) {
    assert.equal(parseTimeZone(v), DEFAULT_TIME_ZONE, v);
  }
});

test("tz: a very long cookie falls back without throwing", () => {
  assert.equal(parseTimeZone("A".repeat(100_000)), DEFAULT_TIME_ZONE);
  assert.equal(parseTimeZone("America/New_York".repeat(1000)), DEFAULT_TIME_ZONE);
});

test("tz: control characters and emoji fall back", () => {
  for (const v of ["\u0000", "America/New_York\u0000", "😀", "\n"]) {
    assert.equal(parseTimeZone(v), DEFAULT_TIME_ZONE, JSON.stringify(v));
  }
});

test("tz: a lone '%' never throws", () => {
  assert.doesNotThrow(() => parseTimeZone("%"));
  assert.equal(parseTimeZone("%"), DEFAULT_TIME_ZONE);
});

test("tz: truncated percent-encoding ('%E0%A4%A') never throws", () => {
  assert.doesNotThrow(() => parseTimeZone("%E0%A4%A"));
  assert.equal(parseTimeZone("%E0%A4%A"), DEFAULT_TIME_ZONE);
});

test("tz: invalid UTF-8 sequences ('%C0%AF', '%FF') never throw", () => {
  for (const v of ["%C0%AF", "%FF", "America%2", "%ZZ"]) {
    assert.doesNotThrow(() => parseTimeZone(v), v);
  }
});

test("tz: whatever parseTimeZone returns is usable by Intl", () => {
  for (const v of ["UTC", "Etc/GMT+5", "America/Chicago", "garbage", "", "../x", "america/new_york"]) {
    let out: string;
    try {
      out = parseTimeZone(v);
    } catch {
      continue; // covered by the no-throw tests above
    }
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: out }), `${v} -> ${out}`);
  }
});

test("HELP_GROUPS: six groups of three, every task a real guide task", () => {
  // Loaded after the lucide stub is in the require cache - see the top of the file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HELP_GROUPS } = require("../../src/lib/help-guide") as typeof import("../../src/lib/help-guide");
  assert.equal(HELP_GROUPS.length, 6);
  const all = new Set(HELP_SECTIONS.flatMap((s) => s.tasks));
  for (const g of HELP_GROUPS) {
    assert.equal(g.tasks.length, 3, g.label);
    for (const t of g.tasks) assert.ok(all.has(t), `${g.label}: ${t.label}`);
  }
  assert.ok(labels("connect calendar", 50).includes("Connect Google Calendar"));
  assert.ok(!labels("gmail", 50).length, "nothing in the guide offers Gmail any more");
});
