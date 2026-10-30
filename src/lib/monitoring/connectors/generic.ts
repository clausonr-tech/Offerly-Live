import "server-only";
import { createHash } from "crypto";
import puppeteer, { type Browser } from "puppeteer";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch, assertPublicUrl } from "../safe-fetch";
import { startRenderProxy, type RenderProxy } from "../render-proxy";
import { isAllowedByRobots } from "../robots";
import {
  classifyFetchError,
  shouldEscalateToRender,
  type FetchFailureReason,
} from "../fetch-reason";
import { resolvedPublicHttpUrl } from "../../safe-url";
import { currentDeadlineSignal } from "../deadline";

/**
 * The rendered navigation's budget. A real browser on a heavy corporate site
 * legitimately needs seconds, so this stays where it was.
 */
const NAV_TIMEOUT_MS = 20000;

/**
 * The plain GET's budget, and deliberately much shorter.
 *
 * One constant used to govern both, so a hanging host paid 20 seconds for the
 * fetch and then a browser launch and another 20 for the navigation - which is
 * how a single source reached 53.5 seconds, against a 4.4-second median.
 *
 * 8,000ms is measured, not chosen for roundness: across 24 random generic
 * sources that answer, the static fetch took a median of 934ms, a 90th
 * percentile of 1,470ms and a maximum of 1,981ms. None came close to 8
 * seconds, so this abandons no working site - it only stops waiting on ones
 * that have hung. A host that is genuinely slow rather than hung still gets
 * its chance: `static_timeout` is not in the never-render set, so the read
 * falls through to the browser.
 */
const STATIC_TIMEOUT_MS = Number(process.env.OFFERLY_STATIC_TIMEOUT_MS ?? 8000);

/**
 * How the rendered navigation decides it has waited long enough.
 *
 * `OFFERLY_RENDER_WAIT=networkidle2` restores the previous behaviour exactly,
 * without a deploy - the way back if a board turns out to need network quiet
 * that the candidate poll below does not give it.
 */
const RENDER_WAIT_UNTIL = (process.env.OFFERLY_RENDER_WAIT ?? "load") as
  | "load"
  | "domcontentloaded"
  | "networkidle2";

/**
 * Longest the candidate poll will wait for client-rendered listings.
 *
 * Tuned, not guessed. At 8,000ms the twelve highest-yielding generic sources
 * took 29,672ms against 19,731ms for `networkidle2` - SLOWER, because the two
 * sources that genuinely have no candidates sat out the whole ceiling rather
 * than finishing early. Every source that does have candidates found them on
 * the first or second look: Morgan Stanley's TalentLink board, which returned
 * NOTHING under `networkidle2`, produced 51 listings 836ms into the read.
 *
 * Tuned down to 1,500ms by measurement, against the same twelve sources:
 *
 *   8,000ms  29,672ms total  (+51 listings, 50% slower - the two boardless
 *                             sources sat out the whole ceiling)
 *   3,000ms  20,825ms total  (+51 listings, 6% slower)
 *   1,500ms  19,678ms total  (+51 listings, same speed as networkidle2)
 *
 * Three looks. Every board that has candidates found them on the first or
 * second, so the accuracy is bought for nothing. A board that needs longer
 * than this is better served by raising it explicitly for that board than by
 * charging every boardless page the wait.
 */
const RENDER_SETTLE_MS = Number(process.env.OFFERLY_RENDER_SETTLE_MS ?? 1500);

/** How often it looks while waiting. */
const POLL_EVERY_MS = 400;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";

// A real, JS-executing browser instead of a plain fetch(). Most bank career
// sites render their actual job listings client-side (React/Angular SPAs) -
// a plain fetch only ever sees the static shell around that content, which
// is why an earlier version of this connector was finding nav links like
// "Find Summer Analyst Programs" instead of real postings. One browser is
// launched lazily and shared across every call in a single monitor-run.ts
// process (each source gets its own tab, not its own browser) - a fresh
// Chromium per source would be the same mistake the fetch-pool's per-domain
// rate limiting exists to avoid, just far more expensive.
let browserPromise: Promise<Browser> | null = null;
let renderProxy: RenderProxy | null = null;

/**
 * The browser, and the only way out of it.
 *
 * EVERY REQUEST THROUGH A CHECKED ADDRESS
 * ---------------------------------------
 * `--proxy-server` points Chromium at lib/monitoring/render-proxy.ts, which
 * resolves each hostname itself, refuses internal addresses and non-web
 * ports, and then dials the address it checked. Two holes that the
 * `page.on("request")` handler below cannot close are closed by it:
 *
 *   - DNS rebinding. assertPublicUrl resolves with Node and then lets
 *     Chromium resolve the same name again when it connects, so the address
 *     checked is not the address dialled. With a proxy, Chromium sends the
 *     NAME and never resolves anything, so there is only one lookup and the
 *     check is inside it.
 *   - Anything that is not this tab's HTTP requests. Interception is attached
 *     per Page: a window.open popup is a different Page with none, and a
 *     WebSocket handshake is not reported through the Fetch domain at all.
 *     Proxy settings are per-profile, so both arrive at the proxy regardless.
 *
 * `--proxy-bypass-list=<-loopback>` is not optional. Chromium bypasses a
 * proxy for localhost and 127.0.0.1 by default, which is the single
 * destination the address check most wants to refuse.
 *
 * The per-request handler stays as well. It is what blocks unread images and
 * fonts, and it refuses a bad address one round trip earlier than the proxy
 * would - two layers, neither relied on alone.
 */
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const proxy = await startRenderProxy();
      renderProxy = proxy;
      try {
        return await puppeteer.launch({
          headless: true,
          args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>"],
        });
      } catch (err) {
        // A failed launch must not leave the proxy listening, and must not
        // cache its own rejection as the shared browser for the whole run.
        await proxy.close().catch(() => {});
        renderProxy = null;
        browserPromise = null;
        throw err;
      }
    })();
  }
  return browserPromise;
}

/** Closes the shared browser. monitor-run.ts calls this once at the end of a
 *  run - without it, a launched Chromium process keeps the script's process
 *  alive indefinitely instead of letting `process.exit` actually exit. The
 *  proxy's listening socket would do the same, so it goes with it. */
