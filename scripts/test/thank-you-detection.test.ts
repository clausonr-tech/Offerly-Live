// Adversarial tests for the thank-you meeting detector.
//
// The requirement: the word bank is broad enough to catch every real
// conversation a student has - coffee chats, calls, Zoom/Meet/Teams, lunches,
// booking-tool titles, emoji titles - while never prompting for classes,
// clubs, errands, family, to-dos, repeating entries, declined invitations,
// blocks of time or recorded tests.
//
// Every case runs through selectThankYous, the same path the bell and the
// to-do list take, so contact resolution and the interview/chat split are
// exercised together.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contactInInvite,
  contactInTitle,
  interviewThankBox,
  isChatEvent,
  isInterviewEvent,
  selectThankYous,
  type ChatEvent,
  type ThankContact,
} from "../../src/lib/thank-you";
import { parseGoogleEvent } from "../../src/lib/google-calendar";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-22T20:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const DANA: ThankContact = { id: "c-dana", name: "Dana Reed", email: "dana@evercore.com" };
const SAM: ThankContact = { id: "c-sam", name: "Sam Ito", email: "sam@moelis.com" };
const HOLDEN: ThankContact = { id: "c-holden", name: "Holden Reed", email: "holden@lazard.com" };
const DAN_HOLD: ThankContact = { id: "c-danhold", name: "Dan Hold", email: null };
const DANIEL_OH: ThankContact = { id: "c-oh", name: "Daniel Oh", email: "daniel.oh@gs.com" };
const PEOPLE = [DANA, SAM, HOLDEN, DAN_HOLD, DANIEL_OH];

/** Someone on the invitation who is not a saved contact. */
const STRANGER = "jordan.lee@evercore.com";

function event(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:g1",
    title: "Coffee chat with Dana Reed",
    startsAt: ago(4),
    endsAt: ago(3.5),
    ...over,
  };
}

/** What the student is prompted for, if anything, after this entry. */
function judge(over: Partial<ChatEvent>, contacts: ThankContact[] = PEOPLE) {
  const prompts = selectThankYous({
    events: [event(over)],
    contacts,
    done: new Set(),
    thanked: [],
    now: NOW,
  });
  return prompts[0] ?? null;
}
const occasionOf = (over: Partial<ChatEvent>) => judge(over)?.occasion ?? null;

const onZoom = { videoCall: true, attendeeEmails: [STRANGER] };

// =====================================================================
// 1. Real networking titles that must prompt a chat thank-you
// =====================================================================

/** Titles naming a saved contact, no link, nobody on the invite. */
const NAMED_CHATS = [
  "Coffee chat with Dana Reed",
  "coffee w Dana Reed",
  "Coffee w/ Dana Reed",
  "☕ Dana Reed",
  "☕️ w/ Dana Reed",
  "Lunch w/ Dana Reed",
  "lunch with dana reed",
  "Catch up with Sam Ito",
  "Catch-up: Sam Ito",
  "Catching up w/ Sam Ito",
  "Dana Reed / Kai",
  "Kai x Dana Reed",
  "KAI X DANA REED",
  "Kai <> Dana Reed",
  "Kai<>Dana Reed",
  "Dana Reed <> Alex Rivera",
  "Dana Reed | Kai",
  "Dana Reed & Kai",
  "Kai + Dana Reed",
  "Call with Dana Reed",
  "call w/ dana reed",
  "Phone call - Dana Reed",
  "mtg w/ Dana Reed",
  "Mtg: Dana Reed",
  "Meeting w Dana Reed",
  "Meet Dana Reed",
  "1:1 with Dana Reed",
  "1-1 Dana Reed",
  "One on one w/ Dana Reed",
  "Drinks with Dana Reed",
  "Breakfast w/ Dana Reed",
  "Brunch - Dana Reed",
  "Dinner with Dana Reed",
  "Tea with Dana Reed",
  "Walk with Dana Reed",
  "Touch base w/ Dana Reed",
  "Check-in with Dana Reed",
  "Connect w/ Dana Reed",
  "Chat w/ Dana Reed!!",
  "CALL WITH DANA REED",
  "COFFEE CHAT - DANA REED",
  "Coffee   chat   with   Dana   Reed",
  "  Coffee chat w/ Dana Reed (Evercore)  ",
  "Talk w/ Dana Reed re: Evercore",
  "Follow-up call with Dana Reed",
  "Convo with Sam Ito",
  "Sync w/ Sam Ito",
  "Intro - Sam Ito",
  "Coffee chat with Holden Reed",
  "Call with Holden Reed",
];
for (const title of NAMED_CHATS) {
  test(`named chat: "${title}"`, () => {
    const p = judge({ title });
    assert.equal(p?.occasion, "chat");
    assert.ok(p?.contact, "names who it was with");
  });
}

