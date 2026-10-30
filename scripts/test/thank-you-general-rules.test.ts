// Thank-you prompts after chats and calls: the general rules, adversarially.
//
// Round two. The detector and the "Write it" routing act without asking, so
// this file leans on what the earlier suites do not: where the link goes and
// what it pre-fills for someone who is not a saved contact (never a guessed
// email, never a name or address in a URL), which firm it names, the bots an
// invitation carries, realistic titles not yet covered, and a seeded fuzz of
// selectThankYous's invariants.
//
// Tests state the CORRECT behaviour. A failing test here is a bug report.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THANK_YOU_LOOKBACK_DAYS,
  contactInInvite,
  contactInTitle,
  isChatEvent,
  isInterviewEvent,
  daysOwed,
  firmInTitle,
  selectThankYous,
  thankYouFlashKey,
  thankYouHref,
  thankYouKey,
  thankYouTitle,
  type ChatEvent,
  type ThankContact,
  type ThankYouPrompt,
} from "../../src/lib/thank-you";
import { parseGoogleEvent } from "../../src/lib/google-calendar";

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-22T20:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const DANA: ThankContact = { id: "c-dana", name: "Dana Reed", email: "dana@evercore.com" };
const SAM: ThankContact = { id: "c-sam", name: "Sam Ito", email: "sam@moelis.com" };
const MORGAN: ThankContact = { id: "c-morgan", name: "Morgan Lee", email: null };
const PING: ThankContact = { id: "c-ping", name: "Ping Zhang", email: "ping.zhang@gs.com" };
const JAMES: ThankContact = { id: "c-james", name: "James Harris", email: "jharris@jefferies.com" };
const JOSE: ThankContact = { id: "c-jose", name: "José Álvarez", email: "jalvarez@lazard.com" };
const PEOPLE = [DANA, SAM, MORGAN, PING, JAMES, JOSE];

const FIRMS = [
  "Evercore",
  "Evercore ISI",
  "Moelis & Company",
  "Lazard",
  "Jefferies",
  "Goldman Sachs",
  "J.P. Morgan",
  "Carlyle Group",
  "PJT Partners",
];

const JORDAN = { email: "jordan.lee@evercore.com", name: "Jordan Lee" };
const ALEX = { email: "alex.kim@moelis.com", name: null };
const CASEY = { email: "casey.ng@lazard.com", name: "Casey Ng" };
const RILEY = { email: "riley@gs.com", name: "Riley Fox" };

function event(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:g1",
    title: "Coffee chat with Dana Reed",
    startsAt: ago(4),
    endsAt: ago(3.5),
    ...over,
  };
}

/** An invitation with these people on it: both lists, as thank-you-db builds them. */
function invite(people: { email: string; name: string | null }[]): Partial<ChatEvent> {
  return { attendeeEmails: people.map((p) => p.email), attendees: people };
}

function all(
  events: ChatEvent[],
  extra: Partial<Parameters<typeof selectThankYous>[0]> = {},
): ThankYouPrompt[] {
  return selectThankYous({
    events,
    contacts: PEOPLE,
    done: new Set(),
    thanked: [],
    firms: FIRMS,
    now: NOW,
    ...extra,
  });
}
const judge = (over: Partial<ChatEvent>, extra: Partial<Parameters<typeof selectThankYous>[0]> = {}) =>
  all([event(over)], extra)[0] ?? null;
const occasionOf = (over: Partial<ChatEvent>, extra: Partial<Parameters<typeof selectThankYous>[0]> = {}) =>
  judge(over, extra)?.occasion ?? null;

const CONTACT_HREF = (id: string) => `/outreach?contact=${id}&occasion=thanks&box=thanks.chat`;
const OUTSIDE_HREF = (key: string) => `/outreach?occasion=thanks&box=thanks.chat&thank=${encodeURIComponent(key)}`;

/** Every name and address the scenario knows, none of which may reach a URL. */
const SECRETS = [
  ...PEOPLE.flatMap((c) => [c.name, c.email ?? ""]),
  ...[JORDAN, ALEX, CASEY, RILEY].flatMap((p) => [p.email, p.name ?? ""]),
].filter((s) => s.length >= 4);

function assertCleanHref(href: string, key: string) {
  const decoded = decodeURIComponent(href).toLowerCase();
  const raw = href.toLowerCase();
  assert.ok(!raw.includes("@") && !raw.includes("%40"), `href carries an address: ${href}`);
  for (const s of SECRETS) {
    const low = s.toLowerCase();
    assert.ok(!raw.includes(low) && !decoded.includes(low), `href carries "${s}": ${href}`);
    assert.ok(!raw.includes(encodeURIComponent(low)), `href carries encoded "${s}": ${href}`);
  }
  const url = new URL(href, "https://offerly.test");
  assert.equal(url.pathname, "/outreach");
  assert.equal(url.searchParams.get("occasion"), "thanks");
  if (!url.searchParams.get("contact")) assert.equal(url.searchParams.get("thank"), key, "thank= decodes to the key");
}

// =====================================================================
// 1. Routing: where "Write it" goes, and what it pre-fills
// =====================================================================

type RouteCase = {
  name: string;
  over: Partial<ChatEvent>;
  contactId: string | null;
  nextName: string | null;
  nextEmail: string | null;
  firm: string | null;
  firms?: string[];
};

