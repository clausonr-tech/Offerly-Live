import "server-only";

// Bounded concurrency + a per-domain minimum gap between requests. No new
// dependency for this: at the scale of a few hundred sources, a token-bucket
// this small is plenty, and it keeps the monitoring system from ever hitting
// one domain harder just because that domain happens to sort first in a
// priority-ordered batch.

/**
 * TWO DIFFERENT PROTECTIONS, and only one of them is about the host.
 *
 * `MIN_GAP_MS_PER_DOMAIN` is the politeness rule: one queue per domain, so a
 * host is never asked twice inside the gap however busy the crawl is. That is
 * what stops us hammering anybody, and it is per-host by construction.
 *
 * `MAX_CONCURRENT` is a cap on OUR OWN machine - sockets, memory, and the
 * browser the generic connector shares. It was 4 when the crawl was 188
 * sources processed one at a time, where it never bound. With 4,889 sources
 * across thousands of distinct hosts it is now the ceiling on the whole run,
 * and raising it parallelises across DIFFERENT domains without touching any
 * single one harder - the per-domain queue still holds.
 *
 * Overridable because the right number depends on the machine this runs on,
 * not on anything about the boards.
 *
 * Do not expect much from raising it further. Measured on 20 September 2026,
 * 60 sources each way: 90 seconds at a cap of 4, 80 seconds at 12. Only 11%,
 * because the pool stopped being the constraint once the crawl went
 * concurrent - that run did 1,492 seconds of work in 80 seconds of wall
 * clock, which is eighteen-fold parallelism. What bounds a run now is its
 * SLOWEST SINGLE SOURCE, and no amount of concurrency divides one source
 * across workers.
 */
const MAX_CONCURRENT = Number(process.env.OFFERLY_FETCH_CONCURRENCY ?? 12);
const MIN_GAP_MS_PER_DOMAIN = 2000;

/**
 * How long a domain's last-request time is remembered.
 *
 * The map used to grow for the lifetime of the process, one entry per host
 * ever fetched. That is nothing on a 106-source crawl and it is 22,575
 * entries on a directory-wide discovery run, kept forever for hosts touched
 * once. Entries older than the gap cannot affect any decision, so they are
 * dropped when the map gets large rather than kept for a rate limit that has
 * long since expired.
 */
const DOMAIN_MEMORY_LIMIT = 4096;

/**
 * Hosts that need a longer gap than the default, because they have said so.
 *
 * Not a guess. Measured 20 September 2026, across every sector rather than
 * just investment banking: all thirteen Workable sources answered 429 - nine
 * hedge funds, three venture capital firms and one real estate manager - and
 * every one of them is on `apply.workable.com`. Thirteen sources on one host
 * at a two-second gap is the crawl throttling itself, and each had already
 * logged its first failure toward being marked broken.
 *
 * A vendor that throttles is not a vendor to push harder. Keyed by host, so
 * one slow vendor does not slow the other 175 sources down with it.
 */
const VENDOR_MIN_GAP_MS: Record<string, number> = {
  "apply.workable.com": 10_000,
};

