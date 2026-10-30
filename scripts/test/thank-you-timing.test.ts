// The thank-you prompt's clock: when it falls due, when it stops being owed,
// which day's banner it is, and which interview a sent note answers.
//
// Adversarial on purpose. Every test states the behaviour a student should
// see; the edges are exact to the millisecond, the zones span the date line
// and both daylight-saving hemispheres, and a seeded fuzz checks the
// invariants selectThankYous must keep on inputs nobody wrote by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_DAY_INTERVIEW_DUE_HOUR,
  DEFAULT_CHAT_MINUTES,
  DEFAULT_INTERVIEW_MINUTES,
  THANK_YOU_AFTER_HOURS,
  THANK_YOU_LOOKBACK_DAYS,
  daysOwed,
  interviewsAnswered,
  selectThankYous,
  thankYouDueAt,
  thankYouFlashKey,
  thankYouKey,
  type ChatEvent,
  type ThankContact,
} from "../../src/lib/thank-you";
import { DEFAULT_TIME_ZONE, localDateString, localParts } from "../../src/lib/time-zone";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOOKBACK = THANK_YOU_LOOKBACK_DAYS * DAY;
const AFTER = THANK_YOU_AFTER_HOURS * HOUR;

const at = (iso: string) => new Date(iso);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const DANA: ThankContact = { id: "c-dana", name: "Dana Reed", email: "dana@evercore.com" };
const SAM: ThankContact = { id: "c-sam", name: "Sam Ito", email: "sam@lazard.com" };
const PEOPLE = [DANA, SAM];

const START = at("2026-09-22T14:00:00Z");

function chat(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:chat1",
    title: "Coffee chat with Dana Reed",
    startsAt: START,
    endsAt: plus(START, 30 * MIN),
    ...over,
  };
}

function interview(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "offerly:int1",
    title: "Goldman first round interview",
    type: "interview",
    startsAt: START,
    endsAt: plus(START, 45 * MIN),
    ...over,
  };
}

function superday(date: string, over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: `google:sd-${date}`,
    title: "Evercore superday",
    // A date-only Google entry is parsed as midnight UTC on its date.
    startsAt: at(date),
    endsAt: null,
    allDay: true,
    ...over,
  };
}

type Input = Parameters<typeof selectThankYous>[0];
function owed(events: ChatEvent[], extra: Partial<Input> = {}) {
  return selectThankYous({ events, contacts: PEOPLE, done: new Set(), thanked: [], ...extra });
}
const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

// =====================================================================
// 1. thankYouDueAt
// =====================================================================

test("constants: all-day interviews are due at 18:00", () => assert.equal(ALL_DAY_INTERVIEW_DUE_HOUR, 18));
test("constants: an interview with no end is taken as an hour", () => assert.equal(DEFAULT_INTERVIEW_MINUTES, 60));
test("constants: a chat with no end is taken as 30 minutes", () => assert.equal(DEFAULT_CHAT_MINUTES, 30));

test("due: chat with an end is due exactly 2h after the end", () => {
  const e = chat({ endsAt: plus(START, 45 * MIN) });
  assert.equal(thankYouDueAt(e, "chat").getTime(), START.getTime() + 45 * MIN + AFTER);
});

test("due: interview with an end is due exactly 2h after the end (occasion does not change a real end)", () => {
  const e = interview({ endsAt: plus(START, 90 * MIN) });
  assert.equal(thankYouDueAt(e, "interview").getTime(), START.getTime() + 90 * MIN + AFTER);
});

test("due: chat with no end is start + 30m + 2h", () => {
  assert.equal(thankYouDueAt(chat({ endsAt: null }), "chat").getTime(), START.getTime() + 30 * MIN + AFTER);
});

test("due: interview with no end is start + 60m + 2h", () => {
  assert.equal(
    thankYouDueAt(interview({ endsAt: null }), "interview").getTime(),
    START.getTime() + 60 * MIN + AFTER,
  );
});

test("due: occasion defaults to chat", () => {
  assert.equal(thankYouDueAt({ startsAt: START, endsAt: null }).getTime(), START.getTime() + 30 * MIN + AFTER);
});

test("due: a zero-length entry is due between start + 2h and start + default length + 2h", () => {
  // Either reading is defensible: the end taken literally, or (as
  // lib/calendar.ts resolveEnd does) a non-positive length read as no end.
  const due = thankYouDueAt(chat({ endsAt: START }), "chat").getTime();
  assert.ok(due >= START.getTime() + AFTER && due <= START.getTime() + DEFAULT_CHAT_MINUTES * MIN + AFTER);
});

test("due: a one-millisecond entry is due 2h + 1ms after it starts", () => {
  assert.equal(thankYouDueAt(chat({ endsAt: plus(START, 1) }), "chat").getTime(), START.getTime() + 1 + AFTER);
});

test("due: a long entry (8h) is due 2h after its end, not after a default length", () => {
  assert.equal(thankYouDueAt(chat({ endsAt: plus(START, 8 * HOUR) }), "chat").getTime(), START.getTime() + 10 * HOUR);
});

test("due: an entry spanning midnight is due 2h after its end the next day", () => {
  const s = at("2026-09-22T23:30:00Z");
  const e = at("2026-09-23T00:30:00Z");
  assert.equal(thankYouDueAt({ startsAt: s, endsAt: e }).toISOString(), "2026-09-23T02:30:00.000Z");
});

test("due: end before start (bad data) is never due before the entry has even begun + 2h", () => {
  // An Offerly entry whose end was typed before its start. Taken literally,
  // the prompt would fall due before the chat happens.
  const e = chat({ endsAt: plus(START, -DAY) });
  const due = thankYouDueAt(e, "chat");
  assert.ok(due.getTime() >= START.getTime() + AFTER, `due ${due.toISOString()} is before start + 2h`);
});

test("due: end 1ms before start (bad data) is still not due before start + 2h", () => {
  const due = thankYouDueAt(chat({ endsAt: plus(START, -1) }), "chat");
  assert.ok(due.getTime() >= START.getTime() + AFTER);
});

test("select: a future chat with a bad past end is not prompted before it happens", () => {
  const future = plus(START, 3 * DAY);
  const e = chat({ startsAt: future, endsAt: plus(future, -2 * DAY) });
  assert.deepEqual(keys(owed([e], { now: plus(future, -HOUR) })), []);
});