// ---- probe: possessive names (Zoom's own default titles) ----

test('possessive: "Dana Reed\u2019s Zoom Meeting" is a chat with Dana', () => {
  const p = judge({ title: "Dana Reed\u2019s Zoom Meeting", videoCall: true });
  assert.equal(p?.occasion, "chat");
  assert.equal(p?.contact?.id, DANA.id);
});

test("possessive: \"Dana Reed's Personal Meeting Room\" (always a Zoom link) is a chat with Dana", () => {
  const p = judge({ title: "Dana Reed's Personal Meeting Room", videoCall: true });
  assert.equal(p?.occasion, "chat");
  assert.equal(p?.contact?.id, DANA.id);
});

test("possessive: contactInTitle finds a name followed by 's", () => {
  assert.equal(contactInTitle("Coffee with Dana Reed's team", PEOPLE)?.id, DANA.id);
});

/** No saved contact, no link, nobody on the invite: the words alone say it. */
const UNNAMED_CHATS = [
  "Coffee chat - Evercore",
  "Virtual coffee w/ Goldman analyst",
  "Grab coffee with Lazard associate",
  "Informational - Moelis",
  "Networking call - Centerview",
  "networking chat w/ PJT analyst",
  "Intro call - Jefferies recruiter",
  "Career chat w/ alum",
  "Advice call - Houlihan",
  "Mentorship call",
  "Alumni coffee - Penn",
  "Analyst call - Evercore",
  "VP chat - Lazard",
  "Meet & greet w/ Evercore MD",
  "Zoom - Evercore analyst",
  "Zoom w/ Goldman analyst",
  "Zoom call",
  "Google Meet - Moelis analyst",
  "Teams call - BofA",
  "MS Teams - Citi associate",
  "Webex w/ Wells Fargo analyst",
  "Phone call - Houlihan associate",
  "Video call w/ Lazard VP",
  "Quick call - Jefferies",
  "15 min call - Guggenheim",
  "30-min chat w/ Evercore analyst",
  "☕ Evercore",
  "📞 Lazard analyst",
  "🤝 Moelis associate",
  "Coffee chat - John Ohanian",
  "Coffee chat w/ Chatham Financial analyst",
  "Coffee chat - Labrador Capital",
  "Coffee chat - Momentum Partners",
  "Coffee chat - Classic Capital",
  "Coffee chat - Blockchain Capital",
  "Coffee chat - Holdco Partners",
];
for (const title of UNNAMED_CHATS) {
  test(`unnamed chat: "${title}"`, () => {
    assert.equal(occasionOf({ title }), "chat");
  });
}

/** Booking-tool and invite titles, a stranger on the invite and a video link. */
const INVITED_CHATS = [
  "30 Minute Meeting between Alex Rivera and Jordan Lee",
  "15 Minute Meeting between Jordan Lee and Alex Rivera",
  "Jordan Lee's Zoom Meeting",
  "Jordan Lee's Personal Meeting Room",
  "Invitation: Chat with Kai @ Tue Sep 22, 2026 3pm - 3:30pm (EDT) (kai@example.com)",
  "Updated invitation: Call w/ Kai",
  "Meeting with Jordan Lee",
  "Catch up - Jordan Lee",
  "Microsoft Teams Meeting",
];
for (const title of INVITED_CHATS) {
  test(`invite chat: "${title}" with a stranger on a video call`, () => {
    assert.equal(occasionOf({ title, ...onZoom }), "chat");
  });
}

