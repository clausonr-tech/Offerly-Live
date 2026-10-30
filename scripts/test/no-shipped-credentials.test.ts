import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The login page once shipped a working password as the password field's
 * defaultValue - in the served HTML, for a shared account that was also the
 * only admin and exempt from paid-API limits. These keep any form from
 * pre-filling a credential again.
 */

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx|jsx)$/.test(name) ? [full] : [];
  });
}

/**
 * Every <input ...> element in a file, as its raw attribute text. `=>` is
 * allowed inside, so an `onChange={(e) => ...}` does not end the element early
 * and hide the attributes after it.
 */
function inputElements(source: string): string[] {
  return [...source.matchAll(/<input\b((?:=>|[^>])*?)\/?>/g)].map((m) => m[1]);
}

test("no password field anywhere in src/ is pre-filled", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const attrs of inputElements(text)) {
      const isPassword = /type=\{?[^>]*["']password["']/.test(attrs) || /name=["'](password|currentPassword|newPassword)["']/.test(attrs);
      if (isPassword && /\b(defaultValue|value)=/.test(attrs)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
  }
  assert.deepEqual(offenders, [], `password inputs with a preset value: ${offenders.join(", ")}`);
});
