import assert from "node:assert/strict";
import test from "node:test";

import { levelOf } from "@/lib/contact-level";

test("levels read from titles, most senior first", () => {
  const cases: [string | null, string][] = [
    ["Investment Banking Analyst", "Analyst"],
    ["Senior Associate, Private Equity", "Associate"],
    ["Vice President", "VP"],
    ["Senior Vice President - M&A", "VP"],
    ["Associate Director", "Director"],
    ["Managing Director", "MD / Exec"],
    ["President & CEO", "MD / Exec"],
    ["Partner", "MD / Exec"],
    ["Summer Intern", "Intern"],
    ["MBA Candidate", "Other"],
    [null, "Other"],
  ];
  for (const [role, want] of cases) assert.equal(levelOf(role), want, String(role));
});