test("Calendly's default title counts with no link and nobody listed", () => {
  assert.equal(occasionOf({ title: "30 Minute Meeting between Alex Rivera and Jordan Lee" }), "chat");
});

test("a contact's bare name counts once there is a video link", () => {
  assert.equal(occasionOf({ title: "Dana Reed", videoCall: true }), "chat");
});

test("Calendly's two-name title counts with a contact and a link", () => {
  assert.equal(occasionOf({ title: "Dana Reed and Alex Rivera", videoCall: true }), "chat");
});

for (const title of ["Evercore", "Alex Rivera", "(untitled)", "Kai / Evercore"]) {
  test(`a saved contact on the invite makes "${title}" a chat with them`, () => {
    const p = judge({ title, attendeeEmails: [DANA.email!] });
    assert.equal(p?.occasion, "chat");
    assert.equal(p?.contact?.id, DANA.id);
    assert.match(p!.href, /contact=c-dana/);
  });
}

// ---- probes: realistic chats the detector may miss ----

/** Verb before the role: "Call with Goldman analyst" is as clear as "Analyst call". */
const ROLE_AFTER_VERB = [
  "Call with Goldman analyst",
  "Chat w/ JPM associate",
  "Lunch with Evercore VP",
  "Call w/ Penn alum",
  "Catch up with Lazard MD",
];
for (const title of ROLE_AFTER_VERB) {
  test(`role after the verb: "${title}" is a chat`, () => {
    assert.equal(occasionOf({ title }), "chat");
  });
}

test('"1 hr call - Evercore" counts like "30 min call - Evercore"', () => {
  assert.equal(occasionOf({ title: "30 min call - Evercore" }), "chat");
  assert.equal(occasionOf({ title: "1 hr call - Evercore" }), "chat");
});

test("a phone call with a stranger on the invite (no video link) is a chat", () => {
  // A banker's invite: "Call with Alex Rivera", dial-in in the notes, no Zoom.
  assert.equal(occasionOf({ title: "Call with Jordan Lee", attendeeEmails: [STRANGER] }), "chat");
});

test('SavvyCal-style "Kai <> Jordan Lee" with a stranger on a video call is a chat', () => {
  assert.equal(occasionOf({ title: "Kai <> Jordan Lee", ...onZoom }), "chat");
});

test('"Dana Reed/Kai" with no spaces round the slash is a chat', () => {
  assert.equal(occasionOf({ title: "Dana Reed/Kai" }), "chat");
});

test("a contact's name plus someone else on the invite (a phone call) is a chat", () => {
  // Dana's work address differs from the one saved, so she is not "invited".
  assert.equal(occasionOf({ title: "Dana Reed (Evercore)", attendeeEmails: ["d.reed@evercore.com"] }), "chat");
});

// ---- probes: NEVER/GROUP words that describe the person, not the entry ----

const DESCRIPTOR_CHATS: [string, string][] = [
  ["Coffee chat with Jenny Oh", "Korean surname Oh read as office hours"],
  ["Call with Daniel Oh", "saved contact named Oh"],
  ["Coffee chat with Dan Hold", "saved contact named Hold"],
  ["Coffee chat w/ Dana Reed (dad's friend)", "networking through family"],
  ["Call with Dana Reed - mom's coworker at Evercore", "networking through family"],
  ["Coffee chat - Dana Reed, Wharton Class of 2019", "alumni class year"],
  ["Networking call - family office", "family office is a finance sector"],
  ["Coffee chat - Walton Family Office analyst", "family office is a finance sector"],
  ["Call with Dana Reed - Evercore TMT group", "a banker's coverage group"],
  ["Zoom w/ Dana Reed (Carlyle Group)", "firm named X Group"],
  ["Call with Dana Reed (met at career fair)", "where they met"],
  ["Call w/ Dana Reed - project finance", "project finance is a sector"],
  ["Coffee chat w/ Dana Reed (rescheduled)", "the entry at its new time"],
  ["Networking call - Lazard restructuring practice", "a bank's practice area"],
];
for (const [title, why] of DESCRIPTOR_CHATS) {
  test(`descriptor, not a veto (${why}): "${title}" is a chat`, () => {
    assert.equal(occasionOf({ title }), "chat");
  });
}

