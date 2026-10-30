import assert from "node:assert/strict";
import test from "node:test";

import { authorLabel, isTopic } from "@/lib/discussions";

const person = { name: "Aidan Matus-Enochs", school: "University of Southern California", gradYear: 2029 };

test("an anonymous post shows nothing about its author", () => {
  const label = authorLabel({ anonymous: true, isSample: false, sampleAuthor: null, author: person });
  assert.equal(label, "Anonymous");
  for (const leak of ["Aidan", "Southern", "29"]) assert.ok(!label.includes(leak), leak);
});

test("anonymous wins even on a sample", () => {
  assert.equal(authorLabel({ anonymous: true, isSample: true, sampleAuthor: "Class of 2027", author: null }), "Anonymous");
});

test("a named post shows name, school and class", () => {
  assert.equal(
    authorLabel({ anonymous: false, isSample: false, sampleAuthor: null, author: person }),
    "Aidan Matus-Enochs · University of Southern California '29",
  );
  assert.equal(authorLabel({ anonymous: false, isSample: false, sampleAuthor: null, author: null }), "A student");
});

test("a sample shows its sample label, never a person", () => {
  assert.equal(authorLabel({ anonymous: false, isSample: true, sampleAuthor: "Class of 2027", author: null }), "Class of 2027");
  assert.equal(authorLabel({ anonymous: false, isSample: true, sampleAuthor: null, author: null }), "Sample");
});

test("topics are a closed list", () => {
  assert.ok(isTopic("Interviews"));
  assert.ok(!isTopic("interviews"));
  assert.ok(!isTopic(undefined));
});
