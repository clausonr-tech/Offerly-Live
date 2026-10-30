// Prompting a thank-you after a coffee chat or call.
//
// The detector reads calendar titles nobody wrote for us, and acts without
// asking, so the risks are the same as the interview prompt's: too eager and
// it asks someone to thank their dentist, too shy and the one email every
// banker expects after a chat never gets written.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_DAY_INTERVIEW_DUE_HOUR,
  DEFAULT_CHAT_MINUTES,
  DEFAULT_INTERVIEW_MINUTES,
  THANK_YOU_AFTER_HOURS,
  THANK_YOU_LOOKBACK_DAYS,
  contactInTitle,
  interviewThankBox,
  interviewsAnswered,
  isChatEvent,
  isInterviewEvent,
  selectThankYous,
  thankYouProgress,
  thankYouTitle,
  thankYouDueAt,
  thankYouHref,
  type ChatEvent,
} from "../../src/lib/thank-you";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-22T20:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const DANA = { id: "c-dana", name: "Dana Reed" };
const SAM = { id: "c-sam", name: "Sam Ito" };
const PEOPLE = [DANA, SAM];

function chat(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:g1",
    title: "Coffee chat with Dana Reed",
    startsAt: ago(4),
    endsAt: ago(3.5),
    ...over,
  };
}

function owed(events: ChatEvent[], extra: Partial<Parameters<typeof selectThankYous>[0]> = {}) {
  return selectThankYous({ events, contacts: PEOPLE, done: new Set(), thanked: [], now: NOW, ...extra });
}

// ---------- the numbers ----------

test("two hours after it ends", () => assert.equal(THANK_YOU_AFTER_HOURS, 2));
test("a chat with no end is taken as half an hour", () => assert.equal(DEFAULT_CHAT_MINUTES, 30));
test("two weeks back and no further", () => assert.equal(THANK_YOU_LOOKBACK_DAYS, 14));

// ---------- what counts ----------

const CHATS = [
  "Coffee chat with Dana Reed",
  "Coffee - Sam Ito",
  "Zoom w/ Goldman analyst",
  "Virtual coffee",
  "Informational interview - Evercore",
  "Networking call, Lazard",
  "Intro call with recruiter",
];
for (const title of CHATS) {
  test(`"${title}" is a chat`, () => {
    assert.ok(isChatEvent(chat({ title }), contactInTitle(title, PEOPLE)));
  });
}

const CALLS_WITH_A_CONTACT = ["Call with Dana Reed", "Catch up - Sam Ito", "Meeting with Dana Reed"];
for (const title of CALLS_WITH_A_CONTACT) {
  test(`"${title}" is a chat because it names a contact`, () => {
    assert.ok(isChatEvent(chat({ title }), contactInTitle(title, PEOPLE)));
  });
}

const NOT_CHATS = [
  "Call",
  "Call mom",
  "Team meeting",
  "Econ 101 lecture",
  "Study group call",
  "Club chat",
  "Evercore superday",
  "Goldman first round",
  "Mock interview",
  "Dentist",
];
for (const title of NOT_CHATS) {
  test(`"${title}" is not a chat`, () => {
    assert.ok(!isChatEvent(chat({ title }), contactInTitle(title, PEOPLE)));
  });
}

test("an Offerly entry filed as a coffee chat counts whatever it is called", () => {
  assert.ok(isChatEvent(chat({ title: "Dana", type: "coffee_chat" }), null));
});

test("an Offerly entry filed as a meeting/call counts too", () => {
  assert.ok(isChatEvent(chat({ title: "Sync", type: "meeting" }), null));
});

test("an Offerly entry filed as an interview never does", () => {
  assert.ok(!isChatEvent(chat({ title: "Coffee chat", type: "interview" }), null));
});

test("an all-day entry is not a chat", () => {
  assert.ok(!isChatEvent(chat({ allDay: true }), DANA));
});

// ---------- who it was with ----------

test("a contact's full name in the title is who it was with", () => {
  assert.deepEqual(contactInTitle("Coffee chat with Dana Reed", PEOPLE), DANA);
});

test("case and punctuation do not matter", () => {
  assert.deepEqual(contactInTitle("coffee w/ DANA REED!", PEOPLE), DANA);
});

