// Politeness: how hard the crawler is allowed to hit one host.
//
// This had no tests, and the per-domain gap did not work. It read a domain's
// last-request time, awaited the remainder, and only then recorded a new one -
// so under concurrency, which is the only situation it exists for, four
// callers for one domain read the SAME timestamp, slept in parallel and fired
// together. A "2000ms minimum gap per domain" permitted four simultaneous
// requests.
//
// Tested through createFetchPool so the gaps can be milliseconds. The shared
// pooledFetch is the same code with the real limits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchPool, pooledFetch, fetchPoolStats } from "../../src/lib/monitoring/fetch-pool";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Records when each task started, relative to the first. */
function recorder() {
  const starts: { url: string; at: number }[] = [];
  let origin = 0;
  return {
    starts,
    task: (url: string, duration = 0) => async () => {
      if (!origin) origin = Date.now();
      starts.push({ url, at: Date.now() - origin });
      if (duration) await sleep(duration);
      return url;
    },
  };
}

// ------------------------------------------------------- the per-domain gap

test("two requests to one domain are separated by the gap", async () => {
  /**
   * 200ms with 50ms of slack, not 60ms with 10ms.
   *
   * The property is unchanged - a host is never asked twice inside the gap -
   * but the measurement is taken inside the task, which is the request
   * moment and therefore subject to event-loop scheduling. A 10ms tolerance
   * on a 60ms interval is below the noise floor of a loaded machine: this
   * passed 12 times out of 12 on its own and failed at "48ms apart" during a
   * full 22,112-test run, where the FIRST task's recorded start slips later
   * under congestion and compresses the measured interval from the wrong end.
   *
   * Raising the gap rather than lowering the threshold keeps the assertion
   * meaningful - 50ms of absolute slack is comfortably above scheduling
   * noise, where 10ms is not - and costs 140ms of test time.
   */
  const pool = createFetchPool({ minGapMs: 200, maxConcurrent: 4 });
  const r = recorder();
  await Promise.all([
    pool.run("https://a.com/1", r.task("1")),
    pool.run("https://a.com/2", r.task("2")),
  ]);
  assert.equal(r.starts.length, 2);
  const apart = r.starts[1].at - r.starts[0].at;
  assert.ok(apart >= 150, `only ${apart}ms apart`);
});

test("four concurrent requests to ONE domain do not fire together", async () => {
  // The bug, exactly. Four slots and one domain used to mean four at once.
  const pool = createFetchPool({ minGapMs: 40, maxConcurrent: 4 });
  const r = recorder();
  await Promise.all(
    [1, 2, 3, 4].map((n) => pool.run(`https://a.com/${n}`, r.task(String(n)))),
  );
  assert.equal(r.starts.length, 4);
  const spread = r.starts[3].at - r.starts[0].at;
  assert.ok(spread >= 100, `all four started within ${spread}ms of each other`);
});

test("requests to one domain keep their order", async () => {
  const pool = createFetchPool({ minGapMs: 20, maxConcurrent: 4 });
  const r = recorder();
  await Promise.all(
    ["a", "b", "c"].map((n) => pool.run(`https://one.com/${n}`, r.task(n))),
  );
  assert.deepEqual(r.starts.map((s) => s.url), ["a", "b", "c"]);
});

test("different domains are not slowed by each other", async () => {
  // The gap is per domain. Serialising everything would make the crawl take
  // as long as the sum of its parts.
  const pool = createFetchPool({ minGapMs: 80, maxConcurrent: 4 });
  const r = recorder();
  const started = Date.now();
  await Promise.all([
    pool.run("https://a.com/", r.task("a")),
    pool.run("https://b.com/", r.task("b")),
    pool.run("https://c.com/", r.task("c")),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 80 * 3, `three domains took ${elapsed}ms - they were serialised`);
});

test("subdomains are separate hosts", async () => {
  const pool = createFetchPool({ minGapMs: 80, maxConcurrent: 4 });
  const started = Date.now();
  await Promise.all([
    pool.run("https://a.example.com/", async () => 1),
    pool.run("https://b.example.com/", async () => 2),
  ]);
  assert.ok(Date.now() - started < 160);
});

test("the host is matched case-insensitively", async () => {
  const pool = createFetchPool({ minGapMs: 60, maxConcurrent: 4 });
  const r = recorder();
  await Promise.all([
    pool.run("https://A.com/1", r.task("1")),
    pool.run("https://a.com/2", r.task("2")),
  ]);
  assert.ok(r.starts[1].at - r.starts[0].at >= 50, "same host in different case shared no gap");
});

test("a port or path does not split a domain's queue", async () => {
  const pool = createFetchPool({ minGapMs: 60, maxConcurrent: 4 });
  const r = recorder();
  await Promise.all([
    pool.run("https://a.com:443/one", r.task("1")),
    pool.run("https://a.com/two?x=1", r.task("2")),
  ]);
  assert.ok(r.starts[1].at - r.starts[0].at >= 50);
});

// ------------------------------------------------------------- concurrency

test("no more than maxConcurrent tasks run at once", async () => {
  const pool = createFetchPool({ minGapMs: 0, maxConcurrent: 3 });
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      pool.run(`https://d${i}.com/`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(15);
        running -= 1;
      }),
    ),
  );
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "nothing ran in parallel at all");
});

