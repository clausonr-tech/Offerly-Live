// Who hears about a firm's posts, and who sees its events. No database.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  eventNotificationKey,
  eventVisibleTo,
  parseFirmNotificationKey,
  postingNotificationKey,
  shouldNotifyOfEvent,
  shouldNotifyOfPosting,
} from "../../src/lib/firm-delivery-rules";

const student = (over = {}) => ({ userId: "s", gradYear: 2028, schoolId: "penn", claimedSchoolId: null, isDemo: false, ...over });

test("a matched student hears about an internship they can apply to", () => {
  assert.equal(shouldNotifyOfPosting(student(), { eligibleGradYears: [2028], isDemo: false }), true);
  assert.equal(shouldNotifyOfPosting(student(), { eligibleGradYears: [2027], isDemo: false }), false, "wrong class year");
  assert.equal(shouldNotifyOfPosting(student(), { eligibleGradYears: [], isDemo: false }), true, "the firm did not say");
  assert.equal(shouldNotifyOfPosting(student({ gradYear: null }), { eligibleGradYears: [2027], isDemo: false }), true);
});

test("a campus event reaches matched students at those schools only; an open one reaches every match", () => {
  assert.equal(shouldNotifyOfEvent(student(), { schoolIds: ["penn"], isDemo: false }), true);
  assert.equal(shouldNotifyOfEvent(student(), { schoolIds: ["duke"], isDemo: false }), false);
  assert.equal(shouldNotifyOfEvent(student({ schoolId: null }), { schoolIds: ["penn"], isDemo: false }), false);
  assert.equal(shouldNotifyOfEvent(student({ schoolId: null, claimedSchoolId: "penn" }), { schoolIds: ["penn"], isDemo: false }), true);
  assert.equal(shouldNotifyOfEvent(student({ schoolId: null }), { schoolIds: [], isDemo: false }), true);
});

test("demo posts reach demo accounts only, and real posts never reach a demo", () => {
  assert.equal(shouldNotifyOfPosting(student(), { eligibleGradYears: [], isDemo: true }), false);
  assert.equal(shouldNotifyOfPosting(student({ isDemo: true }), { eligibleGradYears: [], isDemo: true }), true);
  assert.equal(shouldNotifyOfEvent(student({ isDemo: true }), { schoolIds: [], isDemo: false }), false);
});

test("on the firm's page, a campus event shows only at its schools, and closed or demo events to nobody else", () => {
  const viewer = { schoolId: "penn", claimedSchoolId: null, isDemo: false };
  assert.equal(eventVisibleTo(viewer, { schoolIds: [], isDemo: false, isActive: true }), true, "crawled or open");
  assert.equal(eventVisibleTo(viewer, { schoolIds: ["penn"], isDemo: false, isActive: true }), true);
  assert.equal(eventVisibleTo(viewer, { schoolIds: ["duke"], isDemo: false, isActive: true }), false);
  assert.equal(eventVisibleTo(viewer, { schoolIds: [], isDemo: false, isActive: false }), false);
  assert.equal(eventVisibleTo(viewer, { schoolIds: [], isDemo: true, isActive: true }), false);
});

test("a firm's bell row reads back the posting or event it is about, and nothing else does", () => {
  const id = "0b6f3a52-7d1e-4c8a-9f10-2a4b5c6d7e8f";
  assert.deepEqual(parseFirmNotificationKey(postingNotificationKey(id)), { kind: "posting", id });
  assert.deepEqual(parseFirmNotificationKey(eventNotificationKey(id)), { kind: "event", id });
  assert.equal(parseFirmNotificationKey(`outreach:${id}:2026-10-01`), null, "another kind");
  assert.equal(parseFirmNotificationKey("firm_posting:not-a-uuid"), null, "a malformed id never reaches a query");
  assert.equal(parseFirmNotificationKey(`firm_event:${id}:extra`), null);
  assert.equal(parseFirmNotificationKey(""), null);
});
