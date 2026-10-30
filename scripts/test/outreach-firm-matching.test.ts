// Joining "the firm on this posting" to "the firm typed on this contact".
//
// The join is the whole feature: a student typed "GS" into a contact three
// months ago and the posting says "Goldman Sachs", and if those two do not meet
// the prompt is silent in exactly the case it was built for. The reverse is
// worse - two different banks collapsing onto one key would tell a student to
// write to people at the wrong firm.
//
// Also here: which of their contacts the row offers, and in what order. A real
// account has the same person imported twice and half the list with no address
// yet (both visible in any screenshot of the contacts table), and a banner with
// three slots has to spend them well.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  daysOut,
  nudgesFor,
  opening,
  person,
  type ContactRow,
} from "./outreach-fixtures";

/** Does a contact whose firm is written `typed` hear about a posting at `posted`? */
function matches(posted: string, typed: string): boolean {
  return nudgesFor([opening({ firmName: posted })], [person({ firm: typed })]).length === 1;
}

// ---------- the same firm, written differently ----------

const SAME_FIRM: [string, string][] = [
  ["Goldman Sachs", "Goldman Sachs"],
  ["Goldman Sachs", "goldman sachs"],
  ["Goldman Sachs", "GOLDMAN SACHS"],
  ["Goldman Sachs", "  Goldman Sachs  "],
  ["Goldman Sachs", "Goldman Sachs & Co."],
  ["Goldman Sachs", "Goldman Sachs Group"],
  ["Goldman Sachs", "The Goldman Sachs Group"],
  ["Goldman Sachs", "GS"],
  ["Goldman Sachs", "Goldman, Sachs"],
  ["Goldman Sachs", "Goldman Sachs Inc"],
  ["Goldman Sachs", "Goldman Sachs LLC"],
  ["JPMorgan", "JPM"],
  ["JPMorgan", "JP Morgan"],
  ["JPMorgan", "J.P. Morgan"],
  ["JPMorgan", "JP Morgan Chase"],
  ["Morgan Stanley", "MS"],
  ["Morgan Stanley", "Morgan Stanley & Co. LLC"],
  ["Bank of America", "BofA"],
  ["Bank of America", "BAML"],
  ["Bank of America", "Merrill Lynch"],
  ["Bank of America", "Bank of America Merrill Lynch"],
  ["Blackstone", "The Blackstone Group"],
  ["Blackstone", "Blackstone Inc."],
  ["Evercore", "Evercore Partners"],
  ["Evercore", "Evercore Inc."],
  ["KKR", "KKR & Co."],
  ["KKR", "KKR & Co. Inc."],
  ["McKinsey and Company", "McKinsey & Company"],
  ["McKinsey and Company", "Mck"],
  ["Boston Consulting", "BCG"],
  ["Boston Consulting", "Boston Consulting Group"],
  ["Bain and Company", "Bain & Company"],
  ["PJT Partners", "PJT"],
  ["Deutsche Bank", "DB"],
  ["Lazard", "Lazard Ltd"],
  ["Moelis", "Moelis & Company"],
  ["Centerview Partners", "centerview partners llp"],
  ["Jefferies", "Jefferies LLC"],
  ["Houlihan Lokey", "Houlihan Lokey, Inc."],
];

for (const [posted, typed] of SAME_FIRM) {
  test(`a contact at "${typed}" hears about a posting at "${posted}"`, () => {
    assert.ok(matches(posted, typed));
  });
}

test("it works in the other direction too", () => {
  // The posting is the messy side as often as the contact is.
  assert.ok(matches("The Goldman Sachs Group, Inc.", "Goldman Sachs"));
  assert.ok(matches("KKR & Co. Inc.", "KKR"));
});

// ---------- different firms stay different ----------

