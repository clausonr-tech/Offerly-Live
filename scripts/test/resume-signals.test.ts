import assert from "node:assert/strict";
import test from "node:test";

import { resumeSignals } from "@/lib/resume-signals";

// Exactly the shape formatSummary writes into users.resumeText.
const SUMMARY = `EDUCATION
- University of Southern California · BS Business Administration
- GPA: 3.72

WORK EXPERIENCE
- Evercore · Summer Analyst · New York · Summer 2026
    - Built the model for a $1.2bn carve-out
- Trojan Capital · Analyst · Los Angeles · 2025
    - Covered three names

CLUBS & ACTIVITIES
- Trojan Investing Society · Vice President · 2025-2026
    - Ran the stock pitch competition

SKILLS
- Excel, Python, Bloomberg

INTERESTS
- Distance running, chess, Formula 1`;

test("interests listed on a resume are read back out", () => {
  assert.deepEqual(resumeSignals(SUMMARY).interests, ["Distance running", "chess", "Formula 1"]);
});

test("employers and clubs come back as names, without titles or dates", () => {
  const s = resumeSignals(SUMMARY);
  assert.deepEqual(s.employers, ["Evercore", "Trojan Capital"]);
  assert.deepEqual(s.activities, ["Trojan Investing Society"]);
});

test("skills are read as a list", () => {
  assert.deepEqual(resumeSignals(SUMMARY).skills, ["Excel", "Python", "Bloomberg"]);
});

test("indented highlight bullets are never mistaken for entries", () => {
  // "    - Built the model..." is detail, not an employer.
  assert.ok(!resumeSignals(SUMMARY).employers.some((e) => e.startsWith("Built")));
});

test("a resume with no interests section yields none, not junk", () => {
  const noInterests = SUMMARY.split("\n\nINTERESTS")[0];
  assert.deepEqual(resumeSignals(noInterests).interests, []);
  assert.deepEqual(resumeSignals(noInterests).skills, ["Excel", "Python", "Bloomberg"]);
});

test("nothing on file yields empty lists, never a crash", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.deepEqual(resumeSignals(v), { interests: [], skills: [], employers: [], activities: [] });
  }
});
