// Ask the ATS vendors where each firm's job board is.
//
// The gap this closes: 20,663 of 22,575 directory rows have no careers URL at
// all, so `discover-boards.ts` - which finds boards by reading links off a
// careers page - has nothing to read. Venture capital is the extreme case at
// 2,149 firms, 1,863 websites and zero careers URLs.
//
// This asks instead. Board tokens on these platforms are derived from the
// company's own name, and each platform's public API answers 404 for a token
// that does not exist, so a 200 is proof rather than an inference. See
// src/lib/monitoring/ats-probe.ts for why a 200 is not automatically proof on
// every platform, and which ones are therefore excluded.
//
// NO DATABASE. Reads the directory from JSON and writes a proposals file.
// Two reasons: PGlite is single-writer and this repo has lost a database to
// that once, so a long network job has no business holding the lock; and
// writing sources is a reviewed step, exactly as discover-boards.ts treats it.
//
//   npx tsx --conditions=react-server scripts/probe-boards.ts --limit 500
//   npx tsx --conditions=react-server scripts/probe-boards.ts --category venture_capital --limit 200
//
// Then read the report, and apply it with scripts/apply-probed-boards.ts.
import { writeFileSync } from "fs";
import { candidateTokens, probablePlatforms, type ProbePlatform } from "../src/lib/monitoring/ats-probe";
import bulkFirmRows from "../src/lib/firm-seeds-bulk.json";

type FirmRow = {
  slug: string;
  name: string;
  website: string | null;
  careersUrl: string | null;
  category: string;
};

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 12000;

/** Politeness, per vendor host rather than globally: the platforms are
 *  independent services and serialising all of them behind one gap would make
 *  a sweep six times slower for no benefit to anyone. */
const PER_HOST_GAP_MS = 150;

/** How many firms are probed at once. Deliberately small - the point is to
 *  finish, not to be the loudest client these APIs see today. */
const CONCURRENCY = 4;

/**
 * Throttling is answered by SLOWING DOWN, not by giving up.
 *
 * The first version dropped a host for the rest of the run after 8
 * consecutive inconclusive answers. Measured on the 2,882-firm private equity
 * sweep, that produced 1,298 firms - 45% - with no answer at all, because once
 * a vendor started 429ing every subsequent firm inherited the give-up. The
 * reported 1.0% hit rate was a floor, not a finding, and a sweep whose
 * negatives are mostly "we stopped asking" is worse than no sweep: it looks
 * like coverage data.
 *
 * So a host that throttles gets a longer gap, doubling up to a ceiling, and
 * recovers as soon as it answers cleanly again. Nothing is abandoned.
 */
const BACKOFF_FACTOR = 2;
const MAX_HOST_GAP_MS = 4000;

/**
 * How long the retry pass may take, in total.
 *
 * The retry exists so a throttled firm ends with a real answer rather than a
 * confident false negative. It is not worth unbounded time: a vendor that is
 * still refusing after this long will refuse for the rest of the run too, and
 * the honest record is "still unanswered" rather than a sweep that never
 * finishes. Measured need: the private equity run left 1,298 firms to retry.
 */
const RETRY_BUDGET_MS = 10 * 60 * 1000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const LIMIT = Number(arg("limit") ?? 500);
const OFFSET = Number(arg("offset") ?? 0);
const CATEGORY = arg("category");
const MAX_TOKENS = Number(arg("tokens") ?? 2);
const OUT = arg("out") ?? "scripts/data/probed-boards.json";

/** One in-flight request per host at a time, with a gap between them. */
class HostQueue {
  private next = new Map<string, number>();
  private gap = new Map<string, number>();

  /** The current gap for a host - its platform default, widened by any
   *  throttling we have seen. */
  gapFor(host: string, baseGap: number): number {
    return Math.max(baseGap, this.gap.get(host) ?? 0);
  }

  /** A 429 means ask more slowly; a clean answer means we may speed back up.
   *  Recovery is gradual rather than immediate, so one lucky response does not
   *  undo a backoff the vendor is still enforcing. */
  observe(host: string, inconclusive: boolean, baseGap: number) {
    const current = this.gap.get(host) ?? baseGap;
    if (inconclusive) {
      this.gap.set(host, Math.min(current * BACKOFF_FACTOR, MAX_HOST_GAP_MS));
    } else if (current > baseGap) {
      this.gap.set(host, Math.max(baseGap, Math.round(current / BACKOFF_FACTOR)));
    }
  }