test("due: far future (year 9999) is computed without overflow", () => {
  const s = at("9999-06-01T12:00:00Z");
  assert.equal(thankYouDueAt({ startsAt: s, endsAt: null }).toISOString(), "9999-06-01T14:30:00.000Z");
});

test("due: far past (1970) is computed", () => {
  const s = at("1970-01-01T00:00:00Z");
  assert.equal(thankYouDueAt({ startsAt: s, endsAt: null }, "interview").toISOString(), "1970-01-01T03:00:00.000Z");
});

test("due: allDay:false with a midnight-UTC start is treated as timed, not all-day", () => {
  const s = at("2026-09-22T00:00:00Z");
  assert.equal(thankYouDueAt({ startsAt: s, endsAt: null, allDay: false }, "interview").toISOString(), "2026-09-22T03:00:00.000Z");
});

test("due: allDay ignores endsAt (a Google all-day end is the next date, exclusive)", () => {
  const e = superday("2026-09-22", { endsAt: at("2026-09-23") });
  assert.equal(thankYouDueAt(e, "interview", "America/New_York").toISOString(), "2026-09-22T22:00:00.000Z");
});

test("due: the default zone is America/New_York", () => {
  assert.equal(DEFAULT_TIME_ZONE, "America/New_York");
  const e = superday("2026-09-22");
  assert.equal(thankYouDueAt(e, "interview").getTime(), thankYouDueAt(e, "interview", "America/New_York").getTime());
});

// =====================================================================
// 2. All-day interviews: 18:00 on the student's clock, that date
// =====================================================================

const ALL_DAY_CASES: [zone: string, date: string, expectedUtc: string][] = [
  // US: DST starts 2026-03-08, ends 2026-11-01.
  ["America/New_York", "2026-03-07", "2026-03-07T23:00:00.000Z"],
  ["America/New_York", "2026-03-08", "2026-03-08T22:00:00.000Z"],
  ["America/New_York", "2026-03-09", "2026-03-09T22:00:00.000Z"],
  ["America/New_York", "2026-10-31", "2026-10-31T22:00:00.000Z"],
  ["America/New_York", "2026-11-01", "2026-11-01T23:00:00.000Z"],
  ["America/New_York", "2026-09-22", "2026-09-22T22:00:00.000Z"],
  ["America/Los_Angeles", "2026-03-08", "2026-03-09T01:00:00.000Z"],
  ["America/Los_Angeles", "2026-11-01", "2026-11-02T02:00:00.000Z"],
  ["America/Los_Angeles", "2026-12-31", "2027-01-01T02:00:00.000Z"],
  ["America/Los_Angeles", "2026-06-15", "2026-06-16T01:00:00.000Z"],
  // EU: BST starts 2026-03-29, ends 2026-10-25.
  ["Europe/London", "2026-03-28", "2026-03-28T18:00:00.000Z"],
  ["Europe/London", "2026-03-29", "2026-03-29T17:00:00.000Z"],
  ["Europe/London", "2026-10-25", "2026-10-25T18:00:00.000Z"],
  ["Europe/London", "2026-10-24", "2026-10-24T17:00:00.000Z"],
  ["Asia/Kolkata", "2026-03-08", "2026-03-08T12:30:00.000Z"],
  ["Asia/Kolkata", "2026-11-01", "2026-11-01T12:30:00.000Z"],
  ["Asia/Tokyo", "2026-09-22", "2026-09-22T09:00:00.000Z"],
  ["Asia/Tokyo", "2027-01-01", "2027-01-01T09:00:00.000Z"],
  // Australia: AEDT ends 2026-04-05, starts 2026-10-04.
  ["Australia/Sydney", "2026-04-04", "2026-04-04T07:00:00.000Z"],
  ["Australia/Sydney", "2026-04-05", "2026-04-05T08:00:00.000Z"],
  ["Australia/Sydney", "2026-10-04", "2026-10-04T07:00:00.000Z"],
  ["Australia/Sydney", "2026-10-03", "2026-10-03T08:00:00.000Z"],
  // NZ: NZDT ends 2026-04-05, starts 2026-09-27.
  ["Pacific/Auckland", "2026-04-05", "2026-04-05T06:00:00.000Z"],
  ["Pacific/Auckland", "2026-09-27", "2026-09-27T05:00:00.000Z"],
  ["Pacific/Auckland", "2026-09-26", "2026-09-26T06:00:00.000Z"],
  ["Pacific/Auckland", "2026-01-01", "2026-01-01T05:00:00.000Z"],
  // Odd offsets and the extremes of the date line.
  ["Asia/Kathmandu", "2026-09-22", "2026-09-22T12:15:00.000Z"],
  ["Pacific/Chatham", "2026-09-22", "2026-09-22T05:15:00.000Z"],
  ["Pacific/Kiritimati", "2026-09-22", "2026-09-22T04:00:00.000Z"],
  ["Pacific/Pago_Pago", "2026-09-22", "2026-09-23T05:00:00.000Z"],
  ["UTC", "2026-09-22", "2026-09-22T18:00:00.000Z"],
  ["America/New_York", "2028-02-29", "2028-02-29T23:00:00.000Z"],
];

for (const [zone, date, expected] of ALL_DAY_CASES) {
  test(`all-day: ${zone} ${date} is due at 18:00 local (${expected})`, () => {
    const due = thankYouDueAt(superday(date), "interview", zone);
    assert.equal(due.toISOString(), expected);
    const p = localParts(due, zone);
    assert.equal(localDateString(due, zone), date);
    assert.equal(p.hour, 18);
    assert.equal(p.minute, 0);
  });
}

test("all-day: selectThankYous honours the student's zone (Tokyo): 1ms before 18:00 JST not owed, at 18:00 owed", () => {
  const e = superday("2026-09-22");
  const due = at("2026-09-22T09:00:00Z");
  assert.deepEqual(keys(owed([e], { now: plus(due, -1), timeZone: "Asia/Tokyo" })), []);
  const got = owed([e], { now: due, timeZone: "Asia/Tokyo" });
  assert.deepEqual(keys(got), [thankYouKey(e.sourceKey)]);
  assert.equal(got[0].dueAt.toISOString(), due.toISOString());
  assert.equal(got[0].occasion, "interview");
});

test("all-day: the same superday is owed in Auckland but not yet in Los Angeles at the same instant", () => {
  const e = superday("2026-09-22");
  const now = at("2026-09-22T12:00:00Z");
  assert.equal(owed([e], { now, timeZone: "Pacific/Auckland" }).length, 1);
  assert.equal(owed([e], { now, timeZone: "America/Los_Angeles" }).length, 0);
});

