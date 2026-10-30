// The interview thank-you rules, attacked on purpose.
//
// Who the interviewers are (the invitation's people, mapped to saved contacts,
// plus the contact the entry names), when each is thanked, how notes that match
// nobody are credited by time, when an interview closes by itself (never with
// an empty list), where "Write it" goes at every step, and what the progress
// line says in every state. Every expectation below is the behaviour a student
// should see; a failure here is a bug in src/lib/thank-you.ts unless noted.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  interviewThankBox,
  isInterviewEvent,
  selectThankYous,
  thankYouDueAt,
  thankYouKey,
  thankYouProgress,
  thankYouTitle,
  type ChatEvent,
  type Interviewer,
  type ThankContact,
  type ThankYouPrompt,
} from "../../src/lib/thank-you";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "America/New_York";

/** 2026-09-DD hh:mm on a New York clock (EDT, UTC-4, all of September). */
const ny = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 8, day, hh + 4, mm));
/** An all-day entry's start as Google hands it over: midnight UTC on its date. */
const dateOnly = (day: number) => new Date(Date.UTC(2026, 8, day));

const NOW = ny(23, 11);

const DANA: ThankContact = { id: "c-dana", name: "Dana Reed", email: "dana@evercore.com" };
// Saved with odd case and whitespace; invitations carry it lower-cased.
const SAM: ThankContact = { id: "c-sam", name: "Sam Ito", email: " Sam.Ito@Evercore.com " };
const LEE: ThankContact = { id: "c-lee", name: "Lee Park", email: null };
const KIM: ThankContact = { id: "c-kim", name: "Kim Olsen", email: "kim@lazard.com" };
const CONTACTS = [DANA, SAM, LEE, KIM];
const FIRMS = ["Evercore", "Evercore ISI", "Lazard", "Goldman Sachs", "Moelis"];

type Att = { email: string; name: string | null };
const A_DANA: Att = { email: "dana@evercore.com", name: "Dana R." };
const A_PAT: Att = { email: "pat@evercore.com", name: "Pat Chen" };
const A_JO: Att = { email: "jo@evercore.com", name: null };
const A_SAM: Att = { email: "sam.ito@evercore.com", name: null };
const A_ROB: Att = { email: "Rob.Diaz@Evercore.com", name: "Rob Diaz" };

const SAVED_BY_EMAIL = new Map<string, ThankContact>(
  CONTACTS.filter((c) => c.email).map((c) => [c.email!.trim().toLowerCase(), c]),
);

/** A Google interview with an invitation, the way parseGoogleEvent hands it over. */
function gInterview(over: Partial<ChatEvent> & { attendees?: Att[] } = {}): ChatEvent {
  const attendees = over.attendees ?? [];
  return {
    sourceKey: "google:iv1",
    title: "Evercore first round interview",
    startsAt: ny(22, 10),
    endsAt: ny(22, 11),
    attendeeEmails: attendees.map((a) => a.email.toLowerCase()),
    ...over,
    attendees,
  };
}

/** An interview typed into Offerly: no invitation, maybe a linked contact. */
function oInterview(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "offerly:iv1",
    title: "Evercore first round",
    type: "interview",
    startsAt: ny(22, 10),
    endsAt: ny(22, 11),
    ...over,
  };
}

function chat(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    sourceKey: "google:chat1",
    title: "Coffee chat with Sam Ito",
    startsAt: ny(22, 9),
    endsAt: ny(22, 9, 30),
    ...over,
  };
}

type Send = { contactId: string; at: Date; interview?: boolean; email?: string | null };
type Input = Parameters<typeof selectThankYous>[0];

function run(events: ChatEvent[], extra: Partial<Input> = {}): ThankYouPrompt[] {
  return selectThankYous({
    events,
    contacts: CONTACTS,
    done: new Set(),
    thanked: [],
    firms: FIRMS,
    now: NOW,
    timeZone: TZ,
    ...extra,
  });
}
const byKey = (out: ThankYouPrompt[], sourceKey: string) => out.find((p) => p.key === thankYouKey(sourceKey));
const keys = (out: ThankYouPrompt[]) => out.map((p) => p.key).sort();

/** A note to someone on an invitation: by contact when saved, by address when not. */
function noteTo(a: Att, at: Date, interview = false, shout = false): Send {
  const saved = SAVED_BY_EMAIL.get(a.email.toLowerCase());
  if (saved) return { contactId: saved.id, at, interview };
  const email = shout ? a.email.toUpperCase() : a.email;
  return { contactId: `c-out-${a.email.split("@")[0].toLowerCase()}`, at, interview, email };
}
/** An interview-template note to someone on no invitation. */
const stray = (n: number, at: Date): Send => ({ contactId: `c-stray-${n}`, at, interview: true, email: `stray${n}@x.com` });

const hrefFor = (key: string, box: string, contactId: string | null) =>
  contactId
    ? `/outreach?contact=${contactId}&occasion=thanks&box=${box}`
    : `/outreach?occasion=thanks&box=${box}&thank=${encodeURIComponent(key)}`;

