// Second-opinion board discovery, for the firms the first pass gave up on.
//
// discover-boards.ts concluded ~40 firms have no job board. That conclusion is
// only as good as its method, and its method had four holes:
//
//   1. it matched a fixed list of ~15 ATS hostnames, so a firm on any other
//      platform - or hosting its own board - looked identical to a firm with
//      no board at all;
//   2. it followed ONE hop, through links whose text matched a keyword regex,
//      so a board two clicks deep, or behind a link that says "Opportunities
//      at the firm", was invisible;
//   3. it never read sitemap.xml, which is where a site lists the pages it
//      wants found - including the ones no nav link points at;
//   4. it looked for links to a board and never for a board, so a page that
//      IS the listing (a plain <ul> of roles) counted as nothing found.
//
// This pass closes all four and reports its evidence, so a "no board" verdict
// can be checked rather than taken on faith.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/discover-boards-deep.ts
import { openScriptDb } from "./_db";
import puppeteer, { type Browser } from "puppeteer";
import { startRenderProxy, type RenderProxy } from "../src/lib/monitoring/render-proxy";
import * as schema from "../src/db/schema";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const GAP_MS = 300;

/**
 * Every ATS and job-board host worth recognising, not just the ones this
 * codebase already has a connector for. A hosted board we cannot yet parse is
 * still a completely different finding from no board existing.
 */
const ATS_HOSTS = [
  "myworkdayjobs.com", "tal.net", "greenhouse.io", "oraclecloud.com", "lever.co",
  "icims.com", "eightfold.ai", "avature.net", "taleo.net", "successfactors.com",
  "successfactors.eu", "workable.com", "jobvite.com", "phenompeople.com", "ashbyhq.com",
  "smartrecruiters.com", "brassring.com", "silkroad.com", "jazz.co", "applytojob.com",
  "breezy.hr", "recruitee.com", "teamtailor.com", "bamboohr.com", "paylocity.com",
  "myworkdaysite.com", "ultipro.com", "ukg.net", "adp.com", "clearcompany.com",
  "jobscore.com", "pinpointhq.com", "hirehive.com", "rippling-ats.com", "gusto.com",
  "paycomonline.net", "paycor.com", "dayforcehcm.com", "csod.com", "cornerstoneondemand.com",
  "hiringthing.com", "jobdiva.com", "bullhornstaffing.com", "crelate.com", "trakstar.com",
  "workforcenow.adp.com", "join.com", "personio.de", "factorialhr.com", "mysolvedhcm.com",
];

/** Paths a self-hosted board commonly lives at, tried when nothing is linked. */
const GUESS_PATHS = [
  "/careers", "/careers/", "/careers/open-positions", "/careers/openings",
  "/careers/opportunities", "/careers/jobs", "/about/careers", "/join-us",
  "/company/careers", "/opportunities", "/open-positions", "/jobs", "/work-with-us",
  "/careers/students", "/campus", "/careers/campus", "/early-careers",
];

const BAD = /\/login|\/userhome|\/signin|\/register|privacy|cookie|\.pdf$|\.jpg$|\.png$/i;

type Finding = {
  kind: "ats" | "self-hosted" | "iframe" | "sitemap" | "none";
  url: string;
  evidence: string;
};

function atsMatch(text: string): { url: string; host: string } | null {
  for (const host of ATS_HOSTS) {
    const re = new RegExp(
      `https?://[\\w.-]*${host.replace(/\./g, "\\.")}[^\\s"'<>\\\\)]*`,
      "i",
    );
    const m = re.exec(text);
    if (m && !BAD.test(m[0])) {
      return { url: m[0].replace(/&amp;/g, "&").replace(/[.,;:]+$/, ""), host };
    }
  }
  return null;
}

async function getText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml,*/*" },
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
 * Does this page LIST jobs itself?
 *
 * Two independent signals, either of which is strong on its own:
 *  - schema.org JobPosting markup, which a site only emits deliberately;
 *  - three or more links whose paths look like individual job pages, which is
 *    what a hand-built board looks like in markup.
 *
 * Three is the threshold because one or two "job-ish" links are usually a
 * careers page pointing at its own two open roles, or a nav accident.
 */
