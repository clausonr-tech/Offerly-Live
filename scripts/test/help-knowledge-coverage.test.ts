// The Help assistant knows every page a student can open, as the page is now.
//
// Recomputes the pages and the hash of each page's code (lib/help-knowledge-
// sources, the same code the learn script uses) and compares them with
// src/lib/help-knowledge.json. A new page, a changed page or a deleted page
// fails here, naming each one and the command that fixes it:
//
//   npm run help:learn
//
// Also checks the knowledge never mentions secrets, configuration, the admin
// console or which model powers the app. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  HELP_LEARN_COMMAND,
  forbiddenInKnowledge,
  hashSources,
  importSpecifiers,
  knowledgeDrift,
  listHelpKnowledgeTargets,
  routeOf,
  type HelpKnowledgeFile,
} from "../../src/lib/help-knowledge-sources";

const ROOT = process.cwd();
const knowledge: HelpKnowledgeFile = JSON.parse(readFileSync(path.join(ROOT, "src/lib/help-knowledge.json"), "utf8"));
const targets = listHelpKnowledgeTargets(ROOT);

test("the knowledge covers every page, and every entry matches the page's current code", () => {
  const drift = knowledgeDrift(knowledge, targets, ROOT);
  const problems = [
    ...drift.missing.map((k) => `  missing: ${k} (a page with no entry)`),
    ...drift.stale.map((k) => `  stale:   ${k} (its code changed since it was learned)`),
    ...drift.orphaned.map((k) => `  orphan:  ${k} (the page no longer exists)`),
  ];
  assert.equal(
    problems.length,
    0,
    `The Help assistant's knowledge is out of date:\n${problems.join("\n")}\n\nRun: ${HELP_LEARN_COMMAND}\nthen commit src/lib/help-knowledge.json.`,
  );
});

test("the page list includes the overview, the app frame and the main sections, and no admin or api routes", () => {
  const keys = targets.map((t) => t.key);
  for (const k of ["overview", "shell", "/", "/dashboard", "/discovery", "/networking", "/outreach", "/schedule", "/learn", "/help", "/news", "/profile"]) {
    assert.ok(keys.includes(k), `expected a knowledge target for ${k}`);
  }
  for (const k of keys) {
    assert.ok(!/\/admin(\/|$)/.test(k), `admin route leaked into the knowledge targets: ${k}`);
    assert.ok(!/\/api(\/|$)/.test(k), `api route leaked into the knowledge targets: ${k}`);
    assert.ok(!/\/_/.test(k), `private folder leaked into the knowledge targets: ${k}`);
  }
  assert.equal(new Set(keys).size, keys.length, "duplicate targets");
});