test("a first name alone is not enough - first names collide", () => {
  assert.equal(contactInTitle("Coffee with Dana", PEOPLE), null);
});

test("a name inside a longer name is not matched", () => {
  assert.equal(contactInTitle("Coffee with Dana Reedman", PEOPLE), null);
});

test("the longest matching name wins", () => {
  const people = [DANA, { id: "c-dana2", name: "Dana Reed Smith" }];
  assert.equal(contactInTitle("Chat with Dana Reed Smith", people)?.id, "c-dana2");
});

// ---------- when ----------

test("due two hours after the end", () => {
  const due = thankYouDueAt({ startsAt: ago(4), endsAt: ago(3) });
  assert.equal(due.getTime(), ago(1).getTime());
});

test("with no end, due two and a half hours after the start", () => {
  const due = thankYouDueAt({ startsAt: ago(4), endsAt: null });
  assert.equal(due.getTime(), ago(1.5).getTime());
});

test("not yet due an hour after the chat", () => {
  assert.deepEqual(owed([chat({ startsAt: ago(1.5), endsAt: ago(1) })]), []);
});

test("due once two hours have passed", () => {
  assert.equal(owed([chat()]).length, 1);
});

test("still owed days later", () => {
  assert.equal(owed([chat({ startsAt: ago(72), endsAt: ago(71.5) })]).length, 1);
});

test("dropped once it is more than two weeks late", () => {
  assert.deepEqual(owed([chat({ startsAt: ago(24 * 15), endsAt: ago(24 * 15 - 0.5) })]), []);
});

// ---------- done ----------

test("ticked off is done", () => {
  assert.deepEqual(owed([chat()], { done: new Set(["thank_you:google:g1"]) }), []);
});

test("a thank-you sent to them after the chat began is done", () => {
  assert.deepEqual(owed([chat()], { thanked: [{ contactId: "c-dana", at: ago(1) }] }), []);
});

test("a thank-you sent to them before this chat is not", () => {
  assert.equal(owed([chat()], { thanked: [{ contactId: "c-dana", at: ago(48) }] }).length, 1);
});

test("a thank-you to someone else is not", () => {
  assert.equal(owed([chat()], { thanked: [{ contactId: "c-sam", at: ago(1) }] }).length, 1);
});

test("the same entry twice is one prompt", () => {
  assert.equal(owed([chat(), chat()]).length, 1);
});

// ---------- where it points ----------

test("with a contact, the drafter opens addressed to them on a thank-you", () => {
  assert.equal(thankYouHref(DANA), "/outreach?contact=c-dana&occasion=thanks&box=thanks.chat");
});

test("without one, it opens on a thank-you for whoever it was", () => {
  assert.equal(thankYouHref(null), "/outreach?occasion=thanks&box=thanks.chat");
});

test("the prompt carries who it was with", () => {
  assert.deepEqual(owed([chat()])[0].contact, DANA);
});

// ---------- video calls ----------

test("a call titled with only the two names counts when it has a video link", () => {
  assert.equal(isChatEvent(chat({ title: "Dana Reed and Alex Rivera", videoCall: true }), DANA), true);
});

test("...and so does a contact's name joined to another, link or not", () => {
  assert.equal(isChatEvent(chat({ title: "Dana Reed and Alex Rivera" }), DANA), true);
  assert.equal(isChatEvent(chat({ title: "Kai <> Dana Reed" }), DANA), true);
});

test("a contact's name on its own is not a meeting", () => {
  assert.equal(isChatEvent(chat({ title: "Dana Reed" }), DANA), false);
});

test("...and a video link with no contact named is not enough - it could be a class", () => {
  assert.equal(isChatEvent(chat({ title: "Section 204", videoCall: true }), null), false);
});

test("...and a video link does not rescue a class that names a contact", () => {
  assert.equal(isChatEvent(chat({ title: "Study group - Dana Reed", videoCall: true }), DANA), false);
});

// ---------- interviews ----------

function interview(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:i1",
    title: "Goldman Sachs first round interview",
    startsAt: ago(5),
    endsAt: ago(4),
    ...over,
  };
}