const DIFFERENT_FIRMS: [string, string][] = [
  ["Bain Capital", "Bain & Company"],
  ["Morgan Stanley", "JPMorgan"],
  ["Goldman Sachs", "Goldman Sachs Asset Management Korea"],
  ["Evercore", "Evercore Wealth Management"],
  ["Blackstone", "BlackRock"],
  ["Lazard", "Lazard Asset Management"],
  ["Citi", "Citadel"],
  ["Barclays", "Barclay Damon"],
];

for (const [posted, typed] of DIFFERENT_FIRMS) {
  test(`"${typed}" is not "${posted}"`, () => {
    assert.ok(!matches(posted, typed));
  });
}

test("a firm name that normalises to nothing matches nothing", () => {
  assert.deepEqual(nudgesFor([opening({ firmName: "Inc." })], [person({ firm: "LLC" })]), []);
});

test("one contact at each of two similarly named firms stays on its own row", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Bain Capital" }), opening({ firmName: "Bain & Company" })],
    [
      person({ id: "a", firm: "Bain Capital" }),
      person({ id: "b", name: "Sam Ito", firm: "Bain & Company" }),
    ],
  );
  assert.equal(nudges.length, 2);
  for (const n of nudges) assert.equal(n.contacts.length, 1);
});

test("contacts written two ways at one firm land on the same row", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs" })],
    [
      person({ id: "a", name: "Ada Vance", firm: "Goldman Sachs" }),
      person({ id: "b", name: "Sam Ito", firm: "GS" }),
      person({ id: "c", name: "Dana Reed", firm: "The Goldman Sachs Group" }),
    ],
  );
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].contacts.length, 3);
});

// ---------- the text the links filter their own table by ----------

test("the filter text is what the student typed, not what the posting says", () => {
  // The contacts table filters on a plain substring of their own typing, so
  // sending it the posting's wording would land them on an empty table.
  const nudges = nudgesFor(
    [opening({ firmName: "The Goldman Sachs Group, Inc." })],
    [person({ firm: "Goldman Sachs" })],
  );
  assert.equal(nudges[0].contactFirmQuery, "Goldman Sachs");
});

test("the shortest spelling wins, being the one contained in the others", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs" })],
    [
      person({ id: "a", firm: "Goldman Sachs & Co. LLC" }),
      person({ id: "b", name: "Sam Ito", firm: "Goldman Sachs" }),
      person({ id: "c", name: "Ada Vance", firm: "Goldman Sachs Group" }),
    ],
  );
  assert.equal(nudges[0].contactFirmQuery, "Goldman Sachs");
});

test("the filter text is trimmed, so it cannot start with whitespace", () => {
  const nudges = nudgesFor([opening()], [person({ firm: "   Evercore   " })]);
  assert.equal(nudges[0].contactFirmQuery, "Evercore");
});

test("the filter text actually matches every contact it is meant to find", () => {
  const rows = [
    person({ id: "a", firm: "Goldman Sachs & Co." }),
    person({ id: "b", name: "Sam Ito", firm: "Goldman Sachs" }),
  ];
  const nudges = nudgesFor([opening({ firmName: "Goldman Sachs" })], rows);
  const q = nudges[0].contactFirmQuery.toLowerCase();
  // The same test the contacts grid applies.
  for (const row of rows) {
    assert.ok(row.firm!.toLowerCase().includes(q), `${row.firm} would not survive the filter`);
  }
});

test("an abbreviation-only list still produces filter text that finds it", () => {
  const nudges = nudgesFor([opening({ firmName: "Goldman Sachs" })], [person({ firm: "GS" })]);
  assert.equal(nudges[0].contactFirmQuery, "GS");
});

test("the filter text is URL-encodable without loss", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "McKinsey and Company" })],
    [person({ firm: "McKinsey & Company" })],
  );
  assert.equal(decodeURIComponent(encodeURIComponent(nudges[0].contactFirmQuery)), "McKinsey & Company");
});

// ---------- who the row offers, and in what order ----------