const ROUTES: RouteCase[] = [
  {
    name: "known by full name in the title, nobody invited",
    over: { title: "Coffee chat with Dana Reed" },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "known by email on the invite, invite gives a different display name",
    over: { title: "Coffee chat", ...invite([{ email: DANA.email!, name: "D. Reed (Evercore)" }]) },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "known by linked contactId on an Offerly chat",
    over: { sourceKey: "offerly:o1", type: "coffee_chat", title: "Coffee", contactId: SAM.id },
    contactId: SAM.id, nextName: "Sam Ito", nextEmail: SAM.email!, firm: null,
  },
  {
    name: "known contact with no saved email",
    over: { title: "Coffee chat - Morgan Lee" },
    contactId: MORGAN.id, nextName: "Morgan Lee", nextEmail: null, firm: null,
  },
  {
    name: "known contact plus a stranger invited: the contact's own email, never the stranger's",
    over: { title: "Call with Dana Reed", ...invite([JORDAN]) },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "known contact and a tracked firm in the title: firm is only for outside notes",
    over: { title: "Coffee chat with Dana Reed (Evercore)" },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "invite beats title: Sam invited, Dana named",
    over: { title: "Coffee chat with Dana Reed", ...invite([{ email: SAM.email!, name: "Sam Ito" }]) },
    contactId: SAM.id, nextName: "Sam Ito", nextEmail: SAM.email!, firm: null,
  },
  {
    name: "invite email in capitals still finds the contact",
    over: { title: "Coffee chat", ...invite([{ email: "DANA@EVERCORE.COM", name: null }]) },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "linked contact beats a different contact on the invite",
    over: {
      sourceKey: "offerly:o2", type: "meeting", title: "Call", contactId: DANA.id,
      ...invite([{ email: SAM.email!, name: "Sam Ito" }]),
    },
    contactId: DANA.id, nextName: "Dana Reed", nextEmail: DANA.email!, firm: null,
  },
  {
    name: "unknown, nobody invited, tracked firm in the title",
    over: { title: "Coffee chat - Evercore" },
    contactId: null, nextName: null, nextEmail: null, firm: "Evercore",
  },
  {
    name: "unknown, nobody invited, no firm",
    over: { title: "Virtual coffee" },
    contactId: null, nextName: null, nextEmail: null, firm: null,
  },
  {
    name: "unknown, exactly one invitee with a display name",
    over: { title: "Coffee chat", ...invite([JORDAN]) },
    contactId: null, nextName: "Jordan Lee", nextEmail: JORDAN.email, firm: null,
  },
  {
    name: "unknown, exactly one invitee with no display name: email only",
    over: { title: "Coffee chat - Moelis & Company", ...invite([ALEX]) },
    contactId: null, nextName: null, nextEmail: ALEX.email, firm: "Moelis & Company",
  },
  {
    name: "unknown, two invitees: nobody guessed",
    over: { title: "Coffee chat - Lazard", ...invite([CASEY, RILEY]) },
    contactId: null, nextName: null, nextEmail: null, firm: "Lazard",
  },
  {
    name: "unknown, three invitees: nobody guessed",
    over: { title: "Networking call - Goldman Sachs", ...invite([CASEY, RILEY, JORDAN]) },
    contactId: null, nextName: null, nextEmail: null, firm: "Goldman Sachs",
  },
  {
    name: "unknown, one invitee and a firm: all three filled",
    over: { title: "Zoom w/ Evercore ISI analyst", videoCall: true, ...invite([JORDAN]) },
    contactId: null, nextName: "Jordan Lee", nextEmail: JORDAN.email, firm: "Evercore ISI",
  },
  {
    name: "linked contact deleted, nothing else: outside note",
    over: { sourceKey: "offerly:o3", type: "coffee_chat", title: "Coffee", contactId: "c-gone" },
    contactId: null, nextName: null, nextEmail: null, firm: null,
  },
  {
    name: "linked contact deleted, falls back to the invited contact",
    over: {
      sourceKey: "offerly:o4", type: "coffee_chat", title: "Coffee", contactId: "c-gone",
      ...invite([{ email: SAM.email!, name: null }]),
    },
    contactId: SAM.id, nextName: "Sam Ito", nextEmail: SAM.email!, firm: null,
  },
  {
    name: "first name only in the title is not the contact",
    over: { title: "Coffee chat with Dana - Evercore" },
    contactId: null, nextName: null, nextEmail: null, firm: "Evercore",
  },
  {
    name: "unknown Offerly coffee chat carries no invitees",
    over: { sourceKey: "offerly:o5", type: "coffee_chat", title: "Coffee w/ Lazard analyst" },
    contactId: null, nextName: null, nextEmail: null, firm: "Lazard",
  },
  {
    name: "tracked firms empty: firm null even when the title names one",
    over: { title: "Coffee chat - Evercore" },
    firms: [],
    contactId: null, nextName: null, nextEmail: null, firm: null,
  },
];

for (const r of ROUTES) {
  test(`route: ${r.name}`, () => {
    const p = judge(r.over, r.firms ? { firms: r.firms } : {});
    assert.ok(p, "prompted");
    assert.equal(p.occasion, "chat");
    assert.deepEqual(p.next, { contactId: r.contactId, name: r.nextName, email: r.nextEmail, firm: r.firm });
    assert.equal(p.href, r.contactId ? CONTACT_HREF(r.contactId) : OUTSIDE_HREF(p.key));
    assert.equal(p.contact?.id ?? null, r.contactId);
    assertCleanHref(p.href, p.key);
  });
}

// ---- routing through parseGoogleEvent: bots, rooms and self never count as "the one person" ----

const CAL = { id: "primary", title: "Kai" };
function rawEvent(over: Record<string, unknown> = {}) {
  return {
    id: "evt1",
    summary: "Coffee chat",
    htmlLink: "https://calendar.google.com/event?eid=1",
    start: { dateTime: "2026-09-22T15:00:00Z" },
    end: { dateTime: "2026-09-22T15:30:00Z" },
    ...over,
  };
}
function fromGoogle(over: Record<string, unknown> = {}): ChatEvent {
  const g = parseGoogleEvent(rawEvent(over), CAL)!;
  return {
    sourceKey: `google:${g.id}`,
    title: g.title,
    startsAt: new Date(g.start),
    endsAt: g.end ? new Date(g.end) : null,
    allDay: g.allDay,
    notes: g.notes,
    videoCall: g.videoCall,
    attendeeEmails: g.attendeeEmails,
    attendees: g.attendees,
    declined: g.declined,
    recurring: g.recurring,
    eventType: g.eventType,
  };
}
const SELF = { email: "kai@upenn.edu", self: true, responseStatus: "accepted" };
const PERSON = { email: "  Jordan.Lee@Evercore.com ", displayName: "  Jordan Lee  " };

