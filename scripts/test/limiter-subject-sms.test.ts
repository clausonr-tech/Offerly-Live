/**
 * The test SMS is bounded per NUMBER, not only per account.
 *
 * users.phone is typed into a form and explicitly not ownership-verified, and
 * the only bound on the test message was five a day per ACCOUNT - so N
 * accounts pointed at one person's handset sent 5N real messages to it, on
 * Offerly's Twilio bill, with every limiter faithfully counting the wrong
 * party. The email side has had a per-destination bound for exactly this
 * reason (lib/firm-auth chargeCodeQuota); this is the SMS one.
 *
 * Real Postgres (PGlite with the real schema, so rate_events is the real
 * table), a real session for each account, and a counting fake Twilio. No
 * network.
 */

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { rateEvents, users } from "@/db/schema";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

/** One handset, written three different ways by three accounts. */
const VICTIM_SPELLINGS: Record<string, string> = {
  [A]: "+15550109999",
  [B]: "+1 (555) 010-9999",
  [C]: "555-010-9999",
};
const VICTIM_SUBJECT = "15550109999";

let sent: string[] = [];
const realFetch = globalThis.fetch;

async function withAccounts(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  process.env.TWILIO_ACCOUNT_SID = "AC-test";
  process.env.TWILIO_AUTH_TOKEN = "token-test";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /^https:\/\/api\.twilio\.com\//, `unexpected request ${url}`);
    sent.push(String(new URLSearchParams(String(init?.body)).get("To")));
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  try {
    await h.db.insert(users).values(
      [A, B, C].map((id) => ({
        id,
        email: `${id}@example.edu`,
        passwordHash: "x",
        phone: VICTIM_SPELLINGS[id],
      })),
    );
    await fn(h);
  } finally {
    globalThis.fetch = realFetch;
    restore();
    await h.close();
  }
}

async function send(h: TestDatabase, userId: string) {
  const { sendTestSms } = await import("@/app/(app)/settings/actions");
  return asStudent(h.db, userId, () => sendTestSms(undefined));
}

test("one number gets five test messages a day, however many accounts aim at it", async () => {
  await withAccounts(async (h) => {
    for (let i = 0; i < 5; i++) {
      const out = await send(h, A);
      assert.deepEqual(out, { success: true }, `send ${i + 1} from the first account failed`);
    }
    assert.equal(sent.length, 5);

    // A second account, well inside its own five, aimed at the same handset.
    const second = await send(h, B);
    assert.ok(second?.error, "a second account spent a fresh five on one number");
    assert.match(second.error, /that number/i);
    assert.doesNotMatch(second.error, /maximum number of test messages/i, "it read as the account's own cap");
    assert.equal(sent.length, 5, "a refused message was still billed");

    // And a third spelling of the same number is the same destination.
    const third = await send(h, C);
    assert.ok(third?.error, "a third spelling of one number got its own budget");
    assert.equal(sent.length, 5);

    const rows = await h.db
      .select({ subject: rateEvents.subject })
      .from(rateEvents)
      .where(eq(rateEvents.bucket, "sms:test:to"));
    assert.equal(rows.length, 5, "the destination bound counted something other than the sends");
    for (const r of rows) {
      assert.equal(r.subject, VICTIM_SUBJECT, "the number was metered by its spelling");
      assert.doesNotMatch(r.subject, /\u0000/);
    }
  });
});

test("a different number has its own budget, and the account cap still bites", async () => {
  await withAccounts(async (h) => {
    await h.db.update(users).set({ phone: "+15550107777" }).where(eq(users.id, B));
    for (let i = 0; i < 5; i++) assert.deepEqual(await send(h, A), { success: true });

    // Someone else's phone is untouched by the flood at the first number.
    assert.deepEqual(await send(h, B), { success: true }, "one number's cap refused a different number");

    // The account's own cap is unchanged: the first account has had its five.
    const own = await send(h, A);
    assert.ok(own?.error);
    assert.match(own.error, /maximum number of test messages/i, "the account cap stopped reporting itself");
    assert.equal(sent.length, 6);
  });
});