// =====================================================================
// 2. Entries that must never prompt
// =====================================================================

const SCHOOL = [
  "FNCE 1000 Lecture",
  "ECON 101 recitation",
  "Section 204",
  "CIS 1200 Lab",
  "Office hours - Prof. Smith",
  "OH w/ TA",
  "Midterm review",
  "Final exam - ACCT 101",
  "Quiz 3",
  "Homework 4 due",
  "PSET 3",
  "Problem set",
  "Study group",
  "Studying @ Van Pelt",
  "Tutoring",
  "Seminar",
  "Discussion section",
];
const CLUBS = [
  "Finance Club GBM",
  "Investment club meeting",
  "Team meeting",
  "Exec board meeting",
  "Consulting club case practice",
  "Group project meeting",
  "Committee call",
  "Standup",
  "All-hands",
  "Webinar - Goldman Sachs",
  "Evercore info session",
  "Career fair",
  "Workshop: resume review",
  "Panel: women in finance",
  "Chapter meeting",
  "Team zoom",
];
const LIFE = [
  "Gym",
  "Workout",
  "Soccer practice",
  "Basketball game",
  "Dentist",
  "Doctor",
  "Therapy",
  "Haircut",
  "Dinner with mom",
  "Call dad",
  "FaceTime mom",
  "Family dinner",
  "Mom's birthday",
  "Sam's bday",
  "Anniversary dinner",
  "Flight to NYC",
  "Travel",
  "Commute",
  "Coffee with mom",
  "Dinner with roommates",
];
const TODOS = [
  "Email Dana Reed",
  "E-mail Sam Ito",
  "Follow up with Dana Reed",
  "Followup with Dana Reed",
  "Send thank you to Sam Ito",
  "Thank Dana Reed",
  "Text Dana Reed",
  "Message Sam Ito on LinkedIn",
  "LinkedIn Dana Reed",
  "Apply to Goldman",
  "Submit Evercore application",
  "Research Lazard",
  "Draft cover letter",
  "Write thank-you note",
  "Reply to Dana Reed",
  "Reminder: coffee chat with Dana Reed",
  "To-do: call Dana Reed",
  "Prep for coffee chat with Dana Reed",
  "Coffee chat prep - Dana Reed",
  "Prepare questions for Dana Reed call",
];
const BLOCKS = [
  "Busy",
  "OOO",
  "Out of office",
  "Focus time",
  "Blocked",
  "Hold",
  "Tentative",
  "Coffee chat - CANCELLED",
  "Call with Dana Reed (postponed)",
  "Dana Reed",
  "Evercore",
  "Lunch",
  "Call",
  "Meeting",
];
for (const [kind, titles] of [
  ["school", SCHOOL],
  ["club", CLUBS],
  ["life", LIFE],
  ["to-do", TODOS],
  ["block", BLOCKS],
] as const) {
  for (const title of titles) {
    test(`not a chat (${kind}): "${title}"`, () => {
      assert.equal(occasionOf({ title }), null);
    });
  }
}

test("a class on Zoom with the professor invited is not a chat when it names the course", () => {
  assert.equal(occasionOf({ title: "FNCE 1000 Lecture", ...onZoom }), null);
});

// ---- probes: false positives ----

const FALSE_POSITIVES: [string, string][] = [
  ["Hangout with friends", "a social hangout, not Google Hangouts"],
  ["Hangout at Jake's", "a social hangout, not Google Hangouts"],
  ["FaceTime grandma", "family on FaceTime"],
  ["Zoom with grandparents", "family on Zoom"],
  ["ECON 101 Zoom", "a course code on Zoom"],
  ["FNCE 1000 zoom", "a course code on Zoom"],
  ["Schedule coffee chat with Dana Reed", "a to-do"],
  ["Set up call with Dana Reed", "a to-do"],
  ["Book coffee chat w/ Sam Ito", "a to-do"],
  ["Reschedule coffee chat with Dana Reed", "a to-do"],
  ["Reach out to Dana Reed for coffee", "a to-do"],
  ["Ask Sam Ito for a coffee chat", "a to-do"],
  ["Sign up for Evercore coffee chats", "a to-do"],
  ["Coffee chat thank-you note - Dana Reed", "the thank-you itself, as a to-do"],
  ["Info session with Goldman Sachs", "a group presentation"],
  ["Intro meeting - Investment Club", "a club's first meeting"],
];
for (const [title, why] of FALSE_POSITIVES) {
  test(`false positive (${why}): "${title}" is not a chat`, () => {
    assert.equal(occasionOf({ title }), null);
  });
}