test("all-day: a superday is dropped 14 days + 1ms after 18:00 local", () => {
  const e = superday("2026-09-01");
  const due = thankYouDueAt(e, "interview", "Europe/London");
  assert.equal(owed([e], { now: plus(due, LOOKBACK), timeZone: "Europe/London" }).length, 1);
  assert.equal(owed([e], { now: plus(due, LOOKBACK + 1), timeZone: "Europe/London" }).length, 0);
});

// =====================================================================
// 3. selectThankYous at exact boundaries
// =====================================================================

const DUE = plus(START, 30 * MIN + AFTER);

test("boundary: now == dueAt is owed", () => {
  assert.equal(owed([chat()], { now: DUE }).length, 1);
});

test("boundary: now == dueAt - 1ms is not owed", () => {
  assert.equal(owed([chat()], { now: plus(DUE, -1) }).length, 0);
});

test("boundary: exactly 14 days late is owed", () => {
  assert.equal(owed([chat()], { now: plus(DUE, LOOKBACK) }).length, 1);
});

test("boundary: 14 days + 1ms late is dropped", () => {
  assert.equal(owed([chat()], { now: plus(DUE, LOOKBACK + 1) }).length, 0);
});

test("boundary: interview with no end, 1ms before start+3h not owed, at start+3h owed", () => {
  const e = interview({ endsAt: null });
  const due = plus(START, 3 * HOUR);
  assert.equal(owed([e], { now: plus(due, -1) }).length, 0);
  assert.equal(owed([e], { now: due }).length, 1);
});

test("boundary: a thank-you sent exactly at startsAt answers the chat", () => {
  assert.equal(owed([chat()], { now: DUE, thanked: [{ contactId: DANA.id, at: START }] }).length, 0);
});

test("boundary: a thank-you sent 1ms before startsAt does not answer it", () => {
  assert.equal(owed([chat()], { now: DUE, thanked: [{ contactId: DANA.id, at: plus(START, -1) }] }).length, 1);
});

test("boundary: a thank-you to someone else does not answer it", () => {
  assert.equal(owed([chat()], { now: DUE, thanked: [{ contactId: SAM.id, at: plus(START, HOUR) }] }).length, 1);
});

test("boundary: a chat with nobody known is answered by a thank-you that belongs to no other entry", () => {
  const e = chat({ title: "Coffee chat", contactId: null });
  assert.equal(owed([e], { now: DUE, thanked: [{ contactId: DANA.id, at: plus(START, HOUR) }] }).length, 0);
});

test("boundary: ...but not by one that answers another entry's person", () => {
  const unknown = chat({ sourceKey: "google:u", title: "Coffee chat", contactId: null });
  const withDana = chat({ sourceKey: "google:d", title: "Coffee chat with Dana Reed" });
  const left = owed([unknown, withDana], { now: DUE, thanked: [{ contactId: DANA.id, at: plus(START, HOUR) }] });
  assert.deepEqual(left.map((t) => t.key), [thankYouKey("google:u")]);
});

test("boundary: ...nor by one sent before it began", () => {
  const e = chat({ title: "Coffee chat", contactId: null });
  assert.equal(owed([e], { now: DUE, thanked: [{ contactId: "c-new", at: plus(START, -1) }] }).length, 1);
});

test("boundary: a send after now (clock skew) still answers the chat", () => {
  assert.equal(owed([chat()], { now: DUE, thanked: [{ contactId: DANA.id, at: plus(DUE, DAY) }] }).length, 0);
});

test("boundary: a ticked-off chat is not owed at any time", () => {
  const done = new Set([thankYouKey("google:chat1")]);
  for (const t of [0, HOUR, DAY, LOOKBACK]) assert.equal(owed([chat()], { now: plus(DUE, t), done }).length, 0);
});

