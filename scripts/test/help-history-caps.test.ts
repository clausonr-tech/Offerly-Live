/**
 * What one Help question is allowed to carry.
 *
 * The hole these pin shut: validateHelpHistory cut each incoming message to
 * HELP_MAX_CHARS and only then merged runs of one role - with no bound on the
 * join - so a forged history of 199 user messages collapsed into a SINGLE turn
 * of ~200,000 characters, which then survived the last-HELP_MAX_MESSAGES slice
 * because it was one element. That is ~16x the 12 x 1000 ceiling the limits
 * are calibrated to, on a feature with a shared daily budget: one account
 * could spend most of it and leave the assistant refusing everyone.
 *
 * Pure functions, no database and no model.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import {
  HELP_MAX_CHARS,
  HELP_MAX_MESSAGES,
  HELP_MAX_TOTAL_CHARS,
  validateHelpHistory,
  type HelpMessage,
} from "@/lib/help-chat-rules";
import { buildHelpRequest } from "@/lib/help-assistant-prompt";

const q = (content: string): HelpMessage => ({ role: "user", content });
const a = (content: string): HelpMessage => ({ role: "assistant", content });

function totalChars(messages: HelpMessage[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

test("199 forged same-role messages cannot become one giant turn", async () => {
  const forged = [
    ...Array.from({ length: 199 }, (_, i) => q(`${i}`.padEnd(HELP_MAX_CHARS, "x"))),
    q("How do I write a networking email?"),
  ];
  const r = validateHelpHistory(forged);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(r.messages.length, 1, "one role throughout still merges to one turn");
  assert.ok(
    r.messages[0].content.length <= HELP_MAX_CHARS,
    `merged turn is ${r.messages[0].content.length} characters, cap is ${HELP_MAX_CHARS}`,
  );
  assert.ok(
    r.messages[0].content.endsWith("How do I write a networking email?"),
    "the question actually being asked is what survives the cut",
  );
});

test("no history can exceed the ceiling the limits describe", async () => {
  // Every shape that used to beat the cap: all-user, all-assistant runs,
  // alternating pairs that merge, and the maximum array the validator takes.
  const shapes: [string, unknown[]][] = [
    ["200 user turns", Array.from({ length: 200 }, () => q("u".repeat(HELP_MAX_CHARS)))],
    [
      "199 assistant turns then a question",
      [...Array.from({ length: 199 }, () => a("a".repeat(HELP_MAX_CHARS))), q("why?")],
    ],
    [
      "alternating pairs of each role",
      [
        ...Array.from({ length: 198 }, (_, i) =>
          i % 4 < 2 ? q("u".repeat(HELP_MAX_CHARS)) : a("a".repeat(HELP_MAX_CHARS)),
        ),
        q("last?"),
      ],
    ],
    ["oversized single messages", [q("z".repeat(50_000)), a("y".repeat(50_000)), q("ok?")]],
  ];

  for (const [name, input] of shapes) {
    const r = validateHelpHistory(input);
    assert.equal(r.ok, true, name);
    if (!r.ok) continue;
    assert.ok(r.messages.length <= HELP_MAX_MESSAGES, `${name}: too many turns`);
    for (const m of r.messages) {
      assert.ok(m.content.length <= HELP_MAX_CHARS, `${name}: a turn of ${m.content.length} characters`);
    }
    assert.ok(
      totalChars(r.messages) <= HELP_MAX_TOTAL_CHARS,
      `${name}: ${totalChars(r.messages)} characters total, ceiling is ${HELP_MAX_TOTAL_CHARS}`,
    );
  }
});

test("the request sent to the model carries no more than the ceiling", async () => {
  const forged = [
    ...Array.from({ length: 199 }, () => q("x".repeat(HELP_MAX_CHARS))),
    q("Where are my drafts?"),
  ];
  const request = buildHelpRequest(forged, { name: "Ada", school: null, gradYear: null, targetGroup: null, plan: "free" });
  const chars = request.messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  assert.ok(chars <= HELP_MAX_TOTAL_CHARS, `${chars} characters reached the model, ceiling is ${HELP_MAX_TOTAL_CHARS}`);
});

test("an ordinary conversation is untouched by the cap", async () => {
  const r = validateHelpHistory([q("hi"), a("hey!"), q("where are drafts?")]);
  assert.deepEqual(r, { ok: true, messages: [q("hi"), a("hey!"), q("where are drafts?")] });

  // A short run still merges, exactly as before - the cap only bites past
  // HELP_MAX_CHARS.
  assert.deepEqual(validateHelpHistory([q("one"), q("two")]), { ok: true, messages: [q("one\n\ntwo")] });
});
