// Find the real job board behind a careers page.
//
// The 48 sources that fetch cleanly and parse zero listings are almost all
// pointed at a careers landing page, an FAQ, or a "contact us" form. The
// actual list of jobs lives somewhere else - usually on an off-the-shelf ATS
// the firm links out to. That link is nearly always present in the raw HTML
// even when the visible listings are not, because the outbound link is a
// plain <a href> while the listings are rendered by script.
//
// So: fetch each page, look for links to ATS hosts we recognise, and rank
// them. Reports proposals only - writing them is a separate, reviewed step.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/discover-boards.ts [--all]
import { writeFileSync } from "fs";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import puppeteer, { type Browser } from "puppeteer";
import { startRenderProxy, type RenderProxy } from "../src/lib/monitoring/render-proxy";
import * as schema from "../src/db/schema";
import bulkFirmRows from "../src/lib/firm-seeds-bulk.json";

type DiscoveredBoard = {
  firmId: string;
  sourceId: string;
  firmName: string;
  currentUrl: string;
  connectorId: string;
  boardUrl: string;
  viaVendorCdn: boolean;
};

const DISCOVERED_PATH = "scripts/data/discovered-boards.json";
const discovered: DiscoveredBoard[] = [];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const GAP_MS = 500;

/**
 * ATS host patterns, best-supported first. `connector` is what we would
 * actually poll it with - "none" means we can find the board but have no
 * parser for it yet, which is still worth knowing: it turns an unexplained
 * silence into a named, countable gap.
 */
