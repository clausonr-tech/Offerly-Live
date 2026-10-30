// Point every posting's "Apply" at a form a student can actually fill in.
//
// Measured on 21 September 2026: 861 of 879 published postings carried an
// application_url byte-identical to source_url. The crawler now derives a
// real one going forward (src/lib/monitoring/apply-url.ts, wired in at
// scripts/monitor-run.ts), and this repairs what is already stored.
//
// NOTHING IS WRITTEN ON A GUESS
// -----------------------------
// A derived url is a hypothesis about a board's URL shape, so every candidate
// is FETCHED before it is stored, and one that does not resolve is thrown
// away in favour of the link that is already there. The worst outcome of a
// wrong pattern is a wasted request.
//
// The existing link is checked too, which is the other half of the report:
// a posting whose advert is itself dead cannot be repaired from here - there
// is no better url to move it to - so those are listed for a human rather
// than quietly left looking fixed.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/fix-apply-urls.ts
//   ... --apply
//   ... --listings        also repair detected_listings (6k+ requests, slow)
//   ... --limit=50        stop after N rows, for a quick look
//
// Read-only without --apply, and it never writes a url it has not just seen
// answer.
//
// CRAWLER ROWS ONLY, AND NOT A PLAIN FETCH
// ----------------------------------------
// Both halves of this were wrong until 10 October 2026 (security review).
//
// The select had no origin predicate, so it covered origin='firm' rows too -
// whose source_url and application_url are whatever a recruiter typed into the
// firm portal, accepted by cleanUrl as any http(s) URL at all. This script
// then requested every one of them from the OPERATOR'S machine with
// `fetch(redirect: "follow")`: a firm could point a posting at
// http://127.0.0.1:9200/ or an internal host and have the operator's laptop
// make the request. And the update was keyed on id alone, so a firm-authored
// row on a known ATS host could have its application_url rewritten, against
// the standing rule that scripts never change what a firm wrote
// (retire-off-profession-postings.ts).
//
// So: `origin = 'crawler'` on the select AND on the update, and every probe
// goes through `safeFetch`, which refuses private, loopback, link-local and
// reserved addresses, re-checks every redirect hop by hand, and pins the
// address it checked to the socket it connects (src/lib/monitoring/safe-fetch.ts).
// Nothing about the repair itself changes for the rows this is actually for.
import type postgres from "postgres";
import { createPostgresClient } from "../src/db/connection";
import { deriveApplyUrl } from "../src/lib/monitoring/apply-url";
import { safeFetch } from "../src/lib/monitoring/safe-fetch";

const APPLY = process.argv.includes("--apply");
const WITH_LISTINGS = process.argv.includes("--listings");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0) || null;

/** Polite: boards throttle, and there is no hurry on a one-off repair. */
const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;
const PER_HOST_DELAY_MS = 400;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

type Row = { id: string; listing: string; current: string | null };

/**
 * Three answers, not two.
 *
 * The first version of this returned a boolean and reported 563 of 818 links
 * dead. They were not. www.rbccm.com/en/careers/campus-recruiting answers 503
 * to HEAD and 200 to GET, and the code only retried with GET on 405/403/400,
 * so a live page was recorded as dead. Worse, 87 requests fired at one
 * TalentLink host inside a few seconds drew timeouts that were counted the
 * same way. A checker that cannot tell "broken" from "would not talk to me"
 * produces confident nonsense, so it now says "unknown" and nothing is
 * concluded from it.
 *
 * HEAD is an optimisation and never a verdict: only a 2xx from it is
 * believed, and every other outcome falls through to GET.
 */
type Liveness = "ok" | "dead" | "unknown";

async function probe(url: string, method: "HEAD" | "GET"): Promise<{ status: number } | { error: true }> {
  try {
    // safeFetch, not fetch: see CRAWLER ROWS ONLY above. It follows redirects
    // itself, re-checking each hop, which is why `redirect` is not set here -
    // `redirect: "follow"` is precisely the hole a 302 walks through.
    const res = await safeFetch(url, {
      method,
      timeoutMs: TIMEOUT_MS,
      headers: { "user-agent": UA, accept: "text/html,*/*", "accept-language": "en-US,en;q=0.9" },
    });
    // Nothing reads the body, and an undrained one holds the socket open.
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch {
    // A refused address lands here with everything else, which is the right
    // answer: "unknown", so nothing is concluded and nothing is written.
    return { error: true };
  }
}

async function resolves(url: string): Promise<Liveness> {
  const head = await probe(url, "HEAD");
  if ("status" in head && head.status >= 200 && head.status < 300) return "ok";

  // Anything else about HEAD is uninformative. Ask properly.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    const get = await probe(url, "GET");
    if ("error" in get) continue; // timeout or refusal: retry once, then unknown
    if (get.status >= 200 && get.status < 300) return "ok";
    // Only the server saying "this is not here" counts as dead. A 403 is bot
    // protection, a 429 is us, a 5xx is their bad afternoon - none of those
    // are a broken link, and treating them as one is what went wrong before.
    if (get.status === 404 || get.status === 410) return "dead";
    return "unknown";
  }
  return "unknown";
}

/**
 * One request at a time per host, spaced out.
 *
 * The boards being checked are the same few tenants over and over - 125
 * listings share one TalentLink host - so a flat concurrency limit points the
 * whole budget at one server and gets throttled. Work is grouped by host,
 * hosts run in parallel, and each host is walked sequentially.
 */