export async function closeGenericConnectorBrowser(): Promise<void> {
  const pending = browserPromise;
  const proxy = renderProxy;
  browserPromise = null;
  renderProxy = null;
  if (pending) {
    const browser = await pending.catch(() => null);
    if (browser) await browser.close();
  }
  if (proxy) await proxy.close().catch(() => {});
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Resource types a rendered crawl pays for and never reads.
 *
 * Both render paths in this file end at `textContent` - the DOM's text, not
 * its pixels. No branch measures layout, reads a colour, or looks at an image.
 * So every hero image, web font and autoplaying video on a careers page is
 * bytes and latency spent on nothing.
 *
 * It is not only the download. `waitUntil: "networkidle2"` waits for the
 * network to go quiet, so a page with thirty images does not settle until the
 * thirtieth arrives - the crawl waits out the slowest asset on a corporate
 * marketing page to read a job title from markup that was there in the first
 * second. Measured across 520 checks in two hours, this connector was 96.5%
 * of all crawl time.
 *
 * NOT stylesheets and NOT scripts. Scripts are the entire point - these boards
 * render their vacancy list client-side, and blocking them would turn a full
 * board into an empty one, which is exactly the silent accuracy loss this
 * crawler is built to avoid. Stylesheets are cheap by comparison and a few
 * sites' scripts throw without them, so they stay too.
 */
const UNREAD_RESOURCE_TYPES = new Set(["image", "media", "font"]);

/**
 * A tab set up the way every render in this file wants it.
 *
 * Shared so the two paths cannot drift: they had the same user agent and
 * viewport copied into each, which is the kind of duplication that ends with
 * one of them being blocked by a board and nobody knowing why.
 */
async function preparePage(page: import("puppeteer").Page): Promise<void> {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 900 });
  // A popup is a tab this file never asked for and never reads. Nothing in
  // either render path looks at a second page, so the only thing a
  // window.open can do here is make requests - and it would make them with no
  // interception of its own, since that is attached per Page. It is closed on
  // arrival; the render proxy is what holds the line on the requests it may
  // already have started. The browser is shared for the whole run, so a
  // popup left open would outlive the page.close() in the finally below.
  page.on("popup", (popup) => void popup?.close().catch(() => {}));
  // OFFERLY_RENDER_ALL_ASSETS=1 fetches everything, as this did before. Kept
  // as a way to answer "is a board reading short because of the blocking?"
  // without a code change, and it is how the blocking was shown not to cost
  // listings in the first place. The address check below applies either way.
  const renderAll = process.env.OFFERLY_RENDER_ALL_ASSETS === "1";
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    // An abort looks to the page like an asset that failed to load, which is
    // an ordinary thing on the web and something these sites already handle.
    // Wrapped because a request can be resolved by navigation before this
    // handler runs, and that races into an unhandled rejection that would
    // fail the whole source rather than one image.
    const abort = () => void req.abort().catch(() => {});
    try {
      if (!renderAll && UNREAD_RESOURCE_TYPES.has(req.resourceType())) return abort();
      const url = req.url();
      // Inline data needs no network, so there is no address to check.
      if (url.startsWith("data:") || url.startsWith("blob:")) return void req.continue().catch(() => {});
      // EVERY request, not only the first URL: a redirect, a script-driven
      // navigation or a subresource could otherwise point the browser at an
      // internal address and hand its contents back through page.content().
      assertPublicUrl(url).then(
        () => void req.continue().catch(() => {}),
        () => abort(),
      );
    } catch {
      /* the request is already gone; nothing to decide */
    }
  });
}

/**
 * Identity of the extracted listings, replacing what used to be a hash of the
 * whole page.
 *
 * Sorted before hashing because a page that reorders its listings between
 * checks - common on anything with "most recent first" or randomised
 * promotion - has not changed in any way that matters, and an order-sensitive
 * hash would report it as changed every single time.
 *
 * Only the fields whose movement should trigger a re-diff go in. Location and
 * description are deliberately included: a role quietly switching from New
 * York to London, or having its deadline paragraph rewritten, is exactly the
 * kind of change worth catching, and both live behind an unchanged URL.
 */
export function hashListings(listings: NormalizedListing[]): string {
  if (listings.length === 0) return sha256("empty");
  const lines = listings
    .map((l) =>
      [l.externalJobId ?? "", l.title, l.listingUrl, l.location ?? "", l.descriptionRaw].join("|"),
    )
    .sort();
  return sha256(lines.join("\n"));
}

type DomCandidate = { title: string; href: string };

/** Runs INSIDE the rendered page via page.evaluate() - real DOM traversal,
 *  not regex-on-a-string, which is what makes this able to find a listing
 *  the plain-HTML fallback couldn't: real career pages routinely put the
 *  descriptive title in a heading ("Goldman Sachs 2027 Summer Internships")
 *  next to a generic, keyword-free "Apply Now" link, so checking only the
 *  anchor's own text (the old approach) missed it entirely. This checks a
 *  small ancestor container's text too, and prefers a nearby heading as the
 *  title when the anchor's own text is too short/generic to use as one.
 *
 *  Uses textContent, never innerText: innerText is layout-dependent and
 *  unreliable in headless Chrome (it can come back empty for text that is
 *  really there, depending on how far along layout/font-loading is when it's
 *  read) - textContent reads the DOM directly and isn't affected by that.
 *  This cost a real debugging session: the very first version of this
 *  function used innerText and silently found nothing on Goldman Sachs'
 *  careers page despite real matching anchors being present in the DOM. */