test("a slot is released even when the task throws", async () => {
  // Otherwise one failing board permanently costs the crawl a slot, and four
  // failures stop it dead.
  const pool = createFetchPool({ minGapMs: 0, maxConcurrent: 2 });
  for (let i = 0; i < 6; i++) {
    await pool.run(`https://x${i}.com/`, async () => {
      throw new Error("boom");
    }).catch(() => {});
  }
  assert.equal(pool.stats().inFlight, 0, "slots leaked after failures");
  const finished = await pool.run("https://after.com/", async () => "ok");
  assert.equal(finished, "ok");
});

test("the error is propagated, not swallowed", async () => {
  const pool = createFetchPool({ minGapMs: 0 });
  await assert.rejects(
    () => pool.run("https://a.com/", async () => { throw new Error("the real reason"); }),
    /the real reason/,
  );
});

test("the task's return value comes back unchanged", async () => {
  const pool = createFetchPool({ minGapMs: 0 });
  assert.deepEqual(await pool.run("https://a.com/", async () => ({ n: 1 })), { n: 1 });
});

test("waiting tasks all eventually run", async () => {
  const pool = createFetchPool({ minGapMs: 0, maxConcurrent: 2 });
  const done: number[] = [];
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      pool.run(`https://d${i}.com/`, async () => {
        await sleep(2);
        done.push(i);
      }),
    ),
  );
  assert.equal(done.length, 20);
  assert.equal(pool.stats().inFlight, 0);
  assert.equal(pool.stats().waiting, 0);
});

test("slots settle back to zero after a mixed batch", async () => {
  const pool = createFetchPool({ minGapMs: 0, maxConcurrent: 2 });
  await Promise.all([
    pool.run("https://a.com/", async () => "ok"),
    pool.run("https://b.com/", async () => { throw new Error("x"); }).catch(() => {}),
    pool.run("https://c.com/", async () => "ok"),
  ]);
  assert.equal(pool.stats().inFlight, 0);
});

// ------------------------------------------------------------ degenerate input

test("an unparseable URL still gets a queue rather than crashing", async () => {
  const pool = createFetchPool({ minGapMs: 0 });
  assert.equal(await pool.run("not a url", async () => "ok"), "ok");
  assert.equal(await pool.run("", async () => "ok"), "ok");
});

test("two unparseable URLs do not share one queue by accident", async () => {
  // Grouping every malformed URL under one key would serialise unrelated work.
  const pool = createFetchPool({ minGapMs: 80, maxConcurrent: 4 });
  const started = Date.now();
  await Promise.all([
    pool.run("garbage one", async () => 1),
    pool.run("garbage two", async () => 2),
  ]);
  assert.ok(Date.now() - started < 160);
});

test("the domain map does not grow without bound", async () => {
  // One entry per host ever fetched is nothing on a 106-source crawl and
  // 22,575 on a directory-wide discovery run.
  const pool = createFetchPool({ minGapMs: 0, maxConcurrent: 8 });
  for (let i = 0; i < 5000; i++) {
    await pool.run(`https://host${i}.example.com/`, async () => i);
  }
  assert.ok(pool.stats().domains <= 4096 + 1, `map held ${pool.stats().domains} domains`);
});

// ---------------------------------------------------------- the shared pool

test("the shared pool works and reports its counters", async () => {
  assert.equal(await pooledFetch("https://shared.example.com/", async () => "ok"), "ok");
  const stats = fetchPoolStats();
  assert.equal(typeof stats.inFlight, "number");
  assert.equal(typeof stats.waiting, "number");
  assert.ok(stats.inFlight >= 0);
});

test("the shared pool is a single instance across callers", async () => {
  // Two callers must contend for the same slots, or the cap means nothing.
  const before = fetchPoolStats().domains;
  await pooledFetch("https://shared2.example.com/", async () => "ok");
  assert.ok(fetchPoolStats().domains >= before);
});