// ---- flags that rule an entry out, whatever the title ----

const FLAGGED: [string, Partial<ChatEvent>][] = [
  ["a repeating entry", { recurring: true }],
  ["a repeating weekly 1:1", { title: "Weekly 1:1 with Dana Reed", recurring: true }],
  ["a repeating entry with the contact invited", { recurring: true, attendeeEmails: [DANA.email!] }],
  ["a declined invitation", { declined: true }],
  ["a declined invitation with the contact invited", { declined: true, attendeeEmails: [DANA.email!] }],
  ["a declined video call", { title: "Zoom w/ Goldman analyst", declined: true, ...onZoom }],
  ["an out-of-office block", { eventType: "outOfOffice" }],
  ["a focus-time block", { eventType: "focusTime" }],
  ["a working-location entry", { eventType: "workingLocation" }],
  ["a birthday entry", { eventType: "birthday" }],
  ["an Offerly personal entry", { sourceKey: "offerly:1", type: "personal" }],
  ["an Offerly deadline", { sourceKey: "offerly:2", type: "deadline" }],
  ["an Offerly info session", { sourceKey: "offerly:3", type: "info_session" }],
];
for (const [what, over] of FLAGGED) {
  test(`never prompted: ${what}`, () => {
    assert.equal(occasionOf(over), null);
  });
}

test("never prompted: an all-day entry, even a coffee chat with a contact", () => {
  assert.equal(isChatEvent(event({ allDay: true }), DANA, true), false);
});

// =====================================================================
// 3. Interview vs chat, and which interview thank-you
// =====================================================================

const INTERVIEWS: [string, string][] = [
  ["Superday - Evercore", "thanks.superday"],
  ["Evercore Super Day", "thanks.superday"],
  ["Final round superday - Lazard", "thanks.superday"],
  ["Assessment centre - Barclays", "thanks.superday"],
  ["Assessment day - HSBC", "thanks.superday"],
  ["Phone screen - Citi", "thanks.screen"],
  ["HR screen", "thanks.screen"],
  ["Recruiter screen w/ Goldman", "thanks.screen"],
  ["Screening call - Jefferies", "thanks.screen"],
  ["Initial screen - Moelis", "thanks.screen"],
  ["First round interview - Lazard", "thanks.interview"],
  ["Interview with Dana Reed", "thanks.interview"],
  ["Final round - PJT", "thanks.interview"],
  ["2nd round - Evercore", "thanks.interview"],
  ["Technical interview - Houlihan", "thanks.interview"],
  ["Intvw - Guggenheim", "thanks.interview"],
  ["Fit call - Centerview", "thanks.interview"],
  ["Case study - Bain Capital", "thanks.interview"],
  ["Onsite - Blackstone", "thanks.interview"],
  ["Interviewing with Evercore", "thanks.interview"],
  ["R2 - Jefferies", "thanks.interview"],
];
for (const [title, box] of INTERVIEWS) {
  test(`interview: "${title}" opens ${box}`, () => {
    const p = judge({ title });
    assert.equal(p?.occasion, "interview");
    assert.equal(interviewThankBox(title), box);
    assert.match(p!.href, new RegExp(`box=${box.replace(".", "\\.")}`));
    assert.equal(isChatEvent(event({ title }), contactInTitle(title, PEOPLE)), false, "never also a chat");
  });
}

