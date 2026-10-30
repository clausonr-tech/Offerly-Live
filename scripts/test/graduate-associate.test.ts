// Offerly is for undergraduates, and in banking the title carries the degree:
// Summer ANALYST is the undergraduate seat, Summer ASSOCIATE is the MBA one.
//
// The regression this guards: 69 MBA summer-associate postings were live and
// reachable by a student graduating in 2029 on 21 September 2026. The existing
// hard rule only fires on titles that print "MBA" outright, and most banks
// never do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { graduateAssociateReason } from "../../src/lib/monitoring/classify";

const MBA_BODY = "Candidates must be currently enrolled in an MBA program graduating in 2028.";

test("an MBA summer associate programme is excluded", () => {
  // Real titles, live on 2026-09-21.
  for (const title of [
    "Global Investment Banking Summer Associate Program - 2027",
    "2027 Liability Management & Restructuring Summer Associate Program – New York",
    "2027 Guggenheim Securities Investment Banking Summer Associate",
  ]) {
    assert.ok(graduateAssociateReason(title, null, MBA_BODY), `expected exclusion for: ${title}`);
  }
});

test("a summer ANALYST posting survives even when the body mentions MBA", () => {
  // Banks describe the analyst and associate programmes in one shared body, so
  // "MBA" appears in postings undergraduates CAN take. Excluding on the
  // description alone would have dropped these - all real, all live.
  for (const title of [
    "2027 Japan Summer Analyst Program (Tokyo)",
    "2027 Quantitative Risk Management Summer Analyst Program",
    "2027 Finance Summer Analyst Program (Hong Kong)",
  ]) {
    assert.equal(graduateAssociateReason(title, null, MBA_BODY), null, title);
  }
});

test("a posting advertising BOTH seats stays in", () => {
  // An undergraduate can apply to the analyst half of it.
  assert.equal(
    graduateAssociateReason("2027 Summer Analyst / Summer Associate Program", null, MBA_BODY),
    null,
  );
});

test("consulting's undergraduate 'associate' is not swept up", () => {
  // Berkeley Research Group posts "2027 Summer Associate (Intern)" - in
  // consulting, associate is the undergraduate grade. A title-only rule would
  // have thrown these away.
  assert.equal(
    graduateAssociateReason("2027 Summer Associate (Intern) - Corporate Finance", null, "Open to undergraduates in their penultimate year."),
    null,
  );
});

test("a summer associate posting that states no requirement is left alone", () => {
  // 19 of the 69 state nothing. They stay in: a wrong exclusion costs a
  // student a real opening, and we have no evidence either way.
  assert.equal(
    graduateAssociateReason("2027 Investment Banking Summer Associate Program", null, "Join our team in New York."),
    null,
  );
});

test("the division is judged too, not only the title", () => {
  assert.ok(graduateAssociateReason("2027 Summer Associate", "Investment Banking", MBA_BODY));
});

test("a master's degree or PhD requirement counts, not just MBA", () => {
  assert.ok(
    graduateAssociateReason("2027 Summer Associate Program", null, "Requires a master's degree in finance."),
  );
  assert.ok(
    graduateAssociateReason("2027 Summer Associate Program", null, "Open to graduate degree candidates."),
  );
});

test("a bare 'associate' title is never enough on its own", () => {
  // Bridgewater posts "2028 Investment Associate Intern" - undergraduate.
  assert.equal(graduateAssociateReason("2028 Investment Associate Intern", null, MBA_BODY), null);
});