test("an interview with no end is taken as an hour", () => assert.equal(DEFAULT_INTERVIEW_MINUTES, 60));
test("an all-day interview is due at six that evening", () => assert.equal(ALL_DAY_INTERVIEW_DUE_HOUR, 18));

const INTERVIEWS = [
  "Goldman Sachs first round interview",
  "Evercore superday",
  "Lazard 2nd round",
  "Phone screen - Moelis recruiting",
  "Final round, Centerview",
  "Case study interview - Bain",
];

for (const title of INTERVIEWS) {
  test(`"${title}" is an interview to thank for`, () => {
    assert.equal(isInterviewEvent(interview({ title })), true);
  });
}

const NOBODY_THERE = [
  "HireVue - JPMorgan",
  "One-way video interview Citi",
  "Online assessment - Barclays",
  "Numerical test",
  "Modelling test - KKR",
  "Mock interview with career services",
  "Interview prep",
  "Goldman interview deadline",
];

for (const title of NOBODY_THERE) {
  test(`"${title}" is not an interview to thank for`, () => {
    assert.equal(isInterviewEvent(interview({ title })), false);
  });
}

test("an Offerly entry filed as an interview counts whatever it is called", () => {
  assert.equal(isInterviewEvent(interview({ title: "Goldman", type: "interview" })), true);
});

test("an Offerly entry filed as a coffee chat is not an interview, whatever it says", () => {
  assert.equal(isInterviewEvent(interview({ title: "Interview tips coffee", type: "coffee_chat" })), false);
});

test("a Google entry that says interview only in its notes counts", () => {
  assert.equal(isInterviewEvent(interview({ title: "Goldman Sachs", notes: "Your first round interview" })), true);
});

test("an entry filed as a meeting does not become one from its notes", () => {
  const e = interview({ title: "Call with Dana Reed", type: "meeting", notes: "ask about the interview process" });
  assert.equal(isInterviewEvent(e), false);
});

test("an interview is never also a chat", () => {
  assert.equal(isChatEvent(interview({ title: "Interview with Dana Reed" }), DANA), false);
});

test("a superday opens the superday thank-you", () => {
  assert.equal(interviewThankBox("Evercore Super Day"), "thanks.superday");
});

test("a recruiter screen opens the phone-screen thank-you", () => {
  assert.equal(interviewThankBox("Phone screen - Moelis"), "thanks.screen");
});

test("anything else opens the live-interview thank-you", () => {
  assert.equal(interviewThankBox("Lazard 2nd round"), "thanks.interview");
});

test("an interview is owed two hours after it ends, on the interview thank-you", () => {
  const [t] = owed([interview()]);
  assert.equal(t.occasion, "interview");
  // Nobody saved: "Outside of your matched contacts", looked up by the key.
  assert.equal(t.href, "/outreach?occasion=thanks&box=thanks.interview&thank=thank_you%3Agoogle%3Ai1");
  assert.equal(t.dueAt.getTime(), ago(2).getTime());
});

test("an interview with no end is due three hours after it starts", () => {
  const e = interview({ endsAt: null });
  assert.equal(thankYouDueAt(e, "interview").getTime(), e.startsAt.getTime() + 3 * HOUR);
});

test("not owed an hour after the interview", () => {
  assert.deepEqual(owed([interview({ startsAt: ago(2), endsAt: ago(1) })]), []);
});

test("an all-day superday is due at six that evening, on the student's clock", () => {
  const e = interview({ title: "Evercore superday", allDay: true, startsAt: new Date("2026-09-22T00:00:00Z"), endsAt: null });
  // 18:00 in New York on 22 September is 22:00 UTC.
  assert.equal(thankYouDueAt(e, "interview", "America/New_York").toISOString(), "2026-09-22T22:00:00.000Z");
  // ...and 18:00 in London is 17:00 UTC.
  assert.equal(thankYouDueAt(e, "interview", "Europe/London").toISOString(), "2026-09-22T17:00:00.000Z");
});

test("so a superday today is not owed at four in the afternoon", () => {
  const e = interview({ title: "Evercore superday", allDay: true, startsAt: new Date("2026-09-22T00:00:00Z"), endsAt: null });
  assert.deepEqual(owed([e], { now: new Date("2026-09-22T20:00:00Z"), timeZone: "America/New_York" }), []);
  assert.equal(owed([e], { now: new Date("2026-09-22T22:30:00Z"), timeZone: "America/New_York" }).length, 1);
});

