/**
 * Every admin page checks that the caller is an admin, itself.
 *
 * (app)/admin/layout.tsx gates the section, and two of its pages relied on
 * that alone. A layout is not guaranteed to render in every response for its
 * page: an RSC request carries a client-supplied router-state tree, and Next
 * starts rendering at the first segment the tree does NOT already claim - so
 * a tree naming the admin layout's segments has the page render with the
 * layout, and its role check, skipped. The pages then queried the database
 * and serialised pending crawled listings, the monitoring registry and the
 * learned firm email patterns into the response with no identity checked at
 * all.
 *
 * Asserted at the source, the way firm-portal-privacy.test.ts asserts what
 * the Analytics page prints: the hole is in which gate a FILE calls, and a
 * rule that has to hold for pages added later cannot be tested by rendering
 * the three that exist today. The gate must also come before any data is
 * read, so a page cannot answer with rows gathered before the check.
 *
 * Nothing here touches a database or the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ADMIN_DIR = path.join(process.cwd(), "src/app/(app)/admin");

/** The in-page gates that end in a redirect for anyone who is not an admin. */
const PAGE_GATES = [/\brequireAdminPage\s*\(/, /\brequireAdmin\s*\(/];

/** Where data starts being read, so the gate can be required before it. */
const READS = [/\bgetDb\s*\(/, /\bfirmPortalOverview\s*\(/, /\blistFirmAccounts\s*\(/, /\blistFirmPosts\s*\(/, /\blistAdminAudit\s*\(/];

function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pagesUnder(full));
    else if (/^page\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const PAGES = pagesUnder(ADMIN_DIR);

test("there are admin pages to check", () => {
  assert.ok(PAGES.length >= 3, `found only ${PAGES.length} admin pages - has the directory moved?`);
});

for (const page of PAGES) {
  const rel = path.relative(process.cwd(), page);

  test(`${rel} gates on role itself, not only in the layout`, () => {
    const src = fs.readFileSync(page, "utf8");
    const gate = PAGE_GATES.map((re) => src.search(re)).filter((i) => i >= 0);
    assert.ok(
      gate.length > 0,
      `${rel} has no in-page admin check. Call requireAdminPage() from @/lib/admin-session at the top of the page: the layout gate alone can be skipped on an RSC request.`,
    );

    const gateAt = Math.min(...gate);
    for (const read of READS) {
      const readAt = src.search(read);
      if (readAt < 0) continue;
      assert.ok(
        gateAt < readAt,
        `${rel} reads data (${read.source}) before its admin check - the check has to come first.`,
      );
    }
  });
}

test("the section layout still carries its own gate", () => {
  const src = fs.readFileSync(path.join(ADMIN_DIR, "layout.tsx"), "utf8");
  assert.match(src, /role\s*!==\s*"admin"/, "the admin layout no longer checks the role");
  assert.match(src, /redirect\(/, "the admin layout no longer redirects");
});

test("the gate it calls is the one that redirects a non-admin", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/admin-session.ts"), "utf8");
  // Signed out -> /login, signed in but not an admin -> away from /admin.
  assert.match(src, /redirect\("\/login"\)/);
  assert.match(src, /role\s*!==\s*"admin"\)\s*redirect\(/);
});
