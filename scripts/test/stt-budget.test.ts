/**
 * Speech-to-text spend is bounded by real audio, not by the client's claim.
 *
 * The byte cap (4MB) never bounded what the provider bills, which is audio
 * MINUTES: a few hundred kilobytes of low-bitrate audio can be an hour long,
 * and durationMs is whatever the browser says. These pin the two controls that
 * replace it - the rolling budget, and refusing an answer the provider itself
 * measured as longer than the question allowed.
 *
 * No network: only the database is touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { sttUsage, users } from "@/db/schema";
import {
  DAILY_AUDIO_SECONDS,
  audioSecondsUsed,
  chargeableSeconds,
  reserveAudioSeconds,
  tooLongForAnswer,
} from "@/lib/video-interview/stt-budget";

const USER_ID = "55555555-5555-4555-8555-555555555555";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "stt@example.edu",
      passwordHash: "x",
      name: "STT Student",
      plan: "pro",
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

test("an answer the provider measured as over the answer time is refused", () => {
  // A 30-second question, 3s grace. The client may claim what it likes; this
  // reads the provider's own measurement.
  assert.equal(tooLongForAnswer(29, 30, 3000), false, "a normal answer stands");
  assert.equal(tooLongForAnswer(32.9, 30, 3000), false, "inside the grace it stands");
  assert.equal(tooLongForAnswer(600, 30, 3000), true, "ten minutes of audio for a 30s answer is refused");
});

test("a provider that reports no duration leaves the answer alone", () => {
  // Then the claimed length, already checked against the server's clock, is
  // all there is - refusing here would break every provider without duration.
  assert.equal(tooLongForAnswer(null, 30, 3000), false);
});

test("seconds accumulate and the budget refuses once spent", async () => {
  await withStudent(async () => {
    assert.equal(await audioSecondsUsed(USER_ID), 0);

    const first = await reserveAudioSeconds(USER_ID, 600);
    assert.equal(first.ok, true, "a fresh day is open");
    assert.equal(await audioSecondsUsed(USER_ID), 600, "the reservation is charged before the call");

    const big = await reserveAudioSeconds(USER_ID, DAILY_AUDIO_SECONDS);
    assert.equal(big.ok, true, "still under the ceiling when it was taken");

    const over = await reserveAudioSeconds(USER_ID, 60);
    assert.equal(over.ok, false, "over the day's audio budget, the coach refuses");
    if (!over.ok) assert.match(over.error, /recording time today/i);
  });
});

test("the charge is corrected to what the provider measured", async () => {
  await withStudent(async () => {
    // Reserved at what the bytes are worth, settled to the real duration - so
    // an honest answer ends up charged for what it actually was, and the
    // pessimistic figure only stands when nobody will tell us.
    const r = await reserveAudioSeconds(USER_ID, 683);
    assert.equal(r.ok, true);
    assert.equal(await audioSecondsUsed(USER_ID), 683);
    if (r.ok) await r.settle(41);
    assert.equal(await audioSecondsUsed(USER_ID), 41, "settled down to the measured duration");

    // No duration reported: the reservation stands.
    const s2 = await reserveAudioSeconds(USER_ID, 200);
    assert.equal(s2.ok, true);
    if (s2.ok) await s2.settle(null);
    assert.equal(await audioSecondsUsed(USER_ID), 241, "an unmeasured call keeps its provisional charge");
  });
});

test("a call that never happened costs nothing", async () => {
  await withStudent(async () => {
    const r = await reserveAudioSeconds(USER_ID, 900);
    assert.equal(r.ok, true);
    assert.equal(await audioSecondsUsed(USER_ID), 900);
    if (r.ok) await r.release();
    assert.equal(await audioSecondsUsed(USER_ID), 0, "a provider outage must not spend a student's day");
  });
});

test("submissions fired together cannot all pass the same reading", async () => {
  await withStudent(async () => {
    // The hole this replaced: audioBudgetError was a plain SELECT and the
    // charge was written after the provider answered, so twelve submissions
    // fired at once all read the same zero and all twelve reached the
    // provider - about four and a half times the day's ceiling in one burst.
    // Each of these asks for a fifth of the budget, so at most five can be
    // granted however they interleave.
    const each = Math.ceil(DAILY_AUDIO_SECONDS / 5);
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveAudioSeconds(USER_ID, each)));
    const granted = results.filter((r) => r.ok).length;
    assert.ok(granted <= 5, `${granted} of 12 were granted against a budget of five`);
    assert.ok(granted >= 1, "every submission in the burst was refused");
    assert.ok(
      (await audioSecondsUsed(USER_ID)) <= granted * each,
      "more was charged than was granted",
    );
  });
});

test("the budget is a rolling day, so yesterday's audio does not count", async () => {
  await withStudent(async (h) => {
    await h.db.insert(sttUsage).values({
      userId: USER_ID,
      seconds: DAILY_AUDIO_SECONDS * 2,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    assert.equal(await audioSecondsUsed(USER_ID), 0, "older than a day");
    assert.equal((await reserveAudioSeconds(USER_ID, 60)).ok, true);
  });
});

test("a nonsense charge is still at least a second, never zero or negative", async () => {
  await withStudent(async () => {
    for (const seconds of [0, -5, Number.NaN]) {
      const r = await reserveAudioSeconds(USER_ID, seconds);
      assert.equal(r.ok, true);
    }
    assert.equal(await audioSecondsUsed(USER_ID), 3, "each took the floor of one second");
  });
});

// An adversarial pass over the first version of this control found that both
// halves of it were inert whenever the provider reports no duration - which is
// every provider on the plain "json" response format, the gpt-4o transcribe
// models included. The meter then recorded the BROWSER's durationMs, and
// upload-validation bounds that from above but never from below, so a 4MB
// low-bitrate file declared as three seconds was an hour of billed audio
// metered as three seconds.

test("weight is bounded by the answer time the question allowed", async () => {
  const { validateAudioUpload } = await import("@/lib/video-interview/upload-validation");
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const base = {
    declaredType: "audio/webm",
    head: webm,
    durationMs: 3_000,
    answerSeconds: 30,
    msSinceServed: 40_000,
  };

  // The attack: the flat 4MB ceiling admitted this, and the claimed three
  // seconds kept every duration check happy.
  const heavy = validateAudioUpload({ ...base, size: 4 * 1024 * 1024 - 1 });
  assert.equal(heavy.ok, false, "a 4MB file for a 30-second answer is refused");
  if (!heavy.ok) assert.match(heavy.error, /too large for an answer of this length/);

  // An honest recording is nowhere near the cap: browser Opus speech is a few
  // KB per second, and the cap is 32KB per second.
  const honest = validateAudioUpload({ ...base, size: 30 * 4 * 1024 });
  assert.equal(honest.ok, true, "an ordinary 30-second answer still uploads");

  // The cap scales with what was asked for rather than being flat.
  const longAnswer = validateAudioUpload({ ...base, answerSeconds: 120, msSinceServed: 130_000, size: 1_500_000 });
  assert.equal(longAnswer.ok, true, "the same weight is fine for a two-minute answer");
});

test("a provider that reports no duration is charged what the bytes weigh", async () => {
  // tooLongForAnswer cannot judge a missing duration, so the budget is what
  // has to hold - and it must not be fed the browser's number.
  assert.equal(tooLongForAnswer(null, 30, 3000), false, "nothing to compare");

  // The provider's own measurement is the truth and is what a student pays.
  assert.equal(chargeableSeconds({ reportedSeconds: 41, bytes: 400_000, allowedSeconds: 183 }), 41);

  // THE ATTACK this replaced. Charging the answer time the question allowed
  // looked like "charging the maximum", but it was the wrong maximum: a four
  // megabyte file is far more audio than three minutes, and three minutes is
  // what it used to cost.
  const allowedSeconds = 183;
  const heavy = chargeableSeconds({ reportedSeconds: null, bytes: 4 * 1024 * 1024, allowedSeconds });
  assert.ok(heavy > allowedSeconds * 3, `four megabytes was charged as ${Math.round(heavy)}s`);

  // AND THE REGRESSION that replaced it, which is the other half. Dividing by
  // the codec's absolute floor instead of by what this app's own recorder
  // produces charged an honest three-minute answer nearly eight times over,
  // and cut a student off after two of their twelve sessions. An honest answer
  // must cost about its own length.
  const { ANSWER_OPTIONS, DURATION_GRACE_MS } = await import("@/lib/video-interview/types");
  const longest = Math.max(...ANSWER_OPTIONS);
  // 48 kbit/s is what VideoInterview.tsx starts the recorder at.
  const honestBytes = Math.round((longest * 48_000) / 8);
  const honest = chargeableSeconds({
    reportedSeconds: null,
    bytes: honestBytes,
    allowedSeconds: longest + DURATION_GRACE_MS / 1000,
  });
  assert.ok(
    honest <= longest + DURATION_GRACE_MS / 1000,
    `an honest ${longest}s answer of ${honestBytes} bytes was charged ${Math.round(honest)}s`,
  );

  // And it never charges LESS than the answer allowance, so the fallback can
  // only be stricter than what it replaced.
  assert.equal(chargeableSeconds({ reportedSeconds: null, bytes: 0, allowedSeconds: 183 }), 183);
  assert.equal(chargeableSeconds({ reportedSeconds: null, bytes: 50_000, allowedSeconds: 183 }), 183);
  // A nonsense report falls back to the same rule rather than to zero.
  assert.equal(chargeableSeconds({ reportedSeconds: -5, bytes: 0, allowedSeconds: 63 }), 63);
});

test("the day's budget fits the sessions the coach actually offers", async () => {
  const { LIMITS } = await import("@/lib/video-interview/limits");
  const { ANSWER_OPTIONS, DURATION_GRACE_MS, QUESTIONS_PER_INTERVIEW } = await import("@/lib/video-interview/types");
  // The budget was three hours and the honest worst case was 10,980 seconds:
  // twelve sessions of five questions at the longest answer option, each
  // charged its allowance. A student who chose three-minute answers was cut
  // off one answer short of the last session they were entitled to - the
  // limiter punishing the one person it was not meant to stop.
  const longest = Math.max(...ANSWER_OPTIONS) + DURATION_GRACE_MS / 1000;
  const honestWorstCase = LIMITS.sessionsPerDay * QUESTIONS_PER_INTERVIEW * longest;
  assert.ok(
    DAILY_AUDIO_SECONDS >= honestWorstCase,
    `the budget is ${DAILY_AUDIO_SECONDS}s and honest use can reach ${honestWorstCase}s`,
  );
});