function selfHostedEvidence(html: string): string | null {
  if (/"@type"\s*:\s*"JobPosting"/i.test(html)) return "schema.org JobPosting markup";

  const jobLinks = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*(?:job|position|opening|vacanc|role)[^"]*)"/gi)) {
    const href = m[1];
    if (BAD.test(href)) continue;
    // Needs a path segment past the listing root - "/careers/jobs" is the
    // index, "/careers/jobs/summer-analyst-2027" is a posting.
    if (/\/(job|position|opening|vacanc|role)[\w-]*\/[\w-]{4,}/i.test(href)) jobLinks.add(href);
  }
  if (jobLinks.size >= 3) return `${jobLinks.size} job-detail links in page`;
  return null;
}

/** Career-ish URLs a site advertises in its own sitemap. */
async function sitemapCandidates(origin: string): Promise<string[]> {
  const out = new Set<string>();
  for (const name of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const xml = await getText(`${origin}${name}`);
    if (!xml) continue;

    // A sitemap index points at more sitemaps; follow the career-ish ones.
    const nested = [...xml.matchAll(/<loc>([^<]*sitemap[^<]*)<\/loc>/gi)].map((m) => m[1]);
    const bodies = [xml];
    for (const child of nested.slice(0, 3)) {
      const sub = await getText(child);
      if (sub) bodies.push(sub);
    }

    for (const body of bodies) {
      for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        const url = m[1];
        if (/career|job|opening|vacanc|opportunit|join|campus|intern/i.test(url) && !BAD.test(url)) {
          out.add(url);
        }
      }
    }
  }
  return [...out].slice(0, 12);
}

/**
 * Chromium, and the only way out of it.
 *
 * This pass is the one that follows TWO hops and every job-shaped <loc> in a
 * third party's sitemap.xml - the widest set of operator-machine renders in
 * the repository, and every URL in it came out of somebody else's markup. So
 * it launches the way the crawler's rendered path does: behind
 * lib/monitoring/render-proxy.ts, which resolves each hostname itself, refuses
 * internal addresses and non-web ports, and dials the address it checked.
 *
 * `--proxy-bypass-list=<-loopback>` is not optional: Chromium bypasses a proxy
 * for localhost and 127.0.0.1 by default, which is the one destination the
 * check most wants to refuse. The long comment above `getBrowser` in
 * src/lib/monitoring/connectors/generic.ts is the full argument - in short, a
 * page-level check sees neither popups nor WebSockets, and resolving a name
 * twice for one decision is the rebinding window itself.
 */
async function launchFilteredBrowser(): Promise<{ browser: Browser; proxy: RenderProxy }> {
  const proxy = await startRenderProxy();
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>"],
      // The browser child gets none of this process's environment: run with
      // --env-file=.env.local, process.env here holds live credentials.
      env: {},
    });
    return { browser, proxy };
  } catch (err) {
    // A failed launch must not leave the proxy listening - its socket would
    // keep this process alive after main() returns.
    await proxy.close().catch(() => {});
    throw err;
  }
}