const NEITHER = [
  "HireVue - Goldman Sachs",
  "Hirevue interview - JPM",
  "Hire-Vue",
  "One-way video interview - Citi",
  "Online test - Citi",
  "Online assessment - Barclays",
  "Numerical test",
  "Written exam - Rothschild",
  "Modelling test - Evercore",
  "Modeling test",
  "Mock interview with Dana Reed",
  "Mock superday",
  "Interview prep",
  "Interview prep with Dana Reed",
  "Superday prep",
  "Prepping for Evercore interview",
  "Interview debrief",
  "Interview tips webinar",
  "Interview practice",
  "Application deadline - Goldman",
];
for (const title of NEITHER) {
  test(`neither interview nor chat: "${title}"`, () => {
    assert.equal(occasionOf({ title }), null);
  });
}

test('probe: "Pre-recorded video interview - Barclays" has nobody to thank', () => {
  assert.equal(occasionOf({ title: "Pre-recorded video interview - Barclays" }), null);
});

test("an informational interview is a chat, not an interview", () => {
  assert.equal(occasionOf({ title: "Informational interview - Evercore" }), "chat");
});

test("a Google entry that says interview only in its notes is an interview", () => {
  assert.equal(occasionOf({ title: "Evercore", notes: "First round interview with the TMT team" }), "interview");
});

test("probe: a coffee chat whose invite notes mention interviews stays a chat", () => {
  const p = judge({
    title: "Coffee chat with Dana Reed",
    notes: "Happy to walk you through the interview process at Evercore.",
  });
  assert.equal(p?.occasion, "chat");
});

test("a declined interview is not prompted", () => {
  assert.equal(occasionOf({ title: "Superday - Evercore", declined: true }), null);
});

test("an interview in an out-of-office block is not prompted", () => {
  assert.equal(isInterviewEvent(event({ title: "Superday", eventType: "outOfOffice" })), false);
});

test("an interview naming a contact is thanked by name on the interview thank-you", () => {
  const p = judge({ title: "Interview with Dana Reed" });
  assert.equal(p?.contact?.id, DANA.id);
  assert.match(p!.href, /contact=c-dana&occasion=thanks&box=thanks\.interview/);
});

// =====================================================================
// 4. Who it was with
// =====================================================================

test("the linked contact beats the invite and the title", () => {
  const p = judge({
    title: "Coffee chat with Holden Reed",
    contactId: SAM.id,
    attendeeEmails: [DANA.email!],
  });
  assert.equal(p?.contact?.id, SAM.id);
});

test("the invite beats the title", () => {
  const p = judge({ title: "Coffee chat with Sam Ito", attendeeEmails: [DANA.email!] });
  assert.equal(p?.contact?.id, DANA.id);
});

test("the title is used when nothing else says", () => {
  assert.equal(judge({ title: "Coffee chat with Sam Ito" })?.contact?.id, SAM.id);
});

test("invite matching ignores case and stray spaces on the invite side", () => {
  assert.equal(contactInInvite(["  DANA@Evercore.COM "], PEOPLE)?.id, DANA.id);
});

test("invite matching ignores case and stray spaces on the contact side", () => {
  const messy = { id: "c-m", name: "Morgan Fox", email: " Morgan@PJT.com " };
  assert.equal(contactInInvite(["morgan@pjt.com"], [messy])?.id, "c-m");
});

test("the first invited contact wins", () => {
  assert.equal(contactInInvite([SAM.email!, DANA.email!], PEOPLE)?.id, SAM.id);
  assert.equal(contactInInvite([STRANGER, DANA.email!, SAM.email!], PEOPLE)?.id, DANA.id);
});

test("a contact with no email never matches an invite", () => {
  const noEmail = [
    { id: "a", name: "Ann Bee", email: null },
    { id: "b", name: "Bo Cee", email: "" },
    { id: "c", name: "Cy Dee", email: "   " },
    { id: "d", name: "Di Eff" },
  ];
  assert.equal(contactInInvite(["", " ", STRANGER], noEmail), null);
});

test("no invite list, or an empty one, is no invited contact", () => {
  assert.equal(contactInInvite(undefined, PEOPLE), null);
  assert.equal(contactInInvite([], PEOPLE), null);
});

test("a declined entry yields nothing even with a contact invited and linked", () => {
  assert.equal(judge({ declined: true, contactId: DANA.id, attendeeEmails: [DANA.email!] }), null);
});