  /** `gap` is per platform: Personio needs seconds where Greenhouse is happy
   *  with milliseconds, and one global number means either being rude to one
   *  vendor or needlessly slow for the rest. */
  async wait(host: string, gap: number) {
    const now = Date.now();
    const earliest = this.next.get(host) ?? 0;
    const delay = Math.max(0, earliest - now);
    this.next.set(host, Math.max(now, earliest) + gap);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

const queue = new HostQueue();

async function ask(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json, application/xml, text/xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    // Never truncated before parsing - a sliced JSON document fails to parse
    // and the board reads as empty. That bug cost a false FAIL on Ashby, whose
    // board is 73 postings and well past any sane cap.
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

type Hit = {
  slug: string;
  name: string;
  category: string;
  platform: string;
  connectorId: string | null;
  token: string;
  boardUrl: string;
  listings: number;
};

type Miss = {
  slug: string;
  name: string;
  category: string;
  reason: string;
  /**
   * The platforms that never answered for this firm.
   *
   * Recorded per platform rather than per firm because one throttling vendor
   * should not invalidate six clean answers. On the real estate run, 370 of
   * 420 firms were reported as "needs a re-run" when in most cases a single
   * platform had 429'd and the rest had returned honest 404s - so the retry
   * re-probed every platform for 88% of the sweep to re-learn what it already
   * knew.
   */
  unansweredPlatforms?: string[];
};

async function probeFirm(
  firm: FirmRow,
  platforms: ProbePlatform[],
  /** When set, only these platforms are asked - used by the retry pass so a
   *  firm is not re-probed on platforms that already gave a clean answer. */
  onlyPlatforms?: string[],
): Promise<{ hit: Hit | null; miss: Miss | null; requests: number }> {
  const tokens = candidateTokens(firm.website, firm.name).slice(0, MAX_TOKENS);
  if (!tokens.length) {
    return {
      hit: null,
      miss: { ...firm, reason: "no usable token could be derived from the domain or name" },
      requests: 0,
    };
  }

  const askable = onlyPlatforms
    ? platforms.filter((p) => onlyPlatforms.includes(p.name))
    : platforms;

  let requests = 0;
  const unansweredPlatforms = new Set<string>();

  // Token-major: the domain label is tried on every platform before any odder
  // variant is tried anywhere.
  for (const token of tokens) {
    for (const platform of askable) {
      const url = platform.probeUrl(token);
      const host = new URL(url).host;
      const baseGap = platform.minGapMs ?? PER_HOST_GAP_MS;

      await queue.wait(host, queue.gapFor(host, baseGap));
      const response = await ask(url);
      requests += 1;

      const outcome = platform.interpret(response.status, response.body);
      queue.observe(host, outcome.inconclusive === true, baseGap);
      if (outcome.inconclusive) {
        unansweredPlatforms.add(platform.name);
        continue;
      }
      // A clean answer clears an earlier failure on the same platform - the
      // second token may have gone through after a backoff.
      unansweredPlatforms.delete(platform.name);

      if (outcome.found) {
        // First hit wins and the firm is done. A firm on two platforms is
        // recorded on the one we can read, which is what PROBE_PLATFORMS'
        // ordering already guarantees.
        return {
          hit: {
            slug: firm.slug,
            name: firm.name,
            category: firm.category,
            platform: platform.name,
            connectorId: platform.connectorId,
            token,
            boardUrl: platform.boardUrl(token),
            listings: outcome.listings,
          },
          miss: null,
          requests,
        };
      }
    }
  }

  return {
    hit: null,
    miss: {
      slug: firm.slug,
      name: firm.name,
      category: firm.category,
      // The distinction matters: "asked and told no" is a finding, while
      // "never got an answer" is a job to redo. Collapsing them is how a
      // throttled sweep turns into a directory full of confident negatives.
      reason: unansweredPlatforms.size
        ? `inconclusive - ${[...unansweredPlatforms].join(", ")} never answered`
        : `no board on ${askable.length} platforms for ${tokens.join(", ")}`,
      unansweredPlatforms: unansweredPlatforms.size ? [...unansweredPlatforms] : undefined,
    },
    requests,
  };
}

async function main() {
  const platforms = probablePlatforms();
  if (!platforms.length) {
    console.error(
      "No platform is marked provenDiscriminating. Run scripts/ats-probe-live-check.ts first -\n" +
        "probing with an unverified platform is how thousands of sources get invented.",
    );
    process.exit(1);
  }

  const all = bulkFirmRows as FirmRow[];
  const candidates = all
    .filter((f) => f.website)
    .filter((f) => !f.careersUrl) // a firm that already has a board needs no probe
    .filter((f) => !CATEGORY || f.category === CATEGORY)
    .slice(OFFSET, OFFSET + LIMIT);

  console.log(
    `Probing ${candidates.length} firms across ${platforms.length} platforms ` +
      `(${platforms.map((p) => p.name).join(", ")}), up to ${MAX_TOKENS} tokens each.`,
  );
  console.log(`Worst case ${candidates.length * MAX_TOKENS * platforms.length} requests.\n`);

  const hits: Hit[] = [];
  const misses: Miss[] = [];
  let requests = 0;
  let done = 0;

  // A fixed pool of workers pulling from one list, rather than batches: a
  // batch runs at the speed of its slowest firm and leaves the pool idle.
  const cursor = { i: 0 };
  async function worker() {
    for (;;) {
      const index = cursor.i++;
      if (index >= candidates.length) return;
      const firm = candidates[index];
      const result = await probeFirm(firm, platforms);
      requests += result.requests;
      if (result.hit) {
        hits.push(result.hit);
        console.log(
          `  + ${result.hit.name} -> ${result.hit.platform} "${result.hit.token}" ` +
            `(${result.hit.listings} listings)`,
        );
      } else if (result.miss) {
        misses.push(result.miss);
      }
      done += 1;
      if (done % 50 === 0) {
        console.log(`  ... ${done}/${candidates.length} firms, ${requests} requests, ${hits.length} boards`);
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  /**
   * Anything still unanswered is asked again, once, at whatever pace the
   * backoff has settled on.
   *
   * Without this a throttled stretch leaves firms recorded as "no board on 6
   * platforms" when the truth is that nobody ever answered - a false negative
   * carrying a confident reason, which is precisely the shape that hid 59 real
   * internships. A retry costs one more pass over a minority of firms and
   * turns most of them into a real yes or no.
   */
  const unanswered = misses.filter((m) => m.reason.startsWith("inconclusive"));
  if (unanswered.length) {
    console.log(`\n  retrying ${unanswered.length} firms that never got an answer...`);
    const bySlug = new Map(candidates.map((f) => [f.slug, f]));
    const stillUnanswered: Miss[] = [];
    const retryStarted = Date.now();
    const retryCursor = { i: 0 };

    /**
     * The retry uses the SAME worker pool as the main pass.
     *
     * The first version was a plain sequential loop, which on the private
     * equity run meant 1,298 firms single-threaded at up to eight seconds a
     * request - hours, for a pass meant to take minutes. A retry that never
     * finishes is not a retry.
     */
    async function retryWorker() {
      for (;;) {
        if (Date.now() - retryStarted > RETRY_BUDGET_MS) return;
        const index = retryCursor.i++;
        if (index >= unanswered.length) return;
        const firm = bySlug.get(unanswered[index].slug);
        if (!firm) continue;
        // Only the platforms that failed - the rest already answered.
        const result = await probeFirm(firm, platforms, unanswered[index].unansweredPlatforms);
        requests += result.requests;
        if (result.hit) {
          hits.push(result.hit);
          console.log(`  + ${result.hit.name} -> ${result.hit.platform} "${result.hit.token}"`);
        } else if (result.miss?.reason.startsWith("inconclusive")) {
          stillUnanswered.push(result.miss);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, retryWorker));

    // Firms the budget never reached keep their first-pass verdict, which is
    // already "inconclusive" - so they are reported as unanswered rather than
    // silently becoming negatives.
    const attempted = new Set(unanswered.slice(0, retryCursor.i).map((m) => m.slug));
    const resolved = misses.filter((m) => !attempted.has(m.slug));
    misses.length = 0;
    misses.push(...resolved, ...stillUnanswered);
    console.log(
      `  retry left ${stillUnanswered.length} still unanswered` +
        `${retryCursor.i < unanswered.length ? `, ${unanswered.length - retryCursor.i} not reached within the budget` : ""}.`,
    );
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);

  const byCategory: Record<string, { firms: number; found: number }> = {};
  for (const firm of candidates) {
    byCategory[firm.category] ??= { firms: 0, found: 0 };
    byCategory[firm.category].firms += 1;
  }
  for (const hit of hits) byCategory[hit.category].found += 1;

  const byPlatform: Record<string, number> = {};
  for (const hit of hits) byPlatform[hit.platform] = (byPlatform[hit.platform] ?? 0) + 1;

  const inconclusive = misses.filter((m) => m.reason.startsWith("inconclusive")).length;

  const report = {
    generatedAt: new Date().toISOString(),
    platforms: platforms.map((p) => p.name),
    firmsProbed: candidates.length,
    requests,
    seconds,
    hits,
    misses,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`\n${hits.length} boards found from ${candidates.length} firms in ${seconds}s (${requests} requests).`);
  console.log(`${inconclusive} firms need a re-run (no answer, not a negative).`);
  console.log("\nby platform:");
  for (const [name, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }
  console.log("\nby category (found / probed):");
  for (const [name, c] of Object.entries(byCategory).sort((a, b) => b[1].found - a[1].found)) {
    const rate = c.firms ? ((c.found / c.firms) * 100).toFixed(1) : "0.0";
    console.log(`  ${String(c.found).padStart(5)} / ${String(c.firms).padEnd(6)} ${rate.padStart(5)}%  ${name}`);
  }
  console.log(`\nwritten to ${OUT}`);
  process.exit(0);
}

main();