test("boundary: an interview thank-you exactly at interview start answers it", () => {
  const e = interview();
  const due = thankYouDueAt(e, "interview");
  // Nobody listed: credited (one note in), still owed until "That's everyone".
  const got = owed([e], { now: due, thanked: [{ contactId: "c-x", at: START, interview: true }] });
  assert.deepEqual(got.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:int1"), 1]]);
  // The linked contact thanked exactly at the start: everyone, so closed.
  const linked = interview({ contactId: DANA.id });
  assert.equal(owed([linked], { now: due, thanked: [{ contactId: DANA.id, at: START, interview: true }] }).length, 0);
  assert.equal(owed([linked], { now: due, thanked: [{ contactId: DANA.id, at: START }] }).length, 0);
});

test("boundary: an interview thank-you 1ms before interview start does not answer it", () => {
  const e = interview();
  const due = thankYouDueAt(e, "interview");
  const got = owed([e], { now: due, thanked: [{ contactId: "c-x", at: plus(START, -1), interview: true }] });
  assert.equal(got.length, 1);
  assert.equal(got[0].notesSent, 0);
  const linked = interview({ contactId: DANA.id });
  assert.equal(owed([linked], { now: due, thanked: [{ contactId: DANA.id, at: plus(START, -1), interview: true }] }).length, 1);
});

test("boundary: a non-interview send to a stranger does not answer an interview", () => {
  const e = interview();
  const due = thankYouDueAt(e, "interview");
  assert.equal(owed([e], { now: due, thanked: [{ contactId: "c-x", at: plus(START, HOUR) }] }).length, 1);
});

test("boundary: dueAt on the prompt equals thankYouDueAt for the event", () => {
  const [p] = owed([chat({ endsAt: plus(START, 17 * MIN) })], { now: plus(DUE, DAY) });
  assert.equal(p.dueAt.getTime(), START.getTime() + 17 * MIN + AFTER);
  assert.equal(p.startsAt.getTime(), START.getTime());
});

// =====================================================================
// 4. daysOwed and thankYouFlashKey across local midnight
// =====================================================================

const K = "thank_you:google:chat1";

test("flash key includes the notification key", () => {
  const fk = thankYouFlashKey(K, START, "America/New_York");
  assert.ok(fk.startsWith(K + ":"), fk);
  assert.equal(fk, `${K}:2026-09-22`);
});

test("flash key: two different notification keys never share a key on the same day", () => {
  assert.notEqual(thankYouFlashKey("thank_you:a", START), thankYouFlashKey("thank_you:b", START));
});

test("flash key: default zone is New York", () => {
  assert.equal(thankYouFlashKey(K, START), thankYouFlashKey(K, START, "America/New_York"));
});

const MIDNIGHT_CASES: [zone: string, lastMinute: string, midnight: string][] = [
  ["America/New_York", "2026-09-23T03:59:00Z", "2026-09-23T04:00:00Z"],
  ["America/Los_Angeles", "2026-09-23T06:59:00Z", "2026-09-23T07:00:00Z"],
  ["Europe/London", "2026-09-22T22:59:00Z", "2026-09-22T23:00:00Z"],
  ["Asia/Kolkata", "2026-09-22T18:29:00Z", "2026-09-22T18:30:00Z"],
  ["Asia/Tokyo", "2026-09-22T14:59:00Z", "2026-09-22T15:00:00Z"],
  ["Australia/Sydney", "2026-09-22T13:59:00Z", "2026-09-22T14:00:00Z"],
  ["Pacific/Auckland", "2026-09-22T11:59:00Z", "2026-09-22T12:00:00Z"],
  // Midnight on DST-change days.
  ["America/New_York", "2026-03-08T04:59:00Z", "2026-03-08T05:00:00Z"],
  ["America/New_York", "2026-11-01T03:59:00Z", "2026-11-01T04:00:00Z"],
  ["Europe/London", "2026-03-29T22:59:00Z", "2026-03-29T23:00:00Z"],
  ["Europe/London", "2026-10-25T23:59:00Z", "2026-10-26T00:00:00Z"],
];

for (const [zone, before, after] of MIDNIGHT_CASES) {
  test(`flash key: ${zone} (${after}) 23:59 vs 00:00 local gives different keys, one day apart`, () => {
    const a = at(before);
    const b = at(after);
    assert.equal(localParts(a, zone).hour, 23);
    assert.equal(localParts(b, zone).hour, 0);
    assert.notEqual(thankYouFlashKey(K, a, zone), thankYouFlashKey(K, b, zone));
    const due = plus(a, -HOUR);
    assert.equal(daysOwed(due, a, zone), 0);
    assert.equal(daysOwed(due, b, zone), 1);
  });
}

for (const zone of ["America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland"]) {
  test(`flash key: ${zone} same local day gives the same key at every hour`, () => {
    // Local 00:00 on 2026-09-22 through 23:59.
    const p0 = localParts(at("2026-09-22T12:00:00Z"), zone);
    const date = `${p0.year}-${String(p0.month).padStart(2, "0")}-${String(p0.day).padStart(2, "0")}`;
    const keysSeen = new Set<string>();
    for (let t = at("2026-09-20T00:00:00Z").getTime(); t < at("2026-09-25T00:00:00Z").getTime(); t += 15 * MIN) {
      const d = new Date(t);
      if (localDateString(d, zone) === date) keysSeen.add(thankYouFlashKey(K, d, zone));
    }
    assert.deepEqual([...keysSeen], [`${K}:${date}`]);
  });
}

test("flash key: a New York student does not get a new key at UTC midnight", () => {
  const a = at("2026-09-22T23:30:00Z"); // 19:30 EDT
  const b = at("2026-09-23T00:30:00Z"); // 20:30 EDT
  assert.equal(thankYouFlashKey(K, a, "America/New_York"), thankYouFlashKey(K, b, "America/New_York"));
  assert.equal(daysOwed(a, b, "America/New_York"), 0);
});

test("flash key: a Los Angeles student does not get a new key at UTC midnight", () => {
  const a = at("2026-09-22T23:59:59.999Z");
  const b = at("2026-09-23T00:00:00Z");
  assert.equal(thankYouFlashKey(K, a, "America/Los_Angeles"), thankYouFlashKey(K, b, "America/Los_Angeles"));
});

test("flash key: a Tokyo student gets a new key at 15:00 UTC, not at UTC midnight", () => {
  const z = "Asia/Tokyo";
  assert.notEqual(thankYouFlashKey(K, at("2026-09-22T14:59:59Z"), z), thankYouFlashKey(K, at("2026-09-22T15:00:00Z"), z));
  assert.equal(thankYouFlashKey(K, at("2026-09-22T23:59:59Z"), z), thankYouFlashKey(K, at("2026-09-23T00:00:00Z"), z));
});

test("flash key: the 25-hour fall-back day in New York is one key", () => {
  const z = "America/New_York";
  const set = new Set<string>();
  for (let t = at("2026-11-01T04:00:00Z").getTime(); t < at("2026-11-02T05:00:00Z").getTime(); t += 30 * MIN) {
    set.add(thankYouFlashKey(K, new Date(t), z));
  }
  assert.deepEqual([...set], [`${K}:2026-11-01`]);
});

test("flash key: the 23-hour spring-forward day in New York is one key", () => {
  const z = "America/New_York";
  const set = new Set<string>();
  for (let t = at("2026-03-08T05:00:00Z").getTime(); t < at("2026-03-09T04:00:00Z").getTime(); t += 30 * MIN) {
    set.add(thankYouFlashKey(K, new Date(t), z));
  }
  assert.deepEqual([...set], [`${K}:2026-03-08`]);
});

test("daysOwed: 0 at the due instant", () => assert.equal(daysOwed(DUE, DUE, "America/New_York"), 0));
test("daysOwed: 0 when now is before due (never negative)", () =>
  assert.equal(daysOwed(DUE, plus(DUE, -5 * DAY), "America/New_York"), 0));
test("daysOwed: 1 the next local day, even 1 minute later", () => {
  const due = at("2026-09-23T03:58:00Z"); // 23:58 EDT
  assert.equal(daysOwed(due, at("2026-09-23T04:00:00Z"), "America/New_York"), 1);
});
test("daysOwed: still 0 at 23:59 of the same local day 20h later", () => {
  const due = at("2026-09-22T08:00:00Z"); // 04:00 EDT
  assert.equal(daysOwed(due, at("2026-09-23T03:59:00Z"), "America/New_York"), 0);
});
test("daysOwed: 14 exactly 14 days late", () => assert.equal(daysOwed(DUE, plus(DUE, LOOKBACK), "America/New_York"), 14));
test("daysOwed: counts calendar days across the US fall-back change", () => {
  const due = at("2026-10-31T16:00:00Z"); // 12:00 EDT Sat
  assert.equal(daysOwed(due, at("2026-11-02T17:00:00Z"), "America/New_York"), 2); // 12:00 EST Mon
});
test("daysOwed: counts calendar days across the US spring-forward change", () => {
  const due = at("2026-03-07T17:00:00Z"); // 12:00 EST Sat
  assert.equal(daysOwed(due, at("2026-03-09T16:00:00Z"), "America/New_York"), 2); // 12:00 EDT Mon
});
test("daysOwed: across a year boundary", () => {
  assert.equal(daysOwed(at("2026-12-31T15:00:00Z"), at("2027-01-02T15:00:00Z"), "Europe/London"), 2);
});
test("daysOwed: across Feb 29 in a leap year", () => {
  assert.equal(daysOwed(at("2028-02-28T15:00:00Z"), at("2028-03-01T15:00:00Z"), "UTC"), 2);
});
test("daysOwed: the same pair of instants can be 0 in one zone and 1 in another", () => {
  const due = at("2026-09-22T11:00:00Z");
  const now = at("2026-09-22T13:00:00Z");
  assert.equal(daysOwed(due, now, "America/New_York"), 0); // 07:00 -> 09:00 EDT, same day
  assert.equal(daysOwed(due, now, "Pacific/Auckland"), 1); // 23:00 NZST -> 01:00 the next day
});

// Property: a student loading pages hourly for 5 days. One banner per local
// day while owed, never two, and daysOwed advances with the key.
const SIM_ZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];
const SIM_STARTS = ["2026-09-22T14:00:00Z", "2026-03-06T20:17:00Z", "2026-10-23T03:45:00Z", "2026-10-30T22:00:00Z", "2026-04-02T09:05:00Z"];