function findCandidatesInPage(patternSource: string, cap: number) {
  // Rebuilt inside the page: a RegExp cannot cross the evaluate boundary, but
  // its source string can - which is what lets this share ONE keyword list
  // with the static scan instead of carrying a copy that drifts.
  const keywords = new RegExp(patternSource, "iu");
  const results: { title: string; href: string }[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const anchor = a as HTMLAnchorElement;
    const ownText = (anchor.textContent || "").trim().replace(/\s+/g, " ");
    const container = anchor.closest("li, article, section, div") as HTMLElement | null;
    const contextText = ownText.length >= 8 ? ownText : (container?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (!keywords.test(contextText)) continue;

    let title = ownText;
    if (title.length < 8 || title.length > 160) {
      const heading = container?.querySelector("h1, h2, h3, h4") as HTMLElement | null;
      title = (heading?.textContent || contextText).trim().replace(/\s+/g, " ").slice(0, 160);
    }
    if (!title) continue;

    const href = anchor.href; // the browser has already resolved this to an absolute URL
    if (seen.has(href)) continue;
    seen.add(href);

    if (results.length >= cap) {
      // Reported, not silently dropped - the caller closes listings it does
      // not see, and must not do that on a read it knows was cut short.
      truncated = true;
      break;
    }
    results.push({ title, href });
  }

  /**
   * Is this page a search form nobody filled in?
   *
   * An empty board and a board behind a keyword box are the same thing
   * downstream - a healthy source producing nothing - which is how a firm can
   * go unread indefinitely without ever counting as a gap. Only asked when
   * nothing was found, and only answered from real evidence: a search input
   * AND a submit control AND no result-shaped links.
   */
  let searchForm = false;
  if (results.length === 0) {
    const hasSearchInput = Boolean(
      document.querySelector(
        'input[type="search"], input[name*="keyword" i], input[placeholder*="search" i], input[id*="search" i]',
      ),
    );
    const hasSubmit = Boolean(
      document.querySelector('button[type="submit"], input[type="submit"], form button'),
    );
    searchForm = hasSearchInput && hasSubmit;
  }

  return { results, truncated, searchForm };
}

/**
 * A plain HTTP GET - no browser.
 *
 * Tried before Chrome on every check. Launching a browser costs roughly a
 * second of CPU and ~100x the memory of a fetch, and a large share of career
 * pages ship their listings as schema.org JSON-LD in the served HTML, where a
 * fetch can read them perfectly well. The browser is the expensive fallback
 * for the pages that genuinely need it (client-rendered SPAs), not the default
 * for pages that don't.
 *
 * Returns null on any failure so the caller falls through to rendering rather
 * than treating a static-fetch problem as a dead source.
 *
 * The failure REASON comes back with it, because the caller needs it and the
 * catch used to throw it away. A named cause is the difference between "43%
 * of our reads fail" and "43% fail with dns_unresolved" - the first is
 * unactionable and was believed for three weeks.
 *
 * RETURNED, NOT STASHED. The first version of this kept the reason in a
 * module-level variable, on the reasoning that it is read immediately after
 * the call that sets it. That is false here: monitor-run.ts runs 16 workers
 * concurrently through this one module, so source A's reason is overwritten
 * by source B's success before A reads it. The first instrumented crawl
 * showed it - 11 of 30 inconclusive reads came back `unclassified` with no
 * other explanation.
 */
type StaticRead =
  | { ok: true; html: string; httpStatus: number }
  | { ok: false; reason: FetchFailureReason };

async function fetchStatic(url: string): Promise<StaticRead> {
  try {
    // safeFetch, not fetch: this is also the path `enrich` uses for detail
    // pages, whose URLs come from the scraped index page rather than from us.
    // See lib/monitoring/safe-fetch.ts for what that allows if left unchecked.
    const response = await safeFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      timeoutMs: STATIC_TIMEOUT_MS,
    });
    const html = await response.text();
    return { ok: true, html, httpStatus: response.status };
  } catch (err) {
    // A refused address fails like any other, so a poisoned listing URL
    // simply keeps its index-page stub instead of killing the run. The cause
    // travels with the failure rather than being discarded.
    return { ok: false, reason: classifyFetchError(err) };
  }
}

/** Navigates a fresh tab to `url`, waits for the page's own JS to settle, and
 *  returns the fully rendered HTML, the DOM-based fallback candidates found
 *  while the page was still open, and the navigation's HTTP status. There is
 *  no conditional-GET equivalent here (no If-None-Match/ETag negotiation
 *  through a rendered navigation) - change detection for this connector
 *  relies entirely on the content-hash comparison monitor-run.ts already
 *  does, at the cost of a real render on every check rather than a cheap 304. */
/**
 * Exported for `scripts/review-agent.ts`, which re-reads a rejected listing's
 * own page before deciding whether the rejection was right.
 *
 * It needs this for the same reason the connector does: measured on a sample
 * of twelve, five job pages returned nothing to a plain GET because the board
 * renders its postings with JavaScript. An agent judging a blank page is not
 * judging the posting - and in that agent an unreadable page is a SKIP, so
 * without a browser two in five rejections simply cannot be re-examined.
 *
 * Callers outside the crawl must invoke `closeGenericConnectorBrowser()` when
 * they finish, or a launched Chromium keeps the process alive.
 */
export async function renderPage(
  url: string,
): Promise<{
  html: string;
  httpStatus: number;
  domCandidates: DomCandidate[];
  truncated: boolean;
  searchForm: boolean;
}> {
  // Checked before a browser is even launched: a rendered navigation to an
  // internal address would read it with full network access and hand back the
  // DOM, which is strictly worse than the static path doing the same.
  await assertPublicUrl(url);
  return withPage(async (page) => {
    /**
     * WAIT FOR THE LISTINGS, NOT FOR THE NETWORK TO GO QUIET.
     *
     * `waitUntil: "networkidle2"` asks for at most two in-flight connections
     * for 500ms. On an ordinary careers page that happens in about 1.7
     * seconds. On a corporate site with analytics, a chat widget or a
     * long-poll it NEVER happens, so the navigation burns the full
     * NAV_TIMEOUT_MS and then throws - and a thrown goto means this function
     * returns nothing at all, so the page is reported unreadable rather than
     * slow.
     *
     * Measured over seven days of generic reads (17,971 runs): 1,290 landed
     * in the 18-24s band and 114 in the 38-46s band - 7.8% of runs shaped
     * exactly like one or two expired timeouts, consuming 31,703 of 241,824
     * seconds, 13.1% of all generic crawl time. On four such sites
     * `networkidle2` returned zero characters in 20s each; `load` plus a
     * settle returned 42,179 / 116,383 / 46,302 characters in about 2s.
     *
     * But `networkidle2` is the BETTER rule for a client-rendered board,
     * because the listings arrive in an XHR it waits for and `load` does not.
     * Swapping it outright would trade a slow read for a silently empty one.
     *
     * So this waits for the thing actually wanted: navigate on `load`, then
     * look for candidates every POLL_EVERY_MS and stop the moment any are
     * found. A static board answers on the first look; a client-rendered one
     * answers as soon as its XHR lands, which is sooner than network quiet;
     * and a page that never settles costs RENDER_SETTLE_MS instead of a
     * 20-second timeout and still hands back whatever it has.
     */
    const response = await page.goto(url, {
      waitUntil: RENDER_WAIT_UNTIL,
      timeout: NAV_TIMEOUT_MS,
    });

    let found = await page.evaluate(
      findCandidatesInPage,
      listingKeywordPatternSource(),
      MAX_CANDIDATES,
    );
    // Only the fast path polls: `networkidle2` has already waited for quiet,
    // so a second wait on top of it would be the old cost plus the new one.
    if (RENDER_WAIT_UNTIL !== "networkidle2") {
      const deadline = Date.now() + RENDER_SETTLE_MS;
      while (found.results.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
        found = await page.evaluate(
          findCandidatesInPage,
          listingKeywordPatternSource(),
          MAX_CANDIDATES,
        );
      }
    }

    // After the poll, so a client-rendered board's HTML carries what its JS
    // put there rather than the shell it started as.
    const html = await page.content();
    return {
      html,
      httpStatus: response?.status() ?? 200,
      domCandidates: found.results,
      truncated: found.truncated,
      searchForm: found.searchForm,
    };
  });
}

