import assert from "node:assert/strict";
import { test } from "node:test";

import { format } from "date-fns";

import { bellRow, firmFromDetail, UNTITLED_JOB, type BellRowInput } from "../../src/lib/notification-row";
import { ordinal } from "../../src/lib/outreach-ladder";

// The bell's one-line row, run through every kind of job the app files.
//
// The copy below mirrors how each kind is written today - prompt-flash.ts
// (outreach, interview_prep, follow_up, thank_you) and nudge-actions.ts
// (thank_you ticked off the to-do list). Those builders are private and
// server-only, so the shapes are restated here; if one changes its wording,
// the matching generator below has to change with it.

type Kind = "outreach" | "interview_prep" | "follow_up" | "thank_you";
type Case = { kind: Kind; label: string; input: BellRowInput; firm: string | null };

const d = (day: number) => format(new Date(2026, 8, day), "d MMM");
// The plain rule, written independently of the implementation: runs of
// whitespace become one space. Joiners inside emoji and scripts are NOT
// whitespace and must come through untouched.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const NAMES = [
  "Jon Doe",
  "Priya Shah",
  "Alexandra Montgomery-Whitfield",
  "Zoë Ångström",
  "José Núñez",
  "李小龙",
  "محمد علي",
  "O'Brien",
  "Sam \u{1F469}\u200D\u{1F4BC} Lee", // a zero-width joiner holds the emoji together
  "Niloufar Mi\u200Ckhahad", // a zero-width non-joiner, as Persian spelling uses
  "Jean-Baptiste de la Rochefoucauld-Liancourt the Third, Esq.",
];

const FIRMS: (string | null)[] = [
  "Goldman Sachs",
  "J.P. Morgan",
  "Perella Weinberg Partners",
  "Centerview Partners",
  "Évercore",
  "Moelis & Company",
  "A · B Capital", // the separator inside a firm's own name
  "  Houlihan   Lokey  ", // stray whitespace from a typed contact
  "野村證券",
  null,
];

const EVENT_TITLES = [
  "Coffee chat - Priya",
  "Superday debrief call with the whole restructuring team and two MDs",
  "Call · Goldman", // the separator inside a calendar title
  "Zoom: 1st round",
  "   ",
];

/** follow_up: "Follow up with {name}" / "{nth} email[ · {firm}] · no reply since {d}" */
function followUps(): Case[] {
  const out: Case[] = [];
  for (const name of NAMES) {
    for (const firm of FIRMS) {
      for (const step of [2, 3]) {
        const body = `${ordinal(step)} email${firm ? ` · ${firm}` : ""} · no reply since ${d(step + 3)}`;
        const clean = firm ? oneLine(firm) : null;
        out.push({
          kind: "follow_up",
          label: `${name} @ ${firm} step ${step}`,
          input: { title: `Follow up with ${name}`, body, when: `${step}d` },
          firm: clean || null,
        });
      }
    }
  }
  // Every rung the ordinal can spell, including the teens.
  for (const step of [1, 4, 11, 12, 13, 21, 22, 23, 101, 111]) {
    out.push({
      kind: "follow_up",
      label: `rung ${step}`,
      input: { title: "Follow up with Jon Doe", body: `${ordinal(step)} email · Lazard · no reply since ${d(1)}`, when: "1h" },
      firm: "Lazard",
    });
  }
  return out;
}

/** outreach: "Email {firm}" / "{n} contact(s) still to email · opens {d}" - the firm IS the title. */
function outreach(): Case[] {
  const out: Case[] = [];
  for (const firm of FIRMS) {
    if (!firm) continue;
    for (const n of [1, 2, 7, 40]) {
      out.push({
        kind: "outreach",
        label: `${firm} x${n}`,
        input: {
          title: `Email ${firm}`,
          body: `${n} contact${n === 1 ? "" : "s"} still to email · opens ${d(n % 28 + 1)}`,
          when: "just now",
        },
        firm: null,
      });
    }
  }
  return out;
}

/** interview_prep: "Prep|Refresh for {firm | event}" / "Technicals round before {d}" */
function interviews(): Case[] {
  const out: Case[] = [];
  for (const phase of ["Prep", "Refresh"] as const) {
    const body =
      phase === "Refresh"
        ? `Quick technicals round before your interview on ${d(24)}`
        : `Technicals round before ${d(26)}`;
    for (const firm of FIRMS) {
      if (!firm) continue;
      out.push({ kind: "interview_prep", label: `${phase} ${firm}`, input: { title: `${phase} for ${firm}`, body, when: "3h" }, firm: null });
    }
    for (const t of EVENT_TITLES) {
      out.push({ kind: "interview_prep", label: `${phase} "${t}"`, input: { title: `${phase} for ${t}`, body, when: "3h" }, firm: null });
    }
  }
  return out;
}

