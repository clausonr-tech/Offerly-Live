// What the Help assistant has to know about, and whether what it knows is
// current.
//
// Every page a student can open is a "target": its route, plus the source
// files that make up what they see there. The knowledge in help-knowledge.json
// carries a hash of each target's sources. When a page's code changes, its
// hash no longer matches, and scripts/test/help-knowledge-coverage.test.ts
// fails with the command that relearns it:
//
//   npm run help:learn
//
// Shared by that script and that test, so both agree on what a page is made
// of. Node-only (fs, crypto) and free of "server-only", so a plain script can
// import it.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const HELP_LEARN_COMMAND = "npm run help:learn";

type HelpKnowledgeKind = "overview" | "shell" | "route";

export type HelpKnowledgeTarget = {
  /** "overview", "shell", or the route as a student types it ("/discovery/firm/[slug]"). */
  key: string;
  kind: HelpKnowledgeKind;
  /** Repo-relative, forward slashes, sorted. */
  sources: string[];
};

export type HelpKnowledgeEntry = { hash: string; sources: string[]; title: string; text: string };

export type HelpKnowledgeFile = {
  version: number;
  generatedAt: string;
  entries: Record<string, HelpKnowledgeEntry>;
};

/** The product's point, its navigation and the recruiting path - not one page, the whole shape. */
const OVERVIEW_SOURCES = ["README.md", "docs/RECRUITING-WORKFLOW.md", "src/lib/help-guide.ts", "src/lib/nav-sections.ts"];

/**
 * Who the assistant is for. Students and firm recruiters each get their own
 * assistant, knowledge file and pages: a student never needs to know how the
 * firm portal works, and a firm must never be told about a student's pages.
 */
export type HelpAudience = "student" | "firm";

export const HELP_KNOWLEDGE_FILES: Record<HelpAudience, string> = {
  student: "src/lib/help-knowledge.json",
  firm: "src/lib/firm-help-knowledge.json",
};

/** The firm portal's overview: what it is for and its three sections. */
const FIRM_OVERVIEW_SOURCES = ["src/lib/firm-help-guide.ts", "src/lib/firm-nav.ts"];

/** Route folders no student reaches: server endpoints, the admin console and the firm portal. */
const STUDENT_EXCLUDED = new Set(["api", "admin", "firms"]);
/** Inside the firm portal, only server endpoints and the admin console are off limits. */
const FIRM_EXCLUDED = new Set(["api", "admin"]);

/** How far to follow a page's imports into other src/app files, and how much of them to read. */
const IMPORT_DEPTH = 2;
const IMPORTED_BYTES_CAP = 80_000;
/**
 * The small src/lib modules a page's own files import directly. That is where
 * the limits a student hits usually live (character caps, daily counts, the
 * choices in a dropdown), and without them the writer guesses the numbers.
 * Big modules and server-only ones are skipped: they are data and plumbing,
 * not rules.
 */
const LIB_FILE_MAX_BYTES = 15_000;

const posix = (p: string) => p.split(path.sep).join("/");

/**
 * Every page a student can open, plus the app shell (sidebar, bell, help menu
 * - on every signed-in page but no page's own code) and the overview.
 */
export function listHelpKnowledgeTargets(
  root: string = process.cwd(),
  audience: HelpAudience = "student",
): HelpKnowledgeTarget[] {
  const appDir = path.join(root, "src", "app");
  const excluded = audience === "firm" ? FIRM_EXCLUDED : STUDENT_EXCLUDED;
  const overview = audience === "firm" ? FIRM_OVERVIEW_SOURCES : OVERVIEW_SOURCES;
  const targets: HelpKnowledgeTarget[] = [{ key: "overview", kind: "overview", sources: [...overview].sort() }];

  const shellLayout =
    audience === "firm" ? path.join(appDir, "firms", "(portal)", "layout.tsx") : path.join(appDir, "(app)", "layout.tsx");
  if (existsSync(shellLayout)) {
    targets.push({ key: "shell", kind: "shell", sources: collectSources(root, [shellLayout], excluded) });
  }

  // The firm portal's pages are everything under src/app/firms; a student's
  // are everything else.
  const pagesRoot = audience === "firm" ? path.join(appDir, "firms") : appDir;
  for (const dir of existsSync(pagesRoot) ? pageDirs(pagesRoot, excluded) : []) {
    const direct = readdirSync(dir)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "route.ts")
      .map((name) => path.join(dir, name))
      .filter((f) => statSync(f).isFile());
    targets.push({ key: routeOf(appDir, dir), kind: "route", sources: collectSources(root, direct, excluded) });
  }

  return targets.sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
}

function order(t: HelpKnowledgeTarget): number {
  return t.kind === "overview" ? 0 : t.kind === "shell" ? 1 : 2;
}

function pageDirs(dir: string, excluded: Set<string>): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    // Private folders ("_home") are not routes; api and admin are not for students.
    if (name.startsWith("_") || excluded.has(name) || name === "node_modules") continue;
    if (existsSync(path.join(full, "page.tsx"))) out.push(full);
    out.push(...pageDirs(full, excluded));
  }
  return out;
}

/** "src/app/(app)/discovery/firm/[slug]" -> "/discovery/firm/[slug]". Route groups drop out. */
export function routeOf(appDir: string, dir: string): string {
  const segments = posix(path.relative(appDir, dir))
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s));
  return "/" + segments.join("/");
}