test("the prompt names the interview, not a person, when nobody is named", () => {
  const [t] = owed([interview()]);
  assert.equal(t.contact, null);
  assert.equal(thankYouTitle(t), "Thank your interviewers");
});

test("an interview naming a contact is thanked by name, on the interview thank-you", () => {
  const [t] = owed([interview({ title: "Interview with Dana Reed" })]);
  assert.equal(thankYouTitle(t), "Thank Dana Reed");
  assert.equal(t.href, "/outreach?contact=c-dana&occasion=thanks&box=thanks.interview");
});

test("a chat keeps its own title", () => {
  const [t] = owed([chat({ title: "Coffee chat" })]);
  assert.equal(thankYouTitle(t), "Send a thank-you");
});

// ---------- an interview thank-you closes the interview ----------

test("an interview thank-you sent after the interview answers it", () => {
  // No invitation list: the note is credited, but only the student knows
  // whether that was everyone - it stays owed, one note in.
  const [t] = owed([interview()], { thanked: [{ contactId: "c-new", at: ago(1), interview: true }] });
  assert.equal(t.key, "thank_you:google:i1");
  assert.equal(t.notesSent, 1);
  assert.equal(thankYouProgress(t), "1 note sent");
  // ...closed by "That's everyone".
  assert.deepEqual(
    owed([interview()], { done: new Set(["thank_you:google:i1"]), thanked: [{ contactId: "c-new", at: ago(1), interview: true }] }),
    [],
  );
  // With one interviewer on the invitation, one note is everyone.
  const listed = interview({ attendees: [{ email: "pat@gs.com", name: "Pat Lee" }] });
  assert.deepEqual(owed([listed], { thanked: [{ contactId: "c-new", at: ago(1), interview: true }] }), []);
});

test("an ordinary thank-you to someone else does not", () => {
  assert.equal(owed([interview()], { thanked: [{ contactId: "c-new", at: ago(1) }] }).length, 1);
});

test("an interview thank-you sent before the interview does not", () => {
  assert.equal(owed([interview()], { thanked: [{ contactId: "c-new", at: ago(6), interview: true }] }).length, 1);
});

test("a note after today's round answers today's, not last week's", () => {
  const lastWeek = interview({ sourceKey: "google:old", startsAt: ago(24 * 6), endsAt: ago(24 * 6 - 1) });
  const today = interview({ sourceKey: "google:new" });
  const left = owed([lastWeek, today], { thanked: [{ contactId: "c-new", at: ago(1), interview: true }] });
  // Both still owed (nobody listed), but the note is today's.
  assert.deepEqual(
    left.map((t) => [t.key, t.notesSent]),
    [
      ["thank_you:google:old", 0],
      ["thank_you:google:new", 1],
    ],
  );
  // With one interviewer listed on each, the note closes today's alone.
  const one = [{ email: "pat@gs.com", name: "Pat Lee" }];
  const listed = owed([{ ...lastWeek, attendees: one }, { ...today, attendees: one }], {
    thanked: [{ contactId: "c-new", at: ago(1), interview: true }],
  });
  assert.deepEqual(listed.map((t) => t.key), ["thank_you:google:old"]);
});

test("a note written before today's prompt is due still goes to today's round", () => {
  // Today's interview ended an hour ago - not owed yet - and the student wrote
  // the note straight away. It must not be credited to last week's.
  const lastWeek = interview({ sourceKey: "google:old", startsAt: ago(24 * 6), endsAt: ago(24 * 6 - 1) });
  const today = interview({ sourceKey: "google:new", startsAt: ago(2), endsAt: ago(1) });
  const left = owed([lastWeek, today], { thanked: [{ contactId: "c-new", at: ago(0.5), interview: true }] });
  assert.deepEqual(left.map((t) => t.key), ["thank_you:google:old"]);
});

