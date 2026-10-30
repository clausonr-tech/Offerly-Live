import { test } from "node:test";
import assert from "node:assert/strict";

import { TIMELINE_MONTHS, timelineNowMarker } from "@/lib/firm-metadata";
import { EVENT_KIND_TONES, LABEL_TONES, toneForNotification } from "@/lib/label-colors";
import { EVENT_KIND_LABELS } from "@/lib/recruiting-event-display";
import { TASK_LABELS } from "@/lib/task-types";

test("every kind of label has its own colour", () => {
  const tones = Object.values(LABEL_TONES);
  assert.equal(new Set(tones.map((t) => t.fg)).size, tones.length, "two kinds share a text colour");
  assert.equal(new Set(tones.map((t) => t.bg)).size, tones.length, "two kinds share a chip colour");
  assert.equal(new Set(tones.map((t) => t.tint)).size, tones.length, "two kinds share a banner colour");
  for (const kind of Object.keys(TASK_LABELS)) assert.ok(kind in LABEL_TONES, `to-do kind ${kind} has no colour`);
  for (const kind of Object.keys(EVENT_KIND_LABELS)) assert.ok(EVENT_KIND_TONES[kind], `event kind ${kind} has no colour`);
  const eventTones = Object.values(EVENT_KIND_TONES);
  assert.equal(new Set(eventTones).size, eventTones.length, "two event kinds share a colour");
});

test("a notification is coloured as the job it is", () => {
  assert.equal(toneForNotification("interview_prep"), "interview");
  assert.equal(toneForNotification("thank_you"), "thank_you");
  assert.equal(toneForNotification("follow_up"), "follow_up");
  assert.equal(toneForNotification("application_deadline"), "apply");
  assert.equal(toneForNotification("firm_posting"), "posting");
  assert.equal(toneForNotification("firm_event"), "event");
  assert.equal(toneForNotification("outreach"), "outreach");
  assert.equal(toneForNotification(undefined), "outreach");
});

test("the dotted today line sits at today's own month, and the label says how far off the cycle is", async (t) => {
  for (let i = 1; i <= 500; i++) {
    await t.test(`case ${i}`, () => {
      // Deterministic spread: 2024-2031, every month, days 1-28.
      const year = 2024 + (i % 8);
      const month = (i * 5) % 12;
      const day = 1 + ((i * 11) % 28);
      const now = new Date(year, month, day, 12);
      const programYear = i % 5 === 0 ? null : 2025 + ((i * 3) % 6);
      const m = timelineNowMarker(programYear, now);
      assert.ok(m.drawAt >= 0 && m.drawAt < TIMELINE_MONTHS.length, `off the chart: ${m.drawAt}`);
      if (m.status === "in") {
        assert.equal(m.drawAt, m.offset);
        assert.equal(m.yearsAway, 0);
      } else {
        assert.equal(Math.floor(m.drawAt), month, "drawn at today's own month");
        if (m.status === "before") assert.ok(m.yearsAway >= 1);
        else assert.ok(m.yearsAway <= -1);
      }
      assert.match(m.monthLabel, /^[A-Z][a-z]{2} \d{4}$/);
    });
  }
});