async function renderScan(
  browser: Browser,
  url: string,
): Promise<{ html: string; hrefs: string[]; iframes: string[] } | null> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT_MS });
    const html = await page.content();
    const hrefs: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href),
    );
    // A board embedded in an iframe is invisible to every link-based check.
    const iframes: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe[src]")).map(
        (f) => (f as HTMLIFrameElement).src,
      ),
    );
    return { html, hrefs, iframes };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function investigate(browser: Browser, careersUrl: string, website: string): Promise<Finding> {
  const root = (website.startsWith("http") ? website : `https://${website}`).replace(/\/$/, "");

  // 1. Render the registered careers page: ATS link, iframe, or a board in place.
  const rendered = await renderScan(browser, careersUrl);
  if (rendered) {
    const hay = `${rendered.html}\n${rendered.hrefs.join("\n")}`;
    const ats = atsMatch(hay);
    if (ats) return { kind: "ats", url: ats.url, evidence: `links ${ats.host}` };

    for (const src of rendered.iframes) {
      const inner = atsMatch(src);
      if (inner) return { kind: "iframe", url: inner.url, evidence: `iframe -> ${inner.host}` };
    }

    const self = selfHostedEvidence(rendered.html);
    if (self) return { kind: "self-hosted", url: careersUrl, evidence: self };

    // 2. Two hops, following any career-ish internal link rather than only
    //    keyword-matched anchor TEXT.
    const hops = rendered.hrefs
      .filter((h) => /career|job|opening|vacanc|opportunit|join|campus|intern|team/i.test(h))
      .filter((h) => !BAD.test(h))
      .slice(0, 8);

    for (const hop of hops) {
      await new Promise((r) => setTimeout(r, GAP_MS));
      const sub = await renderScan(browser, hop);
      if (!sub) continue;
      const subAts = atsMatch(`${sub.html}\n${sub.hrefs.join("\n")}`);
      if (subAts) return { kind: "ats", url: subAts.url, evidence: `via ${hop.slice(0, 60)}` };
      const subSelf = selfHostedEvidence(sub.html);
      if (subSelf) return { kind: "self-hosted", url: hop, evidence: subSelf };
    }
  }

  // 3. The sitemap - pages the site wants indexed, including unlinked ones.
  for (const candidate of await sitemapCandidates(root)) {
    const html = await getText(candidate);
    if (!html) continue;
    const ats = atsMatch(html);
    if (ats) return { kind: "sitemap", url: ats.url, evidence: `sitemap ${candidate.slice(0, 55)}` };
    const self = selfHostedEvidence(html);
    if (self) return { kind: "sitemap", url: candidate, evidence: self };
  }

  // 4. Common board paths, for sites that link their board from nowhere.
  for (const path of GUESS_PATHS) {
    const html = await getText(`${root}${path}`);
    if (!html) continue;
    const ats = atsMatch(html);
    if (ats) return { kind: "ats", url: ats.url, evidence: `guessed ${path}` };
    const self = selfHostedEvidence(html);
    if (self) return { kind: "self-hosted", url: `${root}${path}`, evidence: `${self} at ${path}` };
  }

  return { kind: "none", url: careersUrl, evidence: "render + 2 hops + sitemap + 16 paths" };
}

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  // Declared out here so the browser AND its proxy are torn down on every exit
  // from the body, not only the one that reaches the end: the proxy's
  // listening socket would otherwise keep this process alive after main().
  let rendered: { browser: Browser; proxy: RenderProxy } | null = null;

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const listings = await db.select().from(schema.detectedListings);
    const firmById = new Map(firms.map((f) => [f.id, f]));

    const counts = new Map<string, number>();
    for (const l of listings) counts.set(l.sourceId, (counts.get(l.sourceId) ?? 0) + 1);

    // The firms the first pass wrote off: fetches fine, parses nothing.
    const targets = sources.filter((s) => (counts.get(s.id) ?? 0) === 0 && s.lastSuccessAt);
    console.log(`re-investigating ${targets.length} firms the first pass gave up on\n`);

    // The filtering proxy goes up with the browser and comes down with it in
    // the finally below, so neither outlives this pass.
    rendered = await launchFilteredBrowser();
    const browser = rendered.browser;
    const byKind = new Map<Finding["kind"], string[]>();

    for (const [i, s] of targets.entries()) {
      const firm = firmById.get(s.firmId);
      const name = firm?.name ?? "?";
      const finding = await investigate(browser, s.careersUrl, firm?.website ?? "");
      const line = `  ${name.padEnd(34)} ${finding.evidence.padEnd(40)} ${finding.url.slice(0, 80)}`;
      byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), line]);
      console.log(`[${i + 1}/${targets.length}] ${name}: ${finding.kind} (${finding.evidence})`);
    }

    for (const kind of ["ats", "iframe", "sitemap", "self-hosted", "none"] as Finding["kind"][]) {
      const rows = byKind.get(kind) ?? [];
      console.log(`\n===== ${kind.toUpperCase()} (${rows.length}) =====`);
      for (const r of rows) console.log(r);
    }
  } finally {
    await rendered?.browser.close().catch(() => {});
    await rendered?.proxy.close().catch(() => {});
    await closeDb();
  }
}

main();
