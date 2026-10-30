import assert from "node:assert/strict";
import test from "node:test";

import { MAX_INTERNSHIPS, internshipDates, parseInternships } from "@/lib/internships";

const ok = (raw: unknown) => {
  const r = parseInternships(JSON.stringify(raw));
  assert.ok("list" in r, JSON.stringify(r));
  return r.list;
};

test("a picked firm keeps its id; a typed one has none", () => {
  const list = ok([
    { firm: "Lazard", firmId: "8d5a895b-56e4-4d1c-901c-6a99ea071c6b", website: "evil.example", role: "Summer Analyst", start: "2025-06", end: "2025-08", current: false },
    { firm: " Zenith Ridge Capital ", firmId: "not-an-id", role: "Intern", start: "2026-05", current: true },
  ]);
  assert.equal(list[0].firmId, "8d5a895b-56e4-4d1c-901c-6a99ea071c6b");
  assert.ok(!("website" in list[0]), "the browser's website is never trusted - the server looks it up");
  assert.deepEqual(list[1], { firm: "Zenith Ridge Capital", firmId: null, role: "Intern", start: "2026-05", end: null, current: true });
});

test("empty, missing and malformed input", () => {
  assert.deepEqual(parseInternships(null), { list: [] });
  assert.deepEqual(parseInternships(""), { list: [] });
  assert.ok("error" in parseInternships("{not json"));
  assert.ok("error" in parseInternships(JSON.stringify({ firm: "x" })), "an object, not a list");
  assert.ok("error" in parseInternships(JSON.stringify([{ firm: "  ", role: "x" }])), "a firm is required");
  assert.ok("error" in parseInternships(JSON.stringify(Array.from({ length: MAX_INTERNSHIPS + 1 }, () => ({ firm: "A", start: "2026-05", current: true })))));
  assert.equal(ok([{ firm: "A".repeat(500), start: "2026-05", current: true }])[0].firm.length, 100, "long text is capped");
});

test("start and end months, and an ongoing internship reads Now", () => {
  const [past, now] = ok([
    { firm: "Lazard", role: "Summer Analyst", start: "2025-06", end: "2025-08", current: false },
    { firm: "KKR", role: "Intern", start: "2026-05", end: "2026-09", current: true },
  ]);
  assert.equal(internshipDates(past), "Jun 2025 \u2013 Aug 2025");
  assert.equal(now.end, null, "an ongoing internship keeps no end");
  assert.equal(internshipDates(now), "May 2026 \u2013 Now");
  assert.ok("error" in parseInternships(JSON.stringify([{ firm: "A", start: "2026-05", end: "2025-01" }])), "end before start");
  assert.ok("error" in parseInternships(JSON.stringify([{ firm: "A", start: "May 2026" }])), "not a month");
  assert.equal(internshipDates({ start: null, end: null, current: false }), null);
});

test("dates are required: a start, and an end unless ongoing", () => {
  assert.ok("error" in parseInternships(JSON.stringify([{ firm: "A", current: true }])), "no start");
  assert.ok("error" in parseInternships(JSON.stringify([{ firm: "A", start: "2025-06" }])), "no end and not ongoing");
  assert.equal(ok([{ firm: "A", start: "2025-06", current: true }])[0].end, null, "ongoing needs no end");
});