/**
 * A prepared tab that closes itself, including when the run is cancelled.
 *
 * Puppeteer has no AbortSignal, so cancellation is expressed the only way the
 * API allows: closing the page, which rejects whatever `goto` or `evaluate`
 * is pending on it. Without this, the per-source budget in monitor-run.ts
 * could not reach a browser render at all - a tab that never settled kept a
 * Chromium page alive long after the worker had moved on, which is where the
 * five-hour check runs measured on 11 October 2026 were spent.
 *
 * Also the one place the newPage/preparePage/close triple lives. It was
 * written out twice, and a third copy was the obvious way to add the next
 * browser-backed read.
 */
async function withPage<T>(fn: (page: import("puppeteer").Page) => Promise<T>): Promise<T> {
  const signal = currentDeadlineSignal();
  if (signal?.aborted) throw signal.reason;

  const browser = await getBrowser();
  const page = await browser.newPage();
  const onAbort = () => {
    // Fire and forget: the point is to make the pending navigation reject,
    // and the `finally` below closes it again harmlessly if this races.
    void page.close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await preparePage(page);
    return await fn(page);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await page.close().catch(() => {});
  }
}

/**
 * Readable text from a page that only exists after its JavaScript has run.
 *
 * Exported so other connectors can borrow the browser this module already
 * owns, rather than launching a second Chromium. TalentLink needs it: its
 * vacancy pages return a sign-in form to a plain GET and render the real
 * posting client-side, so the description is reachable but not by fetch.
 *
 * Expensive by comparison to a fetch - roughly a second of CPU and ~100x the
 * memory - so callers cap how often they reach for it. It is the answer to
 * "the content is there and we cannot read it", never the default.
 */
export async function renderTextWithBrowser(url: string): Promise<string | null> {
  await assertPublicUrl(url);
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      // textContent, not innerText - see findCandidatesInPage for the debugging
      // session that rule cost.
      const text = await page.evaluate(() => {
        const main = document.querySelector("main, [role=main], .vacancy, #content") ?? document.body;
        return (main?.textContent ?? "").replace(/\s+/g, " ").trim();
      });
      return text && text.length >= 200 ? text.slice(0, 8000) : null;
    });
  } catch {
    return null;
  }
}

/** The page's visible prose, stripped of markup and chrome. Deliberately
 *  generous - the announcement detector diffs it rather than matching it, so
 *  extra boilerplate costs nothing while a missing sentence costs everything. */
export function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40000);
}

/** Pulls every `<script type="application/ld+json">` block out of the page
 *  without a full HTML parser - a plain scan is enough for this one tag, and
 *  avoids adding a SEPARATE HTML-parsing dependency on top of the browser
 *  already rendering the page. */
function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Malformed JSON-LD is common enough on real sites to just skip.
    }
  }
  return blocks;
}

/** A `JobPosting` node can arrive bare, inside an array, or nested in a
 *  `@graph` - this walks all three shapes rather than assuming one. */
function flattenJsonLdNodes(blocks: unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      nodes.push(obj);
      if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
    }
  };
  blocks.forEach(visit);
  return nodes;
}

function isJobPosting(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === "JobPosting";
  if (Array.isArray(type)) return type.includes("JobPosting");
  return false;
}

function jobPostingToListing(node: Record<string, unknown>, pageUrl: string): NormalizedListing {
  const title = typeof node.title === "string" ? node.title : "Untitled posting";
  const hiringOrg = node.hiringOrganization as { department?: string } | undefined;
  const jobLocation = node.jobLocation as
    | { address?: { addressLocality?: string; addressRegion?: string } }
    | { address?: { addressLocality?: string; addressRegion?: string } }[]
    | undefined;
  const address = Array.isArray(jobLocation) ? jobLocation[0]?.address : jobLocation?.address;
  const location = address
    ? [address.addressLocality, address.addressRegion].filter(Boolean).join(", ") || null
    : null;
  const description = typeof node.description === "string" ? node.description : "";
  const url = typeof node.url === "string" ? node.url : pageUrl;
  const identifier = node.identifier as { value?: string } | string | undefined;
  const externalJobId =
    typeof identifier === "string"
      ? identifier
      : typeof identifier?.value === "string"
        ? identifier.value
        : null;

  return {
    externalJobId,
    title: decodeTextEntities(title),
    division: decodeTextEntities(
      typeof hiringOrg?.department === "string" ? hiringOrg.department : "",
    ) || null,
    location: location ? decodeTextEntities(location) : null,
    // Strip tags, then decode - schema.org descriptions are frequently raw
    // HTML, and doing it in this order means an entity revealed by tag removal
    // still gets decoded rather than stored as "&amp;".
    descriptionRaw: decodeTextEntities(description.replace(/<[^>]+>/g, " ")),
    employmentType: typeof node.employmentType === "string" ? node.employmentType : null,
    applicationUrl: url,
    listingUrl: url,
    publishedAt: typeof node.datePosted === "string" ? node.datePosted : null,
  };
}

/**
 * The keyword set both candidate scanners share.
 *
 * One list, used by the in-page DOM walk and by the static-HTML scan below,
 * so the two paths cannot drift into disagreeing about what a listing looks
 * like. (findCandidatesInPage cannot reference it - that function is
 * serialized and executed inside the browser, where this module's scope does
 * not exist, so its copy is deliberately inlined there.)
 */
export const LISTING_KEYWORDS = [
  // English.
  "summer analyst",
  "summer associate",
  "intern",
  "internship",
  "analyst program",
  "off-cycle",
  "spring week",
  "insight week",
  "placement",
  "co-op",
  /**
   * NOT English only, and that was a silent hole rather than a small one.
   *
   * Last session fixed the CLASSIFIER for French after the corpus audit found
   * two French technology internships and 42 rejected French listings. But a
   * corpus audit can only inspect rows that exist, and this list is what
   * decides whether a row is ever created. A French board read by this
   * connector produced no candidates at all, so no audit of stored listings
   * could ever have surfaced it - the evidence was destroyed one stage
   * earlier.
   *
   * "stage" is simply the French word for an internship, and it is also an
   * ordinary English noun ("the next stage"). It is included anyway: a false
   * candidate costs one row that the quality gate drops and a human never
   * sees, while a missing one costs a real internship. Everything this
   * connector produces goes to human review regardless (see `verifiable` in
   * posting-quality.ts), and enrichment order is decided by
   * TITLE_INTERNSHIP_PATTERN, so junk cannot crowd out a real internship's
   * detail fetch either.
   */
  // French.
  "stage",
  "stagiaire",
  "alternance",
  "alternant",
  "apprenti",
  // German.
  "praktikum",
  "praktikant",
  "werkstudent",
  // Spanish.
  "prácticas",
  "practicas",
  "becario",
  "pasantía",
  "pasantia",
  // Italian.
  "tirocinio",
  "stagista",
  // Portuguese.
  "estágio",
  "estagio",
  "estagiário",
  // Dutch.
  "stagiair",
];