test("a stranger alone on a subjectless invite is nothing", () => {
  assert.equal(occasionOf({ title: "Evercore", attendeeEmails: [STRANGER] }), null);
});

test("a linked contact that no longer exists falls back to the invite", () => {
  const p = judge({ title: "Coffee chat", contactId: "c-deleted", attendeeEmails: [SAM.email!] });
  assert.equal(p?.contact?.id, SAM.id);
});

// =====================================================================
// 5. parseGoogleEvent
// =====================================================================

const CAL = { id: "primary", title: "Kai" };
const raw = (over: Record<string, unknown> = {}) => ({
  id: "evt1",
  summary: "Coffee chat",
  htmlLink: "https://calendar.google.com/event?eid=1",
  start: { dateTime: "2026-09-22T15:00:00-04:00" },
  end: { dateTime: "2026-09-22T15:30:00-04:00" },
  ...over,
});
const parse = (over: Record<string, unknown> = {}) => parseGoogleEvent(raw(over), CAL);

test("parse: a cancelled entry is null", () => {
  assert.equal(parse({ status: "cancelled" }), null);
});

test("parse: an entry with no start is null", () => {
  assert.equal(parse({ start: undefined }), null);
  assert.equal(parse({ start: {} }), null);
});

test("parse: an entry with no id, or not an object, is null", () => {
  assert.equal(parse({ id: "" }), null);
  assert.equal(parseGoogleEvent(null, CAL), null);
  assert.equal(parseGoogleEvent("x", CAL), null);
});

test("parse: an ordinary entry keeps its times and title", () => {
  const e = parse()!;
  assert.equal(e.title, "Coffee chat");
  assert.equal(e.start, "2026-09-22T15:00:00-04:00");
  assert.equal(e.end, "2026-09-22T15:30:00-04:00");
  assert.equal(e.allDay, false);
  assert.equal(e.videoCall, false);
  assert.deepEqual(e.attendeeEmails, []);
  assert.equal(e.declined, false);
  assert.equal(e.recurring, false);
});

test("parse: a date-only entry is all-day", () => {
  const e = parse({ start: { date: "2026-09-22" }, end: { date: "2026-09-23" } })!;
  assert.equal(e.allDay, true);
  assert.equal(e.start, "2026-09-22");
});

test("parse: an untitled entry is called (untitled)", () => {
  assert.equal(parse({ summary: undefined })!.title, "(untitled)");
});

test("parse: the student and rooms are not attendees; emails are lower-cased and trimmed", () => {
  const e = parse({
    attendees: [
      { email: "kai@upenn.edu", self: true, responseStatus: "accepted" },
      { email: "Conf-Room-4@resource.calendar.google.com", resource: true },
      { email: "  Dana@Evercore.COM " },
      { email: "SAM@moelis.com", responseStatus: "declined" },
    ],
  })!;
  // Sam declined: not there, so not someone to thank.
  assert.deepEqual(e.attendeeEmails, ["dana@evercore.com"]);
  assert.equal(e.declined, false, "someone else declining is not the student declining");
});

test("parse: the student's own decline is declined", () => {
  const e = parse({ attendees: [{ email: "kai@upenn.edu", self: true, responseStatus: "declined" }] })!;
  assert.equal(e.declined, true);
});

test("parse: malformed attendee entries are skipped, not thrown on", () => {
  const e = parse({
    attendees: [null, undefined, {}, { email: 42 }, { email: "" }, { displayName: "No Email" }, { email: "ok@x.com" }],
  })!;
  assert.deepEqual(e.attendeeEmails, ["ok@x.com"]);
  assert.equal(e.declined, false);
});

test("parse: attendees that are not an array are ignored", () => {
  assert.deepEqual(parse({ attendees: { email: "x@y.com" } })!.attendeeEmails, []);
});

test("parse: one instance of a repeating entry is recurring", () => {
  assert.equal(parse({ recurringEventId: "base123" })!.recurring, true);
});

test("parse: eventType defaults to default and passes through otherwise", () => {
  assert.equal(parse()!.eventType, "default");
  assert.equal(parse({ eventType: "focusTime" })!.eventType, "focusTime");
});

