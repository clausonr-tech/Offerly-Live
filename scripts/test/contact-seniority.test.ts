import assert from "node:assert/strict";
import test from "node:test";

import { juniorFirst, seniorityLevel } from "@/lib/contact-seniority";

test("titles read bottom to top", () => {
  const order = [
    "Private Equity Summer Analyst",
    "Investment Banking Analyst",
    "Investment Banking Associate",
    "Investment Banking Vice President",
    "Principal, Private Equity",
    "Managing Director",
  ].map(seniorityLevel);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(seniorityLevel("Senior Managing Director"), seniorityLevel("Managing Director"), "an SMD is an MD");
  assert.equal(seniorityLevel("Chief Technology Officer"), 5);
  assert.equal(seniorityLevel("Senior Associate"), seniorityLevel("Associate"));
});

test("the Harris Williams set, as measured, comes out junior first", () => {
  const titles = [
    "Chief Technology Officer",
    "Managing Director",
    "Investment Banking Analyst",
    "Investment Banking Associate",
    "Investment Banking Vice President",
  ];
  assert.deepEqual(juniorFirst(titles, (t) => t), [
    "Investment Banking Analyst",
    "Investment Banking Associate",
    "Investment Banking Vice President",
    "Chief Technology Officer",
    "Managing Director",
  ]);
});

test("people at the same level keep their similarity order", () => {
  const people = [
    { name: "closest", title: "Analyst" },
    { name: "MD", title: "Managing Director" },
    { name: "second", title: "Analyst" },
  ];
  assert.deepEqual(juniorFirst(people, (p) => p.title).map((p) => p.name), ["closest", "second", "MD"]);
});