async function byHost<T>(items: T[], hostOf: (item: T) => string, worker: (item: T) => Promise<void>): Promise<void> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const h = hostOf(item);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h)!.push(item);
  }
  const queues = [...groups.values()];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queues.length) }, async () => {
      while (next < queues.length) {
        for (const item of queues[next++]) {
          await worker(item);
          await new Promise((r) => setTimeout(r, PER_HOST_DELAY_MS));
        }
      }
    }),
  );
}

type Outcome =
  | "fixed"
  | "already-good"
  | "no-candidate"
  | "candidate-unclear"
  | "listing-dead"
  | "listing-unclear";

const hostOf = (row: Row) => {
  try {
    return new URL(row.listing).hostname;
  } catch {
    return "invalid";
  }
};

async function repair(sql: postgres.Sql, table: string, urlColumn: string, rows: Row[]) {
  const counts: Record<Outcome, number> = {
    fixed: 0,
    "already-good": 0,
    "no-candidate": 0,
    "candidate-unclear": 0,
    "listing-dead": 0,
    "listing-unclear": 0,
  };
  const perAts = new Map<string, { tried: number; ok: number }>();
  const dead: string[] = [];

  await byHost(rows, hostOf, async (row) => {
    // A link that already differs from the advert came from the feed itself.
    // Believe it - but still look, because a dead stated url is the other
    // half of what the user reported.
    if (row.current && row.current !== row.listing) {
      const live = await resolves(row.current);
      if (live === "ok") counts["already-good"]++;
      else if (live === "dead") {
        counts["listing-dead"]++;
        dead.push(row.current);
      } else counts["listing-unclear"]++;
      return;
    }

    const candidate = deriveApplyUrl(row.listing);
    if (!candidate) {
      counts["no-candidate"]++;
      const live = await resolves(row.listing);
      if (live === "dead") {
        counts["listing-dead"]++;
        dead.push(row.listing);
      } else if (live === "unknown") counts["listing-unclear"]++;
      return;
    }

    const stats = perAts.get(candidate.ats) ?? { tried: 0, ok: 0 };
    stats.tried++;
    perAts.set(candidate.ats, stats);

    // Written only on "ok". "unknown" is NOT good enough: a link this script
    // could not reach is a link it has no business storing.
    if ((await resolves(candidate.url)) === "ok") {
      stats.ok++;
      counts.fixed++;
      if (APPLY) {
        // `origin = 'crawler'` here as well as on the select: a row whose
        // origin changed between the read and the write is still not this
        // script's to touch. detected_listings has no origin column - every
        // row in it IS the crawler's - so the predicate is added only where
        // it exists.
        await sql.unsafe(
          `update "${table}" set "${urlColumn}" = $1 where id = $2::uuid${table === "internship_postings" ? " and origin = 'crawler'" : ""}`,
          [candidate.url, row.id],
        );
      }
      return;
    }

    counts["candidate-unclear"]++;
    const live = await resolves(row.listing);
    if (live === "dead") {
      counts["listing-dead"]++;
      dead.push(row.listing);
    }
  });

  console.log(`\n${table} (${rows.length} rows)`);
  console.log(`  ${String(counts.fixed).padStart(5)} ${APPLY ? "repaired" : "would be repaired"} - candidate fetched and answered`);
  console.log(`  ${String(counts["already-good"]).padStart(5)} already had a working apply link`);
  console.log(`  ${String(counts["no-candidate"]).padStart(5)} board has no separate form - left on the advert`);
  console.log(`  ${String(counts["candidate-unclear"]).padStart(5)} candidate would not answer - left alone`);
  console.log(`  ${String(counts["listing-dead"]).padStart(5)} link is DEAD (404/410) - needs a human`);
  console.log(`  ${String(counts["listing-unclear"]).padStart(5)} link unreachable from here (bot-check, throttling) - no conclusion drawn`);

  if (perAts.size) {
    console.log("  by board:");
    for (const [ats, st] of [...perAts].sort()) {
      console.log(`    ${ats.padEnd(12)} ${st.ok}/${st.tried} candidates answered`);
    }
  }
  if (dead.length) {
    const unique = [...new Set(dead)];
    console.log(`  dead links (${dead.length} rows, ${unique.length} distinct):`);
    for (const u of unique.slice(0, 8)) console.log(`    ${u}`);
  }
  return counts;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\nDATABASE_URL is not set.\n");
    process.exit(1);
  }
  const sql = createPostgresClient(url, { pooling: "as-configured", max: 4, onnotice: () => {} }).sql;
  console.log(APPLY ? "Repairing apply links." : "DRY RUN - fetching to check, writing nothing.");

  try {
    const postings = (await sql.unsafe(
      // origin = 'crawler' - the rows this script exists to repair. A
      // firm-authored row's URLs are the recruiter's, are not fetched from
      // here, and are not rewritten from here.
      `select id::text as id, source_url as listing, application_url as current
       from internship_postings
       where is_active and source_url is not null and origin = 'crawler'
       order by program_year desc nulls last${LIMIT ? ` limit ${LIMIT}` : ""}`,
    )) as unknown as Row[];
    await repair(sql, "internship_postings", "application_url", postings);

    if (WITH_LISTINGS) {
      const listings = (await sql.unsafe(
        `select id::text as id, listing_url as listing, application_url as current
         from detected_listings where listing_url is not null and status <> 'closed'
         order by first_detected_at desc${LIMIT ? ` limit ${LIMIT}` : ""}`,
      )) as unknown as Row[];
      await repair(sql, "detected_listings", "application_url", listings);
    }

    console.log(APPLY ? "\nDone." : "\nDry run. Re-run with --apply to write.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
