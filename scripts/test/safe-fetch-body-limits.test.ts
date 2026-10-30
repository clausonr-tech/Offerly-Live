// safeFetch and pinnedFetch (src/lib/monitoring/safe-fetch.ts): what happens
// AFTER the response headers arrive.
//
// The timeout used to be cleared the moment headers were in, and the caller's
// own AbortSignal was destructured away and never used, so the body phase ran
// with nothing armed at all. A host that answered 200 and then dripped one
// byte at a time held a fetch-pool slot (one of twelve) for the rest of the
// crawl process, and a gzip bomb expanded into memory with no cap. These
// tests pin down the deadline, the caller's signal, the byte cap, and the
// fact that an ordinary body still reads exactly as it did.
//
// No outbound network: every server here is on loopback. safeFetch refuses
// loopback addresses by design, so the tests address a documentation-range
// literal (no DNS, so nothing to resolve) and replace the transport's
// global fetch with pinnedFetch aimed at the loopback fixture - the same seam
// safe-fetch.ts already documents for the test runner.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { BodyTooLargeError, pinnedFetch, safeFetch } from "../../src/lib/monitoring/safe-fetch";
import { createFetchPool } from "../../src/lib/monitoring/fetch-pool";

let server: http.Server;
let port = 0;
let realFetch: typeof globalThis.fetch;
let bomb: Buffer;

/** The address safeFetch is asked for: a public literal, so assertPublicUrl
 *  passes it without a DNS lookup, on a port it allows. */
const PUBLIC = "http://93.184.216.34:8080";

/** Loopback is where the fixture actually is. */
const reachLoopback = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], allowed: () => true };

const drips = new Set<NodeJS.Timeout>();

before(async () => {
  bomb = zlib.gzipSync(Buffer.alloc(20_000_000, 0x61));
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/drip") {
      // Headers immediately, then one byte at a time, forever. The shape the
      // finding describes: fast to answer, never to finish.
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x");
      const timer = setInterval(() => res.write("x"), 50);
      drips.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        drips.delete(timer);
      });
    } else if (path === "/bomb") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(bomb);
    } else if (path === "/gzip-ok") {
      // A real page's worth of compressed HTML, well inside the default cap.
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(Buffer.alloc(2_000_000, 0x63)));
    } else if (path === "/flood") {
      // Uncompressed, so the cap in safeFetch is the only thing stopping it.
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(64 * 1024, 0x62);
      const timer = setInterval(() => res.write(chunk), 1);
      drips.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        drips.delete(timer);
      });
    } else if (path === "/redirect-drip") {
      // A redirect whose body never ends. Nobody reads a redirect body, and
      // an unread one holds the socket open.
      res.writeHead(302, { location: "/ok", "content-type": "text/plain" });
      res.write("ignore me");
      const timer = setInterval(() => res.write("x"), 50);
      drips.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        drips.delete(timer);
      });
    } else res.end("plain");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  // safe-fetch.ts uses globalThis.fetch as its transport under the test
  // runner. Pointed at the fixture through pinnedFetch, which honours the
  // signal safeFetch hands it.
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const target = new URL(href);
    return pinnedFetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init ?? {}, reachLoopback);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const timer of drips) clearInterval(timer);
  server.closeAllConnections();
  server.close();
});

test("a body that drips forever is cut off by the body deadline, not left to hang", { timeout: 10000 }, async () => {
  const started = Date.now();
  const res = await safeFetch(`${PUBLIC}/drip`, { timeoutMs: 5000, bodyTimeoutMs: 400 });
  assert.equal(res.status, 200, "headers arrive fast - the stall is in the body");
  await assert.rejects(res.text(), "the read ends instead of hanging");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `ended in ${elapsed}ms, so it was the body deadline and not the header timeout`);
});

test("the caller's own signal is honoured, not dropped", { timeout: 10000 }, async () => {
  // workday, oracle-hcm, eightfold and icims all pass a signal like this.
  const controller = new AbortController();
  const res = await safeFetch(`${PUBLIC}/drip`, { signal: controller.signal, timeoutMs: 5000, bodyTimeoutMs: 60_000 });
  const reading = res.text();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(reading, "the caller's abort reaches the body read");
});