test("a slow domain's queue does not occupy every concurrency slot", async () => {
  /**
   * HEAD-OF-LINE BLOCKING, AND WHY IT IS THIS POOL'S WORST CASE.
   *
   * `run()` used to take a concurrency slot and THEN wait out the domain gap,
   * so a worker sat in a slot doing nothing but sleeping. That is harmless
   * when one source per host is in flight and ruinous at this crawl's shape:
   * 58 of the 5,102 sources are on `apply.workable.com`, which has a
   * hand-set 10-second gap because it answers 429 at the default. Twelve of
   * them chained behind each other hold every slot in the pool, asleep, for
   * two minutes - and the other 5,044 sources wait on a vendor they have
   * nothing to do with.
   *
   * Sleeping outside a slot costs nothing, so the gap is waited out first.
   */
  const pool = createFetchPool({ minGapMs: 100, maxConcurrent: 2 });
  // Timed from the call, not from the first recorded start: the shared
  // recorder's origin is whenever the FIRST task ran, which hides exactly the
  // delay being measured here.
  const started = Date.now();
  let fastAt = Infinity;
  const at = () => Date.now() - started;
  await Promise.all([
    // Three on one slow host: the gap chains them whatever we do.
    pool.run("https://slow.com/1", async () => {}),
    pool.run("https://slow.com/2", async () => {}),
    pool.run("https://slow.com/3", async () => {}),
    // One on a host of its own. It needs a slot, not permission from slow.com.
    pool.run("https://fast.com/", async () => {
      fastAt = at();
    }),
  ]);

  assert.ok(
    fastAt < 250,
    `fast.com started at ${fastAt}ms, behind a queue on another host - the slots were held by sleepers`,
  );
});

test("the per-host gap holds when the CONCURRENCY CAP is the bottleneck", async () => {
  /**
   * The condition every other test in this file misses.
   *
   * They all run 2-4 tasks against maxConcurrent 4, so no task ever waits for
   * a slot - and waiting for a slot is precisely when the gap can be bypassed.
   * With the gap waited out before the slot, several same-host callers whose
   * gaps elapsed long ago are released in one tick and fire together: this
   * configuration measured requests 0ms apart against a 100ms rule, 8
   * violations at the real Greenhouse shape of 59 sources on one host.
   *
   * The gap is a promise about REQUESTS, so it is measured at the request.
   */
  const GAP = 60;
  const pool = createFetchPool({ minGapMs: GAP, maxConcurrent: 4 });
  const issuedAt: number[] = [];
  const t0 = Date.now();

  await Promise.all([
    // Many on one host...
    ...Array.from({ length: 12 }, (_, i) =>
      pool.run(`https://one.com/${i}`, async () => {
        issuedAt.push(Date.now() - t0);
      }),
    ),
    // ...plus enough other hosts to keep all four slots busy, so the same-host
    // callers are queued rather than running as they arrive.
    ...Array.from({ length: 40 }, (_, i) =>
      pool.run(`https://other${i}.com/`, () => sleep(20)),
    ),
  ]);

  assert.equal(issuedAt.length, 12);
  issuedAt.sort((a, b) => a - b);
  const gaps = issuedAt.slice(1).map((t, i) => t - issuedAt[i]);
  const worst = Math.min(...gaps);
  /**
   * `GAP - 2`, not `GAP`, and the two milliseconds are measurement not slack.
   *
   * `awaitSpacing` re-checks the elapsed time after every wake, so the pool
   * cannot issue two requests to one host inside the gap. But both the pool's
   * clock and this test's are `Date.now()`, at millisecond resolution, so a
   * true 60ms interval can read as 59 - which is exactly how this failed
   * during a full 22,171-test run while passing 21 of 21 on its own.
   *
   * The regression this test exists for measured ZERO milliseconds apart, so
   * a two-millisecond tolerance costs it nothing: it is three orders of
   * magnitude away from the failure being caught.
   */
  assert.ok(
    worst >= GAP - 2,
    `two requests to one.com were issued ${worst}ms apart, under the ${GAP}ms gap`,
  );
});

test("one crowded host does not stall hosts it has nothing to do with", async () => {
  // The other half of the same rule, at the shape that caused it: a vendor
  // host with many sources must not consume the slots while it waits its turn.
  const pool = createFetchPool({ minGapMs: 150, maxConcurrent: 3 });
  const t0 = Date.now();
  let unrelatedAt = Infinity;

  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) =>
      pool.run(`https://crowded.com/${i}`, async () => {}),
    ),
    pool.run("https://unrelated.com/", async () => {
      unrelatedAt = Date.now() - t0;
    }),
  ]);

  assert.ok(
    unrelatedAt < 300,
    `unrelated.com waited ${unrelatedAt}ms behind crowded.com's queue`,
  );
});
