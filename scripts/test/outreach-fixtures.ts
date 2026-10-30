// Shared fixtures for the outreach-prompt suites.
//
// Three files test this feature - selection, timing, and firm matching - and
// all three need the same two rows: an application that opens, and someone at
// that firm. Keeping the builders here means a change to either shape breaks
// all three loudly at once rather than leaving two of them quietly testing a
// shape the product no longer has.

import { selectOutreachNudges } from "../../src/lib/application-outreach";

export const DAY = 86_400_000;

/** A Wednesday at midday UTC, far from a month end, DST change or year end, so
 *  no test here is accidentally about a calendar edge it did not mean. */
export const NOW = new Date("2026-09-22T12:00:00Z");

export type Application = Parameters<typeof selectOutreachNudges>[0]["applications"][number];
export type ContactRow = Parameters<typeof selectOutreachNudges>[0]["contactRows"][number];

export function daysOut(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() + days * DAY);
}

export function opening(over: Partial<Application> = {}): Application {
  return {
    firmName: "Evercore",
    firmSlug: "evercore",
    firmWebsite: "evercore.com",
    cycleLabel: "Summer 2028",
    date: daysOut(14),
    kind: "opens",
    provenance: "posting",
    ...over,
  };
}

export function person(over: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "c1",
    name: "Dana Reed",
    firm: "Evercore",
    role: "Analyst",
    email: "dana.reed@evercore.com",
    relationshipStatus: "not_contacted",
    ...over,
  };
}

/** The common shape of a case: one opening, one contact, one question. */
export function nudgesFor(
  applications: Application[],
  contactRows: ContactRow[],
  now: Date = NOW,
) {
  return selectOutreachNudges({ applications, contactRows, now });
}