for (const zone of SIM_ZONES) {
  test(`property: hourly loads over 5 days in ${zone} give one flash key per local day while owed`, () => {
    for (const s of SIM_STARTS) {
      const e = chat({ startsAt: at(s), endsAt: plus(at(s), 45 * MIN) });
      const due = thankYouDueAt(e, "chat");
      const flashKeys: string[] = [];
      const days = new Set<string>();
      let prevKey: string | null = null;
      let prevLate = -1;
      const retired = new Set<string>();
      for (let t = due.getTime() - 6 * HOUR; t <= due.getTime() + 5 * DAY; t += HOUR) {
        const now = new Date(t);
        const got = selectThankYous({ events: [e], contacts: PEOPLE, done: new Set(), thanked: [], now, timeZone: zone });
        if (!got.length) {
          assert.ok(t < due.getTime(), `not owed at ${now.toISOString()} though past due`);
          continue;
        }
        const fk = thankYouFlashKey(got[0].key, now, zone);
        const late = daysOwed(got[0].dueAt, now, zone);
        assert.ok(fk.startsWith(got[0].key + ":"));
        assert.ok(!retired.has(fk), `flash key ${fk} came back after a later day's`);
        if (prevKey !== null && fk !== prevKey) {
          retired.add(prevKey);
          assert.equal(late, prevLate + 1, `daysOwed jumped ${prevLate} -> ${late} at ${now.toISOString()}`);
        }
        if (prevKey === fk) assert.equal(late, prevLate);
        prevKey = fk;
        prevLate = late;
        flashKeys.push(fk);
        days.add(localDateString(now, zone));
      }
      assert.equal(new Set(flashKeys).size, days.size, `${zone} ${s}`);
      assert.ok(days.size >= 5 && days.size <= 6, `${days.size} days`);
    }
  });
}

// =====================================================================
// 5. interviewsAnswered
// =====================================================================

const iv = (key: string, iso: string) => ({ key, startsAt: at(iso) });
const send = (iso: string) => ({ at: at(iso) });

test("answered: no interviews, no sends", () => assert.deepEqual([...interviewsAnswered([], [])], []));
test("answered: interviews but no sends", () =>
  assert.deepEqual([...interviewsAnswered([iv("a", "2026-09-01T10:00:00Z")], [])], []));
test("answered: sends but no interviews", () =>
  assert.deepEqual([...interviewsAnswered([], [send("2026-09-01T10:00:00Z")])], []));