test("a signal already aborted never gets a body at all", { timeout: 10000 }, async () => {
  await assert.rejects(
    (async () => {
      const res = await safeFetch(`${PUBLIC}/drip`, { signal: AbortSignal.abort(), bodyTimeoutMs: 60_000 });
      await res.text();
    })(),
  );
});

test("a body past its byte cap is refused while it arrives", { timeout: 10000 }, async () => {
  const res = await safeFetch(`${PUBLIC}/flood`, { maxBytes: 200_000, bodyTimeoutMs: 8000 });
  await assert.rejects(res.text(), (err: Error) => {
    assert.match(err.message, /exceeded 200000 bytes|aborted|terminated/i);
    return true;
  });
});

test("a gzip bomb dies at the decoder, before it is anyone's string", { timeout: 10000 }, async () => {
  // 20MB of 'a' in a ~20KB response. Capped on what comes OUT of the
  // decoder, which is the only place the asymmetry is visible.
  const res = await pinnedFetch(`http://test.example:${port}/bomb`, { maxBytes: 100_000 }, reachLoopback);
  await assert.rejects(res.text());

  // And through safeFetch, whose own cap covers every encoding.
  const viaSafe = await safeFetch(`${PUBLIC}/bomb`, { maxBytes: 100_000, bodyTimeoutMs: 8000 });
  await assert.rejects(viaSafe.text());

  // 20MB is past the default cap too, so the bomb does not need a caller
  // who thought to ask for a smaller one.
  const byDefault = await safeFetch(`${PUBLIC}/bomb`, { bodyTimeoutMs: 8000 });
  await assert.rejects(byDefault.text());

  // And a real page's worth of compressed HTML still decompresses whole.
  const allowed = await safeFetch(`${PUBLIC}/gzip-ok`, { bodyTimeoutMs: 8000 });
  assert.equal((await allowed.text()).length, 2_000_000, "an ordinary gzip body is untouched");
});

test("an ordinary body, and a redirect, still behave exactly as before", { timeout: 10000 }, async () => {
  const res = await safeFetch(`${PUBLIC}/ok`, { timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "plain");

  // The redirect's own endless body is cancelled rather than waited on, so
  // following the hop is as fast as the hop itself.
  const started = Date.now();
  const hop = await safeFetch(`${PUBLIC}/redirect-drip`, { timeoutMs: 5000, bodyTimeoutMs: 5000 });
  assert.equal(await hop.text(), "plain", "the redirect was followed and re-checked");
  assert.ok(Date.now() - started < 4000, "the unread redirect body did not hold the hop open");
});

test("a stalled body frees its fetch-pool slot instead of leaking it", { timeout: 15000 }, async () => {
  // The harm the finding describes is not one slow host: it is that each
  // stalled body kept one of twelve slots for the rest of the process, so
  // later sources starved on acquireSlot and burned their budgets waiting.
  const pool = createFetchPool({ maxConcurrent: 2, minGapMs: 0 });
  const stall = (path: string) =>
    pool.run(`${PUBLIC}${path}`, async () => {
      const res = await safeFetch(`${PUBLIC}${path}`, { timeoutMs: 5000, bodyTimeoutMs: 300 });
      return res.text();
    });

  const first = stall("/drip").then(
    () => "finished",
    () => "cut off",
  );
  const second = stall("/drip").then(
    () => "finished",
    () => "cut off",
  );
  const third = pool
    .run(`${PUBLIC}/ok`, async () => (await safeFetch(`${PUBLIC}/ok`, { timeoutMs: 5000 })).text())
    .then((text) => text);

  assert.deepEqual(await Promise.all([first, second, third]), ["cut off", "cut off", "plain"]);
  assert.equal(pool.stats().inFlight, 0, "every slot came back");
});

test("BodyTooLargeError is what the cap raises", () => {
  assert.match(new BodyTooLargeError(5).message, /exceeded 5 bytes/);
});
