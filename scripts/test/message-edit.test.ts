// How long a sent message can be edited (lib/message-limits). No database.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canEditMessage, MESSAGE_EDIT_WINDOW_MS } from "../../src/lib/message-limits";

const sent = new Date("2026-09-23T12:00:00Z");
const at = (ms: number) => new Date(sent.getTime() + ms);

test("a message can be edited for ten minutes after sending, and not after", () => {
  assert.equal(MESSAGE_EDIT_WINDOW_MS, 10 * 60_000);
  assert.equal(canEditMessage(sent, at(0)), true, "just sent");
  assert.equal(canEditMessage(sent, at(9 * 60_000 + 59_000)), true, "9:59 in");
  assert.equal(canEditMessage(sent, at(10 * 60_000)), false, "exactly ten minutes");
  assert.equal(canEditMessage(sent, at(2 * 3_600_000)), false, "hours later");
});

test("a send time a little ahead of the server's clock is still editable", () => {
  assert.equal(canEditMessage(sent, at(-5_000)), true, "the database clock runs ahead");
});