/**
 * The keyword list as a matcher, on WORD boundaries.
 *
 * Two bugs in one. The scan used `lower.includes(keyword)`, so "intern"
 * matched "International" and "Internal" - every "Internal Audit" link on
 * every careers page was a candidate. And a plain `\b` cannot be used to fix
 * it, because JavaScript's `\b` is ASCII-only: it treats "é" as a non-word
 * character, so `\bstage\b` matches inside "stagé" and `\bpráctica\b` breaks
 * at the accent. Unicode property escapes give a boundary that understands
 * the languages this list is now written in.
 *
 * Built as a source string rather than a RegExp because it is handed to
 * `page.evaluate`, which serialises its arguments - and that is the point.
 * This list used to be duplicated verbatim inside the in-page function
 * because that function executes in the browser where this module's scope
 * does not exist, and two copies of a rule is two rules. Passing it as an
 * ARGUMENT means there is one list again, and a keyword added here cannot be
 * forgotten there.
 */
export function listingKeywordPatternSource(keywords = LISTING_KEYWORDS): string {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`;
}

export function listingKeywordPattern(): RegExp {
  return new RegExp(listingKeywordPatternSource(), "iu");
}

/**
 * How many candidates one read may return.
 *
 * Was 30, with a comment reasoning that proving a page is worth attention
 * needs a handful of examples. That reasoning was sound for a page SAMPLE and
 * wrong for what these actually become: listings. A board publishing 60
 * internships had 30 of them silently dropped - and worse, as newer postings
 * pushed older ones out of the slice, the caller saw them disappear from the
 * fetch and CLOSED them. A live internship recorded as ended.
 *
 * Raised, and paired with `truncated` on the result so the caller can tell a
 * ceiling from a shrinking board. The real cost ceiling is the detail-fetch
 * cap, not the number of rows carried back.
 */
const MAX_CANDIDATES = 200;

/**
 * Link text that is a signpost rather than a posting.
 *
 * This is the trap this connector has already fallen into once: an earlier
 * version returned nav links like "Find Summer Analyst Programs" as if they
 * were listings. Those live in site chrome on client-rendered pages, which is
 * exactly where the static scan runs and the real board does not exist yet.
 */
const NAVIGATIONAL = /^(find|search|explore|discover|browse|view|see|learn|read|apply)\b|\ball (jobs|roles|opportunities)\b|overview$/i;

/** Blocks whose links are navigation by construction. Removed before scanning
 *  rather than filtered afterwards, because an anchor's ancestry is not
 *  recoverable from a string once it has been matched out of context. */
export function stripChrome(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, " ");
}

/**
 * Candidates from SERVED HTML, without a browser.
 *
 * Why this exists: the static path above already short-circuits when a page
 * carries JobPosting JSON-LD, but plenty of real boards are ordinary
 * server-rendered HTML with no structured data at all - iCIMS is an entire
 * connector built on that observation. Those pages were still paying a full
 * Chromium launch (roughly a second of CPU and ~100x the memory of a fetch)
 * to rediscover anchors that were already in the bytes we had.
 *
 * DELIBERATELY CONSERVATIVE, and the asymmetry is the whole design: when this
 * declines, the browser still runs and nothing is lost but the fetch. When it
 * fires wrongly, junk enters the pipeline and a real board is never rendered.
 * So it demands more evidence than the in-page walk does:
 *
 *   - chrome is stripped first (see stripChrome)
 *   - signpost link text is rejected (see NAVIGATIONAL)
 *   - at least two DISTINCT posting URLs, because a client-rendered shell
 *     usually carries one stray marketing link and a real board carries a list
 *
 * A single genuinely-static posting therefore falls through to the browser,
 * which finds it anyway. That is the intended trade.
 */
export function findCandidatesInHtml(html: string, baseUrl: string): DomCandidate[] {
  return scanHtmlForCandidates(html, baseUrl).results;
}

/** The same scan, reporting whether it hit its ceiling. `findCandidatesInHtml`
 *  stays as the plain-list form because several callers only want the list. */
export function scanHtmlForCandidates(
  html: string,
  baseUrl: string,
): { results: DomCandidate[]; truncated: boolean } {
  const keywords = listingKeywordPattern();
  const cleaned = stripChrome(html);
  const anchor = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const results: DomCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;

  let match: RegExpExecArray | null;
  while ((match = anchor.exec(cleaned))) {
    const [, rawHref, inner] = match;
    const ownText = decodeTextEntities(inner.replace(/<[^>]+>/g, " "));

    // Context window, mirroring the DOM walk's "check a small ancestor
    // container" rule: real boards routinely pair a keyword-free "Apply" link
    // with the role name in a heading beside it.
    const start = Math.max(0, match.index - 800);
    // The window is kept as MARKUP and stripped separately, because the
    // heading lookup below needs the tags that the text form throws away.
    const window = cleaned.slice(start, match.index + match[0].length);
    const context = decodeTextEntities(window.replace(/<[^>]+>/g, " "));

    // The keyword is looked for in the anchor AND its surroundings, never in
    // one or the other. A length threshold picking between them is what made
    // the first version of this return nothing on the commonest card layout
    // there is: "Apply Now" is nine characters, so it passed for "long enough
    // to judge on its own" and then contained no keyword.
    if (!keywords.test(`${ownText} ${context}`)) {
      continue;
    }

    /** The nearest preceding heading - where the role name sits when the
     *  anchor itself is a button. */
    const headings = [...window.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
    const fromHeading = headings.length
      ? decodeTextEntities(headings[headings.length - 1][1].replace(/<[^>]+>/g, " "))
      : "";

    // The anchor's own words win when they name a role. They lose when they
    // are the wrong length to be a title, or when they are a signpost -
    // "Apply Now" is both a perfectly good link and a uselessly generic name.
    const ownLooksLikeATitle =
      ownText.length >= 8 && ownText.length <= 160 && !NAVIGATIONAL.test(ownText);
    const title = (ownLooksLikeATitle ? ownText : fromHeading).slice(0, 160).trim();

    if (title.length < 8) continue;
    if (NAVIGATIONAL.test(title)) continue;

    // Schemes that are not pages. `mailto:` matters most: "email
    // recruiting@firm.com about our internship programme" is a real sentence
    // on real careers pages, and it is an address, not a posting.
    const hrefRaw = decodeTextEntities(rawHref).trim();
    if (!hrefRaw || hrefRaw.startsWith("#")) continue;
    if (/^(javascript|mailto|tel|data|file):/i.test(hrefRaw)) continue;

    let href: string;
    try {
      href = new URL(hrefRaw, baseUrl).toString();
    } catch {
      continue;
    }
    // A link back to the page being scanned is navigation, not a posting.
    if (href.split("#")[0] === baseUrl.split("#")[0]) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    if (results.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    results.push({ title, href });
  }

  // Two distinct postings is the floor - see the note above on why a single
  // match is handed to the browser instead of trusted.
  return results.length >= 2 ? { results, truncated } : { results: [], truncated: false };
}

/**
 * Readable text from a detail page with no structured data, or null when what
 * came back cannot be trusted to describe this particular job.
 *
 * The null case is the important one, and it is not hypothetical: a great many
 * "job detail" URLs are client-rendered, so a static fetch returns the site's
 * shell - nav, marketing links, a scam warning - byte-identical for every
 * listing on the site. Measured on a real board, three different internships
 * all came back with the same 820 characters of chrome. That is strictly worse
 * than the short stub it would replace, because identical boilerplate makes
 * every listing look the same to the classifier while looking like real
 * content to a reviewer.
 *
 * The test is whether the page says what the job is called. A real detail page
 * names its own role somewhere in the text; a shell does not. Cheap, and it
 * fails in the safe direction - keeping a thin-but-true description over a
 * long and misleading one.
 */
export function extractReadableText(html: string, title: string): string | null {
  const candidate =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{80,})["']/i.exec(html)?.[1] ??
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{80,})["']/i.exec(html)?.[1] ??
    html
      .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // Capped: the classifier reads phrases, and a full job page's
      // equal-opportunity boilerplate is not what it reads for.
      .slice(0, 4000);

  if (!candidate) return null;

  // Decoded here rather than at the three branches above, because all three
  // produce entity-carrying text: a meta tag's content attribute is HTML, and
  // so is the stripped body. The title check below then compares decoded
  // against decoded, which is what makes "M&A" match "M&amp;A".
  const decoded = decodeTextEntities(candidate);

  /**
   * The longest word in the title that is distinctive enough to look for.
   *
   * A length floor alone does not do it, and the comment here used to name
   * "Campus" as an example of a word too generic to test on while the rule
   * cheerfully accepted it - it is six characters. That is not a nitpick: the
   * whole point of this function is to refuse a page of site chrome, and
   * "Campus" is a word that appears in site chrome on every careers site
   * there is. A shell page containing it would have passed the one check
   * standing between it and being stored as a real description.
   *
   * So generic careers vocabulary is excluded by name. Role words -
   * "analyst", "banking", "markets", "internship" - are deliberately NOT on
   * the list: those are exactly what a real detail page repeats.
   *
   * No fallback when nothing survives. Returning null means the listing keeps
   * its short-but-true stub, which is the safe direction this function is
   * built around. Found by generic-description.test.ts.
   */
  const CHROME_WORDS = new Set([
    "campus",
    "career",
    "careers",
    "student",
    "students",
    "graduate",
    "graduates",
    "opportunity",
    "opportunities",
    "application",
    "applications",
    "programme",
    "program",
  ]);
  const distinctive = title
    .split(/[^A-Za-z+#]+/)
    .filter((w) => w.length >= 5 && !CHROME_WORDS.has(w.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (!distinctive) return null;

  return decoded.toLowerCase().includes(distinctive.toLowerCase()) ? decoded : null;
}

/**
 * Undo one round of HTML entity encoding on text that is already plain.
 *
 * Needed on both paths this connector reads, for different reasons.
 *
 * JSON-LD is the common one: it is JSON, so a browser never decodes HTML
 * entities inside its string values, and plenty of sites HTML-encode the
 * strings they emit there. Société Générale does - its JobPosting titles read
 * "Corporate &amp; Investment banking", which went into the database verbatim
 * and would have been shown to a student that way. Measured 18 September 2026
 * on 5 of 11 SG listings.
 *
 * DOM text is the rarer one: `textContent` has already been decoded once by
 * the browser, so an entity still sitting there was encoded TWICE at source.
 *
 * Bounded to the five named entities plus numeric escapes on purpose. This is
 * a repair for a specific double-encoding bug, not an HTML parser, and a
 * general unescape run over text that is already plain would start corrupting
 * titles that legitimately contain an ampersand followed by a word.
 */
export function decodeTextEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d{2,5});/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last: decoding it first would turn "&amp;lt;" into "<".
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Converts the DOM-found candidates (see findCandidatesInPage) into the
 *  connector's normal output shape. Deliberately thin: this only fires when
 *  a page has no JobPosting structured data at all, and anything it finds
 *  still goes through the real classifier before it's treated as a real
 *  listing. */
function domCandidatesToListings(
  candidates: DomCandidate[],
  /** The board the anchors were found on, to resolve any href against. */
  baseUrl: string,
): NormalizedListing[] {
  /**
   * A CANDIDATE WITH NO OPENABLE ADDRESS IS PAGE FURNITURE, NOT A JOB.
   *
   * `anchor.href` is absolute when the browser resolved it, but `javascript:`
   * survives that untouched - `<a href="javascript:void(0)">` reads back as
   * exactly that. Four stored listings carry it, and they are what they look
   * like: a filter control or a sort header that happened to sit beside a
   * title. The static scan path has no browser at all, so there a relative
   * href needs resolving for real.
   *
   * Dropped rather than stored with a null address. A listing a student cannot
   * open is not a listing, and keeping it only moves the rejection downstream
   * to the publish gate, where it arrives as an unexplained hold.
   */
  return candidates.flatMap((c) => {
    const href = resolvedPublicHttpUrl(c.href, baseUrl);
    if (!href) return [];
    return [
      {
        externalJobId: null,
        title: decodeTextEntities(c.title),
        division: null,
        location: null,
        descriptionRaw: decodeTextEntities(c.title),
        employmentType: null,
        applicationUrl: href,
        listingUrl: href,
        publishedAt: null,
      },
    ];
  });
}

/** Listings whose description is no better than their own title carry nothing
 *  a classifier can work with - that is the DOM-candidate shape, where the
 *  "description" is the link text. Those are what a detail fetch is for. */
export function needsDetail(listing: NormalizedListing): boolean {
  const description = listing.descriptionRaw.trim();
  return description.length < 120 || description === listing.title.trim();
}

/** How many detail pages one check will fetch. A page with sixty listings on
 *  it going from zero to sixty in one check is a real scenario (a firm opening
 *  its whole programme at once), and following every link would be a burst of
 *  sixty requests at one domain. The cap trades completeness for restraint:
 *  the rest keep their index-page text and still reach a human reviewer. */
const MAX_DETAIL_FETCHES = 25;
const DETAIL_GAP_MS = 700;

/**
 * What a check amounts to when the RENDER failed but the plain GET did not.
 *
 * Exported and pure so the decision is testable: `fetch()` itself needs a
 * network and a Chromium, which is why every other test in this file's suite
 * exercises pure functions only.
 *
 * See the call site for the measurement behind it - 319 of 351 never-answered
 * sources are apex homepages whose GET succeeds, whose render then times out,
 * and whose perfectly good HTML was being discarded in favour of "HTTP 0 -
 * not an answer about this firm".
 */
export function renderFailureResult(
  staticResult: { html: string; httpStatus: number } | null,
  renderReason: FetchFailureReason = "unclassified",
  staticReason: FetchFailureReason | null = null,
): ConnectorFetchResult {
  if (staticResult && staticResult.httpStatus < 400) {
    return {
      listings: [],
      etag: null,
      contentHash: hashListings([]),
      httpStatus: staticResult.httpStatus,
      notModified: false,
      // The page as prose, so the announcement watcher can read a firm that
      // has no board at all. This is the only way such a firm is ever seen.
      responseBytes: staticResult.html.length,
      pageText: readableText(staticResult.html),
      // We did not see a client-rendered board, and cannot claim we did.
      // Keeps decideClosure from closing stored listings and isBoardCollapse
      // from reading this as a board that emptied.
      truncated: true,
    };
  }
  /**
   * Nothing was read at all. A soft error rather than a throw -
   * monitor-run.ts's inconclusive path knows what to do with httpStatus 0.
   *
   * THE STATIC CAUSE WINS when there is one. Both stages failed, and the
   * earlier failure is the one that explains the check: a host that does not
   * resolve also cannot be rendered, and reporting `nav_timeout` for it would
   * name the symptom while hiding the cause. That inversion is exactly what
   * made the HTTP-0 bucket unreadable.
   */
  return {
    listings: [],
    etag: null,
    contentHash: "",
    httpStatus: 0,
    notModified: false,
    inconclusiveReason: staticReason ?? renderReason,
  };
}

export const genericConnector: SourceConnector = {
  id: "generic",
  canHandle: () => true, // the fallback of last resort - always matches

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    /**
     * Ask the site first.
     *
     * This connector is the one that fetches URLs nobody assessed - 63
     * careers pages that arrived from discovery - so it is where a runtime
     * robots check actually matters. Reported as httpStatus 0 with no
     * listings, the same shape as any other unreadable source, so a
     * disallowed firm shows up in the audit as producing nothing rather than
     * disappearing silently.
     */
    if (!(await isAllowedByRobots(source.careersUrl))) {
      return {
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: 0,
        notModified: false,
        inconclusiveReason: "robots_disallowed",
      };
    }

    // Cheap path: a plain GET, and JSON-LD if the served HTML carries it.
    // Only when that finds nothing does this fall through to a real browser.
    const staticStartedAt = Date.now();
    const staticRead = await fetchStatic(source.careersUrl);
    const staticMs = Date.now() - staticStartedAt;
    // Measured even when the read failed: a timeout's duration is the most
    // informative number this connector produces, and it is the one the
    // static timeout should be set from.
    let renderMs: number | undefined;
    const staticResult = staticRead.ok ? staticRead : null;
    if (staticResult && staticResult.httpStatus < 400) {
      const staticNodes = flattenJsonLdNodes(
        extractJsonLdBlocks(staticResult.html),
      ).filter(isJobPosting);
      if (staticNodes.length) {
        const listings = staticNodes.map((n) => jobPostingToListing(n, source.careersUrl));
        return {
          timings: { staticMs, renderMs },
          listings,
          etag: null,
          contentHash: hashListings(listings),
          httpStatus: staticResult.httpStatus,
          notModified: false,
          responseBytes: staticResult.html.length,
        };
      }

      // No structured data, but the served HTML may still BE the board - a
      // server-rendered list of anchors is what iCIMS turned out to be, and
      // there is no reason to launch a browser to re-read bytes we hold.
      // findCandidatesInHtml returns nothing unless it is confident, so a
      // client-rendered shell falls through to the render path below.
      const staticScan = scanHtmlForCandidates(staticResult.html, source.careersUrl);
      if (staticScan.results.length) {
        const listings = domCandidatesToListings(staticScan.results, source.careersUrl);
        /**
         * CANDIDATES FOUND BUT ALL DROPPED IS NOT AN EMPTY BOARD.
         *
         * `domCandidatesToListings` discards a candidate with no openable
         * address, and if every one goes the read returns `listings: []` with
         * `httpStatus: 200` and `truncated: false` - which `decideClosure`
         * reads as "the board is genuinely empty" and closes every stored
         * listing against, and which now retires their postings too.
         *
         * Reachable without anything exotic: a board on a non-web port, a host
         * with an all-digit label, or - on the render path, where
         * `findCandidatesInPage` returns bare `anchor.href` with no scheme
         * filter - a board whose job links are all `javascript:`-driven.
         *
         * `truncated` is exactly the right signal: it already means "this read
         * is not a complete picture of the board", and closure refuses to act
         * on one. Set rather than returning an error, because the page WAS
         * read; what failed is our ability to use what it said.
         */
        const allCandidatesDropped = staticScan.results.length > 0 && listings.length === 0;
        return {
          timings: { staticMs, renderMs },
          listings,
          etag: null,
          contentHash: hashListings(listings),
          httpStatus: staticResult.httpStatus,
          notModified: false,
          pageText: readableText(staticResult.html),
          truncated: staticScan.truncated || allCandidatesDropped,
          responseBytes: staticResult.html.length,
        };
      }
    }

    // A 4xx/5xx from the cheap path is reported as-is rather than retried with
    // a browser: a 404 career page is a dead source, and rendering it would
    // cost a browser launch to rediscover the same 404.
    if (staticResult && staticResult.httpStatus >= 400) {
      return {
        timings: { staticMs, renderMs },
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: staticResult.httpStatus,
        notModified: false,
        responseBytes: staticResult.html.length,
      };
    }

    /**
     * A browser cannot reach what the network could not reach.
     *
     * The 4xx early return above has always existed; status 0 fell straight
     * through it, so a host that does not resolve paid the static timeout and
     * then a Chromium launch and a navigation timeout on top. With failure
     * reasons recorded, that path averaged 41.9 seconds against a 4.4-second
     * median for everything else.
     *
     * Only the four reasons a real browser was MEASURED to reject as well are
     * refused here - see shouldEscalateToRender in lib/monitoring/fetch-reason.ts
     * for which, and for why `tls_error` and the timeouts deliberately are not
     * among them.
     */
    if (!staticRead.ok && !shouldEscalateToRender(staticRead.reason)) {
      return {
        timings: { staticMs, renderMs },
        listings: [],
        etag: null,
        contentHash: "",
        httpStatus: 0,
        notModified: false,
        inconclusiveReason: staticRead.reason,
      };
    }

    let html: string;
    let httpStatus: number;
    let domCandidates: DomCandidate[];
    let renderTruncated: boolean;
    let searchForm: boolean;
    const renderStartedAt = Date.now();
    try {
      ({
        html,
        httpStatus,
        domCandidates,
        truncated: renderTruncated,
        searchForm,
      } = await renderPage(source.careersUrl));
      renderMs = Date.now() - renderStartedAt;
    } catch (err) {
      /**
       * A FAILED RENDER DOES NOT ERASE A SUCCESSFUL READ.
       *
       * This used to discard `staticResult` and report httpStatus 0 - "not an
       * answer about this firm" - even when the plain GET above had returned
       * the page perfectly well. For an apex homepage with no job board, which
       * is what 319 of the 351 never-answered sources are, that is the normal
       * path: the GET succeeds, there is no board to find because it is a
       * homepage, the render is attempted anyway, and a slow render buries the
       * read we already had.
       *
       * Capital Today was measured on 11 October 2026 with 73 check runs, every
       * one "inconclusive: HTTP 0", `consecutive_inconclusive` 73, averaging
       * 27.4 seconds - while `safeFetch` against the same URL returns 200 with
       * 25,869 bytes in 620ms. Three losses per run: a 20-second render for a
       * page already in memory, a reported non-answer where there was an
       * answer, and - because `pageText` was only ever set on the render path
       * or on a static read that found a board - the announcement watcher
       * never saw a word of it. That watcher exists FOR firms with no board.
       *
       * So the static read is reported as what it was. `truncated` is set
       * because a client-rendered board may genuinely exist and we did not get
       * to see it: that keeps `decideClosure` from closing stored listings on
       * the strength of a read we know was partial, and keeps
       * `isBoardCollapse` from reading it as a board that emptied.
       */
      return renderFailureResult(
        staticResult,
        classifyFetchError(err),
        staticRead.ok ? null : staticRead.reason,
      );
    }

    if (httpStatus >= 400) {
      return { listings: [], etag: null, contentHash: "", httpStatus, notModified: false, timings: { staticMs, renderMs } };
    }

    const jsonLdNodes = flattenJsonLdNodes(extractJsonLdBlocks(html)).filter(isJobPosting);
    const listings = jsonLdNodes.length
      ? jsonLdNodes.map((n) => jobPostingToListing(n, source.careersUrl))
      : domCandidatesToListings(domCandidates, source.careersUrl);
    // Same guard as the static path above: candidates found and all dropped is
    // an unusable read, not an empty board.
    const allRenderCandidatesDropped = domCandidates.length > 0 && listings.length === 0;

    return {
      timings: { staticMs, renderMs },
      listings,
      etag: null,
      contentHash: hashListings(listings),
      httpStatus,
      notModified: false,
      // Carried back so a source with no parseable board can still be watched
      // for an opening announcement - see announcements.ts. Trimmed: what is
      // wanted is the page's prose, not its scripts and stylesheets.
      responseBytes: html.length,
      pageText: readableText(html),
      // Structured data is the whole board by definition; only the DOM walk
      // has a ceiling it can hit.
      truncated: jsonLdNodes.length ? false : renderTruncated || allRenderCandidatesDropped,
      // Reported only when the page really yielded nothing - a board with
      // listings AND a search box is a board, not a blocked one.
      blockedBy: listings.length === 0 && searchForm ? "search_form" : null,
    };
  },

  /**
   * Fetches each new listing's own page and replaces the stub description with
   * whatever the detail page actually says - JSON-LD first, then the meta
   * description, then the page's own visible text.
   *
   * Static fetch only, never a browser: this runs over several URLs at a time,
   * and the point of the exercise is more signal per request, not a browser
   * launch per listing.
   */
  // Declared so the caller does not charge an attempt to a listing this will
  // return untouched - see maxEnrichPerCheck in types.ts.
  maxEnrichPerCheck: MAX_DETAIL_FETCHES,

  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL_FETCHES; i++) {
      /**
       * THE DEAFEST LOOP IN THE CRAWL, until now.
       *
       * `withPage` reads the ambient signal and `safeFetch` folds it in, but
       * this loop read nothing - so after the per-source budget aborted it kept
       * going: a robots check per iteration (a network call), then
       * DETAIL_GAP_MS of `setTimeout` that no signal can interrupt, then a
       * `fetchStatic` that now rejects instantly. Twenty-five iterations is
       * about seventeen seconds of pure sleeping past a budget that had already
       * given up, twice per check, and it is the likeliest way a check's
       * recorded time overruns while cancellation is working everywhere else.
       */
      if (currentDeadlineSignal()?.aborted) break;

      const listing = out[i];
      if (!needsDetail(listing) || !listing.listingUrl) continue;

      // Sequential with a gap rather than parallel: this runs inside the slot
      // fetch-pool already granted for this source, so it must not turn one
      // polite request into a burst against the same host.
      // Each detail URL came off a scraped page, so it is its own unassessed
      // destination - a board may be readable while its postings sit under a
      // disallowed path. Checked before the request, not after.
      if (!(await isAllowedByRobots(listing.listingUrl))) continue;

      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      const detailRead = await fetchStatic(listing.listingUrl);
      const detail = detailRead.ok ? detailRead : null;
      if (!detail || detail.httpStatus >= 400) continue;

      const node = flattenJsonLdNodes(extractJsonLdBlocks(detail.html)).filter(isJobPosting)[0];
      if (node) {
        // The detail page's own JobPosting supersedes the index-page stub
        // entirely - it is the same listing described properly.
        const full = jobPostingToListing(node, listing.listingUrl);
        out[i] = { ...full, listingUrl: listing.listingUrl };
        continue;
      }

      // Null means the page could not be shown to be about this job - keep
      // the short-but-accurate stub rather than overwriting it with chrome.
      const description = extractReadableText(detail.html, listing.title);
      if (description && description.length > listing.descriptionRaw.length) {
        out[i] = { ...listing, descriptionRaw: description };
      }
    }

    return out;
  },
};
