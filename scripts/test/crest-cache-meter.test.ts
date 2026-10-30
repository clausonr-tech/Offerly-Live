/**
 * What bounds the upstream lookups behind /api/crest.
 *
 * The route takes no session - a crest is drawn before anyone is signed in -
 * and used to do a database query plus up to two outbound provider requests
 * for EVERY request, with nothing kept and nothing counted. It also only
 * asked its domain parser for a verdict and then carried on with the raw
 * query value, so "a.com", "anything@a.com" and "A.com." were three different
 * requests for one school, each with its own trip upstream.
 *
 * Three things bound it now: the answer for a (normalised domain, size) is
 * kept - including "there is no crest" - requests arriving together share one
 * lookup, and a lookup that has to happen is counted against the caller's
 * address by the shared limiter. A served-from-memory crest is never counted,
 * so ordinary page loads cannot be refused.
 *
 * A real database (PGlite migrated by replaying drizzle/*.sql, so rate_events
 * is the real table) and a counting fake upstream. No network.
 */

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

import "./helpers/async-local-storage";
import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { rateEvents } from "@/db/schema";
import { CREST_LOOKUP_LIMIT, GET } from "@/app/api/crest/route";

// A one-pixel PNG is all the route has to carry; the bytes only have to be
// recognisable on the way back out.
const ICON = Buffer.from("89504e470d0a1a0a", "hex");

let h: TestDatabase;
let restore: () => void;
const realFetch = globalThis.fetch;
let fetches: string[] = [];
/** Set to hold every fake lookup until the test lets it finish. */
let held: Promise<void> | null = null;
/** Domains the fake upstream has no icon for. */
const unknown = new Set<string>();

before(async () => {
  // No provider credentials: the Brandfetch leg stays dark, as it does in CI.
  delete process.env.BRANDFETCH_CLIENT_ID;
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /^https:\/\/www\.google\.com\/s2\/favicons\?/, `unexpected upstream request ${url}`);
    fetches.push(url);
    if (held) await held;
    const domain = new URL(url).searchParams.get("domain") ?? "";
    if (unknown.has(domain)) return new Response("nope", { status: 404 });
    return new Response(new Uint8Array(ICON), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  restore();
  await h.close();
});

/** The address the host's proxy reports for these requests. */
const CALLER_IP = "203.0.113.7";

function ask(query: string): Promise<Response> {
  // The route resolves the caller from the headers of the request it is handed
  // (lib/login-throttle clientIpFrom), the way one arrives behind a proxy.
  return GET(
    new Request(`https://offerly.test/api/crest?${query}`, { headers: { "x-real-ip": CALLER_IP } }),
  );
}

async function metered(): Promise<number> {
  const rows = await h.db.select({ id: rateEvents.id }).from(rateEvents).where(eq(rateEvents.bucket, "crest:lookup"));
  return rows.length;
}

test("a crest is looked up once however often it is asked for", async () => {
  fetches = [];
  const before = await metered();

  const first = await ask("domain=zz-crest-one.test&sz=128");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), ICON);

  for (let i = 0; i < 5; i++) {
    const again = await ask("domain=zz-crest-one.test&sz=128");
    assert.equal(again.status, 200, "a kept crest stopped being served");
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), ICON, "the kept bytes came back wrong");
  }

  assert.equal(fetches.length, 1, "the crest was looked up again");
  assert.equal((await metered()) - before, 1, "serving a kept crest was counted against the caller");
});

test("the key is the domain the route normalised, not the query value", async () => {
  fetches = [];
  // All three name one school: a stray local part, capitals, a trailing dot.
  for (const value of ["zz-crest-two.test", "anything%40zz-crest-two.test", "ZZ-Crest-Two.test."]) {
    const res = await ask(`domain=${value}`);
    assert.equal(res.status, 200, `${value} was not answered`);
    await res.arrayBuffer();
  }
  assert.equal(fetches.length, 1, "one school was looked up more than once");
  assert.equal(new URL(fetches[0]).searchParams.get("domain"), "zz-crest-two.test");
});