test("a ticked interview still takes the note written for it", () => {
  const lastWeek = interview({ sourceKey: "google:old", startsAt: ago(24 * 6), endsAt: ago(24 * 6 - 1) });
  const today = interview({ sourceKey: "google:new" });
  const left = owed([lastWeek, today], {
    done: new Set(["thank_you:google:new"]),
    thanked: [{ contactId: "c-new", at: ago(1), interview: true }],
  });
  assert.deepEqual(left.map((t) => t.key), ["thank_you:google:old"]);
});

test("four notes after one superday close the superday and nothing older", () => {
  const answered = interviewsAnswered(
    [
      { key: "old", startsAt: ago(100) },
      { key: "superday", startsAt: ago(10) },
    ],
    [ago(3), ago(2.5), ago(2), ago(1)].map((at) => ({ at })),
  );
  assert.deepEqual([...answered], ["superday"]);
});

test("an interview thank-you does not close a coffee chat", () => {
  assert.equal(owed([chat()], { thanked: [{ contactId: "c-new", at: ago(1), interview: true }] }).length, 1);
});

// ---------- found by the timing sweep ----------

test("a superday blocked over two days is due on its last day", () => {
  const e = interview({
    title: "Evercore superday",
    allDay: true,
    startsAt: new Date("2026-09-22T00:00:00Z"),
    // Google's all-day end is the day after the last one.
    endsAt: new Date("2026-09-24T00:00:00Z"),
  });
  assert.equal(thankYouDueAt(e, "interview", "America/New_York").toISOString(), "2026-09-23T22:00:00.000Z");
});

test("a superday booked as separate rounds is closed by that evening's notes, all of it", () => {
  const rounds = [9, 10, 11, 13].map((h, i) =>
    interview({
      sourceKey: `google:round${i}`,
      title: "Evercore superday",
      startsAt: new Date(`2026-09-22T${String(h + 4).padStart(2, "0")}:00:00Z`),
      endsAt: new Date(`2026-09-22T${String(h + 5).padStart(2, "0")}:00:00Z`),
    }),
  );
  const thanked = [{ contactId: "c-new", at: new Date("2026-09-22T23:00:00Z"), interview: true }];
  const now = new Date("2026-09-23T15:00:00Z");
  // Nobody listed: the note is credited to every round that day, and each
  // stays owed until the student says that's everyone.
  const left = owed(rounds, { now, thanked });
  assert.deepEqual(
    left.map((t) => [t.key, t.notesSent, thankYouProgress(t)]),
    rounds.map((r) => [`thank_you:${r.sourceKey}`, 1, "1 note sent"]),
  );
  // The same interviewer listed on every round: a note to them that evening
  // closes all of it...
  const listed = rounds.map((r) => ({ ...r, attendees: [{ email: "pat@evercore.com", name: null }] }));
  const toPat = [{ contactId: "c-pat", at: new Date("2026-09-22T23:00:00Z"), interview: true, email: "pat@evercore.com" }];
  assert.deepEqual(owed(listed, { now, thanked: toPat }), []);
  // ...but a note to an address no invitation shows counts only for the
  // latest round: one stray note must not close four listed rounds.
  assert.deepEqual(
    owed(listed, { now, thanked }).map((t) => t.key),
    rounds.slice(0, 3).map((r) => `thank_you:${r.sourceKey}`),
  );
  // ...and "That's everyone" on each closes the unlisted ones.
  assert.deepEqual(owed(rounds, { now, thanked, done: new Set(rounds.map((r) => `thank_you:${r.sourceKey}`)) }), []);
});

test("...but not the round the day before", () => {
  const monday = interview({ sourceKey: "google:mon", startsAt: new Date("2026-09-21T14:00:00Z"), endsAt: new Date("2026-09-21T15:00:00Z") });
  const tuesday = interview({ sourceKey: "google:tue", startsAt: new Date("2026-09-22T14:00:00Z"), endsAt: new Date("2026-09-22T15:00:00Z") });
  const now = new Date("2026-09-23T15:00:00Z");
  const thanked = [{ contactId: "c-new", at: new Date("2026-09-22T23:00:00Z"), interview: true }];
  const left = owed([monday, tuesday], { now, thanked });
  assert.deepEqual(
    left.map((t) => [t.key, t.notesSent]),
    [
      ["thank_you:google:mon", 0],
      ["thank_you:google:tue", 1],
    ],
  );
  const one = [{ email: "pat@gs.com", name: null }];
  const listed = owed([{ ...monday, attendees: one }, { ...tuesday, attendees: one }], { now, thanked });
  assert.deepEqual(listed.map((t) => t.key), ["thank_you:google:mon"]);
});

