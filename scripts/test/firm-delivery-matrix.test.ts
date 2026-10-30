// Who is told about a firm's post, and who sees its events, across every
// combination that matters. No database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  eventNotificationKey,
  eventVisibleTo,
  postingNotificationKey,
  shouldNotifyOfEvent,
  shouldNotifyOfPosting,
  type MatchedStudent,
} from "../../src/lib/firm-delivery-rules";

const S = (over: Partial<MatchedStudent> = {}): MatchedStudent => ({
  userId: "s",
  gradYear: 2028,
  schoolId: null,
  claimedSchoolId: null,
  isDemo: false,
  ...over,
});

describe("internship notifications: class year x eligibility x demo", () => {
  const years = [null, 2027, 2028, 2029];
  const eligibility = [[], [2028], [2028, 2029], [2030]];
  for (const gradYear of years) {
    for (const eligible of eligibility) {
      for (const demo of [false, true]) {
        const expected = !demo && (eligible.length === 0 || gradYear === null || eligible.includes(gradYear));
        test(`class ${gradYear ?? "unknown"}, posting for [${eligible.join(",") || "anyone"}]${demo ? ", demo posting" : ""} -> ${expected ? "told" : "not told"}`, () => {
          assert.equal(shouldNotifyOfPosting(S({ gradYear }), { eligibleGradYears: eligible, isDemo: demo }), expected);
        });
      }
    }
  }
  test("a demo student hears about demo posts only", () => {
    assert.equal(shouldNotifyOfPosting(S({ isDemo: true }), { eligibleGradYears: [], isDemo: true }), true);
    assert.equal(shouldNotifyOfPosting(S({ isDemo: true }), { eligibleGradYears: [], isDemo: false }), false);
  });
});

describe("event notifications: the student's school x the event's schools", () => {
  const students: [string, Partial<MatchedStudent>][] = [
    ["verified at Penn", { schoolId: "penn" }],
    ["claimed Penn, unverified", { claimedSchoolId: "penn" }],
    ["verified at Duke, claimed Penn", { schoolId: "duke", claimedSchoolId: "penn" }],
    ["no school at all", {}],
  ];
  const events: [string, string[]][] = [
    ["open to everyone", []],
    ["at Penn", ["penn"]],
    ["at Penn and Duke", ["penn", "duke"]],
    ["at Yale", ["yale"]],
  ];
  const expected: Record<string, boolean[]> = {
    "verified at Penn": [true, true, true, false],
    "claimed Penn, unverified": [true, true, true, false],
    // The verified school wins over the claimed one.
    "verified at Duke, claimed Penn": [true, false, true, false],
    "no school at all": [true, false, false, false],
  };
  for (const [sLabel, over] of students) {
    events.forEach(([eLabel, schoolIds], i) => {
      const want = expected[sLabel][i];
      test(`${sLabel}, event ${eLabel} -> ${want ? "told" : "not told"}`, () => {
        assert.equal(shouldNotifyOfEvent(S(over), { schoolIds, isDemo: false }), want);
        // What they are told about is exactly what they can see on the firm's page.
        const viewer = { schoolId: over.schoolId ?? null, claimedSchoolId: over.claimedSchoolId ?? null, isDemo: false };
        assert.equal(eventVisibleTo(viewer, { schoolIds, isDemo: false, isActive: true }), want);
      });
    });
  }
  test("a closed event is shown to nobody", () => {
    for (const [, over] of students) {
      const viewer = { schoolId: over.schoolId ?? null, claimedSchoolId: over.claimedSchoolId ?? null, isDemo: false };
      assert.equal(eventVisibleTo(viewer, { schoolIds: [], isDemo: false, isActive: false }), false);
    }
  });
  test("a demo event is hidden from real students and shown to demo ones", () => {
    assert.equal(eventVisibleTo({ schoolId: null, claimedSchoolId: null, isDemo: false }, { schoolIds: [], isDemo: true, isActive: true }), false);
    assert.equal(eventVisibleTo({ schoolId: null, claimedSchoolId: null, isDemo: true }, { schoolIds: [], isDemo: true, isActive: true }), true);
  });
});

describe("notification keys", () => {
  test("one key per post, never shared between a posting and an event with the same id", () => {
    assert.notEqual(postingNotificationKey("x"), eventNotificationKey("x"));
    assert.equal(postingNotificationKey("x"), postingNotificationKey("x"));
  });
});