test("the size comes from a fixed set, so it cannot multiply the keys", async () => {
  fetches = [];
  for (const sz of ["999", "0", "-1", "abc", "256"]) {
    const res = await ask(`domain=zz-crest-three.test&sz=${sz}`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
  assert.equal(fetches.length, 1, "an invented size started its own lookup");
  assert.equal(new URL(fetches[0]).searchParams.get("sz"), "256");
});

test("'there is no crest' is kept too, so an unknown domain is asked about once", async () => {
  fetches = [];
  unknown.add("zz-crest-missing.test");
  const first = await ask("domain=zz-crest-missing.test");
  assert.equal(first.status, 404);
  const again = await ask("domain=zz-crest-missing.test");
  assert.equal(again.status, 404);
  assert.equal(fetches.length, 1, "a domain with no crest was looked up again");
});

test("a value that is not a domain is refused, upstream and the meter untouched", async () => {
  fetches = [];
  const before = await metered();
  for (const value of ["", "not-a-domain", "a", `${"x".repeat(300)}.test`, "..", "http%3A%2F%2Fevil.test"]) {
    const res = await ask(`domain=${value}`);
    assert.equal(res.status, 400, `"${value.slice(0, 20)}" was accepted`);
  }
  assert.equal(fetches.length, 0);
  assert.equal(await metered(), before, "a refused request was counted");
});

test("requests arriving together share one lookup", async () => {
  fetches = [];
  const before = await metered();
  let release = () => {};
  held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const burst = Array.from({ length: 6 }, () => ask("domain=zz-crest-burst.test"));
  // Let the first request reach the fake upstream before the rest queue up.
  await new Promise((r) => setImmediate(r));
  release();
  held = null;
  const answers = await Promise.all(burst);

  for (const res of answers) assert.equal(res.status, 200);
  // The invariant that matters: one upstream request, however many callers
  // asked at once. That is what bounds the spend.
  assert.equal(fetches.length, 1, "a burst for one domain fanned out upstream");

  // The meter counts REQUESTS, not lookups, and deliberately so. It used to sit
  // inside the shared promise, which charged the shared lookup once - and which
  // meant the promise's answer was shared too, so one address over its budget
  // handed its refusal to every other visitor asking for the same crest, their
  // own budget never consulted. The decision is now each caller's own, taken
  // before anything is registered, so joining someone else's lookup costs a
  // unit of the joiner's budget. That is the strict direction: the bucket can
  // only ever count at or above the number of upstream requests it is there to
  // bound, never below.
  assert.equal((await metered()) - before, burst.length, "each caller is metered for its own request");
});

test("a loop asking for invented domains runs out of lookups", async () => {
  fetches = [];
  let refused = 0;
  let lastAllowed = 0;
  for (let i = 0; i < CREST_LOOKUP_LIMIT + 10; i++) {
    const res = await ask(`domain=zz-loop-${i}.test`);
    await res.arrayBuffer().catch(() => {});
    if (res.status === 429) {
      refused += 1;
      assert.ok(Number(res.headers.get("retry-after")) > 0, "a refusal did not say when to come back");
      assert.equal(fetches.length, lastAllowed, "a refused request still went upstream");
      if (refused >= 3) break;
    } else {
      lastAllowed = fetches.length;
    }
  }
  assert.ok(refused >= 3, "the meter never refused a loop of invented domains");
  assert.ok(fetches.length <= CREST_LOOKUP_LIMIT, `${fetches.length} lookups went upstream past the limit`);

  // The crests already found are still served, because that costs nothing.
  const kept = await ask("domain=zz-crest-one.test&sz=128");
  assert.equal(kept.status, 200, "a kept crest was refused once the meter was full");
});

test("every metered lookup was counted against a server-resolved caller", async () => {
  const rows = await h.db
    .select({ subject: rateEvents.subject })
    .from(rateEvents)
    .where(and(eq(rateEvents.bucket, "crest:lookup")));
  assert.ok(rows.length > 0);
  // The subject is the address the server resolved from the proxy header and
  // validated as an address - never a raw header string, and never a bucket
  // shared with every other caller whose address did not resolve. What
  // happens when none does is limiter-subject-crest-ip.test.ts.
  for (const r of rows) assert.equal(r.subject, CALLER_IP);
});
