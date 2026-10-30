// The sidebar's map of the app, checked against the pages on disk.
//
// What these guard: a page the rail does not recognise (so no section lights
// up and the student appears to have left where they were), a nested row that
// stops highlighting one level deeper, a legacy redirect whose destination is
// gone, and in-app links that bounce through a redirect-only route instead of
// naming where the page actually lives. Pure: no database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// nav-sections imports lucide-react for the rail's icons, and under
// --conditions=react-server lucide cannot load. Stubbed before the module is
// required - the same move help-and-routing.test.ts makes.
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = (require("../../next.config") as { default: import("next").NextConfig }).default;

// ---------------------------------------------------------------------------
// Routes on disk
// ---------------------------------------------------------------------------

const APP_DIR = join(process.cwd(), "src", "app", "(app)");

function files(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // A folder starting with "_" is private: not a route, and parked code.
      if (!name.startsWith("_")) out.push(...files(full, keep));
    } else if (keep(name)) out.push(full);
  }
  return out;
}

const PAGE_FILES = files(APP_DIR, (n) => n === "page.tsx");

function routeOf(file: string): string {
  const segs = relative(APP_DIR, file).split(sep).slice(0, -1);
  return "/" + segs.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
}

const ROUTES = PAGE_FILES.map((file) => {
  const path = routeOf(file);
  const re = path
    .split("/")
    .slice(1)
    .map((s) => (s.startsWith("[") ? "/[^/]+" : "/" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return { file, path, pattern: new RegExp(`^${re || "/"}$`) };
});

const isRoute = (pathname: string) => ROUTES.some((r) => r.pattern.test(pathname));
const hasPageUnder = (prefix: string) =>
  ROUTES.some((r) => r.path === prefix || r.path.startsWith(prefix + "/"));

/**
 * Pages that exist only to redirect: no markup of their own, a redirect() in
 * the body. Linking to one costs a round trip and, worse, names a place the
 * reader never actually arrives at.
 */
const REDIRECT_ONLY = ROUTES.filter((r) => {
  const src = readFileSync(r.file, "utf8");
  // "</" or "/>": any rendered markup. (A bare "<" would catch generics.)
  return /\bredirect\(/.test(src) && !/<\/|\/>/.test(src);
}).map((r) => r.path);

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

const ALL = NAV_SECTIONS.flatMap((s) => [s, ...(s.children ?? [])]);

test("harness: finds real pages and the redirect-only ones", () => {
  assert.ok(isRoute("/networking/messages"));
  assert.ok(isRoute("/contacts/123"));
  assert.ok(!isRoute("/home"), "the parked _home folder is not a route");
  assert.ok(REDIRECT_ONLY.includes("/networking/contacts"));
  assert.ok(!REDIRECT_ONLY.includes("/contacts"));
  assert.ok(REDIRECT_ONLY.includes("/applications"));
  assert.ok(!REDIRECT_ONLY.includes("/dashboard"));
});

test("every sidebar row opens a real page, and no two rows share one", () => {
  for (const item of ALL) assert.ok(isRoute(item.href), `${item.label}: no page at ${item.href}`);
  const hrefs = ALL.map((i) => i.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test("no sidebar row points at a route that only redirects", () => {
  for (const item of ALL) {
    assert.ok(!REDIRECT_ONLY.includes(item.href), `${item.label} goes via the redirect at ${item.href}`);
  }
});

test("every alias has a page under it, and never claims another section's own subtree", () => {
  for (const item of ALL) {
    for (const alias of item.aliases ?? []) {
      assert.ok(hasPageUnder(alias), `${item.label}: alias ${alias} has no page under it`);
      const owner = NAV_SECTIONS.find((s) => alias === s.href || alias.startsWith(s.href + "/"));
      const parent = NAV_SECTIONS.find((s) => s === item || s.children?.includes(item));
      assert.ok(!owner || owner === parent, `${item.label}: alias ${alias} is inside ${owner?.label}`);
    }
  }
});

// Most children sit under their section's URL. Industry Contacts does not -
// it is /contacts under External Network (/dashboard) - so the rule that
// matters is the one this checks: every child resolves to its own parent,
// never to a section whose URL it happens to share a prefix with.
test("every child resolves to its own section", () => {
  for (const section of NAV_SECTIONS) {
    for (const child of section.children ?? []) {
      assert.equal(sectionFor(child.href)?.href, section.href, `${child.href} is not found under ${section.href}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Which row lights up where
// ---------------------------------------------------------------------------

/** path -> [section label, child label or null] */
const WHERE: [string, string, string | null][] = [
  ["/dashboard", "External Network", null],
  ["/applications/new", "External Network", null],
  ["/applications/123", "External Network", null],
  ["/todo", "External Network", null],
  ["/todo/done", "External Network", null],
  ["/contacts", "External Network", "Industry Contacts"],
  ["/contacts/123", "External Network", "Industry Contacts"],
  ["/contacts/new", "External Network", "Industry Contacts"],
  ["/contacts/company/evercore", "External Network", "Industry Contacts"],

  ["/networking", "Internal Network", null],
  ["/networking/peers", "Internal Network", "Peers"],
  ["/networking/connect", "Internal Network", "Connect"],
  ["/networking/discussions", "Internal Network", "Discussions"],
  ["/networking/discussions/abc", "Internal Network", "Discussions"],
  ["/networking/clubs", "Internal Network", "Clubs"],
  ["/networking/messages", "Internal Network", "Messages"],
  ["/messages/abc", "Internal Network", "Messages"],
  ["/u/abc", "Internal Network", null],
  ["/networking/post", "Internal Network", null],

  ["/schedule", "Schedule", null],

  ["/discovery", "Discovery", null],
  ["/discovery/investment_banking", "Discovery", null],
  ["/discovery/investment_banking/internships", "Discovery", null],
  ["/discovery/internships", "Discovery", "Internships"],
  ["/discovery/firms", "Discovery", "Firms"],
  ["/discovery/firm/evercore", "Discovery", "Firms"],
  ["/tracking", "Discovery", "Internships"],

  ["/news", "News", null],
  ["/learn", "Interview Prep", null],

  ["/outreach", "Outreach", null],
  ["/outreach/email", "Outreach", "Email drafts"],
  ["/outreach/resume", "Outreach", "Resume builder"],
  ["/outreach/resume/history", "Outreach", "Resume builder"],
  ["/drafts", "Outreach", null],
  ["/drafts/abc", "Outreach", null],
];

for (const [path, section, child] of WHERE) {
  test(`rail: ${path} highlights ${section}${child ? ` > ${child}` : ""}`, () => {
    assert.ok(isRoute(path), `${path} is not a page - the table is out of date`);
    const s = sectionFor(path);
    assert.equal(s?.label, section);
    assert.equal(subsectionFor(s!, path)?.label ?? null, child);
  });
}

test("rail: account pages and look-alike paths highlight nothing", () => {
  for (const path of ["/profile", "/profile/interests", "/notifications", "/help", "/settings"]) {
    assert.equal(sectionFor(path), null, path);
  }
  // Prefix, not substring: a sibling that merely starts with the same letters.
  assert.equal(sectionFor("/newsletter"), null);
  assert.equal(sectionFor("/usage"), null);
  assert.equal(sectionFor("/draftsman"), null);
});

test("every page a student can open is either on the map or deliberately off it", () => {
  // /upgrade is the plan gate's landing page (lib/plan-access) - reached by
  // redirect, never from the rail, so it highlights no section on purpose.
  const OFF_MAP = ["/profile", "/settings", "/notifications", "/help", "/admin", "/upgrade"];
  const unmapped = ROUTES.map((r) => r.path.replace(/\[[^\]]+\]/g, "x"))
    .filter((p) => !OFF_MAP.some((o) => p === o || p.startsWith(o + "/")))
    .filter((p) => !REDIRECT_ONLY.includes(p))
    .filter((p) => !sectionFor(p));
  assert.deepEqual(unmapped, []);
});

test("the rail and the Help page agree on which section a page belongs to", () => {
  for (const { path } of ROUTES) {
    const concrete = path.replace(/\[[^\]]+\]/g, "x");
    const nav = sectionFor(concrete);
    const help = helpFor(concrete);
    if (!nav || !help) continue;
    assert.equal(sectionFor(help.href)?.href, nav.href, `${concrete}: rail says ${nav.label}, Help says ${help.href}`);
  }
});

// ---------------------------------------------------------------------------
// Redirects, and links that should not need one
// ---------------------------------------------------------------------------

test("every next.config redirect lands on a real page", async () => {
  const redirects = (await nextConfig.redirects?.()) ?? [];
  assert.ok(redirects.length > 0);
  for (const r of redirects) {
    const dest = r.destination.replace(/\/:path\*$/, "");
    assert.ok(isRoute(dest), `${r.source} -> ${r.destination}: no page at ${dest}`);
    assert.equal(r.permanent, false, `${r.source}: keep legacy redirects temporary`);
  }
});

test("every redirect-only page sends the reader to a real page", () => {
  for (const path of REDIRECT_ONLY) {
    const file = ROUTES.find((r) => r.path === path)!.file;
    // Every path literal inside each redirect(...) call - a call may pick
    // between two with a ternary.
    const calls = [...readFileSync(file, "utf8").matchAll(/redirect\(([^;]*)\);/g)].map((m) => m[1]);
    const targets = calls.flatMap((c) => [...c.matchAll(/[`"](\/[^`"?$]*)/g)].map((m) => m[1]));
    assert.ok(targets.length > 0, `${path}: no literal redirect target found`);
    for (const t of targets) assert.ok(isRoute(t), `${path} redirects to ${t}, which is not a page`);
  }
});

test("app code links straight to pages, not through a redirect-only route", () => {
  const sources = files(APP_DIR, (n) => /\.(tsx|ts)$/.test(n));
  const offenders: string[] = [];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:href=\{?|redirect\(|router\.push\()\s*["`](\/[^"`?#$]*)["`?#]/g)) {
      if (REDIRECT_ONLY.includes(m[1])) offenders.push(`${relative(APP_DIR, file)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
