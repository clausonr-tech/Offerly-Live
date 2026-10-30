// The second batch of 5 October 2026 changes, as rules: expected roles shown
// only within a month, the student's own top-firm order, the recruiting
// timeline's lead months for investment banking, and predicted emails
// (hidden on 5 October, shown again with a PREDICTED label on 8 October).
import { test } from "node:test";
import assert from "node:assert/strict";

import { EXPECTED_SHOW_WITHIN_DAYS, showableExpected } from "@/lib/expected-postings";
import { orderTopFirms } from "@/lib/discovery-matches";
import { CATEGORY_TIMELINE_TRACKS, TIMELINE_LEAD_MONTHS, TIMELINE_MONTHS, timelineLead, timelineNowMarker } from "@/lib/firm-metadata";
import { emailLabel, shouldRenderEmail } from "@/lib/contact-email-render";

const NOW = new Date("2026-10-05T15:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

test("an expected role shows only when it opens within about a month", () => {
  assert.equal(showableExpected({ expectedOpensAt: days(0) }, NOW), true, "today");
  assert.equal(showableExpected({ expectedOpensAt: days(EXPECTED_SHOW_WITHIN_DAYS - 1) }, NOW), true);
  assert.equal(showableExpected({ expectedOpensAt: days(EXPECTED_SHOW_WITHIN_DAYS + 2) }, NOW), false);
  assert.equal(showableExpected({ expectedOpensAt: new Date("2027-09-13T00:00:00Z") }, NOW), false, "the screenshot's Sep 13, 2027");
  assert.equal(showableExpected({ expectedOpensAt: days(-2) }, NOW), false, "already passed without a real posting");
  assert.equal(showableExpected({ expectedOpensAt: null }, NOW), false, "no date, no promise");
});

test("top firms follow the student's own order first, then the default order", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 8, s));
  const rows = [
    { id: "a", source: "ai_matched", createdAt: t(1), position: null },
    { id: "b", source: "manual", createdAt: t(2), position: 1 },
    { id: "c", source: "ai_matched", createdAt: t(3), position: 0 },
    { id: "d", source: "manual", createdAt: t(4), position: null },
    { id: "e", source: "ai_matched", createdAt: t(5) },
  ];
  assert.deepEqual(orderTopFirms(rows).map((r) => r.id), ["c", "b", "d", "a", "e"]);
  assert.deepEqual(
    orderTopFirms(rows.map((r) => ({ ...r, position: null }))).map((r) => r.id),
    ["d", "b", "a", "c", "e"],
    "never reordered: the old order exactly",
  );
});

test("investment banking's timeline opens two summers ahead, and October 2026 is inside a 2028 cycle", () => {
  const ib = CATEGORY_TIMELINE_TRACKS.investment_banking;
  const lead = timelineLead(ib);
  assert.equal(lead, TIMELINE_LEAD_MONTHS.length, "drawn from July two years ahead");
  for (const t of ib) for (const p of t.phases) assert.ok(p.start >= -lead && p.end < TIMELINE_MONTHS.length && p.start <= p.end, `${t.label}: ${p.label}`);
  const m = timelineNowMarker(2028, new Date(2026, 9, 5), lead);
  assert.equal(m.status, "in", "a sophomore in October is in the IB cycle, not a year before it");
  assert.equal(Math.floor(m.drawAt), 3, "drawn at October, the fourth lead month");
  const bb = ib.find((t) => t.label === "Bulge Bracket")!.phases.find((p) => p.kind === "apply")!;
  assert.ok(m.offset >= bb.start + lead && m.offset <= bb.end + lead + 1, "bulge-bracket applications are open today");
});

test("sectors without lead months are drawn exactly as before", () => {
  assert.equal(timelineLead(CATEGORY_TIMELINE_TRACKS.sales_trading), 0);
  const a = timelineNowMarker(2028, new Date(2027, 6, 1));
  const b = timelineNowMarker(2028, new Date(2027, 6, 1), 0);
  assert.deepEqual(a, b);
  assert.equal(Math.floor(a.drawAt), 18 - 12, "July of the year before is column 6");
  const before = timelineNowMarker(2028, new Date(2026, 9, 5));
  assert.equal(before.status, "before");
  assert.equal(Math.floor(before.drawAt), 9, "October, on a January-first chart");
});

test("a predicted address is shown again, labelled PREDICTED (8 October 2026)", () => {
  assert.equal(shouldRenderEmail({ email: "x@evercore.com", emailConfidence: "predicted", emailDomainRelevant: true }), true);
  assert.equal(emailLabel("predicted"), "PREDICTED");
  assert.equal(shouldRenderEmail({ email: "x@evercore.com", emailConfidence: "verified", emailDomainRelevant: true }), true);
  // Still refused when the address is not on the firm's own domain.
  assert.equal(shouldRenderEmail({ email: "x@greenhill.com", emailConfidence: "predicted", emailDomainRelevant: false }), false);
});