const PARSE_ROUTES: [string, unknown[], { name: string | null; email: string | null }][] = [
  ["self + one person", [SELF, PERSON], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + room", [SELF, PERSON, { email: "c_1@resource.calendar.google.com", resource: true }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + Calendly bot", [SELF, PERSON, { email: "notifications@calendly.com" }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + GoodTime scheduler", [SELF, PERSON, { email: "sched@goodtime.io", displayName: "GoodTime" }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + noreply", [SELF, PERSON, { email: "noreply@evercore.com" }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + group calendar", [SELF, PERSON, { email: "abc@group.calendar.google.com" }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person + no_reply (underscore) bot", [SELF, PERSON, { email: "no_reply@evercore.com" }], { name: "Jordan Lee", email: "jordan.lee@evercore.com" }],
  ["self + person whose displayName is blank", [SELF, { email: "Alex.Kim@Moelis.com", displayName: "   " }], { name: null, email: "alex.kim@moelis.com" }],
  ["self + two people", [SELF, PERSON, { email: "casey.ng@lazard.com", displayName: "Casey Ng" }], { name: null, email: null }],
  ["self only", [SELF], { name: null, email: null }],
];
for (const [what, attendees, want] of PARSE_ROUTES) {
  test(`route via Google: ${what}`, () => {
    const ev = fromGoogle({ attendees, summary: "Coffee chat - Evercore" });
    const p = all([ev])[0];
    assert.ok(p, "prompted");
    assert.deepEqual(p.next, { contactId: null, name: want.name, email: want.email, firm: "Evercore" });
    assert.equal(p.href, OUTSIDE_HREF(p.key));
    assertCleanHref(p.href, p.key);
  });
}

// ---- the href itself ----

const ODD_IDS = [
  "abc123_20260922T150000Z",
  "a+b/c=d&e#f?g h%",
  "_underscore",
  "UPPER-lower-123",
  "ünïcödé",
  "x".repeat(300),
];
for (const id of ODD_IDS) {
  test(`href: an outside note's key round-trips through the URL (id ${JSON.stringify(id.slice(0, 20))})`, () => {
    const p = judge({ sourceKey: `google:${id}`, title: "Coffee chat - Evercore" })!;
    assert.equal(p.key, thankYouKey(`google:${id}`));
    const url = new URL(p.href, "https://offerly.test");
    assert.equal(url.searchParams.get("thank"), p.key);
    assert.equal(url.searchParams.get("box"), "thanks.chat");
    assert.equal(url.searchParams.get("contact"), null);
    assert.equal([...url.searchParams.keys()].length, 3, "no stray parameters from the id");
  });
}

test("href: thankYouHref with no contact and no key opens the plain thank-you", () => {
  assert.equal(thankYouHref(null), "/outreach?occasion=thanks&box=thanks.chat");
});

test("href: thankYouHref with a contact ignores the key", () => {
  assert.equal(thankYouHref({ id: "c-1", name: "Dana Reed" }, "thanks.chat", "thank_you:google:x"), CONTACT_HREF("c-1"));
});

test("href: thankYouHref never puts the contact's name in the URL", () => {
  const h = thankYouHref({ id: "c-1", name: "Dana Reed" });
  assert.ok(!h.toLowerCase().includes("dana"));
});

// ---- titles ----

test("title: a known contact is thanked by name", () => {
  const p = judge({ title: "Coffee chat with Dana Reed" })!;
  assert.equal(thankYouTitle(p), "Thank Dana Reed");
});

test("title: an outside chat with one named invitee is thanked by the name the invite gives", () => {
  const p = judge({ title: "Coffee chat", ...invite([JORDAN]) })!;
  assert.equal(thankYouTitle(p), "Thank Jordan Lee");
});

test("title: the flash key is the prompt key plus the local day", () => {
  const p = judge({ title: "Coffee chat with Dana Reed" })!;
  assert.equal(thankYouFlashKey(p.key, NOW, "America/New_York"), `${p.key}:2026-09-22`);
  assert.equal(daysOwed(p.dueAt, NOW, "America/New_York"), 0);
});

// =====================================================================
// 2. firmInTitle: longest match, possessives, case, punctuation
// =====================================================================

const FIRM_CASES: [string, string | null][] = [
  ["Coffee chat - Evercore ISI analyst", "Evercore ISI"],
  ["Coffee chat - Evercore analyst", "Evercore"],
  ["coffee chat - EVERCORE ISI", "Evercore ISI"],
  ["Evercore coffee chat", "Evercore"],
  ["Coffee chat - Evercore (ISI desk)", "Evercore ISI"],
  ["Evercore ISI's research coffee", "Evercore ISI"],
  ["Coffee chat - Evercore's TMT team", "Evercore"],
  ["Coffee chat - Evercore’s TMT team", "Evercore"],
  ["Coffee chat - Lazard's RX group", "Lazard"],
  ["Coffee chat - J.P. Morgan", "J.P. Morgan"],
  ["Coffee chat - JP Morgan", "J.P. Morgan"],
  ["Coffee chat - Moelis & Company", "Moelis & Company"],
  ["Coffee chat - Lazardo Capital", null],
  ["Coffee chat - Evercorex", null],
  ["Coffee chat - Lazard / Evercore alum", "Evercore"],
  ["Coffee chat - Goldman", "Goldman Sachs"],
  ["", null],
  // Bug probes: the firm IS named, as students write it.
  ["Coffee chat - Jefferies' LevFin team", "Jefferies"],
  ["Coffee chat - Moelis analyst", "Moelis & Company"],
];
for (const [title, want] of FIRM_CASES) {
  test(`firmInTitle: ${JSON.stringify(title)} -> ${want}`, () => {
    assert.equal(firmInTitle(title, FIRMS), want);
  });
}

test("firmInTitle: order of the tracked list does not change the longest match", () => {
  assert.equal(firmInTitle("Coffee chat - Evercore ISI", ["Evercore ISI", "Evercore"]), "Evercore ISI");
  assert.equal(firmInTitle("Coffee chat - Evercore ISI", ["Evercore", "Evercore ISI"]), "Evercore ISI");
});

test("firmInTitle: one-letter and blank tracked names are ignored", () => {
  assert.equal(firmInTitle("Coffee chat - A team", ["A", "", "  "]), null);
});

// =====================================================================
// 3. Contact resolution edges not yet covered
// =====================================================================

test("contactInTitle: longest full name wins over a shorter one it contains", () => {
  const a = { id: "a", name: "Dana Reed" };
  const b = { id: "b", name: "Dana Reed Smith" };
  assert.equal(contactInTitle("Coffee chat with Dana Reed Smith", [a, b])?.id, "b");
});

test("contactInTitle: a name in brackets or after a pipe is found", () => {
  assert.equal(contactInTitle("Coffee Chat | Evercore | Dana Reed", PEOPLE)?.id, DANA.id);
  assert.equal(contactInTitle("Coffee chat (Dana Reed)", PEOPLE)?.id, DANA.id);
});

test("contactInInvite: the first invited contact in invite order wins", () => {
  assert.equal(contactInInvite([SAM.email!, DANA.email!], PEOPLE)?.id, SAM.id);
});

// Bug probes on resolution.
test("contactInTitle: a hyphen with no spaces before the name still finds it (\"Coffee chat-Dana Reed\")", () => {
  assert.equal(contactInTitle("Coffee chat-Dana Reed", PEOPLE)?.id, DANA.id);
});

test("contactInTitle: a plural possessive with a bare apostrophe (\"James Harris' Zoom Meeting\")", () => {
  assert.equal(contactInTitle("James Harris' Zoom Meeting", PEOPLE)?.id, JAMES.id);
});

test("contactInTitle: a saved accented name typed without accents (\"Jose Alvarez\")", () => {
  assert.equal(contactInTitle("Coffee chat w/ Jose Alvarez", PEOPLE)?.id, JOSE.id);
});

// =====================================================================
// 4. Detection: realistic titles not yet covered
// =====================================================================

const NEW_CHATS = [
  "Coffee Chat | Evercore | Dana Reed",
  "Evercore Coffee Chat (Virtual)",
  "Virtual Coffee Chat - Goldman Sachs TMT",
  "Informational Interview w/ Lazard VP",
  "Networking Call: BofA LevFin",
  "Phone call w/ Jefferies associate",
  "Alumni call - Moelis",
  "Chat with Wharton alum at Centerview",
  "Coffee @ Blue Bottle w/ JPM associate",
  "☕ chat - Guggenheim",
  "📞 Dana Reed",
  "Intro call: Kai / Evercore",
  "Get to know you call - Perella",
  "Career advice call w/ Dana Reed",
  "FaceTime w/ Dana Reed",
  "Google Meet with Evercore analyst",
  "GMeet - Moelis",
  "1 hour call - Lazard RX",
  "45-min chat w/ PJT VP",
  "20 min catch-up - Houlihan",
  "Quick sync - Evercore analyst",
  "Dana Reed (Evercore) <> Alex Rivera (Penn)",
  "Mentorship chat w/ Sam Ito",
  "Coffee chat (tentative)",
  "Networking call - Evercore Partners",
  "Coffee chat w/ Dana Reed's colleague",
  "Sam Ito x Kai",
  "Informational chat - Dana Reed (Evercore Partners)",
  "Coffee chat 2:30pm - Moelis",
  "MD chat - Houlihan Lokey",
  "Advisor call - Morgan Stanley Wealth",
  "Coffee ☕️ w/ Evercore analyst",
  "coffee chat",
  "Coffee chat!!!",
  "Call: Dana Reed",
  "Dana Reed - call",
  "zoom w/ sam ito",
  "Teams meeting - Dana Reed",
  "Networking lunch - Lazard",
  "Coffee catch-up with Sam Ito",
];
for (const title of NEW_CHATS) {
  test(`chat: ${JSON.stringify(title)}`, () => {
    assert.equal(occasionOf({ title }), "chat");
  });
}

const STRANGER_CALLS: [string, Partial<ChatEvent>][] = [
  ["Jordan Lee and Alex Rivera", { videoCall: true, ...invite([JORDAN]) }],
  ["Jordan Lee & Kai", { videoCall: true, ...invite([JORDAN]) }],
  ["Kai w/ Jordan Lee", { videoCall: true, ...invite([JORDAN]) }],
  ["Call - Jordan Lee", invite([JORDAN, CASEY])],
  ["Chat", invite([JORDAN])],
  ["Discussion - Evercore", invite([JORDAN])],
  ["Check-in - Moelis", invite([JORDAN, CASEY, RILEY])],
  ["Kai x Jordan", invite([JORDAN])],
];
for (const [title, over] of STRANGER_CALLS) {
  test(`chat with a stranger: ${JSON.stringify(title)}`, () => {
    assert.equal(occasionOf({ title, ...over }), "chat");
  });
}

const NOT_CHATS: [string, Partial<ChatEvent>][] = [
  ["Call - Jordan Lee", invite([JORDAN, CASEY, RILEY, ALEX])],
  ["Dinner with Jordan Lee", invite([JORDAN])],
  ["Jordan Lee and Alex Rivera", { videoCall: true, ...invite([JORDAN, CASEY]) }],
  ["Jordan Lee and Alex Rivera", invite([JORDAN])],
  ["Coffee w/ grandpa", {}],
  ["Zoom w/ roommate", {}],
  ["Networking call - mom's friend", {}],
  ["Econ OH", {}],
  ["FNCE 2070 group project call", {}],
  ["Book club", {}],
  ["Coffee chat w/ Dana Reed - CANCELED", {}],
  ["Informational interview prep", {}],
  ["Email Jordan Lee re: coffee", {}],
  ["Team lunch", {}],
  ["Lunch w/ Evercore team", {}],
  ["Out of office - Dana Reed", {}],
  ["Kai x Evercore", {}],
  ["Invitation: Evercore <> Kai", {}],
  ["Draft thank-you to Dana Reed", {}],
  ["Coffee chat thank you email", {}],
  ["Finance Society networking night", {}],
  ["Dentist - Dr. Reed", {}],
  ["Flight to NYC for Evercore coffee", {}],
];
for (const [title, over] of NOT_CHATS) {
  test(`not a chat: ${JSON.stringify(title)}${over.attendeeEmails ? ` (${over.attendeeEmails.length} invited${over.videoCall ? ", video" : ""})` : ""}`, () => {
    assert.equal(occasionOf({ title, ...over }), null);
  });
}

// ---- bug probes: realistic chats the rules turn away ----

test("probe: a contact named Ping is not a to-do (\"Ping Zhang <> Alex Rivera\", Ping invited)", () => {
  const p = judge({ title: "Ping Zhang <> Alex Rivera", ...invite([{ email: PING.email!, name: "Ping Zhang" }]) });
  assert.equal(p?.occasion, "chat");
  assert.equal(p?.contact?.id, PING.id);
});

test("probe: Zoom's own title for a contact named Ping (\"Ping Zhang's Zoom Meeting\")", () => {
  assert.equal(occasionOf({ title: "Ping Zhang's Zoom Meeting", videoCall: true }), "chat");
});

test("probe: equity research is a sector, not a to-do (\"Research coffee chat - Evercore ISI\")", () => {
  assert.equal(occasionOf({ title: "Research coffee chat - Evercore ISI" }), "chat");
});

test("probe: \"Research analyst call - BofA\" is a call with a research analyst", () => {
  assert.equal(occasionOf({ title: "Research analyst call - BofA" }), "chat");
});

test("probe: a class-year tag is not a course code (\"Coffee chat - Dana Reed (WG25)\")", () => {
  assert.equal(occasionOf({ title: "Coffee chat - Dana Reed (WG25)" }), "chat");
});

test("probe: a summer-analyst tag is not a course code (\"Coffee chat - Evercore SA26\")", () => {
  assert.equal(occasionOf({ title: "Coffee chat - Evercore SA26" }), "chat");
});

test("probe: the state of Ohio is not office hours (\"Coffee chat - Dana Reed (Columbus, OH)\")", () => {
  assert.equal(occasionOf({ title: "Coffee chat - Dana Reed (Columbus, OH)" }), "chat");
});

test("probe: a tracked firm called \"... Group\" does not veto its own call (\"Intro call - Carlyle Group\")", () => {
  assert.equal(occasionOf({ title: "Intro call - Carlyle Group" }), "chat");
});

test("probe: a screening call with a recruiter is an interview, not a coffee chat", () => {
  assert.equal(occasionOf({ title: "Screening call with JPM recruiter" }), "interview");
});

test("probe: a first-round call with a VP is an interview, not a coffee chat", () => {
  assert.equal(occasionOf({ title: "First round call w/ Evercore VP" }), "interview");
});

test("probe: \"Coffee chat-Dana Reed\" is addressed to Dana", () => {
  assert.equal(judge({ title: "Coffee chat-Dana Reed" })?.contact?.id, DANA.id);
});

test("probe: \"James Harris' Zoom Meeting\" is addressed to James", () => {
  assert.equal(judge({ title: "James Harris' Zoom Meeting", videoCall: true })?.contact?.id, JAMES.id);
});

test("probe: \"Coffee chat w/ Jose Alvarez\" is addressed to José", () => {
  assert.equal(judge({ title: "Coffee chat w/ Jose Alvarez" })?.contact?.id, JOSE.id);
});

// =====================================================================
// 5. Offerly + Google duplicates
// =====================================================================

const offerlyChat = (over: Partial<ChatEvent> = {}): ChatEvent =>
  event({ sourceKey: "offerly:o1", type: "coffee_chat", title: "Coffee chat", contactId: DANA.id, ...over });
const googleChat = (over: Partial<ChatEvent> = {}): ChatEvent =>
  event({ sourceKey: "google:g1", title: "Coffee chat with Dana Reed", ...over });

test("dup: a Google copy at the same time, same contact, is dropped; the Offerly one speaks", () => {
  const got = all([offerlyChat(), googleChat()]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:offerly:o1"]);
});

test("dup: order of the list does not matter (Google first)", () => {
  const got = all([googleChat(), offerlyChat()]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:offerly:o1"]);
});

test("dup: exactly 30 minutes apart is still the same slot", () => {
  const got = all([offerlyChat(), googleChat({ startsAt: new Date(ago(4).getTime() + 30 * MIN), endsAt: ago(3) })]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:offerly:o1"]);
});

test("dup: 31 minutes apart is two conversations", () => {
  const got = all([offerlyChat(), googleChat({ startsAt: new Date(ago(4).getTime() + 31 * MIN), endsAt: ago(3) })]);
  assert.equal(got.length, 2);
});

test("dup: same contact found differently (Offerly by title, Google by invite) is still one", () => {
  const got = all([
    offerlyChat({ contactId: null, title: "Coffee chat with Dana Reed" }),
    googleChat({ title: "Coffee chat", ...invite([{ email: DANA.email!, name: "Dana" }]) }),
  ]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:offerly:o1"]);
});

test("dup: different contacts at the same time are both owed", () => {
  const got = all([offerlyChat(), googleChat({ title: "Coffee chat with Sam Ito" })]);
  assert.equal(got.length, 2);
});

test("dup: an Offerly chat naming nobody and a Google chat at the same time are one prompt", () => {
  const got = all([offerlyChat({ contactId: null }), googleChat({ title: "Coffee chat - Evercore" })]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:offerly:o1"]);
});

test("dup: the Offerly entry ticked off silences the Google copy too", () => {
  const got = all([offerlyChat(), googleChat()], { done: new Set(["thank_you:offerly:o1"]) });
  assert.deepEqual(got, []);
});

test("dup: a thank-you sent to the contact closes both", () => {
  const got = all([offerlyChat(), googleChat()], { thanked: [{ contactId: DANA.id, at: ago(1) }] });
  assert.deepEqual(got, []);
});

test("dup: two Google entries never dedupe each other by contact (only Offerly speaks for others)", () => {
  const got = all([googleChat({ sourceKey: "google:a" }), googleChat({ sourceKey: "google:b" })]);
  assert.equal(got.length, 2);
});

test("probe dup: an Offerly entry that is NOT a chat (a personal block linked to Dana) must not swallow the real chat", () => {
  const got = all([
    event({ sourceKey: "offerly:p1", type: "personal", title: "Leave for Evercore", contactId: DANA.id, startsAt: ago(4.25), endsAt: ago(4) }),
    googleChat(),
  ]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:google:g1"], "the coffee chat with Dana is still owed");
});

test("probe dup: an Offerly deadline linked to the contact must not swallow the chat", () => {
  const got = all([
    event({ sourceKey: "offerly:d1", type: "deadline", title: "Evercore application", contactId: DANA.id }),
    googleChat(),
  ]);
  assert.deepEqual(got.map((p) => p.key), ["thank_you:google:g1"]);
});

// =====================================================================
// 6. parseGoogleEvent: who is a person
// =====================================================================

const attendeesOf = (emails: string[]) =>
  parseGoogleEvent(rawEvent({ attendees: [SELF, ...emails.map((email) => ({ email }))] }), CAL)!.attendeeEmails;

const PEOPLE_ADDRESSES = [
  "dana.reed@evercore.com",
  "nobody@x.com",
  "abbott@x.com",
  "talbot.jones@x.com",
  "robot.smith@x.com",
  "botond.kiss@x.hu",
  "calendarsmith@x.com",
  "jane@calendar-labs.com",
  "noreen.reply@x.com",
  "sam@zoominfo.com",
  "dana@botanic.com",
  "jane.doe@bot-capital.com",
  "notice.board@x.com",
  // Probe: a person's own plus-tag is still that person.
  "dana.reed+calendar@gmail.com",
];
for (const email of PEOPLE_ADDRESSES) {
  test(`parse: ${email} is a person`, () => {
    assert.deepEqual(attendeesOf([email]), [email]);
  });
}

const NOT_PEOPLE = [
  "noreply@evercore.com",
  "no-reply@greenhouse.io",
  "NoReply@Firm.com",
  "  noreply@x.com  ",
  "noreply+tag@x.com",
  "donotreply@x.com",
  "do-not-reply@x.com",
  "notifications@firm.com",
  "notification@firm.com",
  "calendar@firm.com",
  "calendar-notification@google.com",
  "calendar.team@firm.com",
  "mailer-daemon@googlemail.com",
  "scheduler@firm.com",
  "recruiting-bot@firm.com",
  "bot@firm.com",
  "anyone@calendly.com",
  "x@zoom.us",
  "sched@goodtime.io",
  "coordinator@modernloop.io",
  "abc123@group.calendar.google.com",
  "c_188abc@resource.calendar.google.com",
  "abc@import.calendar.google.com",
  // Probes: the same bots, spelled the other common ways.
  "no_reply@x.com",
  "no.reply@x.com",
  "do_not_reply@x.com",
];
for (const email of NOT_PEOPLE) {
  test(`parse: ${JSON.stringify(email)} is not a person`, () => {
    assert.deepEqual(attendeesOf([email]), []);
  });
}

test("parse: attendees carries the display name, trimmed, or null", () => {
  const g = parseGoogleEvent(
    rawEvent({
      attendees: [
        SELF,
        { email: "A@X.com", displayName: " Ann Bee " },
        { email: "b@x.com", displayName: "" },
        { email: "c@x.com", displayName: 7 },
        { email: "d@x.com" },
      ],
    }),
    CAL,
  )!;
  assert.deepEqual(g.attendees, [
    { email: "a@x.com", name: "Ann Bee" },
    { email: "b@x.com", name: null },
    { email: "c@x.com", name: null },
    { email: "d@x.com", name: null },
  ]);
  assert.deepEqual(g.attendeeEmails, g.attendees.map((a) => a.email));
});

test("parse: a self attendee who is also a resource or bot never counts; self never counts even without self=true twin", () => {
  const g = parseGoogleEvent(rawEvent({ attendees: [SELF, { email: "kai@upenn.edu", self: true, resource: true }] }), CAL)!;
  assert.deepEqual(g.attendees, []);
});

const VIDEO: [string, Record<string, unknown>, boolean][] = [
  ["location \"Microsoft Teams Meeting\"", { location: "Microsoft Teams Meeting" }, true],
  ["location \"Skype\"", { location: "Skype" }, true],
  ["location \"FaceTime\"", { location: "FaceTime" }, true],
  ["location \"Google Meet\"", { location: "  Google Meet " }, true],
  ["location \"GMeet\"", { location: "GMeet" }, true],
  ["a Chime link", { description: "Join https://app.chime.aws/meetings/123" }, true],
  ["a BlueJeans link", { location: "https://bluejeans.com/123" }, true],
  ["a GoTo link", { description: "https://meet.goto.com/123456" }, true],
  ["a Whereby link", { location: "https://whereby.com/dana" }, true],
  ["a Teams consumer link", { description: "https://teams.live.com/meet/9" }, true],
  ["a ZoomGov link", { location: "https://zoomgov.com/j/1" }, true],
  ["a FaceTime link", { description: "https://facetime.apple.com/join#v=1" }, true],
  ["a phone number", { location: "+1 212 555 0100" }, false],
  ["a street address", { location: "Evercore, 55 E 52nd St" }, false],
  ["conferenceData entryPoints not an array", { conferenceData: { entryPoints: "video" } }, false],
  ["a word 'meeting' alone", { location: "Meeting room 4" }, false],
  // Probe: the Teams form is accepted; the Zoom form of the same thing should be too.
  ["location \"Zoom Meeting\"", { location: "Zoom Meeting" }, true],
];
for (const [what, over, want] of VIDEO) {
  test(`parse video: ${what} -> ${want}`, () => {
    assert.equal(parseGoogleEvent(rawEvent(over), CAL)!.videoCall, want);
  });
}

// =====================================================================
// 7. Seeded fuzz: selectThankYous invariants over many scenarios
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

const FUZZ_CONTACTS: ThankContact[] = [
  DANA,
  SAM,
  MORGAN,
  { id: "c-riya", name: "Riya Shah", email: "riya.shah@lazard.com" },
  { id: "c-tom", name: "Tom Baker", email: " TBaker@PJT.com " },
];
const FUZZ_STRANGERS = [JORDAN, ALEX, CASEY, RILEY, { email: "pat.ng@guggenheim.com", name: "  Pat Ng " }];
const FUZZ_BOTS = [
  "noreply@calendly.com",
  "notifications@firm.com",
  "room-1@resource.calendar.google.com",
  "scheduler@goodtime.io",
  "x@zoom.us",
];
const FUZZ_FIRMS = ["Evercore", "Evercore ISI", "Lazard", "Moelis & Company", "J.P. Morgan", "Carlyle Group", "Guggenheim"];
const FUZZ_TITLES = [
  "Coffee chat with {c}",
  "Coffee chat - {f}",
  "Call with {c}",
  "{c} <> Kai",
  "Kai x {s}",
  "Zoom w/ {f} analyst",
  "Networking call - {f}",
  "30 Minute Meeting between Alex Rivera and {s}",
  "{s}'s Zoom Meeting",
  "Chat",
  "Call",
  "Lunch",
  "Gym",
  "ECON 101",
  "Coffee with mom",
  "Informational - {f}",
  "Quick call - {f}",
  "Catch up - {c}",
  "(untitled)",
  "Team meeting",
  "First round interview - {f}",
  "{c}",
  "Meeting",
];
const FUZZ_ZONES = ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Tokyo"];

type Scenario = {
  seed: number;
  events: ChatEvent[];
  contacts: ThankContact[];
  firms: string[];
  done: Set<string>;
  thanked: { contactId: string; at: Date; interview?: boolean }[];
  timeZone: string;
};

function buildScenario(seed: number): Scenario {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const contacts = FUZZ_CONTACTS.filter(() => r() < 0.8);
  const firms = FUZZ_FIRMS.filter(() => r() < 0.6);
  const n = 1 + Math.floor(r() * 6);
  const events: ChatEvent[] = [];
  for (let i = 0; i < n; i++) {
    const title = pick(FUZZ_TITLES)
      .replace("{c}", pick(FUZZ_CONTACTS).name)
      .replace("{s}", pick(FUZZ_STRANGERS).name ?? "Jordan Lee")
      .replace("{f}", pick(FUZZ_FIRMS));
    // Start anywhere from 17 days ago to 1 hour ahead, on a 5-minute grid.
    const start = new Date(NOW.getTime() - Math.floor(r() * (17 * 24 * 12 + 12)) * 5 * MIN + HOUR);
    const endRoll = r();
    const end =
      endRoll < 0.2 ? null : endRoll < 0.25 ? new Date(start.getTime() - 10 * MIN) : new Date(start.getTime() + (15 + Math.floor(r() * 8) * 15) * MIN);
    const idSuffix = r() < 0.2 ? "_20260922T150000Z" : r() < 0.1 ? "+a/b&c" : "";
    if (r() < 0.55) {
      const attendees: Record<string, unknown>[] = [];
      if (r() < 0.8) attendees.push(SELF);
      const k = Math.floor(r() * 4);
      for (let j = 0; j < k; j++) {
        const roll = r();
        if (roll < 0.35) {
          const c = pick(FUZZ_CONTACTS);
          if (c.email) attendees.push({ email: c.email.toUpperCase(), displayName: r() < 0.5 ? c.name : undefined });
        } else if (roll < 0.8) {
          const s = pick(FUZZ_STRANGERS);
          attendees.push({ email: s.email, displayName: s.name ?? undefined });
        } else {
          attendees.push({ email: pick(FUZZ_BOTS), resource: r() < 0.3 });
        }
      }
      const g = parseGoogleEvent(
        {
          id: `g${seed}_${i}${idSuffix}`,
          summary: title,
          htmlLink: "x",
          start: { dateTime: start.toISOString() },
          end: end ? { dateTime: end.toISOString() } : undefined,
          hangoutLink: r() < 0.4 ? "https://meet.google.com/abc" : undefined,
          attendees,
          recurringEventId: r() < 0.05 ? "base" : undefined,
          eventType: r() < 0.05 ? "focusTime" : undefined,
        },
        CAL,
      )!;
      events.push({
        sourceKey: `google:${g.id}`,
        title: g.title,
        startsAt: new Date(g.start),
        endsAt: g.end ? new Date(g.end) : null,
        allDay: g.allDay,
        notes: g.notes,
        videoCall: g.videoCall,
        attendeeEmails: g.attendeeEmails,
        attendees: g.attendees,
        declined: g.declined,
        recurring: g.recurring,
        eventType: g.eventType,
      });
    } else {
      events.push({
        sourceKey: `offerly:o${seed}_${i}`,
        title,
        type: pick(["coffee_chat", "meeting", null, "personal", "coffee_chat"]),
        contactId: r() < 0.5 ? pick([...FUZZ_CONTACTS.map((c) => c.id), "c-deleted"]) : null,
        startsAt: start,
        endsAt: end,
      });
      // Sometimes a Google copy of it, a few minutes off.
      if (r() < 0.3) {
        const shift = (Math.floor(r() * 13) - 6) * 5 * MIN;
        events.push({
          sourceKey: `google:dup${seed}_${i}`,
          title: pick(["Coffee chat", title, `Coffee chat with ${pick(FUZZ_CONTACTS).name}`]),
          startsAt: new Date(start.getTime() + shift),
          endsAt: end ? new Date(end.getTime() + shift) : null,
          attendeeEmails: [],
          attendees: [],
        });
      }
    }
  }
  const done = new Set<string>();
  for (const e of events) if (r() < 0.15) done.add(thankYouKey(e.sourceKey));
  const thanked = Array.from({ length: Math.floor(r() * 3) }, () => ({
    contactId: pick(FUZZ_CONTACTS).id,
    at: new Date(NOW.getTime() - Math.floor(r() * 16 * 24) * HOUR),
    interview: r() < 0.2,
  }));
  return { seed, events, contacts, firms, done, thanked, timeZone: pick(FUZZ_ZONES) };
}

function run(s: Scenario, over: Partial<Parameters<typeof selectThankYous>[0]> = {}) {
  return selectThankYous({
    events: s.events,
    contacts: s.contacts,
    done: s.done,
    thanked: s.thanked,
    firms: s.firms,
    now: NOW,
    timeZone: s.timeZone,
    ...over,
  });
}

const FUZZ_SCENARIOS = 400;

test(`fuzz: selectThankYous invariants hold over ${FUZZ_SCENARIOS} seeded scenarios`, () => {
  let prompts = 0;
  let chats = 0;
  let outside = 0;
  let prefilled = 0;
  let scenariosWithPrompts = 0;
  for (let seed = 1; seed <= FUZZ_SCENARIOS; seed++) {
    const s = buildScenario(seed);
    const at = `seed ${seed}`;
    const out = run(s);
    if (out.length) scenariosWithPrompts++;
    prompts += out.length;
    const byKey = new Map(s.events.map((e) => [thankYouKey(e.sourceKey), e]));
    const byId = new Map(s.contacts.map((c) => [c.id, c]));

    // Unique keys, each one an event's; sorted by due time; in the window; not ticked.
    assert.equal(new Set(out.map((p) => p.key)).size, out.length, `${at}: duplicate keys`);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].dueAt.getTime() <= out[i].dueAt.getTime(), `${at}: not oldest first`);
    }
    for (const p of out) {
      const e = byKey.get(p.key);
      assert.ok(e, `${at}: ${p.key} is no event's key`);
      const late = NOW.getTime() - p.dueAt.getTime();
      assert.ok(late >= 0 && late <= THANK_YOU_LOOKBACK_DAYS * DAY, `${at}: ${p.key} owed outside the window (${late})`);
      assert.ok(!s.done.has(p.key), `${at}: ${p.key} was ticked off`);
      assert.ok(p.dueAt.getTime() > p.startsAt.getTime(), `${at}: due before it began`);
      assert.equal(p.title, e.title);
      assertCleanHref(p.href, p.key);
      const days = daysOwed(p.dueAt, NOW, s.timeZone);
      assert.ok(days >= 0 && days <= THANK_YOU_LOOKBACK_DAYS + 1, `${at}: daysOwed ${days}`);
      assert.ok(thankYouFlashKey(p.key, NOW, s.timeZone).startsWith(`${p.key}:`));

      if (p.occasion !== "chat") continue;
      chats++;
      // Routing.
      assert.equal(p.next.contactId, p.contact?.id ?? null, `${at}: next is not the contact`);
      if (p.contact) {
        assert.equal(p.href, CONTACT_HREF(p.contact.id), `${at}: contact href`);
        assert.equal(p.next.name, p.contact.name);
        assert.equal(p.next.email, p.contact.email ?? null);
        assert.equal(p.next.firm, null);
        assert.equal(thankYouTitle(p), `Thank ${p.contact.name}`);
        // Not already thanked since it began.
        assert.ok(
          !s.thanked.some((t) => t.contactId === p.contact!.id && t.at.getTime() >= p.startsAt.getTime()),
          `${at}: ${p.key} was already thanked`,
        );
        // The contact is one the student has.
        assert.equal(byId.get(p.contact.id), p.contact);
      } else {
        outside++;
        assert.equal(p.href, OUTSIDE_HREF(p.key), `${at}: outside href`);
        // The invite's one name when it gave one; otherwise nobody to name.
        assert.equal(thankYouTitle(p), p.next.name ? `Thank ${p.next.name}` : "Send a thank-you");
        assert.equal(p.next.firm, firmInTitle(e.title, s.firms), `${at}: firm`);
        const invited = e.attendees ?? [];
        if (invited.length === 1) {
          assert.equal(p.next.email, invited[0].email, `${at}: the one invitee's email`);
          assert.equal(p.next.name, invited[0].name, `${at}: the one invitee's name`);
          prefilled++;
        } else {
          assert.equal(p.next.email, null, `${at}: guessed an email among ${invited.length}`);
          assert.equal(p.next.name, null, `${at}: guessed a name among ${invited.length}`);
        }
        if (p.next.email) assert.ok(invited.some((a) => a.email === p.next.email), `${at}: email not on the invite`);
      }
      // A Google copy of an Offerly entry with the same person is never its own prompt.
      if (p.key.startsWith("thank_you:google:") && p.contact) {
        for (const o of s.events) {
          if (!o.sourceKey.startsWith("offerly:")) continue;
          const oc =
            (o.contactId ? byId.get(o.contactId) : undefined) ??
            contactInInvite(o.attendeeEmails, s.contacts) ??
            contactInTitle(o.title, s.contacts);
          // Only an Offerly entry that is itself a chat or an interview speaks
          // for the invitation (a "personal" block linked to Dana does not).
          const speaks = isInterviewEvent(o) || isChatEvent(o, oc ?? null, false, s.firms);
          assert.ok(
            !(speaks && oc?.id === p.contact.id && Math.abs(o.startsAt.getTime() - p.startsAt.getTime()) <= 30 * MIN),
            `${at}: ${p.key} duplicates ${o.sourceKey}`,
          );
        }
      }
    }

    // Pure and repeatable; order of the calendar does not change what is owed.
    assert.deepEqual(run(s), out, `${at}: not deterministic`);
    const reversed = run({ ...s, events: [...s.events].reverse() });
    assert.deepEqual(new Set(reversed.map((p) => p.key)), new Set(out.map((p) => p.key)), `${at}: order-dependent`);

    // Ticking one off removes exactly that one.
    if (out.length) {
      const k = out[0].key;
      const after = run(s, { done: new Set([...s.done, k]) });
      assert.deepEqual(after.map((p) => p.key), out.filter((p) => p.key !== k).map((p) => p.key), `${at}: tick removed more than one`);
    }

    // Thanking one contact now closes their chats and no other chat.
    const firstKnown = out.find((p) => p.occasion === "chat" && p.contact);
    if (firstKnown) {
      const cid = firstKnown.contact!.id;
      const after = run(s, { thanked: [...s.thanked, { contactId: cid, at: NOW }] });
      assert.ok(!after.some((p) => p.occasion === "chat" && p.contact?.id === cid), `${at}: still owed after thanks`);
      const others = (xs: ThankYouPrompt[]) =>
        xs.filter((p) => p.occasion === "chat" && p.contact?.id !== cid).map((p) => p.key);
      assert.deepEqual(others(after), others(out), `${at}: thanking ${cid} changed someone else's chat`);
    }
  }
  // The generator must actually exercise the rules.
  assert.ok(scenariosWithPrompts > FUZZ_SCENARIOS / 3, `only ${scenariosWithPrompts} scenarios prompted anything`);
  assert.ok(outside > 20 && prefilled > 5 && chats - outside > 20, `thin coverage: ${chats} chats, ${outside} outside, ${prefilled} prefilled`);
  console.log(`fuzz: ${FUZZ_SCENARIOS} scenarios, ${prompts} prompts, ${chats} chats (${outside} outside, ${prefilled} prefilled)`);
});