/**
 * A page's files, then the src/app files they import (not type-only imports),
 * breadth first to IMPORT_DEPTH, plus the small src/lib modules the page's own
 * files import, until IMPORTED_BYTES_CAP. The page's own folder is always
 * read in full; nested routes are their own targets.
 */
function collectSources(root: string, direct: string[], excluded: Set<string>): string[] {
  const appDir = path.join(root, "src", "app");
  const seen = new Set(direct.map((f) => path.resolve(f)));
  let frontier = [...seen].sort();
  let importedBytes = 0;

  for (let depth = 0; depth < IMPORT_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (depth === 0 && spec.startsWith("@/lib/")) {
          const lib = resolveLibImport(root, spec);
          if (lib && !seen.has(lib) && importedBytes + statSync(lib).size <= IMPORTED_BYTES_CAP) {
            importedBytes += statSync(lib).size;
            seen.add(lib); // read, but not followed: its own imports are plumbing
          }
          continue;
        }
        const resolved = resolveImport(appDir, file, spec, excluded);
        if (!resolved || seen.has(resolved)) continue;
        const size = statSync(resolved).size;
        if (importedBytes + size > IMPORTED_BYTES_CAP) continue;
        importedBytes += size;
        seen.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next.sort();
  }

  return [...seen].map((f) => posix(path.relative(root, f))).sort();
}

/** Module specifiers a file imports for their values. `import type` pulls in no feature. */
export function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /^\s*import\s+(?!type\s)[^'"]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s+(?!type\s)[^'"]*?from\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specs.push(m[1]);
  return [...new Set(specs)];
}

function resolveImport(appDir: string, fromFile: string, spec: string, excluded: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/app/")) base = path.join(appDir, spec.slice("@/app/".length));
  else return null;

  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const hit = candidates.find((c) => /\.(ts|tsx)$/.test(c) && existsSync(c) && statSync(c).isFile());
  if (!hit) return null;

  const rel = posix(path.relative(appDir, hit));
  if (rel.startsWith("..")) return null;
  const segments = rel.split("/");
  if (segments.some((s) => excluded.has(s))) return null;
  // Another route's page or route handler is that route's business.
  if (/^(page|route)\.tsx?$/.test(segments[segments.length - 1])) return null;
  return path.resolve(hit);
}

function resolveLibImport(root: string, spec: string): string | null {
  const base = path.join(root, "src", "lib", spec.slice("@/lib/".length));
  const hit = [`${base}.ts`, `${base}.tsx`, base].find((c) => /\.(ts|tsx)$/.test(c) && existsSync(c) && statSync(c).isFile());
  if (!hit || statSync(hit).size > LIB_FILE_MAX_BYTES) return null;
  // Server-only modules are the database and the model calls - plumbing. The
  // rules a student sees live in the pure modules the browser can import.
  if (/^\s*import\s+["']server-only["']/m.test(readFileSync(hit, "utf8"))) return null;
  return path.resolve(hit);
}

/** sha256 over each source's path and contents, in path order. A missing file hashes as missing. */
export function hashSources(root: string, sources: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...sources].sort()) {
    const full = path.join(root, rel);
    h.update(rel);
    h.update("\0");
    h.update(existsSync(full) ? readFileSync(full) : "<missing>");
    h.update("\0");
  }
  return h.digest("hex");
}

export type KnowledgeDrift = { missing: string[]; stale: string[]; orphaned: string[] };

/** Targets with no entry, entries whose sources changed, and entries for pages that are gone. */
export function knowledgeDrift(
  file: Pick<HelpKnowledgeFile, "entries">,
  targets: HelpKnowledgeTarget[],
  root: string = process.cwd(),
): KnowledgeDrift {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const t of targets) {
    const entry = file.entries[t.key];
    if (!entry) missing.push(t.key);
    else if (entry.hash !== hashSources(root, t.sources) || entry.sources.join("|") !== t.sources.join("|")) stale.push(t.key);
  }
  const keys = new Set(targets.map((t) => t.key));
  const orphaned = Object.keys(file.entries).filter((k) => !keys.has(k));
  return { missing, stale, orphaned };
}

/**
 * Words that must never appear in what the assistant knows: secrets and
 * configuration, the admin console, which model or vendor powers the app, and
 * implementation details a student has no use for.
 */
const KNOWLEDGE_FORBIDDEN: [label: string, pattern: RegExp][] = [
  ["API key", /\bapi[\s_-]?keys?\b/i],
  ["environment variables", /\benv\b|\.env\b|process\.env|environment variable/i],
  ["vendor name", /\banthropic\b|\bclaude\b|\bopenai\b|\bgpt-?\d/i],
  ["model name", /\bhaiku\b|\bsonnet\b|\bopus\b/i],
  ["admin", /\badmins?\b|\badmin[\s-]only\b/i],
  ["internals", /\bsupabase\b|\bdrizzle\b|\bpglite\b|\bpostgres\b|\bserver action\b|\buseState\b|\.tsx?\b|\bsrc\//i],
  ["secrets", /\bsecret\b|\btoken\b|\bpassword hash\b/i],
];

/** Labels of every forbidden kind of word in the text. Empty when clean. */
export function forbiddenInKnowledge(text: string): string[] {
  return KNOWLEDGE_FORBIDDEN.filter(([, re]) => re.test(text)).map(([label]) => label);
}
