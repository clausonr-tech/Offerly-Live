// Careers-site placeholders ("Join our Talent Community!") are neither stored
// nor shown, and no real role is lost on the way. The keep list is real titles
// from internship_postings on 24 September 2026 - the ones an "internship
// word" rule would have hidden (Praktikant, Werkstudent, Stage H/F,
// Apprentice, Trainee) and the ones that share a word with a placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { isPlaceholderTitle, PLACEHOLDER_TITLE_SQL_PATTERN, shortRoleTitle } from "../../src/lib/role-title";
import { isRealPosting } from "../../src/lib/internship-postings";

const PLACEHOLDERS = [
  // Stored and shown in the 2027 cycle.
  "Join our Talent Community!",
  // Seen on boards the crawler reads.
  "General Application - Investment Banking",
  "General candidate inquiries - Summer Analyst",
  "Talent Network",
  "Join Our Talent Pool",
  "General Interest – Summer 2028",
  "Expression of Interest: Analyst Programme",
  "Resume Drop - Investment Banking",
  "Résumé submission",
  "Submit your CV",
  "Submit Your Résumé",
  "Stay Connected with Houlihan Lokey",
  "Future Opportunities in Restructuring",
  "Open Application - Private Equity",
  "Spontaneous applications",
  "Initiativbewerbung (m/w/d)",
  "Candidature spontanée - Stage",
  "GENERAL   APPLICATION",
];

const REAL_ROLES = [
  // Button text in a real title: kept, and trimmed for display.
  "Summer Analyst 2027 Boston, Massachusetts Investment Banking Apply Now",
  // Share a word with a placeholder.
  "Business Ops & Talent - Summer Analyst",
  "2027 Forestry Finance Internship – Emerging Talent Summer Experience Program",
  "WerkstudentIn Business Development & Talent Operations",
  "Werkstudent im Bereich HR People Strategy (m|w|d) - Schwerpunkt Talent Management & People Development",
  "2027 Summer Financial Analyst - General Partner Advisory (Class of 2028) - New York",
  "Join our 2028 Summer Analyst Program",
  "Open Markets Summer Analyst",
  // No internship word, and real.
  "Praktikant Change Management (m/w/d)",
  "Werkstudent Aktuariat Pricing (m/w/d)",
  "Praktikum im Bereich Infrastructure Equity Transactions (m|w|d)",
  "Stage H/F - Private Equity – Janvier 2027",
  "Stagiaire en actuariat, vie et santé (été 2027, 4 mois)",
  "Apprentice Global Operations",
  "Young Apprentice - C00 - MUMBAI",
  "Branch Manager Trainee - Sherbrooke, Estrie",
  "International Graduate Trainee - focus on mathematics/actuarial science (m/f/d)*",
  "Global Operations Autumn Job - Tokyo - 2026",
  // Ordinary internship titles.
  "2028 Investment Banking Summer Analyst Program",
  "Off-Cycle Internship Programme",
  "投资银行实习生",
];

test("careers-site placeholders are recognised", () => {
  for (const t of PLACEHOLDERS) assert.equal(isPlaceholderTitle(t), true, t);
});

test("real roles are not placeholders, with or without an internship word", () => {
  for (const t of REAL_ROLES) assert.equal(isPlaceholderTitle(t), false, t);
  assert.equal(isPlaceholderTitle(null), false);
  assert.equal(isPlaceholderTitle(""), false);
});

test("isRealPosting hides a placeholder and keeps the real roles", () => {
  const posting = (roleTitle: string) => ({ roleTitle, descriptionFull: "A crawled description.", deadlineText: null, deadlineStatus: "tbd" });
  for (const t of PLACEHOLDERS) assert.equal(isRealPosting(posting(t)), false, t);
  for (const t of REAL_ROLES) assert.equal(isRealPosting(posting(t)), true, t);
});

// getRelevantPostings filters in SQL as well, so a placeholder cannot take a
// slot under the row limit. That pattern has to agree with the JavaScript one
// on every case, in Postgres's own regex engine.
test("the SQL pattern agrees with isPlaceholderTitle in Postgres", async () => {
  const db = new PGlite();
  try {
    const titles = [...PLACEHOLDERS, ...REAL_ROLES];
    const { rows } = await db.query<{ t: string; hit: boolean }>(
      "select t, t ~* $1 as hit from unnest($2::text[]) as t",
      [PLACEHOLDER_TITLE_SQL_PATTERN, titles],
    );
    assert.equal(rows.length, titles.length);
    for (const r of rows) assert.equal(r.hit, isPlaceholderTitle(r.t), r.t);
  } finally {
    await db.close();
  }
});

test("shortRoleTitle drops button text read into a title", () => {
  assert.equal(
    shortRoleTitle("Summer Analyst 2027 Boston, Massachusetts Investment Banking Apply Now"),
    "2027 Boston, Massachusetts Investment Banking",
  );
  assert.equal(shortRoleTitle("Apply Now"), "Apply Now", "nothing left, so the original comes back");
  assert.equal(shortRoleTitle("Apply Now - Mergers & Acquisitions"), "Apply Now - Mergers & Acquisitions", "only a trailing one");
});