for (const t of targets) {
  test(`knowledge entry for ${t.key} is clean and readable`, () => {
    const entry = knowledge.entries[t.key];
    if (!entry) return; // reported once, above, with the command to run
    const bad = forbiddenInKnowledge(`${entry.title}\n${entry.text}`);
    assert.deepEqual(bad, [], `${t.key} mentions: ${bad.join(", ")}`);
    assert.ok(entry.title.trim().length > 0, `${t.key} has no title`);
    assert.ok(entry.text.trim().length > 0, `${t.key} has no text`);
    const words = entry.text.split(/\s+/).length;
    assert.ok(words <= (t.key === "overview" || t.key === "shell" ? 480 : 380), `${t.key} is ${words} words - relearn it shorter`);
    assert.ok(!/```|\*\*|^#{1,6}\s/m.test(entry.text), `${t.key} contains markdown`);
    for (const source of t.sources) assert.ok(!source.includes("/admin/") && !source.includes("/api/"), `${t.key} read ${source}`);
  });
}

test("the whole knowledge fits the budget for one cached system block", () => {
  const chars = Object.values(knowledge.entries).reduce((n, e) => n + e.title.length + e.text.length, 0);
  // ~4 characters a token: 15-25k tokens is the target, 35k the hard ceiling.
  assert.ok(chars / 4 < 35_000, `knowledge is ~${Math.round(chars / 4)} tokens`);
  // Haiku 4.5 will not cache a prefix under 4096 tokens; the knowledge must clear it comfortably.
  assert.ok(chars / 4 > 5_000, `knowledge is only ~${Math.round(chars / 4)} tokens`);
});

test("hashing is deterministic and changes when a source changes", () => {
  const t = targets.find((x) => x.key === "/help")!;
  assert.equal(hashSources(ROOT, t.sources), hashSources(ROOT, [...t.sources].reverse()));
  assert.notEqual(hashSources(ROOT, t.sources), hashSources(ROOT, [...t.sources, "does/not/exist.ts"]));
  const drift = knowledgeDrift({ entries: { ...knowledge.entries, "/help": { ...knowledge.entries["/help"], hash: "0" } } }, targets, ROOT);
  assert.ok(drift.stale.includes("/help"));
  const gone = knowledgeDrift({ entries: { ...knowledge.entries, "/no-such-page": knowledge.entries["/help"] } }, targets, ROOT);
  assert.ok(gone.orphaned.includes("/no-such-page"));
  const { ["/news"]: _dropped, ...withoutNews } = knowledge.entries;
  assert.ok(knowledgeDrift({ entries: withoutNews }, targets, ROOT).missing.includes("/news"));
});

test("routes drop route groups and keep dynamic segments", () => {
  const app = path.join(ROOT, "src/app");
  assert.equal(routeOf(app, path.join(app, "(app)", "discovery", "firm", "[slug]")), "/discovery/firm/[slug]");
  assert.equal(routeOf(app, path.join(app, "(marketing)")), "/");
  assert.equal(routeOf(app, path.join(app, "onboarding", "links")), "/onboarding/links");
});

test("import scanning ignores type-only imports", () => {
  const src = `import type { A } from "./a";\nimport B from "./b";\nimport { c } from "@/app/c";\nexport { d } from "./d";\nimport "./e.css";\nconst f = import("./f");`;
  assert.deepEqual(importSpecifiers(src).sort(), ["./b", "./d", "./e.css", "./f", "@/app/c"]);
});

test("the forbidden-word check catches what must never reach a student", () => {
  for (const s of ["Set the API key", "read from .env.local", "powered by Claude", "Anthropic", "Haiku answers", "admins only", "a server action", "stored in Supabase", "process.env.X", "page.tsx"]) {
    assert.ok(forbiddenInKnowledge(s).length > 0, s);
  }
  for (const s of ["Click \"Add firm\"", "Your school administration", "an environment of support", "Find my top firms uses AI"]) {
    assert.deepEqual(forbiddenInKnowledge(s), [], s);
  }
});

// ---------- the firm portal's assistant ----------
//
// A second knowledge file, for recruiters, learned from the firm portal's own
// pages by the same command. A student's knowledge must never describe the
// firm portal, and a firm's must never describe a student's pages.

const firmKnowledge: HelpKnowledgeFile = JSON.parse(readFileSync(path.join(ROOT, "src/lib/firm-help-knowledge.json"), "utf8"));
const firmTargets = listHelpKnowledgeTargets(ROOT, "firm");

test("the firm knowledge covers every firm portal page, as its code is now", () => {
  const drift = knowledgeDrift(firmKnowledge, firmTargets, ROOT);
  const problems = [
    ...drift.missing.map((k) => `  missing: ${k}`),
    ...drift.stale.map((k) => `  stale:   ${k}`),
    ...drift.orphaned.map((k) => `  orphan:  ${k}`),
  ];
  assert.equal(problems.length, 0, `The firm Help assistant's knowledge is out of date:\n${problems.join("\n")}\n\nRun: ${HELP_LEARN_COMMAND}`);
});

test("the two audiences never see each other's pages", () => {
  const studentKeys = targets.map((t) => t.key);
  const firmKeys = firmTargets.map((t) => t.key);
  for (const k of studentKeys) assert.ok(!/^\/firms(\/|$)/.test(k), `firm page in the student knowledge: ${k}`);
  for (const k of ["overview", "shell", "/firms/internships", "/firms/events", "/firms/analytics", "/firms/help"]) {
    assert.ok(firmKeys.includes(k), `expected a firm knowledge target for ${k}`);
  }
  for (const k of firmKeys) {
    assert.ok(k === "overview" || k === "shell" || k.startsWith("/firms"), `student page in the firm knowledge: ${k}`);
  }
});

for (const t of firmTargets) {
  test(`firm knowledge entry for ${t.key} is clean`, () => {
    const entry = firmKnowledge.entries[t.key];
    if (!entry) return;
    assert.deepEqual(forbiddenInKnowledge(`${entry.title}\n${entry.text}`), [], t.key);
    assert.ok(!/```|\*\*|^#{1,6}\s/m.test(entry.text), `${t.key} contains markdown`);
  });
}