export type FetchPool = {
  run<T>(url: string, task: () => Promise<T>): Promise<T>;
  /** Live counters, for tests and for the crawl log. */
  stats(): { inFlight: number; waiting: number; domains: number };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A pool with its own limits.
 *
 * Exported as a factory so the behaviour can be tested at millisecond gaps
 * instead of the real two seconds. The module-level `pooledFetch` below is the
 * single instance the crawler actually shares.
 */
export function createFetchPool(options?: {
  maxConcurrent?: number;
  minGapMs?: number;
}): FetchPool {
  const maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT;
  const minGapMs = options?.minGapMs ?? MIN_GAP_MS_PER_DOMAIN;

  let inFlight = 0;
  const waiting: (() => void)[] = [];

  /**
   * One queue per domain, as a promise chain.
   *
   * THE BUG THIS REPLACES
   * ---------------------
   * The gap used to be enforced by reading the domain's last-request time,
   * awaiting the remainder, and only then recording a new time. Under
   * concurrency - which is the only situation the gap exists for - that does
   * nothing at all: four slots means four callers for one domain read the
   * SAME last-request time, compute the SAME wait, sleep in parallel and fire
   * simultaneously. The map was updated after the await, so none of them saw
   * the others.
   *
   * So a "2000ms minimum gap per domain" allowed four requests at once, and a
   * board that sorted first in a priority-ordered batch got hit exactly as
   * hard as if there were no limiter - the thing the header says this file
   * exists to prevent.
   *
   * Chaining makes each domain's requests wait for the previous one to have
   * STARTED, in order, which is what the gap was always meant to mean.
   *
   * ORDER AND SPACING ARE TWO RULES, AND THIS MAP ONLY CARRIES THE FIRST
   * -------------------------------------------------------------------
   * Chaining `.then(() => sleep(gap))` conflated them, and whichever side of
   * `acquireSlot()` it sat on, one of the two broke:
   *
   *   slot then gap - correct spacing, but a worker sleeps inside a slot. 58
   *                   sources on apply.workable.com at a 10s gap hold all 12
   *                   slots for two minutes and stall the other 5,044.
   *   gap then slot - no blocking, but the gap now precedes SLOT ACQUISITION
   *                   rather than the request. Under contention several
   *                   same-host callers whose gaps have long elapsed are
   *                   released in one tick and fire together: measured 0ms
   *                   apart against a 100ms rule, with 8 violations at the
   *                   real Greenhouse shape of 59 sources on one host. That
   *                   is the exact failure this file's header says it exists
   *                   to prevent, and no existing test could see it because
   *                   they all use 2-4 tasks and never contend for a slot.
   *
   * So: this map carries ORDER only, and nothing sleeps while holding it.
   * `lastIssuedAt` carries SPACING, measured against the last request that
   * was actually issued, enforced after a slot is in hand.
   */
  const domainTurn = new Map<string, Promise<void>>();
  const lastIssuedAt = new Map<string, number>();

  function domainOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      // An unparseable URL still gets a queue of its own rather than sharing
      // one with every other unparseable URL.
      return url;
    }
  }

  function gapFor(domain: string): number {
    // A vendor's own stated pace wins over the default, and over a faster
    // gap passed in by a test or a caller - the point of the override is that
    // this host cannot take the normal rate.
    return Math.max(minGapMs, VENDOR_MIN_GAP_MS[domain] ?? 0);
  }

  /**
   * Take this host's turn, in arrival order, holding no slot.
   *
   * Returns the release function: the caller invokes it once it has ISSUED,
   * which is what lets the next same-host caller start queueing for a slot.
   * Releasing before the task runs is deliberate - the rule spaces requests,
   * it does not serialise the work behind them.
   */
  async function takeDomainTurn(domain: string): Promise<() => void> {
    if (domainTurn.size > DOMAIN_MEMORY_LIMIT) {
      domainTurn.clear();
      lastIssuedAt.clear();
    }
    const prior = domainTurn.get(domain) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stored before it settles, so the next caller chains behind it.
    domainTurn.set(domain, mine);
    await prior;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        release();
      }
    };
  }

  /** Sleep out whatever is left of this host's gap since its last real issue. */
  async function awaitSpacing(domain: string): Promise<void> {
    const gap = gapFor(domain);
    // Re-measured after every wake rather than computed once: setTimeout can
    // fire a fraction early and Date.now() has millisecond resolution, which
    // showed up as 99ms spacing against a 100ms rule. Looping makes the
    // invariant independent of timer precision.
    for (;;) {
      const last = lastIssuedAt.get(domain);
      const since = last === undefined ? Infinity : Date.now() - last;
      if (since >= gap) break;
      await sleep(gap - since);
    }
    lastIssuedAt.set(domain, Date.now());
  }

  function acquireSlot(): Promise<void> {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function releaseSlot() {
    const next = waiting.shift();
    // Hand the slot straight over rather than decrementing and re-incrementing.
    if (next) next();
    else inFlight = Math.max(0, inFlight - 1);
  }

  return {
    /**
     * Turn, then slot, then spacing. All three, in that order.
     *
     * Each step holds only what it must:
     *
     *  1. `takeDomainTurn` - arrival order for this host, holding NOTHING. A
     *     slow vendor's queue therefore cannot occupy the concurrency slots
     *     while it merely waits, which is the head-of-line failure that 58
     *     sources on `apply.workable.com` at a 10-second gap used to cause
     *     for the other 5,044.
     *  2. `acquireSlot` - a slot, taken only when it is this caller's turn.
     *  3. `awaitSpacing` - the remainder of the gap since this host's last
     *     ISSUED request, which is the only measurement that makes the rule
     *     true. Usually zero, because time has already passed waiting for a
     *     slot; nonzero only when the pool is idle and the host is crowded,
     *     where holding a slot costs nothing because slots are free.
     *
     * Verified under slot contention at 12 and 4 slots with 59 sources on one
     * host - the real Greenhouse shape - where the previous arrangement
     * issued requests 0ms apart against a 100ms rule.
     */
    async run<T>(url: string, task: () => Promise<T>): Promise<T> {
      const domain = domainOf(url);
      const releaseTurn = await takeDomainTurn(domain);
      try {
        await acquireSlot();
        try {
          await awaitSpacing(domain);
          releaseTurn();
          return await task();
        } finally {
          releaseSlot();
        }
      } finally {
        // A throw anywhere above must not leave this host's queue waiting on
        // a promise that will never resolve.
        releaseTurn();
      }
    },
    stats: () => ({ inFlight, waiting: waiting.length, domains: domainTurn.size }),
  };
}

const shared = createFetchPool();

/** Runs `task` under the shared concurrency cap and this domain's rate limit. */
export function pooledFetch<T>(url: string, task: () => Promise<T>): Promise<T> {
  return shared.run(url, task);
}

/** The shared pool's counters, for the crawl log. */
export function fetchPoolStats() {
  return shared.stats();
}
