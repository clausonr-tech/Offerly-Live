// The full firm catalog (src/lib/firm-seeds-bulk.json, ~22.5k firms, ~5.9MB)
// must never be reachable from a "use client" module.
//
// It was, through src/lib/firm-content.ts: client components imported that
// module for CATEGORY_LABELS, and it imports the catalog on line 1, so every
// route rendering one of them shipped a 5.1MB chunk (~850KB compressed) to the
// browser. Labels and types now live in src/lib/firm-metadata.ts and the
// catalog in the server-only src/lib/firm-content.ts.
//
// This walks the same graph the bundler does - from every "use client" file,
// through relative and "@/" imports - and fails naming the import chain if the
// catalog turns up. It stops at "use server" files, which a client bundle
// reaches only as an action reference, never as code.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const CATALOG = path.join(SRC, "lib", "firm-seeds-bulk.json");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|mjs)$/.test(name) ? [full] : [];
  });
}

/** A file's leading directive ("use client" / "use server"), past any comments. */
function directive(source: string): string | null {
  const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["'](use (?:client|server))["']/.exec(source);
  return m ? m[1] : null;
}

/**
 * Every module specifier a file loads at runtime. `import type` and
 * `export type` are erased by the compiler and carry nothing into a bundle,
 * so they are skipped; anything else - static, re-export, side-effect or
 * dynamic import - counts. Comment lines are dropped first so prose that
 * mentions a path is not mistaken for an import.
 */
function runtimeSpecifiers(source: string): string[] {
  const code = source.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, "");
  const specs: string[] = [];
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    if (!m[2]) specs.push(m[3]);
  }
  for (const m of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package, not our code
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** The import chain from `entry` to `target`, or null when it is unreachable. */
function chainTo(entry: string, target: string): string[] | null {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (file === target) {
      const chain: string[] = [];
      for (let f: string | null = file; f; f = parent.get(f) ?? null) chain.unshift(path.relative(ROOT, f));
      return chain;
    }
    if (file.endsWith(".json")) continue;
    const source = readFileSync(file, "utf8");
    if (file !== entry && directive(source) === "use server") continue;
    for (const spec of runtimeSpecifiers(source)) {
      const next = resolve(file, spec);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

const clientModules = sourceFiles(SRC).filter((f) => directive(readFileSync(f, "utf8")) === "use client");

test("the walker sees the client graph and would catch the catalog", () => {
  // Guards the guard: a regex that stopped matching would make the real check
  // below pass vacuously.
  assert.ok(clientModules.length > 50, `found only ${clientModules.length} "use client" modules`);
  assert.ok(
    chainTo(path.join(SRC, "lib", "firm-content.ts"), CATALOG),
    "firm-content.ts should reach the catalog - if not, the walker is broken",
  );
});

test("no \"use client\" module can reach the full firm catalog", () => {
  const leaks = clientModules
    .map((f) => chainTo(f, CATALOG))
    .filter((chain): chain is string[] => chain !== null)
    .map((chain) => chain.join("\n    -> "));
  assert.deepEqual(
    leaks,
    [],
    `The firm catalog is reachable from client code. Import labels and types from ` +
      `@/lib/firm-metadata instead:\n  ${leaks.join("\n  ")}`,
  );
});