const ATS_PATTERNS: { name: string; connector: string; re: RegExp }[] = [
  { name: "workday", connector: "workday", re: /https?:\/\/[\w.-]*\.myworkdayjobs\.com\/[^\s"'<>\\)]+/gi },
  { name: "talentlink", connector: "talentlink", re: /https?:\/\/[\w.-]*\.tal\.net\/[^\s"'<>\\)]+/gi },
  { name: "greenhouse", connector: "greenhouse", re: /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[^\s"'<>\\)]+/gi },
  { name: "lever", connector: "lever", re: /https?:\/\/jobs\.lever\.co\/[^\s"'<>\\)]+/gi },
  { name: "ashby", connector: "ashby", re: /https?:\/\/jobs\.ashbyhq\.com\/[^\s"'<>\\)]+/gi },
  { name: "smartrecruiters", connector: "smartrecruiters", re: /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[^\s"'<>\\)]+/gi },
  { name: "icims", connector: "icims", re: /https?:\/\/[\w.-]*\.icims\.com\/[^\s"'<>\\)]+/gi },
  { name: "avature", connector: "none", re: /https?:\/\/[\w.-]*\.avature\.net\/[^\s"'<>\\)]+/gi },
  { name: "oracle-hcm", connector: "oracle-hcm", re: /https?:\/\/[\w.-]*\.oraclecloud\.com\/hcmUI\/CandidateExperience\/[^\s"'<>\\)]+/gi },
  { name: "taleo", connector: "none", re: /https?:\/\/[\w.-]*\.taleo\.net\/[^\s"'<>\\)]+/gi },
  { name: "successfactors", connector: "none", re: /https?:\/\/[\w.-]*\.successfactors\.com\/[^\s"'<>\\)]+/gi },
  { name: "workable", connector: "workable", re: /https?:\/\/[\w.-]*\.workable\.com\/[^\s"'<>\\)]+/gi },
  { name: "jobvite", connector: "jobvite", re: /https?:\/\/[\w.-]*\.jobvite\.com\/[^\s"'<>\\)]+/gi },
  { name: "phenom", connector: "none", re: /https?:\/\/[\w.-]*\.phenompeople\.com\/[^\s"'<>\\)]+/gi },
  { name: "eightfold", connector: "eightfold", re: /https?:\/\/[\w.-]*\.eightfold\.ai\/[^\s"'<>\\)]+/gi },
  // --- the census additions (2026-09-18) ---------------------------------
  // Added to turn "nothing found" into a named ATS wherever possible. All
  // land on connector "none" deliberately: knowing a firm is on Cornerstone
  // is a countable gap, and claiming we can poll it would be worse than
  // admitting we cannot. Which of these is worth a parser is a decision for
  // after the counts, not before them.
  { name: "cornerstone", connector: "none", re: /https?:\/\/[\w.-]*\.csod\.com\/[^\s"'<>\\)]+/gi },
  { name: "brassring", connector: "none", re: /https?:\/\/[\w.-]*\.brassring\.com\/[^\s"'<>\\)]+/gi },
  { name: "dayforce", connector: "dayforce", re: /https?:\/\/[\w.-]*\.dayforcehcm\.com\/[^\s"'<>\\)]+/gi },
  { name: "recruitee", connector: "recruitee", re: /https?:\/\/[\w.-]*\.recruitee\.com\/[^\s"'<>\\)]+/gi },
  { name: "bamboohr", connector: "bamboohr", re: /https?:\/\/[\w.-]*\.bamboohr\.(?:com|co\.uk)\/[^\s"'<>\\)]+/gi },
  { name: "pinpoint", connector: "none", re: /https?:\/\/[\w.-]*\.pinpointhq\.com\/[^\s"'<>\\)]+/gi },
  { name: "breezy", connector: "breezy", re: /https?:\/\/[\w.-]*\.breezy\.hr\/[^\s"'<>\\)]+/gi },
  { name: "personio", connector: "none", re: /https?:\/\/[\w.-]*\.personio\.(?:de|com)\/[^\s"'<>\\)]+/gi },
  { name: "jazzhr", connector: "none", re: /https?:\/\/[\w.-]*\.applytojob\.com\/[^\s"'<>\\)]+/gi },
  { name: "ultipro", connector: "none", re: /https?:\/\/[\w.-]*\.ultipro\.com\/[^\s"'<>\\)]+/gi },
  { name: "getro", connector: "getro", re: /https?:\/\/[\w.-]*\.getro\.com\/[^\s"'<>\\)]+/gi },
  { name: "consider", connector: "none", re: /https?:\/\/[\w.-]*\.consider\.com\/[^\s"'<>\\)]+/gi },
];

/** Path words that suggest a page is a job LIST rather than one job or a
 *  marketing page. Used only to rank candidates from the same ATS. */
const LIST_HINTS = /student|campus|university|intern|graduate|early.?care|jobboard|search|jobs/i;
/** Paths that are the opposite: a single requisition, or a dead end. */
const BAD_HINTS = /\/login|\/userhome|\/apply|privacy|cookie|\.pdf$/i;

/**
 * Static assets served FROM an ATS host.
 *
 * The widget a careers page loads to render its board lives on the vendor's
 * CDN, so it matches the vendor's host pattern perfectly while being a
 * JavaScript file. Counting one as a discovered board would inflate exactly
 * the number this pass exists to measure - RBC's phenom "board" was
 * ph-search-results-v2-default-30.js.
 */
const ASSET_EXT = /\.(js|mjs|css|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(\?|$)/i;

/**
 * An ATS vendor's asset host rather than a customer's board.
 *
 * Kept as a penalty rather than an exclusion on purpose. That RBC loads
 * phenompeople assets is real evidence about which ATS RBC runs - which is the
 * fact this census is counting - while the CDN URL itself is not somewhere a
 * crawler can ever fetch vacancies. Dropping it would lose a true answer to
 * avoid a misleading URL; reporting both keeps the count honest and says
 * plainly that the board address is still unknown.
 */
const CDN_HOST = /^(cdn|cdn\d|static|assets|media|img|images|s3)\.|[-.]cdn\./i;

async function getHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chromium, and the only way out of it.
 *
 * This script renders pages it does not own: a careers URL scraped from a
 * directory, then a hop followed out of that page's own markup. The crawler's
 * rendered path treats exactly those inputs as hostile and launches Chromium
 * behind lib/monitoring/render-proxy.ts, which resolves each hostname itself,
 * refuses internal addresses and non-web ports, and dials the address it
 * checked. This runs on an operator's laptop, where the internal addresses a
 * rebound hostname can reach are a home router and whatever the laptop is
 * listening on - so it gets the same treatment, launched the same way.
 *
 * `--proxy-bypass-list=<-loopback>` is not optional: Chromium bypasses a proxy
 * for localhost and 127.0.0.1 by default, which is the one destination the
 * check most wants to refuse. See the long comment above `getBrowser` in
 * src/lib/monitoring/connectors/generic.ts for why a page-level check cannot
 * close this on its own (popups and WebSockets never reach it, and two
 * lookups for one decision is the rebinding window).
 */
async function launchFilteredBrowser(): Promise<{ browser: Browser; proxy: RenderProxy }> {
  const proxy = await startRenderProxy();
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>"],
      // The browser child gets none of this process's environment. This script
      // is run with --env-file=.env.local, so process.env holds live database
      // and API credentials that a rendered third-party page has no business
      // being in the same process tree as.
      env: {},
    });
    return { browser, proxy };
  } catch (err) {
    // A failed launch must not leave the proxy listening: its socket would
    // keep this process alive after main() returns.
    await proxy.close().catch(() => {});
    throw err;
  }
}

/**
 * Same scan, but in a real browser.
 *
 * Needed because the link to the ATS is frequently injected by script rather
 * than served in the markup - which is the same reason these pages looked
 * empty to the crawler in the first place. Also follows one hop through an
 * intermediate "students"/"campus" page, since the common shape is
 * careers landing -> students page -> board, and only the last of those three
 * is worth polling.
 */
async function renderAndScan(
  browser: Browser,
  url: string,
  followHops: boolean,
  firmName: string,
  ownSite: string | null,
): Promise<{ candidates: Candidate[]; hops: string[] }> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT_MS });

    // page.content() plus every resolved href: an <a> added by script is in
    // the DOM but its absolute URL is only visible via the property.
    const html = await page.content();
    const hrefs: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href),
    );
    // Recorded here as well as on the static pass: this branch runs precisely
    // when plain HTTP saw nothing, so a host that only exists in script-written
    // markup is visible to the evidence pass only from here.
    recordHosts(`${html}\n${hrefs.join("\n")}`, firmName, ownSite);
    const candidates = findCandidates(`${html}\n${hrefs.join("\n")}`);

    if (candidates.length > 0 || !followHops) return { candidates, hops: [] };

    // No board here. Collect internal pages most likely to hold one.
    const hops: string[] = await page.evaluate(() => {
      const wanted = /student|campus|graduate|intern|early.?care|opportunit|job|vacanc|openings/i;
      const out = new Set<string>();
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const el = a as HTMLAnchorElement;
        if (!wanted.test(`${el.textContent ?? ""} ${el.href}`)) continue;
        if (!el.href.startsWith("http")) continue;
        out.add(el.href.split("#")[0]);
      }
      return Array.from(out).slice(0, 6);
    });
    return { candidates: [], hops };
  } finally {
    await page.close();
  }
}

type Candidate = { url: string; ats: string; connector: string; score: number; cdn: boolean };

function findCandidates(html: string): Candidate[] {
  const found = new Map<string, Candidate>();
  for (const { name, connector, re } of ATS_PATTERNS) {
    for (const raw of html.match(re) ?? []) {
      // HTML-escaped ampersands and trailing punctuation come along for the
      // ride when matching out of raw markup.
      const url = raw.replace(/&amp;/g, "&").replace(/[.,;:]+$/, "");
      if (BAD_HINTS.test(url)) continue;
      if (ASSET_EXT.test(url)) continue;
      if (found.has(url)) continue;
      let cdn = false;
      try {
        cdn = CDN_HOST.test(new URL(url).hostname);
      } catch {
        continue;
      }

      let score = 0;
      // A parser we actually have beats one we would have to write.
      if (connector !== "none") score += 10;
      // Enough to lose to any real board on the same host, never enough to
      // make the ATS itself invisible.
      if (cdn) score -= 20;
      if (LIST_HINTS.test(url)) score += 5;
      // Shorter paths are usually the board root; longer ones a single job.
      score -= new URL(url).pathname.split("/").filter(Boolean).length;
      found.set(url, { url, ats: name, connector, score, cdn });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------------------------------
 * The evidence pass
 *
 * ATS_PATTERNS above is a list somebody wrote down. This is the check on it:
 * every external host these pages link to that we did NOT recognise, counted
 * by how many DIFFERENT firms link to it. A host that eleven firms point at is
 * an applicant tracking system we have no name for; one that a single firm
 * points at is its PR agency.
 *
 * The point is that the fingerprint list stops being a guess. A pattern we
 * forgot shows up here as a number instead of as a silent "nothing found",
 * which is the failure mode that would quietly corrupt the census counts
 * everything downstream is supposed to depend on.
 * ------------------------------------------------------------------------ */

/** host -> the firms seen linking to it. A Set, so one firm linking to the
 *  same host forty times still counts once. */
const hostHits = new Map<string, Set<string>>();

/**
 * Hosts that are never a job board.
 *
 * Kept deliberately short. Over-filtering here would hide the very thing this
 * pass exists to find, so it covers only the categories that are unambiguous:
 * social, analytics, CDNs, fonts, and the consent/marketing tag vendors that
 * appear on essentially every corporate site.
 */
const HOST_NOISE =
  /(^|\.)(google|googletagmanager|google-analytics|googleapis|gstatic|doubleclick|facebook|fb|instagram|twitter|x|t|linkedin|licdn|youtube|youtu|vimeo|tiktok|pinterest|reddit|apple|microsoft|bing|cloudflare|cloudfront|akamai|akamaihd|jsdelivr|unpkg|jquery|bootstrapcdn|fontawesome|typekit|adobe|onetrust|cookielaw|cookiebot|hotjar|segment|mixpanel|optimizely|qualtrics|marketo|hubspot|salesforce|sitecore|wp|w3|schema|creativecommons|mozilla|gravatar|wistia|brightcove|addthis|sharethis|newrelic|sentry|datadoghq|amazonaws|azureedge|windows)\./i;

/** Records every external host in a page, against the firm it was seen on. */
function recordHosts(html: string, firmName: string, ownSite: string | null) {
  const own = ownSite ? ownSite.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : null;
  for (const raw of html.match(/https?:\/\/[\w.-]+/gi) ?? []) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host.length < 4 || !host.includes(".")) continue;
    if (HOST_NOISE.test(`${host}.`)) continue;
    // The firm's own domain and its subdomains are not a third-party ATS.
    if (own && (host === own || host.endsWith(`.${own}`))) continue;
    // Already a named pattern - it is answered, not evidence of a gap.
    if (ATS_PATTERNS.some((p) => new RegExp(p.re.source, "i").test(`https://${host}/x`))) continue;
    let firmsSeen = hostHits.get(host);
    if (!firmsSeen) hostHits.set(host, (firmsSeen = new Set()));
    firmsSeen.add(firmName);
  }
}

/* ---------------------------------------------------------------------------
 * The sitemap probe  (--sitemap)
 *
 * Answers one question before anyone spends four hours on a sitemap
 * connector: do these firms publish a sitemap at all, and does it list
 * job-shaped URLs? Counted, not guessed - the whole reason this probe exists
 * is that the alternative is building the connector to find out.
 * ------------------------------------------------------------------------ */

/**
 * Paths that look like an individual vacancy.
 *
 * Deliberately stricter than "contains the word job". The first draft counted
 * Baird's /newsroom/news/2020/12/opening-doors-to-a-more-secure-future/ as a
 * vacancy, because "opening" followed by a hyphen matched - 3 hits in 5,427
 * URLs, which reads as a firm with a job sitemap and is nothing of the kind.
 * This number decides whether a four-hour connector gets built, so the test is
 * a whole path SEGMENT plus something that identifies a specific requisition.
 */
const STRONG_SEGMENT = /\/(jobs?|vacanc(y|ies)|requisitions?|positions?|openings?)\//i;
/** Weak on its own: /careers/ is as often a marketing section as a board. */
const WEAK_SEGMENT = /\/(careers?|opportunit(y|ies))\//i;
/** An explicit requisition parameter, whatever the path looks like. */
const JOB_PARAM = /(jobid|requisitionid|reqid|jobreq|posting_?id)=/i;
/** Ranks CHILD SITEMAPS, so it matches the whole URL rather than a path
 *  segment - the giveaway is often the subdomain (careers.example.com). */
const SITEMAP_JOB_HINT = /job|career|vacan|position|opening|recruit/i;

/**
 * Is this URL an individual vacancy?
 *
 * Two failures taught this. First it counted Baird's
 * /newsroom/news/2020/12/opening-doors-to-a-more-secure-future/, because
 * "opening" followed by a hyphen looked like a job. Tightening it to demand an
 * id directly after the job segment then counted NOTHING - it threw away
 * Kroll's /en/job/amsterdam/intern-restructuring/21014771, which is a real
 * internship, because the location and title sit between the segment and the
 * id.
 *
 * So: a STRONG segment (/job/, /vacancy/, /requisition/) with anything after
 * it, or an explicit requisition parameter. /careers/ alone is not enough -
 * that is a section of a website, not a posting.
 */
function JOB_SHAPED(u: string): boolean {
  let path: string;
  try {
    path = new URL(u).pathname;
  } catch {
    return false;
  }
  if (JOB_PARAM.test(u)) return true;
  const m = STRONG_SEGMENT.exec(path);
  // Something has to follow the segment - /jobs/ itself is the list, not a job.
  if (m && path.slice(m.index + m[0].length).length > 1) return true;
  // A weak segment still counts when the URL carries a long numeric id.
  return WEAK_SEGMENT.test(path) && /\d{5,}/.test(path);
}

type SitemapResult = {
  firm: string;
  sitemaps: number;
  urls: number;
  jobUrls: number;
  sample: string | null;
};

async function probeSitemap(firm: string, site: string | null): Promise<SitemapResult | null> {
  if (!site) return null;
  const root = (site.startsWith("http") ? site : `https://${site}`).replace(/\/$/, "");

  // robots.txt first: it is the only place a site is obliged to say where its
  // sitemap actually lives, and plenty of them are not at /sitemap.xml.
  const declared: string[] = [];
  const robots = await getHtml(`${root}/robots.txt`);
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (m) declared.push(m[1]);
    }
  }
  const roots = declared.length ? declared.slice(0, 3) : [`${root}/sitemap.xml`];

  let urls = 0;
  let jobUrls = 0;
  let sitemaps = 0;
  let sample: string | null = null;

  // One level of sitemap-index expansion. Large sites nest an index of
  // sitemaps; going deeper than one level would turn a ten-minute probe into
  // a crawl, which is the thing this is meant to decide about, not perform.
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length && sitemaps < 14) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const xml = await getHtml(url);
    if (!xml) continue;
    sitemaps++;

    const isIndex = /<sitemapindex/i.test(xml);
    const locs = (xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) ?? []).map((l) =>
      l.replace(/<\/?loc>/gi, "").trim(),
    );
    if (isIndex) {
      // Prefer the child sitemaps whose own address suggests jobs - matched
      // against the WHOLE URL, host included. Kroll's vacancies live at
      // careers.kroll.com, and a path-segment test ranked that child below
      // /en/, /fr-fr/ and /de-de/, then hit the cap before ever reaching it.
      const ranked = [...locs].sort(
        (a, b) => Number(SITEMAP_JOB_HINT.test(b)) - Number(SITEMAP_JOB_HINT.test(a)),
      );
      queue.push(...ranked.slice(0, 6));
      continue;
    }
    for (const loc of locs) {
      urls++;
      if (JOB_SHAPED(loc)) {
        jobUrls++;
        if (!sample) sample = loc;
      }
    }
  }

  return { firm, sitemaps, urls, jobUrls, sample };
}

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  // Follows DATABASE_URL, like the scripts ported before it. Opening PGlite
  // here wrote board discoveries into a local file nothing reads - and this
  // is the only route by which a source pointed at a homepage or a contact
  // form ever gets re-pointed at a real board.
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  // Declared out here so the proxy is closed on every exit from the body, not
  // only the one that reaches the end of it: a listening socket left behind
  // keeps this process alive after main() returns.
  let rendered: { browser: Browser; proxy: RenderProxy } | null = null;

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const listings = await db.select().from(schema.detectedListings);
    const firmName = new Map(firms.map((f) => [f.id, f.name]));
    const firmSite = new Map(firms.map((f) => [f.id, f.website]));

    const countBySource = new Map<string, number>();
    for (const l of listings) {
      countBySource.set(l.sourceId, (countBySource.get(l.sourceId) ?? 0) + 1);
    }

    /**
     * --category X: probe DIRECTORY firms rather than registered sources.
     *
     * Added for real estate, where board probing reaches almost nothing: 4
     * boards from 420 firms, 1.0%, against 4% for venture capital. Those firms
     * are not absent from the internet, they are on Workday, Taleo and iCIMS -
     * platforms with no probeable public API, whose links sit in plain HTML on
     * the firm's own careers page. Which is exactly what this script already
     * reads; it simply had no way to be pointed at a firm that is not already
     * a monitoring source.
     *
     * Targets are firms in the category with a website and no source yet. The
     * loop below only ever touches careersUrl and firmId, so a directory firm
     * is shaped into the same thing a source is.
     */
    const categoryArg = process.argv.find((a) => a === "--category");
    const category = categoryArg ? process.argv[process.argv.indexOf(categoryArg) + 1] : null;

    const all = process.argv.includes("--all");
    // --unsolved: every source not already pointed at a board we can parse.
    // Broader than the "parses nothing" set, because a source scraping the
    // word "Internships" out of a careers page is equally unsolved - it just
    // fails with rows instead of without them.
    const unsolved = process.argv.includes("--unsolved");
    const withSource = new Set(sources.map((s) => s.firmId));
    const directoryTargets = category
      ? (bulkFirmRows as { slug: string; category: string; website: string | null }[])
          .filter((row) => row.category === category && row.website)
          .map((row) => {
            const firm = firms.find((f) => f.slug === row.slug);
            if (!firm || withSource.has(firm.id) || !firm.website) return null;
            const site = /^https?:/i.test(firm.website) ? firm.website : `https://${firm.website}`;
            // Shaped like a source so the probing loop needs no changes.
            return { id: `directory:${firm.slug}`, firmId: firm.id, careersUrl: site, lastSuccessAt: null };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null)
      : [];

    const targets = category ? directoryTargets : sources.filter((s) => {
      const onAts = /\.(myworkdayjobs\.com|tal\.net|greenhouse\.io)$/.test(
        new URL(s.careersUrl).hostname,
      );
      if (unsolved) return !onAts;
      if ((countBySource.get(s.id) ?? 0) > 0) return false;
      return all || s.lastSuccessAt !== null;
    });

    // --limit N: probe only the first N targets. For checking a change to this
    // script without spending a full pass to find out it throws at the end.
    const limitArg = process.argv.find((a) => a.startsWith("--limit"));
    const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : 0;
    if (limit > 0) targets.length = Math.min(targets.length, limit);

    const wantSitemap = process.argv.includes("--sitemap") || process.argv.includes("--sitemap-only");
    // Re-running the sitemap question should not mean re-fetching 40 firms'
    // careers pages and re-launching a browser at them. They answered already.
    const sitemapOnly = process.argv.includes("--sitemap-only");
    const sitemapResults: SitemapResult[] = [];

    const useBrowser = !process.argv.includes("--no-render") && !sitemapOnly;
    // The filtering proxy goes up with the browser and comes down with it
    // (launchFilteredBrowser above). --no-render and --sitemap-only launch
    // neither, exactly as before.
    rendered = useBrowser ? await launchFilteredBrowser() : null;
    const browser = rendered?.browser ?? null;
    console.log(`probing ${targets.length} sources${browser ? " (with render fallback)" : ""}\n`);

    const found: string[] = [];
    const noConnector: string[] = [];
    const nothing: string[] = [];

    for (const [i, s] of targets.entries()) {
      const name = firmName.get(s.firmId) ?? "?";
      await new Promise((r) => setTimeout(r, GAP_MS));

      // The registered careers URL first, then the firm's own /careers as a
      // fallback - several of these sources point at a contact form on a
      // domain whose real careers page we never recorded.
      const tries = [s.careersUrl];
      const site = firmSite.get(s.firmId);
      if (site) {
        const root = site.startsWith("http") ? site : `https://${site}`;
        for (const p of ["/careers", "/careers/students", "/about/careers"]) {
          const u = `${root.replace(/\/$/, "")}${p}`;
          if (!tries.includes(u)) tries.push(u);
        }
      }

      let best: Candidate | null = null;
      for (const url of sitemapOnly ? [] : tries) {
        const html = await getHtml(url);
        if (!html) continue;
        recordHosts(html, name, site ?? null);
        const cands = findCandidates(html);
        if (cands.length && (!best || cands[0].score > best.score)) best = cands[0];
        if (best && best.connector !== "none") break; // good enough, stop probing
      }

      // Static found nothing usable - escalate to a real browser, which is the
      // only way to see a link that script wrote. Expensive, so it runs only
      // for the sources plain HTTP could not answer.
      if (!best && browser && !sitemapOnly) {
        try {
          const first = await renderAndScan(browser, s.careersUrl, true, name, site ?? null);
          if (first.candidates.length) {
            best = first.candidates[0];
          } else {
            for (const hop of first.hops) {
              const next = await renderAndScan(browser, hop, false, name, site ?? null);
              if (next.candidates.length) {
                best = next.candidates[0];
                break;
              }
            }
          }
        } catch {
          // A render failure is just a miss; the source stays on the list.
        }
      }

      if (wantSitemap) {
        const sm = await probeSitemap(name, site ?? null);
        if (sm) sitemapResults.push(sm);
      }

      const tag = `[${i + 1}/${targets.length}]`;
      if (sitemapOnly) {
        const r = sitemapResults[sitemapResults.length - 1];
        console.log(`${tag} ${name}: ${r ? `${r.jobUrls} job URLs / ${r.urls}` : "no site"}`);
        continue;
      }
      if (!best) {
        nothing.push(`  ${name.padEnd(34)} ${s.careersUrl}`);
        console.log(`${tag} ${name}: nothing found`);
      } else if (best.connector === "none") {
        const note = best.cdn ? "  [vendor CDN - board URL still unknown]" : "";
        noConnector.push(`  ${name.padEnd(34)} ${best.ats.padEnd(16)} ${best.url}${note}`);
        console.log(`${tag} ${name}: ${best.ats} (no connector)${best.cdn ? " [cdn ref only]" : ""}`);
      } else {
        const note = best.cdn ? "  [vendor CDN - board URL still unknown]" : "";
        found.push(`  ${name.padEnd(34)} ${best.connector.padEnd(16)} ${best.url}${note}`);
        // Recorded as data, not only as a printed line. Every other pass in
        // this directory leaves a datasheet; this one printed 21 boards to a
        // terminal and kept nothing, so acting on them meant re-running a
        // browser over 53 firms or retyping them by hand.
        discovered.push({
          firmId: s.firmId,
          sourceId: String(s.id),
          firmName: name,
          currentUrl: s.careersUrl,
          connectorId: best.connector,
          boardUrl: best.url,
          viaVendorCdn: Boolean(best.cdn),
        });
        console.log(`${tag} ${name}: ${best.connector} -> ${best.url}${best.cdn ? " [cdn ref only]" : ""}`);
      }
    }

    writeFileSync(
      DISCOVERED_PATH,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), count: discovered.length, discovered }, null, 2)}\n`,
    );
    console.log(`\n${discovered.length} candidate board(s) written to ${DISCOVERED_PATH}`);
    console.log("NOT applied - each still has to parse through its connector first.");

    console.log(`\n\n===== BOARD FOUND, CONNECTOR EXISTS (${found.length}) =====`);
    for (const f of found) console.log(f);
    console.log(`\n===== BOARD FOUND, NO CONNECTOR YET (${noConnector.length}) =====`);
    for (const f of noConnector) console.log(f);
    console.log(`\n===== NOTHING FOUND (${nothing.length}) =====`);
    for (const f of nothing) console.log(f);

    // The check on ATS_PATTERNS. Ranked by how many distinct firms link to the
    // host, because that is what separates an ATS from a firm's web agency.
    const ranked = [...hostHits.entries()]
      .map(([host, firmsSeen]) => ({ host, n: firmsSeen.size, firms: [...firmsSeen] }))
      .filter((h) => h.n > 1)
      .sort((a, b) => b.n - a.n || a.host.localeCompare(b.host));
    console.log(
      `\n===== UNRECOGNISED HOSTS, 2+ FIRMS (${ranked.length} of ${hostHits.size} distinct hosts seen) =====`,
    );
    console.log("  (candidates for ATS_PATTERNS - a host many firms share is probably an ATS)");
    for (const h of ranked.slice(0, 40)) {
      console.log(`  ${String(h.n).padStart(3)}  ${h.host.padEnd(40)} ${h.firms.slice(0, 4).join(", ")}${h.firms.length > 4 ? ", ..." : ""}`);
    }

    if (wantSitemap) {
      const withJobs = sitemapResults.filter((r) => r.jobUrls > 0).sort((a, b) => b.jobUrls - a.jobUrls);
      const withSitemap = sitemapResults.filter((r) => r.sitemaps > 0);
      console.log(`\n===== SITEMAP PROBE (${sitemapResults.length} firms) =====`);
      console.log(`  published a sitemap at all : ${withSitemap.length}`);
      console.log(`  sitemap lists job-shaped URLs: ${withJobs.length}`);
      console.log(`  -> a sitemap connector could reach ${withJobs.length} of ${sitemapResults.length} probed firms\n`);
      for (const r of withJobs) {
        console.log(`  ${r.firm.padEnd(34)} ${String(r.jobUrls).padStart(5)} job URLs / ${String(r.urls).padStart(6)} total  ${r.sample ?? ""}`.slice(0, 200));
      }
    }

  } finally {
    await rendered?.browser.close().catch(() => {});
    await rendered?.proxy.close().catch(() => {});
    await opened.close();
  }
}

main();