const VIDEO_SOURCES: [string, Record<string, unknown>][] = [
  ["a Meet hangoutLink", { hangoutLink: "https://meet.google.com/abc-defg-hij" }],
  ["a conference video entry point", { conferenceData: { entryPoints: [{ entryPointType: "video" }] } }],
  ["a zoom.us link in the location", { location: "https://us02web.zoom.us/j/123456789" }],
  ["a zoom.us link in the notes", { description: 'Join: <a href="https://zoom.us/j/987">zoom</a>' }],
  ["a company Zoom subdomain", { location: "https://evercore.zoom.us/j/111" }],
  ["a Teams link in the notes", { description: "https://teams.microsoft.com/l/meetup-join/19%3ameeting" }],
  ["a Meet link in the notes", { description: "Join at meet.google.com/abc-defg-hij" }],
  ["a Webex link", { location: "https://evercore.my.webex.com/meet/dreed" }],
];
for (const [what, over] of VIDEO_SOURCES) {
  test(`parse: ${what} is a video call`, () => {
    assert.equal(parse(over)!.videoCall, true);
  });
}

test("parse: a phone-only conference entry point is not a video call", () => {
  assert.equal(
    parse({ conferenceData: { entryPoints: [{ entryPointType: "phone" }, { entryPointType: "more" }] } })!.videoCall,
    false,
  );
});

test("parse: a physical location is not a video call", () => {
  assert.equal(parse({ location: "Blue Bottle Coffee, 54 W 40th St" })!.videoCall, false);
  assert.equal(parse({ description: "Zoom out on the org chart before we meet" })!.videoCall, false);
});

test("probe: a location the student typed as just \"Zoom\" is a video call", () => {
  assert.equal(parse({ location: "Zoom" })!.videoCall, true);
});

test("parse -> detect: a Calendly Zoom invite from a stranger is prompted end to end", () => {
  const g = parse({
    summary: "30 Minute Meeting between Alex Rivera and Jordan Lee",
    location: "https://us06web.zoom.us/j/555",
    attendees: [{ email: "kai@upenn.edu", self: true }, { email: "Jordan.Lee@Evercore.com" }],
  })!;
  const ev: ChatEvent = {
    sourceKey: `google:${g.id}`,
    title: g.title,
    startsAt: ago(4),
    endsAt: ago(3.5),
    allDay: g.allDay,
    notes: g.notes,
    videoCall: g.videoCall,
    attendeeEmails: g.attendeeEmails,
    declined: g.declined,
    recurring: g.recurring,
    eventType: g.eventType,
  };
  assert.equal(occasionOf(ev), "chat");
});

// =====================================================================
// 6. Word-boundary traps: a keyword inside another word is not the keyword
// =====================================================================

/** Loose words need someone on a call; these must not count as those words. */
const INSIDE_WORDS = [
  "Teacher appreciation",
  "Callback list",
  "Chatham House",
  "Meetinghouse cleanup",
  "Calligraphy",
  "Walkthrough",
  "Synchrony statements",
  "Talkative",
  "Dinnerware shopping",
];
for (const title of INSIDE_WORDS) {
  test(`boundary: "${title}" on a call with a stranger is not a chat`, () => {
    assert.equal(occasionOf({ title, ...onZoom }), null);
  });
}

test("boundary: \"Hold\" vetoes, \"Holden\" does not", () => {
  assert.equal(occasionOf({ title: "Hold - Dana Reed" }), null);
  assert.equal(occasionOf({ title: "Coffee chat with Holden Reed" }), "chat");
});

test("boundary: \"Thanksgiving dinner\" is not a thank-you to-do, and not a chat either", () => {
  assert.equal(occasionOf({ title: "Thanksgiving dinner" }), null);
  assert.equal(occasionOf({ title: "Thanksgiving dinner with Dana Reed" }), "chat");
});

test("boundary: \"Dueling\" and \"Labrador\" do not veto a coffee chat", () => {
  assert.equal(occasionOf({ title: "Coffee chat - Dueling Grounds Capital" }), "chat");
  assert.equal(occasionOf({ title: "Coffee w/ Dana Reed at Labrador Cafe" }), "chat");
});