test("the same person imported twice is offered once", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "a", name: "Tena Broyles", email: null }),
      person({ id: "b", name: "Tena Broyles", email: null }),
    ],
  );
  assert.equal(nudges[0].contacts.length, 1);
});

test("the copy kept is the one carrying an address", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "no-email", name: "Tena Broyles", email: null }),
      person({ id: "has-email", name: "Tena Broyles", email: "tena@evercore.com" }),
    ],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.id),
    ["has-email"],
  );
});

test("the copy kept is the one carrying an address, whichever order they arrive in", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "has-email", name: "Tena Broyles", email: "tena@evercore.com" }),
      person({ id: "no-email", name: "Tena Broyles", email: null }),
    ],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.id),
    ["has-email"],
  );
});

test("duplicates are matched regardless of case and padding", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "a", name: "Tena Broyles" }),
      person({ id: "b", name: "  tena broyles " }),
    ],
  );
  assert.equal(nudges[0].contacts.length, 1);
});

test("two genuinely different people are both offered", () => {
  const nudges = nudgesFor(
    [opening()],
    [person({ id: "a", name: "Tena Broyles" }), person({ id: "b", name: "Tena Broyle" })],
  );
  assert.equal(nudges[0].contacts.length, 2);
});

test("the same name at two different firms is two people", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Evercore" }), opening({ firmName: "Lazard" })],
    [
      person({ id: "a", name: "Tena Broyles", firm: "Evercore" }),
      person({ id: "b", name: "Tena Broyles", firm: "Lazard" }),
    ],
  );
  assert.equal(nudges.length, 2);
  for (const n of nudges) assert.equal(n.contacts.length, 1);
});

test("people we can write to tonight come first", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "no", name: "Ada Vance", email: null }),
      person({ id: "yes", name: "Zoe Park", email: "zoe@evercore.com" }),
    ],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.id),
    ["yes", "no"],
    "an address beats alphabetical order",
  );
});

test("within the same kind, names are alphabetical", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "c", name: "Zoe Park", email: "z@evercore.com" }),
      person({ id: "a", name: "Ada Vance", email: "a@evercore.com" }),
      person({ id: "b", name: "Sam Ito", email: "s@evercore.com" }),
    ],
  );
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.name),
    ["Ada Vance", "Sam Ito", "Zoe Park"],
  );
});

test("the order does not depend on the order the rows came out of the database", () => {
  const rows = [
    person({ id: "a", name: "Ada Vance", email: "a@evercore.com" }),
    person({ id: "b", name: "Sam Ito", email: null }),
    person({ id: "c", name: "Zoe Park", email: "z@evercore.com" }),
  ];
  const forwards = nudgesFor([opening()], rows)[0].contacts.map((c) => c.id);
  const backwards = nudgesFor([opening()], [...rows].reverse())[0].contacts.map((c) => c.id);
  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards, ["a", "c", "b"]);
});

const NOT_AN_ADDRESS = ["", "   ", "not-an-email", "dana@", "@evercore.com", "dana evercore.com"];
for (const value of NOT_AN_ADDRESS) {
  test(`${JSON.stringify(value)} does not count as having an address`, () => {
    const nudges = nudgesFor(
      [opening()],
      [
        person({ id: "junk", name: "Ada Vance", email: value }),
        person({ id: "real", name: "Zoe Park", email: "zoe@evercore.com" }),
      ],
    );
    assert.deepEqual(
      nudges[0].contacts.map((c) => c.id),
      ["real", "junk"],
    );
  });
}

test("a name is carried through exactly as it was entered", () => {
  const nudges = nudgesFor([opening()], [person({ name: "  Ada  Vance " })]);
  assert.equal(nudges[0].contacts[0].name, "  Ada  Vance ");
});

test("accented and non-latin names survive the round trip", () => {
  const nudges = nudgesFor(
    [opening()],
    [
      person({ id: "a", name: "Zoë Renée", email: "z@evercore.com" }),
      person({ id: "b", name: "李 明", email: "l@evercore.com" }),
    ],
  );
  assert.equal(nudges[0].contacts.length, 2);
  assert.ok(nudges[0].contacts.some((c) => c.name === "Zoë Renée"));
  assert.ok(nudges[0].contacts.some((c) => c.name === "李 明"));
});

