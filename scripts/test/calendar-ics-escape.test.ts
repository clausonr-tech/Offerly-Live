/**
 * Nobody else's text can add a property to a student's calendar export.
 *
 * The .ics writer joins its content lines with CRLF and used to escape LF
 * alone, so a bare carriage return in an event's title or notes read to a
 * tolerant importer as the end of the line - and whatever the author had put
 * after it as a new property (URL:, ATTENDEE:, a whole VALARM). The text is
 * not always the student's: a firm's event title and location are copied into
 * their calendar when they add a recruiting event.
 *
 *   npx tsx --test scripts/test/calendar-ics-escape.test.ts
 *
 * Pure: no database, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { buildICS } from "@/lib/calendar";

const WHEN = new Date("2026-10-20T13:00:00Z");

function ics(title: string, notes: string | null = null) {
  return buildICS([{ id: "11111111-1111-4111-8111-111111111111", title, notes, eventDate: WHEN }]);
}

/** Every content line of the file, as an importer that honours CR, LF or CRLF
 *  as a break would read them. */
function linesAnyBreak(out: string): string[] {
  return out.split(/\r\n|\r|\n/);
}

/** The names at the start of each content line ("SUMMARY", "URL", ...). */
function propertyNames(out: string): string[] {
  return linesAnyBreak(out)
    .map((l) => /^([A-Za-z-]+)[:;]/.exec(l)?.[1]?.toUpperCase())
    .filter((n): n is string => Boolean(n));
}

const EXPECTED = ["BEGIN", "VERSION", "PRODID", "CALSCALE", "BEGIN", "UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "END", "END"];

test("a carriage return in the title cannot start a new property line", () => {
  const out = ics("Evercore info session\rURL:https://not-offerly.invalid/payload");
  assert.equal(out.includes("\r\nURL:"), false, "no injected property on its own line");
  assert.deepEqual(propertyNames(out), EXPECTED, "only the properties buildICS writes");
  // Read with CR as a break too - which is the whole point of the finding.
  assert.equal(
    linesAnyBreak(out).some((l) => l.startsWith("URL:")),
    false,
    "and not even to an importer that breaks on a bare CR",
  );
  // The words are still there, folded as ICS means a line break.
  assert.match(out, /^SUMMARY:Evercore info session\\nURL:https:\/\/not-offerly\.invalid\/payload$/m);
});

test("a carriage return in the notes cannot start a new property line", () => {
  const out = ics("Coffee chat", "Soho\rBEGIN:VALARM\rACTION:DISPLAY\rEND:VALARM");
  assert.deepEqual(propertyNames(out), [...EXPECTED.slice(0, 10), "DESCRIPTION", "END", "END"]);
  assert.equal(linesAnyBreak(out).filter((l) => l === "BEGIN:VALARM").length, 0);
});

test("CRLF and LF both fold to the escape ICS means by a line break", () => {
  assert.match(ics("One\r\nTwo"), /^SUMMARY:One\\nTwo$/m);
  assert.match(ics("One\nTwo"), /^SUMMARY:One\\nTwo$/m);
  assert.match(ics("One Two"), /^SUMMARY:One\\nTwo$/m);
});

test("other C0 controls are dropped rather than written raw", () => {
  const out = ics("Super\u0000day\u0007 at 9\u001f", "Floor\u000b12");
  assert.match(out, /^SUMMARY:Superday at 9$/m);
  assert.match(out, /^DESCRIPTION:Floor12$/m);
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out), false);
});

test("a tab is ordinary text and survives", () => {
  assert.match(ics("Round\t2"), /^SUMMARY:Round\t2$/m);
});

test("the escapes that were already right still are", () => {
  const out = ics("Lazard, Freres & Co.; 30 Rockefeller \\ Plaza");
  assert.match(out, /^SUMMARY:Lazard\\, Freres & Co\.\\; 30 Rockefeller \\\\ Plaza$/m);
});

test("an ordinary event is unchanged, and the file is still CRLF-delimited", () => {
  const out = ics("Evercore info session", "Zoom link in the invite");
  assert.equal(out.split("\r\n").length, 13);
  assert.equal(out.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"), true);
  assert.equal(out.endsWith("\r\nEND:VEVENT\r\nEND:VCALENDAR"), true);
  assert.match(out, /^SUMMARY:Evercore info session$/m);
  assert.match(out, /^DESCRIPTION:Zoom link in the invite$/m);
});