/** Expected interviewer entry for an attendee (no contact-in-title involved). */
function expectPerson(a: Att, thanked: boolean): Interviewer {
  const email = a.email.toLowerCase();
  const saved = SAVED_BY_EMAIL.get(email);
  return { email, name: saved?.name ?? a.name, contactId: saved?.id ?? null, thanked };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

function assertNoLeak(p: ThankYouPrompt) {
  assert.ok(!p.href.includes("@"), `href carries an address: ${p.href}`);
  assert.ok(!p.href.includes("%40"), `href carries an encoded address: ${p.href}`);
  for (const x of p.interviewers) {
    if (x.name) assert.ok(!p.href.includes(encodeURIComponent(x.name)) && !p.href.includes(x.name), `href carries ${x.name}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Panels of 1-5, notes in every order
// ---------------------------------------------------------------------------

const PANELS: Att[][] = [
  [A_PAT],
  [A_DANA],
  [A_JO],
  [A_ROB],
  [A_DANA, A_PAT],
  [A_JO, A_SAM],
  [A_PAT, A_DANA, A_JO],
  [A_SAM, A_ROB, A_DANA],
  [A_DANA, A_PAT, A_JO, A_SAM],
  [A_ROB, A_JO, A_PAT, A_DANA],
  [A_DANA, A_PAT, A_JO, A_SAM, A_ROB],
];

const label = (a: Att) => a.name ?? a.email;

PANELS.forEach((panel, pi) => {
  const orders = permutations(panel.map((_, i) => i));
  orders.forEach((order, oi) => {
    const name = `panel ${pi} (${panel.map(label).join(", ")}): notes in order ${order.join("")}`;
    test(name, () => {
      const event = gInterview({ sourceKey: `google:panel${pi}`, attendees: panel });
      const key = thankYouKey(event.sourceKey);
      const n = panel.length;
      const firstSaved = panel.map((a) => SAVED_BY_EMAIL.get(a.email.toLowerCase())).find(Boolean) ?? null;
      const sends: Send[] = [];
      for (let k = 0; k <= n; k++) {
        const out = run([event], { thanked: sends });
        const ctx = `${name}, after ${k} note(s)`;
        if (k === n) {
          assert.deepEqual(out, [], `${ctx}: everyone thanked, still owed`);
          break;
        }
        assert.equal(out.length, 1, `${ctx}: not owed`);
        const [p] = out;
        const thankedIdx = new Set(order.slice(0, k));
        assert.deepEqual(
          p.interviewers,
          panel.map((a, i) => expectPerson(a, thankedIdx.has(i))),
          `${ctx}: interviewers`,
        );
        assert.equal(p.notesSent, k, `${ctx}: notesSent`);
        assert.equal(thankYouProgress(p), k === 0 ? null : `${k} of ${n} thanked`, `${ctx}: progress`);
        // Next is the first unthanked person on the list, in list order.
        const nextIdx = panel.findIndex((_, i) => !thankedIdx.has(i));
        const want = expectPerson(panel[nextIdx], false);
        assert.equal(p.next.contactId, want.contactId, `${ctx}: next.contactId`);
        assert.equal(p.next.name, want.name, `${ctx}: next.name`);
        if (!want.contactId) {
          assert.deepEqual(p.next, { contactId: null, name: want.name, email: want.email, firm: "Evercore" }, `${ctx}: next`);
        } else {
          assert.equal(p.next.firm, null, `${ctx}: a saved contact's next carries no firm`);
        }
        assert.equal(p.href, hrefFor(key, "thanks.interview", want.contactId), `${ctx}: href`);
        assertNoLeak(p);
        assert.equal(
          thankYouTitle(p),
          // One person is thanked by name - saved, or as the invitation names them.
          n === 1 && (firstSaved?.name ?? panel[0].name)
            ? `Thank ${firstSaved?.name ?? panel[0].name}`
            : "Thank your interviewers",
          `${ctx}: title`,
        );
        // The next note, alternating templates and address case.
        sends.push(noteTo(panel[order[k]], ny(22, 17, k * 7), (oi + k) % 2 === 0, k % 2 === 1));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Notes to people not on the invitation
// ---------------------------------------------------------------------------

test("off-list: a plain (non-interview) note to a saved contact not on the invite counts for nothing", () => {
  const [p] = run([gInterview({ attendees: [A_PAT, A_JO] })], { thanked: [{ contactId: KIM.id, at: ny(22, 18) }] });
  assert.equal(p.notesSent, 0);
  assert.equal(thankYouProgress(p), null);
});

test("off-list: a plain note to an unsaved address not on the invite counts for nothing", () => {
  const [p] = run([gInterview({ attendees: [A_PAT] })], {
    thanked: [{ contactId: "c-x", at: ny(22, 18), email: "nobody@evercore.com" }],
  });
  assert.equal(p.notesSent, 0);
});

test("off-list: an interview-template note to someone not listed is credited by time", () => {
  const [p] = run([gInterview({ attendees: [A_PAT, A_JO] })], { thanked: [stray(1, ny(22, 18))] });
  assert.equal(p.notesSent, 1);
  assert.equal(thankYouProgress(p), "1 of 2 thanked");
  assert.ok(p.interviewers.every((x) => !x.thanked), "a stray note must not tick a named person");
  assert.equal(p.next.name, "Pat Chen");
});

test("off-list: as many interview-template stray notes as people listed closes it", () => {
  assert.deepEqual(run([gInterview({ attendees: [A_PAT, A_JO] })], { thanked: [stray(1, ny(22, 18)), stray(2, ny(22, 18, 5))] }), []);
});

test("off-list: one named + one stray on a panel of two closes it", () => {
  const out = run([gInterview({ attendees: [A_PAT, A_JO] })], {
    thanked: [noteTo(A_JO, ny(22, 18)), stray(1, ny(22, 18, 5))],
  });
  assert.deepEqual(out, []);
});

test("off-list: one named + one stray on a panel of three is 2 of 3, next is the unthanked first on the list", () => {
  const [p] = run([gInterview({ attendees: [A_PAT, A_JO, A_ROB] })], {
    thanked: [noteTo(A_PAT, ny(22, 18)), stray(1, ny(22, 18, 5))],
  });
  assert.equal(p.notesSent, 2);
  assert.equal(thankYouProgress(p), "2 of 3 thanked");
  assert.equal(p.next.email, "jo@evercore.com");
});

test("off-list: an interview-template note to a saved contact who is not on the invite is credited by time", () => {
  const [p] = run([gInterview({ attendees: [A_PAT, A_JO] })], { thanked: [{ contactId: KIM.id, at: ny(22, 18), interview: true }] });
  assert.equal(p.notesSent, 1);
});

test("off-list: a stray note sent before the interview began counts for nothing", () => {
  const [p] = run([gInterview({ attendees: [A_PAT] })], { thanked: [stray(1, ny(22, 9, 59))] });
  assert.equal(p.notesSent, 0);
});

test("off-list: a note to a listed person sent 1ms before the start does not thank them", () => {
  const e = gInterview({ attendees: [A_PAT] });
  const [p] = run([e], { thanked: [noteTo(A_PAT, new Date(e.startsAt.getTime() - 1), true)] });
  assert.equal(p.interviewers[0].thanked, false);
});

test("off-list: a note to a listed person sent exactly at the start thanks them", () => {
  const e = gInterview({ attendees: [A_PAT] });
  assert.deepEqual(run([e], { thanked: [noteTo(A_PAT, e.startsAt)] }), []);
});

// ---------------------------------------------------------------------------
// 3. The contact the entry names, listed or not (the recruiting coordinator)
// ---------------------------------------------------------------------------

const COORD: Att = { email: "recruiting@evercore.com", name: "Evercore Recruiting" };

function coordinatorCase(over: Partial<ChatEvent> = {}) {
  return gInterview({ title: "Evercore superday - Dana Reed", attendees: [COORD], ...over });
}

test("coordinator: the named contact is put first, the coordinator after", () => {
  const [p] = run([coordinatorCase()]);
  assert.deepEqual(p.interviewers, [
    { email: "dana@evercore.com", name: "Dana Reed", contactId: DANA.id, thanked: false },
    { email: "recruiting@evercore.com", name: "Evercore Recruiting", contactId: null, thanked: false },
  ]);
  assert.equal(p.contact?.id, DANA.id);
});

test("coordinator: two people, so the title is the panel's", () => {
  assert.equal(thankYouTitle(run([coordinatorCase()])[0]), "Thank your interviewers");
});

test("coordinator: the drafter opens on Dana first, on the superday thank-you", () => {
  const [p] = run([coordinatorCase()]);
  assert.equal(p.href, "/outreach?contact=c-dana&occasion=thanks&box=thanks.superday");
});

test("coordinator: after Dana, the coordinator - outside, by key, with the firm", () => {
  const e = coordinatorCase();
  const [p] = run([e], { thanked: [{ contactId: DANA.id, at: ny(22, 18) }] });
  assert.equal(thankYouProgress(p), "1 of 2 thanked");
  assert.deepEqual(p.next, { contactId: null, name: "Evercore Recruiting", email: "recruiting@evercore.com", firm: "Evercore" });
  assert.equal(p.href, hrefFor(thankYouKey(e.sourceKey), "thanks.superday", null));
  assertNoLeak(p);
});

test("coordinator: a note to the coordinator's address as well closes it", () => {
  const out = run([coordinatorCase()], {
    thanked: [{ contactId: DANA.id, at: ny(22, 18) }, { contactId: "c-coord", email: "Recruiting@Evercore.com", at: ny(22, 18, 5) }],
  });
  assert.deepEqual(out, []);
});

test("coordinator: coordinator first, then Dana, also closes it", () => {
  const out = run([coordinatorCase()], {
    thanked: [{ contactId: "c-coord", email: "recruiting@evercore.com", at: ny(22, 18) }, { contactId: DANA.id, at: ny(22, 18, 5) }],
  });
  assert.deepEqual(out, []);
});

test("coordinator: a note to Dana's saved address from another contact record thanks Dana", () => {
  const [p] = run([coordinatorCase()], { thanked: [{ contactId: "c-dup", email: "DANA@evercore.com", at: ny(22, 18) }] });
  assert.equal(p.interviewers[0].thanked, true);
});

test("coordinator: the contact linked by id, not named, is added too", () => {
  const [p] = run([gInterview({ contactId: LEE.id, attendees: [COORD] })]);
  assert.deepEqual(
    p.interviewers.map((x) => [x.contactId, x.email, x.name]),
    [
      [LEE.id, null, "Lee Park"],
      [null, "recruiting@evercore.com", "Evercore Recruiting"],
    ],
  );
  // Lee has no address: thanked by contact id only.
  const [q] = run([gInterview({ contactId: LEE.id, attendees: [COORD] })], { thanked: [{ contactId: LEE.id, at: ny(22, 18) }] });
  assert.equal(q.interviewers[0].thanked, true);
  assert.equal(q.next.email, "recruiting@evercore.com");
});

test("coordinator: a named contact who IS on the invite is not listed twice", () => {
  const [p] = run([gInterview({ title: "Evercore superday - Dana Reed", attendees: [COORD, A_DANA] })]);
  assert.deepEqual(
    p.interviewers.map((x) => x.contactId),
    [null, DANA.id],
  );
});

test("coordinator: Offerly entry linked to a contact - only that contact, and 'Thank <name>'", () => {
  const [p] = run([oInterview({ contactId: DANA.id })]);
  assert.deepEqual(p.interviewers, [{ email: "dana@evercore.com", name: "Dana Reed", contactId: DANA.id, thanked: false }]);
  assert.equal(thankYouTitle(p), "Thank Dana Reed");
  assert.equal(p.href, "/outreach?contact=c-dana&occasion=thanks&box=thanks.interview");
});

test("coordinator: Offerly entry linked to a contact closes on a plain note to them", () => {
  assert.deepEqual(run([oInterview({ contactId: DANA.id })], { thanked: [{ contactId: DANA.id, at: ny(22, 18) }] }), []);
});

test("coordinator: Offerly entry linked to a contact closes on one stray interview note (1 >= 1)", () => {
  assert.deepEqual(run([oInterview({ contactId: DANA.id })], { thanked: [stray(1, ny(22, 18))] }), []);
});

test("coordinator: Offerly entry naming a contact in its title lists them", () => {
  const [p] = run([oInterview({ title: "Interview with Kim Olsen - Lazard" })]);
  assert.deepEqual(p.interviewers.map((x) => x.contactId), [KIM.id]);
  assert.equal(thankYouTitle(p), "Thank Kim Olsen");
});

// ---------------------------------------------------------------------------
// 4. Duplicates
// ---------------------------------------------------------------------------

test("dupes: the same person twice on the invite, in different case, is one interviewer", () => {
  const [p] = run([gInterview({ attendees: [A_PAT, { email: "PAT@Evercore.com", name: "Pat" }, A_JO] })]);
  assert.deepEqual(p.interviewers.map((x) => x.email), ["pat@evercore.com", "jo@evercore.com"]);
});

test("dupes: a twice-listed person, thanked once, is thanked", () => {
  const out = run([gInterview({ attendees: [A_PAT, { email: "PAT@Evercore.com", name: "Pat" }] })], {
    thanked: [noteTo(A_PAT, ny(22, 18))],
  });
  assert.deepEqual(out, []);
});

test("dupes: a saved contact whose saved address differs in case and spaces is recognised on the invite", () => {
  const [p] = run([gInterview({ attendees: [A_SAM, A_PAT] })]);
  assert.deepEqual(p.interviewers[0], { email: "sam.ito@evercore.com", name: "Sam Ito", contactId: SAM.id, thanked: false });
  assert.equal(p.contact?.id, SAM.id);
});

test("dupes: the contact's name beats the invitation's display name", () => {
  const [p] = run([gInterview({ attendees: [A_DANA] })]);
  assert.equal(p.interviewers[0].name, "Dana Reed");
  assert.equal(thankYouTitle(p), "Thank Dana Reed");
});

test("dupes: a note to Sam by contact id (no address on the send) thanks Sam", () => {
  const out = run([gInterview({ attendees: [A_SAM] })], { thanked: [{ contactId: SAM.id, at: ny(22, 18) }] });
  assert.deepEqual(out, []);
});

test("dupes: a note to Sam's address in shouting case from another record thanks Sam", () => {
  const out = run([gInterview({ attendees: [A_SAM] })], { thanked: [{ contactId: "c-other", email: " SAM.ITO@EVERCORE.COM ", at: ny(22, 18) }] });
  assert.deepEqual(out, []);
});

test("dupes: the same interview linked to Dana AND listing Dana is one Dana", () => {
  const [p] = run([gInterview({ contactId: DANA.id, attendees: [{ email: "DANA@EVERCORE.COM", name: null }, A_PAT] })]);
  assert.deepEqual(p.interviewers.map((x) => x.contactId), [DANA.id, null]);
});

test("dupes: two saved records for one address, linked to the second, is still one person on the list", () => {
  const dana2: ThankContact = { id: "c-dana2", name: "Dana Reed", email: "dana@evercore.com" };
  const out = selectThankYous({
    events: [gInterview({ contactId: dana2.id, attendees: [A_DANA] })],
    contacts: [DANA, dana2],
    done: new Set(),
    thanked: [],
    firms: FIRMS,
    now: NOW,
    timeZone: TZ,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].interviewers.length, 1, "Dana listed twice under two contact records");
  assert.equal(thankYouTitle(out[0]), "Thank Dana Reed");
});

test("dupes: the same Google entry twice is one prompt and one set of interviewers", () => {
  const e = gInterview({ attendees: [A_PAT, A_JO] });
  const out = run([e, { ...e }], { thanked: [noteTo(A_PAT, ny(22, 18))] });
  assert.equal(out.length, 1);
  assert.equal(out[0].interviewers.length, 2);
  assert.equal(out[0].notesSent, 1);
});

test("dupes: blank addresses on the invite are nobody", () => {
  const [p] = run([gInterview({ attendees: [{ email: "  ", name: "Ghost" }, A_PAT] })]);
  assert.deepEqual(p.interviewers.map((x) => x.email), ["pat@evercore.com"]);
});

test("dupes: an invitation that lists only blank addresses is an empty list, so notes never close it", () => {
  const [p] = run([gInterview({ attendees: [{ email: "", name: "Ghost" }] })], { thanked: [stray(1, ny(22, 18))] });
  assert.deepEqual(p.interviewers, []);
  assert.equal(thankYouProgress(p), "1 note sent");
});

// ---------------------------------------------------------------------------
// 5. Same-day rounds at different firms
// ---------------------------------------------------------------------------

const GS = () =>
  gInterview({ sourceKey: "google:gs", title: "Goldman Sachs first round interview", startsAt: ny(22, 9), endsAt: ny(22, 10), attendees: [A_JO] });
const EV = () =>
  gInterview({ sourceKey: "google:ev", title: "Evercore second round interview", startsAt: ny(22, 14), endsAt: ny(22, 15), attendees: [A_PAT, A_ROB] });

test("same day: a stray interview note that evening counts only for the latest listed round", () => {
  const out = run([GS(), EV()], { thanked: [stray(1, ny(22, 19))] });
  // Both rounds list who was there, so a note to nobody listed is not spread
  // across the day: it counts for Evercore (the latest), not Goldman.
  assert.equal(byKey(out, "google:gs")?.notesSent, 0);
  assert.equal(byKey(out, "google:ev")?.notesSent, 1);
  assert.equal(thankYouProgress(byKey(out, "google:ev")!), "1 of 2 thanked");
});

test("same day: a note to Goldman's interviewer does not spill into Evercore's count", () => {
  const out = run([GS(), EV()], { thanked: [noteTo(A_JO, ny(22, 19), true)] });
  assert.deepEqual(keys(out), [thankYouKey("google:ev")]);
  assert.equal(out[0].notesSent, 0);
});

test("same day: a note to Evercore's interviewer does not close Goldman's", () => {
  const out = run([GS(), EV()], { thanked: [noteTo(A_PAT, ny(22, 19), true)] });
  assert.equal(byKey(out, "google:gs")?.notesSent, 0);
  assert.equal(byKey(out, "google:ev")?.notesSent, 1);
});

test("same day: a stray note sent between the rounds is Goldman's alone", () => {
  const out = run([GS(), EV()], { thanked: [stray(1, ny(22, 12))] });
  assert.deepEqual(keys(out), [thankYouKey("google:ev")]);
  assert.equal(out[0].notesSent, 0);
});

test("same day: both firms unlisted - one stray note credits both, neither closes", () => {
  const a = oInterview({ sourceKey: "offerly:gs", title: "Goldman Sachs first round", startsAt: ny(22, 9), endsAt: ny(22, 10) });
  const b = oInterview({ sourceKey: "offerly:ev", title: "Evercore first round", startsAt: ny(22, 14), endsAt: ny(22, 15) });
  const out = run([a, b], { thanked: [stray(1, ny(22, 19))] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent, thankYouProgress(p)]), [
    [thankYouKey("offerly:gs"), 1, "1 note sent"],
    [thankYouKey("offerly:ev"), 1, "1 note sent"],
  ]);
});

test("same day: each empty-list prompt routes outside with its own firm only", () => {
  const a = oInterview({ sourceKey: "offerly:gs", title: "Goldman Sachs first round", startsAt: ny(22, 9), endsAt: ny(22, 10) });
  const b = oInterview({ sourceKey: "offerly:ev", title: "Evercore ISI superday", startsAt: ny(22, 14), endsAt: ny(22, 15) });
  const out = run([a, b]);
  assert.deepEqual(byKey(out, "offerly:gs")!.next, { contactId: null, name: null, email: null, firm: "Goldman Sachs" });
  assert.deepEqual(byKey(out, "offerly:ev")!.next, { contactId: null, name: null, email: null, firm: "Evercore ISI" });
  assert.equal(byKey(out, "offerly:ev")!.href, hrefFor(thankYouKey("offerly:ev"), "thanks.superday", null));
});

test("same day: a stray note the next day is not credited to yesterday's rounds when today has one", () => {
  const today = gInterview({ sourceKey: "google:today", title: "Lazard first round interview", startsAt: ny(23, 9), endsAt: ny(23, 9, 45), attendees: [A_ROB] });
  const out = run([GS(), EV(), today], { now: ny(23, 18), thanked: [stray(1, ny(23, 12))] });
  assert.equal(byKey(out, "google:gs")?.notesSent, 0);
  assert.equal(byKey(out, "google:ev")?.notesSent, 0);
  assert.equal(byKey(out, "google:today"), undefined, "today's single-interviewer round is closed by the note");
});

test("same day: back-to-back rounds at two firms, one logged in Offerly and one only on Google, are both owed", () => {
  // A 14:00 Goldman phone screen typed into Offerly, and a 14:30 Evercore
  // interview the student accepted on Google. Different firms, different
  // rooms: the invitation is not a copy of the Offerly entry.
  const gs = oInterview({ sourceKey: "offerly:gs", title: "Goldman Sachs phone screen", startsAt: ny(22, 14), endsAt: ny(22, 14, 30) });
  const ev = gInterview({ sourceKey: "google:ev", title: "Evercore first round interview", startsAt: ny(22, 14, 30), endsAt: ny(22, 15, 15), attendees: [A_PAT] });
  assert.deepEqual(keys(run([gs, ev])), [thankYouKey("google:ev"), thankYouKey("offerly:gs")].sort());
});

test("same day: an interview logged in Offerly that also has the Google invitation keeps the invitation's interviewers", () => {
  const logged = oInterview({ sourceKey: "offerly:ev", startsAt: ny(22, 10), endsAt: ny(22, 11) });
  const invite = gInterview({ sourceKey: "google:ev", startsAt: ny(22, 10), endsAt: ny(22, 11), attendees: [A_PAT, A_JO] });
  const out = run([logged, invite], { thanked: [noteTo(A_PAT, ny(22, 18)), noteTo(A_JO, ny(22, 18, 5))] });
  // Both people on the invitation were thanked by name: nothing is owed.
  assert.deepEqual(out, [], "the invitation's people were dropped with the duplicate, so thanking them closes nothing");
});

// ---------------------------------------------------------------------------
// 6. Superdays: one all-day entry, several timed entries, several days
// ---------------------------------------------------------------------------

const PANEL4 = [A_DANA, A_PAT, A_JO, A_ROB];

function allDaySuperday(over: Partial<ChatEvent> & { attendees?: Att[] } = {}) {
  return gInterview({
    sourceKey: "google:sd",
    title: "Evercore Superday",
    allDay: true,
    startsAt: dateOnly(22),
    endsAt: dateOnly(23),
    ...over,
  });
}

test("superday all-day: due at 18:00 New York on its date", () => {
  assert.equal(thankYouDueAt(allDaySuperday(), "interview", TZ).toISOString(), ny(22, 18).toISOString());
});

test("superday all-day: not owed at 17:59, owed at 18:00", () => {
  const e = allDaySuperday({ attendees: PANEL4 });
  assert.equal(run([e], { now: ny(22, 17, 59) }).length, 0);
  assert.equal(run([e], { now: ny(22, 18) }).length, 1);
});

test("superday all-day: four named notes that evening close it; three leave 3 of 4 with the fourth next", () => {
  const e = allDaySuperday({ attendees: PANEL4 });
  const notes = PANEL4.map((a, i) => noteTo(a, ny(22, 19, i * 5), true));
  assert.deepEqual(run([e], { thanked: notes }), []);
  const [p] = run([e], { thanked: notes.slice(0, 3) });
  assert.equal(thankYouProgress(p), "3 of 4 thanked");
  assert.equal(p.next.name, "Rob Diaz");
  assert.equal(p.next.email, "rob.diaz@evercore.com");
  assert.equal(p.href, hrefFor(thankYouKey("google:sd"), "thanks.superday", null));
});

test("superday all-day: unlisted, a note that evening is credited to it", () => {
  const [p] = run([allDaySuperday()], { thanked: [stray(1, ny(22, 20))] });
  assert.equal(p.notesSent, 1);
  assert.equal(thankYouProgress(p), "1 note sent");
});

test("superday all-day: a note to a listed interviewer the evening BEFORE the superday does not thank them", () => {
  // Coffee with Dana on the 21st, the thank-you for it at 21:00 that night;
  // Dana is on the invitation for the superday on the 22nd.
  const e = allDaySuperday({ attendees: [A_DANA] });
  const out = run([e], { thanked: [{ contactId: DANA.id, at: ny(21, 21) }] });
  assert.equal(out.length, 1, "a note written before the superday closed it");
  assert.equal(out[0].interviewers[0].thanked, false);
});

test("superday all-day: a stray interview note the evening before does not count towards it", () => {
  // The note is for the 21st's Lazard round, not tomorrow's superday.
  const lazard = oInterview({ sourceKey: "offerly:lz", title: "Lazard first round", startsAt: ny(21, 14), endsAt: ny(21, 15) });
  const out = run([lazard, allDaySuperday()], { thanked: [stray(1, ny(21, 21))] });
  assert.equal(byKey(out, "offerly:lz")?.notesSent, 1);
  assert.equal(byKey(out, "google:sd")?.notesSent, 0, "credited to a superday that had not happened");
});

test("superday all-day + timed rounds on the same day: the evening's note is credited to the all-day entry too", () => {
  const rounds = [9, 11, 14].map((h, i) =>
    gInterview({ sourceKey: `google:r${i}`, title: "Evercore Superday", startsAt: ny(22, h), endsAt: ny(22, h + 1) }),
  );
  const out = run([allDaySuperday(), ...rounds], { thanked: [stray(1, ny(22, 20))] });
  for (const k of ["google:sd", "google:r0", "google:r1", "google:r2"]) {
    assert.equal(byKey(out, k)?.notesSent, 1, `${k} not credited`);
  }
});

test("superday timed: four rounds, one interviewer each, four named notes close all four", () => {
  const rounds = PANEL4.map((a, i) =>
    gInterview({ sourceKey: `google:r${i}`, title: "Evercore Superday", startsAt: ny(22, 9 + i), endsAt: ny(22, 10 + i), attendees: [a] }),
  );
  const notes = PANEL4.map((a, i) => noteTo(a, ny(22, 19, i * 5)));
  assert.deepEqual(run(rounds, { thanked: notes }), []);
});

test("superday timed: after two named notes, the other two rounds are owed with nothing sent", () => {
  const rounds = PANEL4.map((a, i) =>
    gInterview({ sourceKey: `google:r${i}`, title: "Evercore Superday", startsAt: ny(22, 9 + i), endsAt: ny(22, 10 + i), attendees: [a] }),
  );
  const out = run(rounds, { thanked: [noteTo(PANEL4[0], ny(22, 19), true), noteTo(PANEL4[2], ny(22, 19, 5), true)] });
  assert.deepEqual(keys(out), [thankYouKey("google:r1"), thankYouKey("google:r3")]);
  for (const p of out) {
    assert.equal(p.notesSent, 0, "a note matched to a person must not also be time-credited");
    assert.equal(thankYouProgress(p), null);
  }
});

test("superday timed: four rounds, one interviewer each, one stray note closes only the last", () => {
  const rounds = PANEL4.map((a, i) =>
    gInterview({ sourceKey: `google:r${i}`, title: "Evercore Superday", startsAt: ny(22, 9 + i), endsAt: ny(22, 10 + i), attendees: [a] }),
  );
  // One note to an address no invitation shows must not close four rounds.
  assert.deepEqual(keys(run(rounds, { thanked: [stray(1, ny(22, 19))] })), ["google:r0", "google:r1", "google:r2"].map(thankYouKey));
});

test("superday timed: four unlisted rounds, four stray notes - each says 4 notes sent and stays owed", () => {
  const rounds = [9, 10, 11, 13].map((h, i) =>
    gInterview({ sourceKey: `google:r${i}`, title: "Evercore Superday", startsAt: ny(22, h), endsAt: ny(22, h + 1) }),
  );
  const out = run(rounds, { thanked: [1, 2, 3, 4].map((n) => stray(n, ny(22, 19, n))) });
  assert.equal(out.length, 4);
  for (const p of out) assert.equal(thankYouProgress(p), "4 notes sent");
});

test("superday multi-day: all-day 22-23 is due 18:00 on the 23rd, not the 22nd", () => {
  const e = allDaySuperday({ endsAt: dateOnly(24), attendees: [A_PAT] });
  assert.equal(run([e], { now: ny(22, 20) }).length, 0);
  assert.equal(run([e], { now: ny(23, 17, 59) }).length, 0);
  assert.equal(run([e], { now: ny(23, 18) }).length, 1);
});

test("superday multi-day: a note on the evening of day two is credited to it", () => {
  const e = allDaySuperday({ endsAt: dateOnly(24) });
  const [p] = run([e], { now: ny(23, 19), thanked: [stray(1, ny(23, 18, 30))] });
  assert.equal(p.notesSent, 1);
});

test("superday multi-day: owed for 14 days from its last day, then dropped", () => {
  const e = allDaySuperday({ endsAt: dateOnly(24) });
  const due = ny(23, 18).getTime();
  assert.equal(run([e], { now: new Date(due + 14 * DAY) }).length, 1);
  assert.equal(run([e], { now: new Date(due + 14 * DAY + 1) }).length, 0);
});

test("superday: 'Assessment centre' opens the superday thank-you", () => {
  const [p] = run([gInterview({ title: "Barclays assessment centre", attendees: [A_PAT] })]);
  assert.equal(p.href, hrefFor(p.key, "thanks.superday", null));
});

// ---------------------------------------------------------------------------
// 7. Partial state: the progress line in every state
// ---------------------------------------------------------------------------

for (let n = 1; n <= 5; n++) {
  for (let named = 0; named < n; named++) {
    for (let strays = 0; named + strays < n; strays++) {
      test(`progress: panel of ${n}, ${named} thanked by name + ${strays} stray`, () => {
        const panel = [A_PAT, A_JO, A_ROB, A_DANA, A_SAM].slice(0, n);
        const thanked = [
          ...panel.slice(0, named).map((a, i) => noteTo(a, ny(22, 17, i))),
          ...Array.from({ length: strays }, (_, i) => stray(i, ny(22, 18, i))),
        ];
        const [p] = run([gInterview({ attendees: panel })], { thanked });
        assert.ok(p, "closed too early");
        assert.equal(p.notesSent, named + strays);
        assert.equal(thankYouProgress(p), named + strays === 0 ? null : `${named + strays} of ${n} thanked`);
        assert.equal(p.next.email, panel[named].email.toLowerCase());
      });
    }
  }
  test(`progress: panel of ${n}, strays that make up the rest close it`, () => {
    const panel = [A_PAT, A_JO, A_ROB, A_DANA, A_SAM].slice(0, n);
    const thanked = [noteTo(panel[0], ny(22, 17)), ...Array.from({ length: n - 1 }, (_, i) => stray(i, ny(22, 18, i)))];
    assert.deepEqual(run([gInterview({ attendees: panel })], { thanked }), []);
  });
}

for (const count of [0, 1, 2, 3, 7]) {
  test(`progress: no list, ${count} note(s) - ${count === 0 ? "null" : "N notes sent"}, still owed`, () => {
    const thanked = Array.from({ length: count }, (_, i) => stray(i, ny(22, 18, i)));
    const [p] = run([oInterview()], { thanked });
    assert.ok(p, "an empty list must never close by notes");
    assert.equal(p.notesSent, count);
    assert.equal(thankYouProgress(p), count === 0 ? null : `${count} note${count === 1 ? "" : "s"} sent`);
    assert.deepEqual(p.next, { contactId: null, name: null, email: null, firm: "Evercore" });
    assert.equal(p.href, hrefFor(p.key, "thanks.interview", null));
    assert.equal(thankYouTitle(p), "Thank your interviewers");
  });
}

test("progress: no list, 'That's everyone' closes it", () => {
  const e = oInterview();
  assert.deepEqual(run([e], { thanked: [stray(1, ny(22, 18))], done: new Set([thankYouKey(e.sourceKey)]) }), []);
});

test("progress: no list, plain notes to strangers are not notes for it", () => {
  const [p] = run([oInterview()], { thanked: [{ contactId: "c-x", at: ny(22, 18), email: "x@y.com" }] });
  assert.equal(p.notesSent, 0);
});

test("progress (unit): thanked count beats a lower note count", () => {
  const ivs: Interviewer[] = [
    { email: "a@x.com", name: null, contactId: null, thanked: true },
    { email: "b@x.com", name: null, contactId: null, thanked: true },
    { email: "c@x.com", name: null, contactId: null, thanked: false },
  ];
  assert.equal(thankYouProgress({ occasion: "interview", interviewers: ivs, notesSent: 1 }), "2 of 3 thanked");
});

test("progress (unit): capped at the list size", () => {
  const ivs: Interviewer[] = [{ email: "a@x.com", name: null, contactId: null, thanked: false }];
  assert.equal(thankYouProgress({ occasion: "interview", interviewers: ivs, notesSent: 4 }), "1 of 1 thanked");
});

test("progress (unit): a chat has none", () => {
  assert.equal(thankYouProgress({ occasion: "chat", interviewers: [], notesSent: 3 }), null);
});

// ---------------------------------------------------------------------------
// 8. Ticked interviews still absorb notes
// ---------------------------------------------------------------------------

test("ticked: a stray note after today's ticked round does not spill into yesterday's", () => {
  const yesterday = oInterview({ sourceKey: "offerly:y", title: "Lazard first round", startsAt: ny(21, 10), endsAt: ny(21, 11) });
  const today = oInterview({ sourceKey: "offerly:t", title: "Evercore first round", startsAt: ny(22, 10), endsAt: ny(22, 11) });
  const out = run([yesterday, today], { done: new Set([thankYouKey("offerly:t")]), thanked: [stray(1, ny(22, 18))] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:y"), 0]]);
});

test("ticked: the same with listed rounds - yesterday's one-person round stays owed", () => {
  const yesterday = gInterview({ sourceKey: "google:y", title: "Lazard first round interview", startsAt: ny(21, 10), endsAt: ny(21, 11), attendees: [A_ROB] });
  const today = gInterview({ sourceKey: "google:t", startsAt: ny(22, 10), endsAt: ny(22, 11), attendees: [A_PAT] });
  const out = run([yesterday, today], { done: new Set([thankYouKey("google:t")]), thanked: [stray(1, ny(22, 18))] });
  assert.deepEqual(keys(out), [thankYouKey("google:y")]);
});

test("ticked: a note to the ticked round's interviewer is not time-credited to a same-day unlisted round", () => {
  const morning = gInterview({ sourceKey: "google:am", startsAt: ny(22, 9), endsAt: ny(22, 10), attendees: [A_PAT] });
  const afternoon = oInterview({ sourceKey: "offerly:pm", title: "Lazard first round", startsAt: ny(22, 14), endsAt: ny(22, 15) });
  const out = run([morning, afternoon], { done: new Set([thankYouKey("google:am")]), thanked: [noteTo(A_PAT, ny(22, 18), true)] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:pm"), 0]]);
});

test("ticked: a ticked round not yet due still takes today's note", () => {
  const old = oInterview({ sourceKey: "offerly:old", startsAt: ny(15, 10), endsAt: ny(15, 11) });
  const now = oInterview({ sourceKey: "offerly:now", startsAt: ny(23, 9), endsAt: ny(23, 10) });
  const out = run([old, now], { now: ny(23, 11), done: new Set([thankYouKey("offerly:now")]), thanked: [stray(1, ny(23, 10, 30))] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:old"), 0]]);
});

test("ticked: a round beyond the 14-day lookback still takes a note sent right after it", () => {
  const ancient = oInterview({ sourceKey: "offerly:anc", startsAt: ny(1, 10), endsAt: ny(1, 11) });
  const recent = oInterview({ sourceKey: "offerly:rec", startsAt: ny(21, 10), endsAt: ny(21, 11) });
  const out = run([ancient, recent], { thanked: [stray(1, ny(1, 18))] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:rec"), 0]]);
});

// ---------------------------------------------------------------------------
// 9. Interviews and chats with the same person on the same day
// ---------------------------------------------------------------------------

const SAM_CHAT = () => chat({ sourceKey: "google:samchat", title: "Coffee chat with Sam Ito", startsAt: ny(22, 8), endsAt: ny(22, 8, 30) });
const SAM_INTERVIEW = () => gInterview({ sourceKey: "google:samiv", startsAt: ny(22, 14), endsAt: ny(22, 15), attendees: [A_SAM] });

test("chat+interview: before anything is sent, both are owed", () => {
  const out = run([SAM_CHAT(), SAM_INTERVIEW()]);
  assert.deepEqual(out.map((p) => p.occasion).sort(), ["chat", "interview"]);
});

test("chat+interview: a note to Sam between them closes the chat only", () => {
  const out = run([SAM_CHAT(), SAM_INTERVIEW()], { thanked: [{ contactId: SAM.id, at: ny(22, 11) }] });
  assert.deepEqual(keys(out), [thankYouKey("google:samiv")]);
  assert.equal(out[0].interviewers[0].thanked, false);
  assert.equal(out[0].notesSent, 0);
});

test("chat+interview: an interview-template note to Sam between them counts for neither interview", () => {
  const out = run([SAM_CHAT(), SAM_INTERVIEW()], { thanked: [{ contactId: SAM.id, at: ny(22, 11), interview: true }] });
  assert.equal(byKey(out, "google:samiv")?.notesSent, 0);
});

test("chat+interview: a note to Sam after both closes both", () => {
  assert.deepEqual(run([SAM_CHAT(), SAM_INTERVIEW()], { thanked: [{ contactId: SAM.id, at: ny(22, 19), interview: true }] }), []);
});

test("chat+interview: an interview note to Sam is matched to Sam, not time-credited to another round that day", () => {
  const other = oInterview({ sourceKey: "offerly:lz", title: "Lazard first round", startsAt: ny(22, 16), endsAt: ny(22, 17) });
  const out = run([SAM_CHAT(), SAM_INTERVIEW(), other], { thanked: [{ contactId: SAM.id, at: ny(22, 19), interview: true }] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:lz"), 0]]);
});

test("chat+interview: interview first, chat later - a note in between thanks the interview, the chat stays owed", () => {
  const iv = gInterview({ sourceKey: "google:danaiv", startsAt: ny(22, 9), endsAt: ny(22, 10), attendees: [A_DANA] });
  const c = chat({ sourceKey: "google:danachat", title: "Coffee chat with Dana Reed", startsAt: ny(22, 15), endsAt: ny(22, 15, 30) });
  const out = run([iv, c], { thanked: [{ contactId: DANA.id, at: ny(22, 12), interview: true }] });
  assert.deepEqual(out.map((p) => [p.key, p.occasion]), [[thankYouKey("google:danachat"), "chat"]]);
});

test("chat+interview: an interview-template note never closes a chat with nobody named", () => {
  const c = chat({ sourceKey: "google:anon", title: "Virtual coffee", attendeeEmails: [], attendees: [] });
  const out = run([c], { thanked: [stray(1, ny(22, 19))] });
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// 10. Box, classification and title
// ---------------------------------------------------------------------------

const BOXES: [string, string][] = [
  ["Evercore Superday", "thanks.superday"],
  ["Lazard super-day", "thanks.superday"],
  ["Barclays Assessment Centre", "thanks.superday"],
  ["Citi assessment center", "thanks.superday"],
  ["Assessment day - HSBC", "thanks.superday"],
  ["Phone screen - Moelis", "thanks.screen"],
  ["HR screen", "thanks.screen"],
  ["Recruiter screening", "thanks.screen"],
  ["Recruiting screen - PJT", "thanks.screen"],
  ["Initial screen", "thanks.screen"],
  ["Screening call - Guggenheim", "thanks.screen"],
  ["Recruiter call - Houlihan", "thanks.screen"],
  ["Goldman first round interview", "thanks.interview"],
  ["Final round, Centerview", "thanks.interview"],
  ["Video screen - Jefferies", "thanks.interview"],
  ["Case study interview", "thanks.interview"],
];
for (const [title, box] of BOXES) {
  test(`box: "${title}" -> ${box}`, () => {
    assert.equal(interviewThankBox(title), box);
    // ...and the prompt's href carries it (filed as an interview, so it is one).
    const [p] = run([oInterview({ title })]);
    assert.equal(p.href, hrefFor(p.key, box, null));
  });
}

const IS_INTERVIEW: [string, Partial<ChatEvent>, boolean][] = [
  ["Goldman first round interview", {}, true],
  ["Evercore superday", {}, true],
  ["Goldman", { type: "interview" }, true],
  ["Goldman Sachs", { notes: "Your second round interview" }, true],
  ["HireVue - JPMorgan", {}, false],
  ["HireVue", { type: "interview" }, false],
  ["Recorded video interview - Citi", {}, false],
  ["Online test - Barclays", {}, false],
  ["Goldman interview deadline", {}, false],
  ["Mock interview", {}, false],
  ["Interview prep with Dana", {}, false],
  ["Coffee chat", {}, false],
  ["Coffee chat re: interview process", {}, false],
  ["Evercore superday", { declined: true }, false],
  ["Evercore superday", { eventType: "outOfOffice" }, false],
  ["Interview", { type: "coffee_chat" }, false],
  ["Sync", { type: "meeting", notes: "interview" }, false],
];
for (const [title, over, want] of IS_INTERVIEW) {
  test(`classify: "${title}" ${JSON.stringify(over)} is ${want ? "" : "not "}an interview`, () => {
    assert.equal(isInterviewEvent(gInterview({ title, ...over })), want);
  });
}

test("title (unit): contact and one interviewer -> Thank <name>", () => {
  assert.equal(thankYouTitle({ occasion: "interview", contact: DANA, interviewers: [{ email: null, name: "Dana Reed", contactId: DANA.id, thanked: false }] }), "Thank Dana Reed");
});
test("title (unit): contact and no interviewers -> Thank <name>", () => {
  assert.equal(thankYouTitle({ occasion: "interview", contact: DANA, interviewers: [] }), "Thank Dana Reed");
});
test("title (unit): contact and two interviewers -> Thank your interviewers", () => {
  const x = { email: null, name: null, contactId: null, thanked: false };
  assert.equal(thankYouTitle({ occasion: "interview", contact: DANA, interviewers: [x, x] }), "Thank your interviewers");
});
test("title (unit): no contact, one unsaved interviewer -> Thank your interviewers", () => {
  assert.equal(thankYouTitle({ occasion: "interview", contact: null, interviewers: [{ email: "p@x.com", name: "Pat", contactId: null, thanked: false }] }), "Thank your interviewers");
});

test("closing: 'done' closes a listed interview with nobody thanked", () => {
  const e = gInterview({ attendees: [A_PAT, A_JO] });
  assert.deepEqual(run([e], { done: new Set([thankYouKey(e.sourceKey)]) }), []);
});

test("closing: a declined interview is never owed and never absorbs notes", () => {
  const declined = gInterview({ sourceKey: "google:dec", startsAt: ny(22, 14), endsAt: ny(22, 15), declined: true, attendees: [A_PAT] });
  const earlier = oInterview({ sourceKey: "offerly:am", startsAt: ny(22, 9), endsAt: ny(22, 10) });
  const out = run([declined, earlier], { thanked: [stray(1, ny(22, 19))] });
  assert.deepEqual(out.map((p) => [p.key, p.notesSent]), [[thankYouKey("offerly:am"), 1]]);
});

// ---------------------------------------------------------------------------
// 11. Seeded fuzz
// ---------------------------------------------------------------------------

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

const FUZZ_POOL: Att[] = [
  A_DANA,
  A_PAT,
  A_JO,
  A_SAM,
  A_ROB,
  { email: "kim@lazard.com", name: "K. Olsen" },
  { email: "PAT@EVERCORE.COM", name: "Pat" },
  { email: "zoe@gs.com", name: null },
];
const FUZZ_TITLES = [
  "Evercore first round interview",
  "Goldman Sachs Superday",
  "Lazard phone screen",
  "Moelis final round",
  "Interview with Dana Reed",
  "Evercore ISI superday - Kim Olsen",
  "Assessment centre",
];
const FUZZ_RUNS = 250;

function emailOfSend(t: Send, contacts: ThankContact[]) {
  return (t.email ?? contacts.find((c) => c.id === t.contactId)?.email ?? null)?.trim().toLowerCase() ?? null;
}

test(`fuzz: ${FUZZ_RUNS} scenarios keep the interview invariants`, () => {
  let checked = 0;
  let sawInterview = 0;
  for (let seed = 1; seed <= FUZZ_RUNS; seed++) {
    const r = mulberry32(seed * 7919);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const events: ChatEvent[] = [];
    const nEvents = 1 + Math.floor(r() * 6);
    for (let i = 0; i < nEvents; i++) {
      const day = 12 + Math.floor(r() * 12);
      const hour = 8 + Math.floor(r() * 10);
      const kind = r();
      if (kind < 0.55) {
        const size = Math.floor(r() * 6);
        const attendees = Array.from({ length: size }, () => pick(FUZZ_POOL));
        events.push(
          gInterview({
            sourceKey: `google:f${i}`,
            title: pick(FUZZ_TITLES),
            startsAt: ny(day, hour, pick([0, 15, 30])),
            endsAt: r() < 0.2 ? null : ny(day, hour + 1),
            contactId: r() < 0.2 ? pick(CONTACTS).id : null,
            attendees,
          }),
        );
      } else if (kind < 0.7) {
        events.push(
          allDaySuperday({ sourceKey: `google:f${i}`, startsAt: dateOnly(day), endsAt: dateOnly(day + (r() < 0.3 ? 2 : 1)), attendees: r() < 0.5 ? [pick(FUZZ_POOL), pick(FUZZ_POOL)] : [] }),
        );
      } else if (kind < 0.85) {
        events.push(oInterview({ sourceKey: `offerly:f${i}`, title: pick(FUZZ_TITLES), startsAt: ny(day, hour), endsAt: ny(day, hour + 1), contactId: r() < 0.5 ? pick(CONTACTS).id : null }));
      } else {
        events.push(chat({ sourceKey: `google:f${i}`, title: pick(["Coffee chat with Sam Ito", "Coffee chat with Dana Reed", "Virtual coffee"]), startsAt: ny(day, hour), endsAt: ny(day, hour, 30) }));
      }
    }
    const mkSend = (): Send => {
      const at = new Date(ny(12, 0).getTime() + Math.floor(r() * 12 * DAY));
      const roll = r();
      const interview = r() < 0.5;
      if (roll < 0.35) return { contactId: pick(CONTACTS).id, at, interview };
      if (roll < 0.75) {
        const a = pick(FUZZ_POOL);
        const email = r() < 0.5 ? a.email.toUpperCase() : ` ${a.email} `;
        return { contactId: "c-out", at, interview, email };
      }
      return { contactId: `c-rand-${Math.floor(r() * 3)}`, at, interview, email: r() < 0.5 ? "nobody@x.com" : null };
    };
    const thanked = Array.from({ length: Math.floor(r() * 7) }, mkSend);
    const extra = Array.from({ length: 1 + Math.floor(r() * 3) }, mkSend);
    const done = new Set(events.filter(() => r() < 0.15).map((e) => thankYouKey(e.sourceKey)));
    const now = new Date(ny(23, 12).getTime() + Math.floor(r() * 2 * DAY));
    const input: Input = { events, contacts: CONTACTS, done, thanked, firms: FIRMS, now, timeZone: TZ };
    const out = selectThankYous(input);
    const ctx = `seed ${seed}`;

    for (const p of out) {
      assertNoLeak(p);
      assert.ok(p.href.startsWith("/outreach?"), `${ctx}: href ${p.href}`);
      if (p.occasion !== "interview") continue;
      sawInterview++;
      const n = p.interviewers.length;
      if (n > 0) {
        assert.ok(!p.interviewers.every((x) => x.thanked), `${ctx}: ${p.key} returned with everyone thanked`);
        assert.ok(p.notesSent < n, `${ctx}: ${p.key} returned with ${p.notesSent} notes for ${n} people`);
      }
      // No person listed twice (by address, or by contact).
      const emails = p.interviewers.map((x) => x.email).filter(Boolean);
      assert.equal(new Set(emails).size, emails.length, `${ctx}: ${p.key} lists an address twice`);
      const ids = p.interviewers.map((x) => x.contactId).filter(Boolean);
      assert.equal(new Set(ids).size, ids.length, `${ctx}: ${p.key} lists a contact twice`);
      // Thanked flags agree with the rule.
      for (const x of p.interviewers) {
        const want = thanked.some(
          (t) =>
            t.at.getTime() >= p.startsAt.getTime() &&
            ((x.contactId && x.contactId === t.contactId) || (x.email && emailOfSend(t, CONTACTS) === x.email)),
        );
        // One way only: a note is credited to the latest round that person
        // was on, so a note to them can leave an older round unthanked.
        if (x.thanked) assert.ok(want, `${ctx}: ${p.key} ${x.email ?? x.contactId} thanked flag`);
      }
      // Next is the first unthanked; the href follows it.
      const who = p.interviewers.find((x) => !x.thanked) ?? null;
      assert.equal(p.next.contactId, who?.contactId ?? null, `${ctx}: next`);
      assert.equal(p.next.email, who?.email ?? null, `${ctx}: next email`);
      if (p.next.contactId) assert.ok(p.href.includes(`contact=${p.next.contactId}&`), `${ctx}: href ${p.href}`);
      else assert.ok(p.href.endsWith(`&thank=${encodeURIComponent(p.key)}`), `${ctx}: href ${p.href}`);
      // Progress follows the formula.
      const x = Math.min(n, Math.max(p.interviewers.filter((i) => i.thanked).length, p.notesSent));
      const want = p.notesSent === 0 ? null : n > 0 ? `${x} of ${n} thanked` : `${p.notesSent} note${p.notesSent === 1 ? "" : "s"} sent`;
      assert.equal(thankYouProgress(p), want, `${ctx}: progress`);
    }

    // Adding sends: owed keys only shrink, notesSent never drops, nobody is un-thanked.
    const more = selectThankYous({ ...input, thanked: [...thanked, ...extra] });
    const before = new Map(out.map((p) => [p.key, p]));
    for (const q of more) {
      const p = before.get(q.key);
      assert.ok(p, `${ctx}: adding sends added ${q.key}`);
      assert.ok(q.notesSent >= p!.notesSent, `${ctx}: ${q.key} notesSent fell ${p!.notesSent} -> ${q.notesSent}`);
      q.interviewers.forEach((x, i) => assert.ok(x.thanked || !p!.interviewers[i].thanked, `${ctx}: ${q.key} un-thanked someone`));
    }
    // ...and sends in a different order give the same answer.
    const reversed = selectThankYous({ ...input, thanked: [...thanked].reverse() });
    assert.deepEqual(
      reversed.map((p) => [p.key, p.notesSent]),
      out.map((p) => [p.key, p.notesSent]),
      `${ctx}: send order changed the result`,
    );
    checked++;
  }
  assert.equal(checked, FUZZ_RUNS);
  assert.ok(sawInterview > FUZZ_RUNS / 2, `fuzz reached too few interviews (${sawInterview})`);
});