test("an end before the start is read as no end, so it is never due early", () => {
  const e = chat({ startsAt: ago(1), endsAt: ago(30) });
  assert.equal(thankYouDueAt(e).getTime(), ago(1).getTime() + (DEFAULT_CHAT_MINUTES / 60 + 2) * HOUR);
});

// ---------- found by the detection sweep ----------

const NOT_WITHOUT_A_CONTACT: [string, Partial<ChatEvent>][] = [
  ["Coffee with dad", {}],
  ["Hangout with friends", {}],
  ["🎥 Movie night", { videoCall: true }],
  ["Meet and greet - Finance Society", {}],
  ["Group project meeting", { videoCall: true, attendeeEmails: ["a@x.com"] }],
  ["Dinner", { attendeeEmails: ["a@x.com"] }],
  ["Meeting", { videoCall: true, attendeeEmails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"] }],
];
for (const [title, over] of NOT_WITHOUT_A_CONTACT) {
  test(`"${title}" is not a chat with nobody we know on it`, () => {
    assert.equal(isChatEvent(chat({ title, ...over }), null), false);
  });
}

test("a phone call with one person not yet saved is a chat", () => {
  assert.equal(isChatEvent(chat({ title: "Call with Jordan Lee", attendeeEmails: ["jordan@evercore.com"] }), null), true);
});

test("a coffee chat that mentions interviews is a coffee chat, not an interview", () => {
  const e = chat({ title: "Coffee chat re: interview process" });
  assert.equal(isInterviewEvent(e), false);
  assert.equal(isChatEvent(e, null), true);
});

// ---------- interviewers, counted per person ----------

const PAT = { email: "pat@evercore.com", name: "Pat Lin" };
const JO = { email: "jo@evercore.com", name: "Jo Park" };
const panel = (over: Partial<ChatEvent> = {}) =>
  interview({ sourceKey: "google:panel", attendees: [PAT, JO], attendeeEmails: [PAT.email, JO.email], ...over });

test("two notes to the same interviewer are one person thanked, not the panel", () => {
  const [t] = owed([panel()], {
    thanked: [
      { contactId: "c-pat", at: ago(1.5), email: PAT.email },
      { contactId: "c-pat", at: ago(1), email: PAT.email },
    ],
  });
  assert.equal(t.notesSent, 1);
  assert.equal(t.next.email, JO.email);
});

test("a note to Pat tonight thanks Pat for tonight's round, not last week's", () => {
  const lastWeek = panel({ sourceKey: "google:old", startsAt: ago(24 * 6), endsAt: ago(24 * 6 - 1) });
  const today = panel({ sourceKey: "google:new", attendees: [PAT], attendeeEmails: [PAT.email] });
  const left = owed([lastWeek, today], { thanked: [{ contactId: "c-pat", at: ago(1), email: PAT.email }] });
  assert.deepEqual(left.map((t) => t.key), ["thank_you:google:old"]);
  assert.equal(left[0].interviewers.find((x) => x.email === PAT.email)?.thanked, false);
});

test("an unknown interviewer opens the outside section by the prompt's key, never their address", () => {
  const [t] = owed([panel()]);
  assert.equal(t.next.email, PAT.email);
  assert.equal(t.next.name, PAT.name);
  assert.ok(!t.href.includes("@"));
  assert.ok(t.href.endsWith(`&thank=${encodeURIComponent(t.key)}`));
});

// ---------- the student's own filing wins ----------

test("a superday the student re-filed as a meeting is thanked as a meeting, not skipped", () => {
  const e = chat({ title: "Evercore superday", type: "meeting", typeSource: "student" });
  assert.equal(isInterviewEvent(e), false);
  assert.equal(isChatEvent(e, null), true);
});

test("...while the detector's own 'meeting' reading of the same title is still an interview", () => {
  const e = chat({ title: "Evercore superday", type: "meeting" });
  assert.equal(isInterviewEvent(e), true);
  assert.equal(isChatEvent(e, null), false);
});