test("answered: a send before every interview answers nothing", () => {
  const got = interviewsAnswered([iv("a", "2026-09-02T10:00:00Z"), iv("b", "2026-09-03T10:00:00Z")], [send("2026-09-01T10:00:00Z")]);
  assert.deepEqual([...got], []);
});
test("answered: a send exactly at an interview's start answers it", () => {
  assert.deepEqual([...interviewsAnswered([iv("a", "2026-09-02T10:00:00Z")], [send("2026-09-02T10:00:00Z")])], ["a"]);
});
test("answered: a send 1ms before an interview's start answers the previous one", () => {
  const got = interviewsAnswered(
    [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-02T10:00:00Z")],
    [{ at: new Date(at("2026-09-02T10:00:00Z").getTime() - 1) }],
  );
  assert.deepEqual([...got], ["a"]);
});
test("answered: a send answers only the latest begun interview, never an older one", () => {
  const got = interviewsAnswered(
    [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z"), iv("c", "2026-09-09T10:00:00Z")],
    [send("2026-09-06T20:00:00Z")],
  );
  assert.deepEqual([...got], ["b"]);
});
test("answered: many sends after one interview credit only that one", () => {
  const got = interviewsAnswered(
    [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z")],
    Array.from({ length: 10 }, (_, i) => send(`2026-09-05T1${i}:00:00Z`)),
  );
  assert.deepEqual([...got], ["b"]);
});
test("answered: one send after each interview credits each", () => {
  const got = interviewsAnswered(
    [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z"), iv("c", "2026-09-09T10:00:00Z")],
    [send("2026-09-01T20:00:00Z"), send("2026-09-05T20:00:00Z"), send("2026-09-09T20:00:00Z")],
  );
  assert.deepEqual([...got].sort(), ["a", "b", "c"]);
});
test("answered: unsorted interviews and sends give the same answer as sorted", () => {
  const ints = [iv("c", "2026-09-09T10:00:00Z"), iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z")];
  const sends = [send("2026-09-10T00:00:00Z"), send("2026-09-01T11:00:00Z")];
  assert.deepEqual([...interviewsAnswered(ints, sends)].sort(), ["a", "c"]);
  assert.deepEqual([...interviewsAnswered([...ints].reverse(), [...sends].reverse())].sort(), ["a", "c"]);
});
test("answered: a send far in the future credits only the latest interview", () => {
  const got = interviewsAnswered(
    [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z")],
    [send("9999-01-01T00:00:00Z")],
  );
  assert.deepEqual([...got], ["b"]);
});
test("answered: does not reorder or mutate the caller's interviews array", () => {
  const ints = [iv("a", "2026-09-01T10:00:00Z"), iv("b", "2026-09-05T10:00:00Z")];
  const copy = ints.map((i) => i.key);
  interviewsAnswered(ints, [send("2026-09-06T00:00:00Z")]);
  assert.deepEqual(ints.map((i) => i.key), copy);
});
test("answered: two interviews with the same start are both answered by one send (either could be it)", () => {
  // The same interview on two calendars (an Offerly entry not synced, and the
  // invite in Google) - or two panels in one slot. The note is for that slot;
  // leaving one of the pair owed nags about an interview already thanked.
  const got = interviewsAnswered(
    [iv("offerly:x", "2026-09-05T10:00:00Z"), iv("google:y", "2026-09-05T10:00:00Z")],
    [send("2026-09-05T20:00:00Z")],
  );
  assert.deepEqual([...got].sort(), ["google:y", "offerly:x"]);
});
test("answered: a tie is resolved the same way whatever the input order", () => {
  const a = iv("a", "2026-09-05T10:00:00Z");
  const b = iv("b", "2026-09-05T10:00:00Z");
  const one = [...interviewsAnswered([a, b], [send("2026-09-06T00:00:00Z")])].sort();
  const two = [...interviewsAnswered([b, a], [send("2026-09-06T00:00:00Z")])].sort();
  assert.deepEqual(one, two);
});
test("answered: a send with an Invalid Date answers nothing and does not throw", () => {
  assert.deepEqual([...interviewsAnswered([iv("a", "2026-09-01T10:00:00Z")], [{ at: new Date(NaN) }])], []);
});

test("select: a note sent tonight is credited to today's ticked interview, leaving last week's owed", () => {
  const old = interview({ sourceKey: "offerly:old", startsAt: at("2026-09-15T14:00:00Z"), endsAt: at("2026-09-15T15:00:00Z") });
  const today = interview({ sourceKey: "offerly:today", startsAt: at("2026-09-22T14:00:00Z"), endsAt: at("2026-09-22T15:00:00Z") });
  const got = owed([old, today], {
    now: at("2026-09-22T23:00:00Z"),
    done: new Set([thankYouKey("offerly:today")]),
    thanked: [{ contactId: "c-x", at: at("2026-09-22T22:00:00Z"), interview: true }],
  });
  assert.deepEqual(keys(got), [thankYouKey("offerly:old")]);
});

test("select: a note sent mid-interview-day is credited to today's not-yet-due interview", () => {
  const old = interview({ sourceKey: "offerly:old", startsAt: at("2026-09-15T14:00:00Z"), endsAt: at("2026-09-15T15:00:00Z") });
  const today = interview({ sourceKey: "offerly:today", startsAt: at("2026-09-22T14:00:00Z"), endsAt: at("2026-09-22T15:00:00Z") });
  const got = owed([old, today], {
    now: at("2026-09-22T15:30:00Z"),
    thanked: [{ contactId: "c-x", at: at("2026-09-22T15:10:00Z"), interview: true }],
  });
  assert.deepEqual(keys(got), [thankYouKey("offerly:old")]);
});

test("select: an interview thank-you does not answer a chat with no contact", () => {
  const c = chat({ title: "Coffee chat", sourceKey: "google:c" });
  const got = owed([c], { now: plus(DUE, HOUR), thanked: [{ contactId: "c-x", at: plus(START, HOUR), interview: true }] });
  assert.equal(got.length, 1);
});

// =====================================================================
// 6. selectThankYous invariants under a seeded fuzz
// =====================================================================

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_TITLES = [
  { title: "Coffee chat with Dana Reed" },
  { title: "Call with Sam Ito" },
  { title: "Virtual coffee" },
  { title: "Networking call, Lazard" },
  { title: "Goldman first round interview" },
  { title: "Evercore superday" },
  { title: "Interview - Lazard", type: "interview" },
  { title: "Recruiter phone screen" },
  { title: "Dentist" },
  { title: "Econ 101 lecture" },
  { title: "Team meeting" },
  { title: "Sync", type: "meeting" },
  { title: "Dana", type: "coffee_chat" },
  { title: "HireVue - JPM" },
];
const FUZZ_ZONES = [...SIM_ZONES, "UTC", "Asia/Kathmandu", "Pacific/Chatham"];
const FUZZ_NOW = at("2026-09-22T20:00:00Z");

function fuzzScenario(seed: number) {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 12);
  const events: ChatEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = pick(FUZZ_TITLES);
    const allDay = r() < 0.15;
    // Sources from a small pool, so duplicates happen.
    const sourceKey = `${r() < 0.5 ? "google" : "offerly"}:${Math.floor(r() * 8)}`;
    let startsAt: Date;
    let endsAt: Date | null;
    if (allDay) {
      const d = new Date(FUZZ_NOW.getTime() - Math.floor(r() * 18) * DAY + DAY);
      startsAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      endsAt = null;
    } else {
      startsAt = new Date(FUZZ_NOW.getTime() - Math.floor(r() * 17 * DAY) + Math.floor(r() * DAY));
      endsAt = r() < 0.3 ? null : new Date(startsAt.getTime() + Math.floor(r() * 4 * HOUR));
    }
    const contactRoll = r();
    events.push({
      sourceKey,
      title: t.title,
      type: t.type ?? null,
      contactId: contactRoll < 0.3 ? DANA.id : contactRoll < 0.5 ? SAM.id : contactRoll < 0.55 ? "c-ghost" : null,
      startsAt,
      endsAt,
      allDay,
      attendeeEmails: r() < 0.2 ? [pick([DANA, SAM]).email!] : undefined,
      videoCall: r() < 0.3,
    });
  }
  const done = new Set<string>();
  for (const e of events) if (r() < 0.2) done.add(thankYouKey(e.sourceKey));
  const mkSend = () => ({
    contactId: pick([DANA.id, SAM.id, "c-other"]),
    at: new Date(FUZZ_NOW.getTime() - Math.floor(r() * 18 * DAY)),
    interview: r() < 0.4,
  });
  const thanked = Array.from({ length: Math.floor(r() * 4) }, mkSend);
  const extraSends = Array.from({ length: 1 + Math.floor(r() * 3) }, mkSend);
  const now = new Date(FUZZ_NOW.getTime() + Math.floor((r() - 0.5) * 2 * DAY));
  const timeZone = pick(FUZZ_ZONES);
  return { events, done, thanked, extraSends, now, timeZone, r };
}

const FUZZ_RUNS = 400;
let fuzzChecks = 0;

test(`fuzz: ${FUZZ_RUNS} scenarios keep every selectThankYous invariant`, () => {
  for (let seed = 1; seed <= FUZZ_RUNS; seed++) {
    const s = fuzzScenario(seed);
    const input: Input = { events: s.events, contacts: PEOPLE, done: s.done, thanked: s.thanked, now: s.now, timeZone: s.timeZone };
    const out = selectThankYous(input);
    const ctx = `seed ${seed}`;

    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].dueAt.getTime() <= out[i].dueAt.getTime(), `${ctx}: not sorted by dueAt`);
    }
    assert.equal(new Set(keys(out)).size, out.length, `${ctx}: duplicate keys`);
    for (const p of out) {
      assert.ok(!s.done.has(p.key), `${ctx}: ${p.key} is done but returned`);
      assert.ok(Number.isFinite(p.dueAt.getTime()), `${ctx}: dueAt invalid`);
      assert.ok(s.now.getTime() >= p.dueAt.getTime(), `${ctx}: ${p.key} returned before due`);
      assert.ok(s.now.getTime() - p.dueAt.getTime() <= LOOKBACK, `${ctx}: ${p.key} more than 14 days late`);
      assert.ok(p.occasion === "chat" || p.occasion === "interview", `${ctx}: occasion ${p.occasion}`);
      assert.ok(p.href.startsWith("/outreach?"), `${ctx}: href ${p.href}`);
      // dueAt is the rule applied to the first event with that key.
      const first = s.events.find((e) => thankYouKey(e.sourceKey) === p.key)!;
      assert.equal(p.dueAt.getTime(), thankYouDueAt(first, p.occasion, s.timeZone).getTime(), `${ctx}: dueAt mismatch`);
      assert.equal(p.startsAt.getTime(), first.startsAt.getTime());
      // A chat: no send to the prompt's contact since the entry began.
      if (p.occasion === "chat" && p.contact) {
        assert.ok(
          !s.thanked.some((t) => t.contactId === p.contact!.id && t.at.getTime() >= p.startsAt.getTime()),
          `${ctx}: ${p.key} already answered by a send`,
        );
      }
      // An interview: never returned with everyone listed thanked, nor with
      // as many notes as people listed.
      if (p.occasion === "interview" && p.interviewers.length > 0) {
        assert.ok(!p.interviewers.every((x) => x.thanked), `${ctx}: ${p.key} returned with everyone thanked`);
        assert.ok(p.notesSent < p.interviewers.length, `${ctx}: ${p.key} returned with notesSent >= list size`);
      }
      // The banner for it is today's, and names it.
      assert.ok(thankYouFlashKey(p.key, s.now, s.timeZone).startsWith(p.key + ":"));
      assert.ok(daysOwed(p.dueAt, s.now, s.timeZone) >= 0 && daysOwed(p.dueAt, s.now, s.timeZone) <= 15);
    }

    // More sends never add a prompt.
    const more = selectThankYous({ ...input, thanked: [...s.thanked, ...s.extraSends] });
    const before = new Set(keys(out));
    for (const k of keys(more)) assert.ok(before.has(k), `${ctx}: extra send added ${k}`);

    // More ticks never add a prompt; fewer never remove one.
    const moreDone = new Set([...s.done, ...s.events.slice(0, 2).map((e) => thankYouKey(e.sourceKey))]);
    for (const k of keys(selectThankYous({ ...input, done: moreDone }))) assert.ok(before.has(k), `${ctx}: tick added ${k}`);

    // A send to someone in no entry can only answer a chat with nobody known
    // on it (credited by time) - never add a prompt, never touch any other.
    const unrelated = selectThankYous({ ...input, thanked: [...s.thanked, { contactId: "c-nobody", at: s.now }] });
    for (const k of keys(unrelated)) assert.ok(before.has(k), `${ctx}: unrelated send added ${k}`);
    for (const p of out) {
      if (keys(unrelated).includes(p.key)) continue;
      assert.ok(p.occasion === "chat" && !p.contact, `${ctx}: unrelated send removed ${p.key}`);
    }

    // Every event listed twice: the same output.
    const doubled = selectThankYous({ ...input, events: [...s.events, ...s.events] });
    assert.deepEqual(keys(doubled), keys(out), `${ctx}: duplicate events changed output`);

    // Unique source keys: the order events arrive in does not change the set.
    const uniq = new Map<string, ChatEvent>();
    for (const e of s.events) if (!uniq.has(e.sourceKey)) uniq.set(e.sourceKey, e);
    const u = [...uniq.values()];
    const shuffled = [...u].sort(() => s.r() - 0.5);
    const a = keys(selectThankYous({ ...input, events: u })).sort();
    const b = keys(selectThankYous({ ...input, events: shuffled })).sort();
    assert.deepEqual(a, b, `${ctx}: event order changed the set`);

    fuzzChecks++;
  }
  assert.equal(fuzzChecks, FUZZ_RUNS);
});

test("fuzz: 300 random interviewsAnswered cases match a brute-force reference (the latest, plus its day)", () => {
  const r = mulberry32(99);
  for (let run = 0; run < 300; run++) {
    const base = at("2026-09-01T00:00:00Z").getTime();
    const starts = new Set<number>();
    const ints: { key: string; startsAt: Date }[] = [];
    const n = Math.floor(r() * 8);
    while (ints.length < n) {
      const t = base + Math.floor(r() * 20 * DAY);
      if (starts.has(t)) continue;
      starts.add(t);
      ints.push({ key: `i${ints.length}`, startsAt: new Date(t) });
    }
    const sends = Array.from({ length: Math.floor(r() * 6) }, () => ({ at: new Date(base - DAY + Math.floor(r() * 23 * DAY)) }));
    const expected = new Set<string>();
    for (const s of sends) {
      let best: { key: string; startsAt: Date } | null = null;
      for (const i of ints) if (i.startsAt <= s.at && (!best || i.startsAt > best.startsAt)) best = i;
      if (!best) continue;
      // Every interview begun by the send on the same New York day as the latest.
      const day = localDateString(best.startsAt, "America/New_York");
      for (const i of ints) {
        if (i.startsAt <= s.at && localDateString(i.startsAt, "America/New_York") === day) expected.add(i.key);
      }
    }
    const got = interviewsAnswered(ints, sends, "America/New_York");
    assert.deepEqual([...got].sort(), [...expected].sort(), `run ${run}`);
  }
});

test("fuzz: 200 random chats, the prompt appears at dueAt and vanishes 14 days + 1ms later", () => {
  const r = mulberry32(7);
  for (let run = 0; run < 200; run++) {
    const s = new Date(at("2026-01-01T00:00:00Z").getTime() + Math.floor(r() * 365 * DAY));
    const e = chat({ startsAt: s, endsAt: r() < 0.5 ? null : plus(s, Math.floor(r() * 3 * HOUR)) });
    const due = thankYouDueAt(e, "chat");
    const zone = FUZZ_ZONES[Math.floor(r() * FUZZ_ZONES.length)];
    const probe = (now: Date) => owed([e], { now, timeZone: zone }).length;
    assert.equal(probe(plus(due, -1)), 0, `run ${run}: before due`);
    assert.equal(probe(due), 1, `run ${run}: at due`);
    assert.equal(probe(plus(due, LOOKBACK)), 1, `run ${run}: at 14 days`);
    assert.equal(probe(plus(due, LOOKBACK + 1)), 0, `run ${run}: after 14 days`);
  }
});

// =====================================================================
// 7. Robustness: bad dates and bad zones must not crash or mislead
// =====================================================================

test("robust: an Invalid Date start is never returned as owed", () => {
  const got = owed([chat({ startsAt: new Date(NaN), endsAt: null })], { now: DUE });
  assert.deepEqual(keys(got), []);
});

test("robust: an Invalid Date end is never returned with an Invalid dueAt", () => {
  const got = owed([chat({ endsAt: new Date(NaN) })], { now: plus(DUE, DAY) });
  for (const p of got) assert.ok(Number.isFinite(p.dueAt.getTime()), "dueAt is Invalid Date");
});

test("robust: an Invalid Date end on a far-future chat does not prompt now", () => {
  const future = plus(START, 30 * DAY);
  const got = owed([chat({ startsAt: future, endsAt: new Date(NaN) })], { now: START });
  assert.deepEqual(keys(got), []);
});

test("robust: an Invalid Date all-day interview does not crash selectThankYous", () => {
  assert.doesNotThrow(() => owed([superday("2026-09-22", { startsAt: new Date("not a date") })], { now: START }));
});

test("robust: a bad entry does not hide or mis-order the good ones", () => {
  const good1 = chat({ sourceKey: "google:good1", startsAt: plus(START, -2 * DAY), endsAt: null });
  const bad = chat({ sourceKey: "google:bad", startsAt: new Date(NaN), endsAt: null });
  const good2 = chat({ sourceKey: "google:good2", startsAt: plus(START, -DAY), endsAt: null });
  const got = owed([good2, bad, good1], { now: plus(START, DAY) });
  assert.deepEqual(keys(got), [thankYouKey("google:good1"), thankYouKey("google:good2")]);
});

test("robust: a NaN `now` returns nothing rather than everything", () => {
  const got = owed([chat()], { now: new Date(NaN) });
  assert.deepEqual(keys(got), []);
});

test("robust: an Invalid Date thanked.at is ignored, not treated as an answer", () => {
  assert.equal(owed([chat()], { now: DUE, thanked: [{ contactId: DANA.id, at: new Date(NaN) }] }).length, 1);
});

test("robust: thankYouDueAt of an Invalid timed start is Invalid (not a plausible-looking date)", () => {
  assert.ok(Number.isNaN(thankYouDueAt({ startsAt: new Date(NaN), endsAt: null }).getTime()));
});

test("robust: every prompt selectThankYous returns can be turned into a banner (daysOwed does not throw)", () => {
  // prompt-flash.ts calls daysOwed(t.dueAt, ...) on every prompt; one bad
  // entry must not take the whole banner down with a RangeError.
  const got = owed([chat({ sourceKey: "google:bad", endsAt: new Date(NaN) }), chat()], { now: plus(DUE, DAY) });
  for (const p of got) {
    assert.doesNotThrow(() => daysOwed(p.dueAt, plus(DUE, DAY), "America/New_York"), p.key);
  }
});

test("robust: an unknown time zone does not crash thankYouFlashKey (falls back to the default)", () => {
  assert.doesNotThrow(() => thankYouFlashKey(K, START, "Mars/Olympus_Mons"));
  assert.equal(thankYouFlashKey(K, START, "Mars/Olympus_Mons"), thankYouFlashKey(K, START, DEFAULT_TIME_ZONE));
});

test("robust: an unknown time zone does not crash daysOwed", () => {
  assert.doesNotThrow(() => daysOwed(DUE, plus(DUE, DAY), "Not/AZone"));
});

test("robust: an unknown time zone does not crash selectThankYous with an all-day interview", () => {
  assert.doesNotThrow(() => owed([superday("2026-09-22")], { now: at("2026-09-23T12:00:00Z"), timeZone: "Not/AZone" }));
});

test("robust: an unknown time zone with only timed entries still works", () => {
  assert.equal(owed([chat()], { now: DUE, timeZone: "Not/AZone" }).length, 1);
});

test("robust: an empty-string time zone does not crash thankYouFlashKey", () => {
  assert.doesNotThrow(() => thankYouFlashKey(K, START, ""));
});

test("robust: time zone names are case-insensitive to Intl (lower-case still works)", () => {
  assert.equal(thankYouFlashKey(K, at("2026-09-23T03:00:00Z"), "america/new_york"), `${K}:2026-09-22`);
});

test("robust: Etc/GMT-14 (UTC+14) all-day due is 18:00 local", () => {
  const due = thankYouDueAt(superday("2026-09-22"), "interview", "Etc/GMT-14");
  assert.equal(due.toISOString(), "2026-09-22T04:00:00.000Z");
});

test("robust: empty inputs return an empty list", () => {
  assert.deepEqual(owed([], { now: START }), []);
});

test("robust: the default `now` is the real clock and does not throw", () => {
  assert.doesNotThrow(() => selectThankYous({ events: [chat()], contacts: PEOPLE, done: new Set(), thanked: [] }));
});
