/**
 * An unvalidated header never becomes a limiter subject, and callers without
 * an address do not share one bucket.
 *
 * /api/crest takes no session - a crest is drawn on the sign-up and firm pages
 * before anyone is signed in - and metered its upstream lookups against
 * `(await requestIp()) ?? "unknown"`. Two problems in one expression. The
 * resolved value was a raw header string with no parsing or length check, so
 * whatever a client sent (where the host sets no trusted header) was written
 * into rate_events.subject as if it were an address. And every caller whose
 * address did not resolve shared the literal bucket "unknown", so one of them
 * could spend the 150 lookups and crests would be refused to all of them.
 *
 * Now: an address or nothing (lib/login-throttle, node:net isIP), and with
 * nothing to charge the route answers "no crest" without a fresh lookup
 * instead of metering everyone together - and without keeping that answer,
 * which would otherwise poison the cache for the callers who can be metered.
 *
 * Real Postgres (PGlite with the real schema) and a counting fake upstream.
 * No network.
 */

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import "./helpers/async-local-storage";
import "./helpers/no-network";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { rateEvents } from "@/db/schema";
import { clientIpFrom } from "@/lib/login-throttle";
import { CREST_LOOKUP_LIMIT, GET, lookupSubject } from "@/app/api/crest/route";

const ICON = Buffer.from("89504e470d0a1a0a", "hex");
/** The header this "host" overwrites, for the whole file. */
const TRUSTED = "x-real-ip";

let h: TestDatabase;
let restore: () => void;
const realFetch = globalThis.fetch;
let fetches: string[] = [];

before(async () => {
  delete process.env.BRANDFETCH_CLIENT_ID;
  // The host names the one header its proxy overwrites. Production without
  // one resolves no address at all now (see clientIpFrom), so a test of the
  // metering has to say which header is trusted - as the deploy does.
  process.env.CLIENT_IP_HEADER = TRUSTED;
  // The route's answer for a caller it cannot meter is the production one:
  // behind a proxy, a request with no resolvable address is not an ordinary
  // caller. (Outside production nothing resolves at all - `npm run dev` has no
  // proxy - which is why that case keeps working; see lookupSubject.)
  (process.env as Record<string, string>).NODE_ENV = "production";
  h = await createTestDb();
  restore = installAsAppDb(h.db);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /^https:\/\/www\.google\.com\/s2\/favicons\?/, `unexpected upstream request ${url}`);
    fetches.push(url);
    return new Response(new Uint8Array(ICON), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  restore();
  await h.close();
});

function ask(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request(`https://offerly.test/api/crest?${query}`, { headers }));
}

async function subjects(): Promise<string[]> {
  const rows = await h.db
    .select({ subject: rateEvents.subject })
    .from(rateEvents)
    .where(eq(rateEvents.bucket, "crest:lookup"));
  return rows.map((r) => r.subject);
}

test("a header value that is not an address resolves to nothing", () => {
  const notAddresses = [
    "",
    "   ",
    "unknown",
    "localhost",
    "evil.example",
    "1.2.3",
    "1.2.3.4.5",
    "999.1.1.1",
    "1.2.3.4abc",
    "x".repeat(4000),
    // A chain whose FIRST entry is junk: the first entry is the client, so
    // there is no address here even though a later entry looks like one.
    "nonsense, 198.51.100.1",
    "::gg",
    "DROP TABLE rate_events",
    "a\u0000b",
  ];
  // A bare bag rather than Headers, because Headers itself refuses some of
  // these (a NUL in a value) and the point is what the resolver does with a
  // string it is handed.
  for (const value of notAddresses) {
    assert.equal(
      clientIpFrom({ get: () => value }),
      null,
      `"${value.slice(0, 24)}" was accepted as an address`,
    );
  }
});