/** thank_you: "Thank {name}" | "Send a thank-you" / "After “{title}”[ · {d}]" */
function thankYous(): Case[] {
  const out: Case[] = [];
  for (const name of [...NAMES, null]) {
    for (const t of EVENT_TITLES) {
      for (const dated of [true, false]) {
        out.push({
          kind: "thank_you",
          label: `${name} after "${t}" dated=${dated}`,
          input: {
            title: name ? `Thank ${name}` : "Send a thank-you",
            body: `After “${t}”${dated ? ` · ${d(20)}` : ""}`,
            when: "2d",
          },
          firm: null,
        });
      }
    }
  }
  return out;
}

/**
 * The same jobs with the firm handed over as a field, the way a server that
 * knows it would. Outreach and interview titles already name it, so it must
 * vanish there; a follow-up shows it; so does a thank-you, whose copy never
 * names a firm at all.
 */
function structured(): Case[] {
  const out: Case[] = [];
  for (const firm of FIRMS) {
    if (!firm) continue;
    const clean = oneLine(firm);
    out.push(
      { kind: "outreach", label: `field: Email ${firm}`, input: { title: `Email ${firm}`, body: `3 contacts still to email · opens ${d(9)}`, firm }, firm: null },
      { kind: "outreach", label: `field (shouted): Email ${firm}`, input: { title: `Email ${firm.toUpperCase()}`, body: "", firm }, firm: null },
      { kind: "interview_prep", label: `field: Prep for ${firm}`, input: { title: `Prep for ${firm}`, body: `Technicals round before ${d(9)}`, firm }, firm: null },
      { kind: "interview_prep", label: `field: Refresh for ${firm}`, input: { title: `Refresh for ${firm}`, body: "", firm }, firm: null },
      { kind: "follow_up", label: `field: follow-up at ${firm}`, input: { title: "Follow up with Jon Doe", body: `2nd email · no reply since ${d(9)}`, firm }, firm: clean },
      { kind: "thank_you", label: `field: thank-you at ${firm}`, input: { title: "Thank Priya Shah", body: `After “Coffee chat” · ${d(9)}`, firm }, firm: clean },
      // A contact who shares the firm's name: the title already says it.
      { kind: "follow_up", label: `field: contact named after ${firm}`, input: { title: `Follow up with Ann ${clean}`, body: `2nd email · ${firm} · no reply since ${d(9)}` }, firm: null },
    );
  }
  return out;
}

const CASES = [...followUps(), ...outreach(), ...interviews(), ...thankYous(), ...structured()];

test("there are at least 300 generated cases, covering every kind", () => {
  assert.ok(CASES.length >= 300, `only ${CASES.length} cases`);
  for (const kind of ["outreach", "interview_prep", "follow_up", "thank_you"] as const) {
    assert.ok(CASES.some((c) => c.kind === kind), `no ${kind} cases`);
  }
});

for (const c of CASES) {
  test(`${c.kind}: ${c.label}`, () => {
    const row = bellRow(c.input);

    // One line, never empty, and it is the title the job was filed with.
    assert.ok(row.title.length > 0);
    assert.doesNotMatch(row.title, /[\n\r\t]/);
    assert.equal(row.title, oneLine(c.input.title) || oneLine(c.input.body ?? "") || UNTITLED_JOB);

    // The firm: known where the job names it outside the title, absent where
    // it does not, and never a repeat of what the title already says.
    assert.equal(row.firm, c.firm);
    if (row.firm) {
      assert.ok(!row.title.toLowerCase().includes(row.firm.toLowerCase()), "firm repeats the title");
      assert.doesNotMatch(row.firm, /^\s|\s$|\n/);
    }

    // Nothing the row drops is lost: detail and age ride in the tooltip.
    const lines = row.tooltip.split("\n");
    assert.equal(lines[0], row.title);
    const body = oneLine(c.input.body ?? "");
    if (body && body !== row.title) assert.ok(lines.includes(body), "detail missing from tooltip");
    if (c.input.when) assert.ok(lines.some((l) => l.startsWith(c.input.when!)), "age missing from tooltip");
    assert.ok(lines.length <= 3);
  });
}

// Hostile and missing input, independent of kind.