test("two people whose names differ only by accent are both kept", () => {
  const nudges = nudgesFor(
    [opening()],
    [person({ id: "a", name: "Renee Diaz" }), person({ id: "b", name: "Renée Díaz" })],
  );
  assert.equal(nudges[0].contacts.length, 2);
});

// ---------- one real account, end to end ----------

/** The contacts table as a real early account looks: two firms, seventeen
 *  rows, one address between them, and the same person entered twice. */
function realAccount(): ContactRow[] {
  const goldman = [
    person({ id: "g1", name: "Jon Doe", email: null }),
    person({ id: "g2", name: "Alex Rivera", email: "clausonr@wharton.upenn.edu" }),
    person({ id: "g3", name: "Maxine Smith", email: null }),
    person({ id: "g4", name: "Mya Rajski", email: null }),
    person({ id: "g5", name: "Remi Rieger", email: null }),
    person({ id: "g6", name: "Tena Broyles", email: null }),
    person({ id: "g7", name: "Tena Broyles", email: null }),
  ].map((p) => ({ ...p, firm: "Goldman Sachs" }));
  const evercore = ["Ada Vance", "Sam Ito", "Zoe Park", "Ben Cole", "Iris Fox"].map((name, i) =>
    person({ id: `e${i}`, name, firm: "Evercore", email: null }),
  );
  return [...goldman, ...evercore];
}

test("a real account: only the firm with an opening is prompted about", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs", firmSlug: "goldman-sachs", date: daysOut(13) })],
    realAccount(),
  );
  assert.deepEqual(
    nudges.map((n) => n.firmName),
    ["Goldman Sachs"],
  );
});

test("a real account: the duplicate is collapsed, so six names not seven", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs", date: daysOut(13) })],
    realAccount(),
  );
  assert.equal(nudges[0].contacts.length, 6);
});

test("a real account: the one person with an address is offered first", () => {
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs", date: daysOut(13) })],
    realAccount(),
  );
  assert.equal(nudges[0].contacts[0].name, "Alex Rivera");
});

test("a real account: the count the prompt states is a count of people", () => {
  // Not of rows: the duplicate would make it six when it is five, and the
  // count is the only number either surface says out loud.
  const nudges = nudgesFor(
    [opening({ firmName: "Goldman Sachs", date: daysOut(13) })],
    realAccount(),
  );
  const names = nudges[0].contacts.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("a real account: ticking everyone off ends the prompt", () => {
  const rows = realAccount().map((r) => ({ ...r, relationshipStatus: "reached_out" }));
  assert.deepEqual(
    nudgesFor([opening({ firmName: "Goldman Sachs", date: daysOut(13) })], rows),
    [],
  );
});

test("a real account: writing to all but one keeps the prompt, naming that one", () => {
  const rows = realAccount().map((r) =>
    r.id === "g4" ? r : { ...r, relationshipStatus: "reached_out" },
  );
  const nudges = nudgesFor([opening({ firmName: "Goldman Sachs", date: daysOut(13) })], rows);
  assert.deepEqual(
    nudges[0].contacts.map((c) => c.name),
    ["Mya Rajski"],
  );
});

test("a real account: both firms opening means both prompts, soonest first", () => {
  const nudges = nudgesFor(
    [
      opening({ firmName: "Goldman Sachs", date: daysOut(13) }),
      opening({ firmName: "Evercore", date: daysOut(4) }),
    ],
    realAccount(),
  );
  assert.deepEqual(
    nudges.map((n) => n.firmName),
    ["Evercore", "Goldman Sachs"],
  );
  assert.equal(nudges[0].contacts.length, 5);
  assert.equal(nudges[1].contacts.length, 6);
});