test("a real address is kept, in the shapes proxies actually send", () => {
  const cases: [string, string][] = [
    ["203.0.113.7", "203.0.113.7"],
    // A proxy that appends the source port, and a v6 literal in brackets.
    ["203.0.113.7:51234", "203.0.113.7"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["[2001:DB8::1]:443", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["::1", "::1"],
    // The chain's first entry is the client; whitespace and case are tidied so
    // one caller is one subject.
    ["  203.0.113.9 , 198.51.100.4", "203.0.113.9"],
  ];
  for (const [header, expected] of cases) {
    assert.equal(clientIpFrom(new Headers({ [TRUSTED]: header })), expected, `${header} was dropped`);
  }
});

test("only the header the host sets is read, when the host names one", () => {
  process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
  try {
    const h = new Headers({ "cf-connecting-ip": "203.0.113.11", "x-real-ip": "198.51.100.77" });
    assert.equal(clientIpFrom(h), "203.0.113.11");
    // A header the proxy does not set is whatever the client sent, so with a
    // configured header the others are not consulted at all.
    assert.equal(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.77" })), null);
  } finally {
    process.env.CLIENT_IP_HEADER = TRUSTED;
  }
});

test("with nobody to charge there is no subject at all, and no shared bucket", () => {
  assert.equal(lookupSubject(null, true), null, "a caller with no address was charged to something");
  assert.equal(lookupSubject("203.0.113.7", true), "203.0.113.7");
  // Outside production nothing resolves for any request, and crests still have
  // to render: one local bucket, named so it cannot collide with an address.
  assert.equal(lookupSubject(null, false), "local-dev");
  assert.doesNotMatch(lookupSubject(null, false) ?? "", /^[0-9a-f.:]+$/);
});

test("a request with no usable address gets no lookup, and writes no row", async () => {
  fetches = [];
  const before = (await subjects()).length;
  const unmeterable: Record<string, string>[] = [
    {},
    { "x-real-ip": "unknown" },
    { "x-real-ip": "not-an-address" },
    { "x-forwarded-for": "x".repeat(2000) },
  ];
  for (const headers of unmeterable) {
    const res = await ask("domain=zz-noip.test", headers);
    assert.equal(res.status, 404, "an unmeterable caller got a fresh lookup");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(fetches.length, 0, "an unmeterable caller reached upstream");
  assert.equal((await subjects()).length, before, "a row was written for a caller with no address");
});

test("and that answer is not kept: the next real caller is still served", async () => {
  fetches = [];
  // Same domain the unmeterable requests just 404ed on. If their answer had
  // been cached, this would serve a 404 for ten minutes to everybody.
  const res = await ask("domain=zz-noip.test", { "x-real-ip": "203.0.113.20" });
  assert.equal(res.status, 200, "a caller's unmeterable 404 was kept for everyone");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), ICON);
  assert.equal(fetches.length, 1);
  assert.ok((await subjects()).includes("203.0.113.20"));
});

test("one caller running out does not refuse another", async () => {
  fetches = [];
  const greedy = { "x-real-ip": "198.51.100.30" };
  let refused: Response | null = null;
  for (let i = 0; i < CREST_LOOKUP_LIMIT + 5 && !refused; i++) {
    const res = await ask(`domain=zz-greedy-${i}.test`, greedy);
    if (res.status === 429) refused = res;
    else await res.arrayBuffer();
  }
  assert.ok(refused, "the meter never refused a loop from one address");

  // A different caller, in the same window, asking about a domain nobody has
  // looked up yet. Under the old shared bucket this was a 429.
  const other = await ask("domain=zz-bystander.test", { "x-real-ip": "198.51.100.31" });
  assert.equal(other.status, 200, "one address spending its budget refused a different caller");
  await other.arrayBuffer();

  // And nothing was ever charged to a name that is not an address.
  for (const s of await subjects()) {
    assert.match(s, /^[0-9a-f.:]+$/, `"${s.slice(0, 32)}" was metered as a caller`);
  }
});

// ------------------------------------------------ a forged address is refused
//
// CLIENT_IP_HEADER names the one header the host's proxy overwrites. With none
// named, x-real-ip and x-forwarded-for are simply whatever the client sent -
// and a forged address is worse than no address, because it can be set to a
// VICTIM's and spend their budget. The audit left "confirm CLIENT_IP_HEADER is
// set on Vercel" as a deployment fact nobody here can check; the code now
// refuses to depend on the answer.

/** Runs `fn` with NODE_ENV and CLIENT_IP_HEADER set, then puts both back. */
function withEnv(nodeEnv: string, header: string | null, fn: () => void): void {
  const env = process.env as Record<string, string | undefined>;
  const prevEnv = env.NODE_ENV;
  const prevHeader = env.CLIENT_IP_HEADER;
  env.NODE_ENV = nodeEnv;
  if (header === null) delete env.CLIENT_IP_HEADER;
  else env.CLIENT_IP_HEADER = header;
  try {
    fn();
  } finally {
    env.NODE_ENV = prevEnv;
    if (prevHeader === undefined) delete env.CLIENT_IP_HEADER;
    else env.CLIENT_IP_HEADER = prevHeader;
  }
}

test("in production, a host that names no header yields no address at all", () => {
  const spoofed = new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" });
  withEnv("production", null, () => {
    assert.equal(clientIpFrom(spoofed), null, "a client-settable header was believed in production");
  });
  // Named, that same header is believed - which is the point of naming it.
  withEnv("production", "x-vercel-forwarded-for", () => {
    assert.equal(clientIpFrom(new Headers({ "x-vercel-forwarded-for": "198.51.100.4" })), "198.51.100.4");
    // And a named header carrying rubbish still yields nothing.
    assert.equal(clientIpFrom(new Headers({ "x-vercel-forwarded-for": "not-an-address" })), null);
  });
});

test("outside production the ordinary headers still work, so local development can rate-limit", () => {
  withEnv("test", null, () => {
    assert.equal(clientIpFrom(new Headers({ "x-real-ip": "127.0.0.1" })), "127.0.0.1");
  });
});

// ------------------------------------- one caller's refusal is one caller's
//
// `inFlight` is a sharing channel, exactly like the cache. The first request
// for a (domain, size) registers its promise and every request arriving while
// it runs is handed that promise's answer - so while the meter was decided
// INSIDE that promise, one address over budget produced a 429 that every other
// visitor asking for the same school crest received, their own budget never
// consulted. The `ttl: 0` guard was written for the cache and did nothing here.
//
// Making the limiter's lock a try-lock is what made this cheap: a refusal
// became reachable from two simultaneous requests rather than 151.

test("a refused caller does not hand their 429 to everyone else asking", async () => {
  fetches = [];
  const greedy = { [TRUSTED]: "198.51.100.40" };
  const domain = "zz-shared-refusal.test";

  // Spend one address's budget on other domains, so its next request for the
  // shared domain is refused.
  for (let i = 0; i < CREST_LOOKUP_LIMIT; i++) {
    const res = await ask(`domain=zz-fill-${i}.test`, greedy);
    await res.arrayBuffer();
  }
  const refused = await ask(`domain=${domain}`, greedy);
  assert.equal(refused.status, 429, "the greedy address should be over its budget");
  assert.equal(refused.headers.get("cache-control"), "private, no-store", "a refusal must not be cacheable");

  // Now a different visitor, with budget of their own, asking for the same
  // domain - at the same time, so the in-flight path is the one exercised.
  fetches = [];
  const bystander = { [TRUSTED]: "198.51.100.41" };
  const [a, b] = await Promise.all([
    ask(`domain=${domain}`, greedy),
    ask(`domain=${domain}`, bystander),
  ]);
  assert.equal(a.status, 429, "the greedy address is still refused");
  assert.equal(b.status, 200, "a bystander was handed the other caller's refusal");
  assert.deepEqual(Buffer.from(await b.arrayBuffer()), ICON);
  await a.arrayBuffer();
});