const EDGE: { name: string; input: BellRowInput; title: string; firm: string | null; tooltip?: string }[] = [
  { name: "empty title falls back to the detail", input: { title: "", body: "2nd email · no reply since 1 Sep" }, title: "2nd email · no reply since 1 Sep", firm: null },
  { name: "whitespace-only title", input: { title: " \n\t ", body: "Technicals round before 3 Oct" }, title: "Technicals round before 3 Oct", firm: null },
  { name: "nothing at all", input: { title: "", body: "" }, title: UNTITLED_JOB, firm: null, tooltip: UNTITLED_JOB },
  { name: "null body", input: { title: "Email Lazard", body: null }, title: "Email Lazard", firm: null, tooltip: "Email Lazard" },
  { name: "undefined body and when", input: { title: "Email Lazard" }, title: "Email Lazard", firm: null, tooltip: "Email Lazard" },
  { name: "NBSP, tabs and newlines collapse", input: { title: "Follow\u00A0up\twith  Jon\n\nDoe", body: "" }, title: "Follow up with Jon Doe", firm: null },
  { name: "an emoji's zero-width joiner survives", input: { title: "Thank Sam \u{1F469}\u200D\u{1F4BC}", body: "" }, title: "Thank Sam \u{1F469}\u200D\u{1F4BC}", firm: null },
  { name: "a zero-width non-joiner survives", input: { title: "Thank Mi\u200Ckhahad", body: "" }, title: "Thank Mi\u200Ckhahad", firm: null },
  { name: "structured firm wins over the detail", input: { title: "Follow up with Jon", body: "2nd email · Lazard · no reply since 1 Sep", firm: "Goldman Sachs" }, title: "Follow up with Jon", firm: "Goldman Sachs" },
  { name: "structured firm already in the title (case-insensitive)", input: { title: "Email GOLDMAN SACHS", body: "", firm: "goldman sachs" }, title: "Email GOLDMAN SACHS", firm: null },
  { name: "blank structured firm falls back to the detail", input: { title: "Follow up with Jon", body: "2nd email · Lazard · no reply since 1 Sep", firm: "  " }, title: "Follow up with Jon", firm: "Lazard" },
  { name: "firm that is also the contact's surname", input: { title: "Follow up with Ann Lazard", body: "2nd email · Lazard · no reply since 1 Sep" }, title: "Follow up with Ann Lazard", firm: null },
  { name: "a thank-you whose event title looks like a follow-up", input: { title: "Thank Jon", body: "After “2nd email · Lazard · no reply since 1 Sep”" }, title: "Thank Jon", firm: null },
  { name: "whitespace-only firm in a follow-up detail", input: { title: "Follow up with Jon", body: "2nd email ·   · no reply since 1 Sep" }, title: "Follow up with Jon", firm: null },
  { name: "just now is not 'just now ago'", input: { title: "Email Lazard", body: "x", when: "just now" }, title: "Email Lazard", firm: null, tooltip: "Email Lazard\nx\njust now" },
  { name: "detail identical to the title is not repeated", input: { title: "Email Lazard", body: " Email  Lazard " }, title: "Email Lazard", firm: null, tooltip: "Email Lazard" },
  { name: "very long title stays whole (the row truncates in CSS)", input: { title: "Prep for " + "Restructuring ".repeat(40), body: "" }, title: oneLine("Prep for " + "Restructuring ".repeat(40)), firm: null },
];

for (const e of EDGE) {
  test(`edge: ${e.name}`, () => {
    const row = bellRow(e.input);
    assert.equal(row.title, e.title);
    assert.equal(row.firm, e.firm);
    if (e.tooltip !== undefined) assert.equal(row.tooltip, e.tooltip);
  });
}

test("firmFromDetail only reads the follow-up shape", () => {
  assert.equal(firmFromDetail("2nd email · Goldman Sachs · no reply since 14 Sep"), "Goldman Sachs");
  assert.equal(firmFromDetail("3rd email · A · B Capital · no reply since 14 Sep"), "A · B Capital");
  assert.equal(firmFromDetail("2nd email · no reply since 14 Sep"), null);
  assert.equal(firmFromDetail("4 contacts still to email · opens 3 Oct"), null);
  assert.equal(firmFromDetail("After “Coffee · chat” · 21 Sep"), null);
  assert.equal(firmFromDetail("Technicals round before 26 Sep"), null);
  assert.equal(firmFromDetail(""), null);
  assert.equal(firmFromDetail(null), null);
  assert.equal(firmFromDetail(undefined), null);
});
