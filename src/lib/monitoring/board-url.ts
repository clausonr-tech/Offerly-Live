import "server-only";
import { publicHttpUrl } from "@/lib/safe-url";
import { isHostOrSubdomainOf } from "./vendor-host";

/**
 * Turning a link found on a careers page into the board URL we should poll -
 * or saying plainly that it is not a board at all.
 *
 * Discovery finds links, and a link to an ATS host is not the same thing as a
 * link to its job board. The two failure shapes seen across this firm set:
 *
 *   1. LOGIN AND ACCOUNT PORTALS. Barclays' careers site links to
 *      `barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays/login?redirect=...`
 *      and Bank of America's to `ghr.wd1.myworkdayjobs.com/en-us/lateral-us/login`.
 *      Stored as-is these fetch cleanly forever and parse zero listings, which
 *      is indistinguishable from a board with no open roles - so the source
 *      looks healthy and silently reports nothing. Worse, they invite the one
 *      thing that actually creates legal exposure: a login page is where an
 *      account gets made, and an account is where terms get accepted.
 *
 *   2. WIDGET AND SINGLE-POSTING URLS. A Greenhouse link on a careers page is
 *      usually `/embed/job_board?for=<token>` or one `/jobs/<id>`, and the
 *      connector reads the token from the first path segment - so "embed"
 *      would be stored as the board name.
 *
 * Both are recoverable: the tenant and site are right there in the URL. This
 * rewrites what can be rewritten and refuses what cannot.
 */

export type NormalizedBoard =
  | { ok: true; url: string; note: string | null }
  | { ok: false; reason: string };

/** Path segments that mean "this is the account machinery, not the board". */
const PORTAL_SEGMENTS = new Set([
  "login",
  "signin",
  "sign-in",
  "register",
  "signup",
  "sign-up",
  "candidate",
  "candidates",
  "profile",
  "account",
  "apply",
  "application",
  "forgotpassword",
  "resetpassword",
]);

const LOCALE = /^[a-z]{2}([-_][A-Za-z]{2})?$/;

/**
 * Boards that exist, work, and are for the wrong people.
 *
 * Discovery returned `moelis.wd1.myworkdayjobs.com/Experienced-Hires` and
 * `ghr.wd1.myworkdayjobs.com/en-us/lateral-us`. Both are real Workday boards
 * that parse perfectly - and every posting on them is an experienced hire,
 * which the classifier then rejects one at a time, forever. Registering one
 * costs a request every cycle to relearn that it has nothing for a student.
 *
 * Refused here rather than filtered downstream so the gap stays VISIBLE: the
 * firm ends up with no source and shows up as uncovered, which is true, instead
 * of a healthy source that silently yields nothing.
 */
const LATERAL_PATH = /(experienced[-_]?hires?|lateral|professional[-_]?hires?|alumni)/i;

/** A link to one posting is not a link to the board it sits on. */
const SINGLE_POSTING = /\/job\/|\/jobs\/\d|_R\d{6,}|\/requisition\/\d/i;

/** Discovery reads URLs out of raw HTML, so they arrive carrying the page's
 *  own escaping - `&#34;` and `&#038;` both turned up in this run. Decoded
 *  before parsing, or the query string is silently wrong. */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&#0*38;|&amp;/g, "&")
    .replace(/&#0*34;|&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*60;|&lt;/g, "<")
    .replace(/&#0*62;|&gt;/g, ">")
    // An entity-escaped quote marks where the real URL ended and the
    // surrounding markup resumed; everything after it is not part of the URL.
    .split(/["'<>]/)[0];
}

export function normalizeBoardUrl(raw: string): NormalizedBoard {
  const cleaned = decodeEntities(raw.trim());

  /**
   * Scheme and host policy FIRST, before any rewriting.
   *
   * `new URL()` parses `javascript:alert(1)` perfectly happily - protocol
   * `javascript:`, empty hostname, pathname `alert(1)` - and none of the
   * branches below test a scheme, so such a link fell through "everything
   * else" and came back `ok` with the string intact, ready to be registered
   * as a board. These URLs come out of `decodeEntities` on raw scraped HTML,
   * so the one thing certain about them is that we did not choose them.
   * publicHttpUrl also turns away loopback, bare addresses and odd ports -
   * see lib/safe-url.
   */
  const policed = publicHttpUrl(cleaned);
  if (!policed) {
    return { ok: false, reason: "not a public http(s) URL" };
  }

  let url: URL;
  try {
    url = new URL(policed);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  // A script, stylesheet or CDN bundle is not a board. Discovery matched the
  // Phenom PATTERN against RBC's and Truist's pages and returned
  // `pp-cdn.phenompeople.com/.../ph-search-results-v2-default-30.js` - the
  // widget's own JavaScript. It proves the firm runs Phenom and says nothing
  // about where their jobs are.
  if (/\.(js|css|json|png|jpe?g|svg|woff2?|ico|map)$/i.test(url.pathname)) {
    return { ok: false, reason: "a static asset (the widget's own code), not a board" };
  }
  if (/^(cdn|assets?|static|[a-z-]*-cdn)\./i.test(url.hostname)) {
    return { ok: false, reason: "a CDN host, not a board" };
  }

  if (LATERAL_PATH.test(url.pathname)) {
    return { ok: false, reason: "an experienced-hire / lateral board, not a student one" };
  }
  // Greenhouse is exempt: its single-posting URLs carry the board token in the
  // segment before /jobs/, so the branch below recovers the board rather than
  // throwing the firm away. Nowhere else can we reconstruct it.
  if (!isHostOrSubdomainOf(url.hostname, "greenhouse.io") && SINGLE_POSTING.test(url.pathname)) {
    return { ok: false, reason: "a link to one posting, not to a board" };
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  // ---- Workday ---------------------------------------------------------
  // https://{tenant}.wd{n}.myworkdayjobs.com/{locale?}/{site}[/...]
  // The site id is the first non-locale segment; everything after it is a
  // filter, a posting, or the login machinery, and none of it belongs in a
  // board URL.
  if (isHostOrSubdomainOf(host, "myworkdayjobs.com")) {
    const localePrefix = segments[0] && LOCALE.test(segments[0]) ? segments[0] : null;
    const rest = localePrefix ? segments.slice(1) : segments;
    const site = rest[0];
    if (!site || PORTAL_SEGMENTS.has(site.toLowerCase())) {
      return { ok: false, reason: "Workday URL with no site id - a search or account page" };
    }
    // `search` and `job` are Workday's own non-board paths.
    if (site === "search" || site === "job") {
      return { ok: false, reason: "Workday search/posting URL, not a board" };
    }
    const trimmed = `https://${host}${localePrefix ? `/${localePrefix}` : ""}/${site}`;
    const dropped = rest.length > 1 || url.search;
    return {
      ok: true,
      url: trimmed,
      note: dropped ? "trimmed to the board root (dropped login/filter path)" : null,
    };
  }

  // ---- Greenhouse ------------------------------------------------------
  // The connector reads the board token from the first path segment, so an
  // /embed/ widget URL or a single /jobs/<id> has to be rewritten to the root.
  if (isHostOrSubdomainOf(host, "greenhouse.io")) {
    /**
     * The embed widget's `?for=` token, validated before it is trusted.
     *
     * It came off a scraped page, and it was being interpolated straight into
     * a URL - so `?for=../../x` or `?for=https://elsewhere` produced a board
     * address nobody chose. A Greenhouse board token is a short identifier,
     * so anything that is not one is not a token.
     */
    const forParam = url.searchParams.get("for");
    if (forParam) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(forParam)) {
        return { ok: false, reason: "Greenhouse embed ?for= is not a board token" };
      }
      return {
        ok: true,
        url: `https://boards.greenhouse.io/${forParam}`,
        note: "rebuilt from the embed widget's ?for= token",
      };
    }
    const token = segments[0] === "embed" ? segments[1] : segments[0];
    if (!token || PORTAL_SEGMENTS.has(token.toLowerCase())) {
      return { ok: false, reason: "Greenhouse URL with no board token" };
    }
    const note = segments.length > 1 ? "trimmed to the board root" : null;
    return { ok: true, url: `https://${host}/${token}`, note };
  }

  // ---- TalentLink ------------------------------------------------------
  // The advertised vacancy list lives at a fixed path; a careers page usually
  // links at the FAQ or the candidate home instead.
  if (isHostOrSubdomainOf(host, "tal.net")) {
    if (url.pathname.includes("/jobboard/")) {
      return { ok: true, url: url.toString(), note: null };
    }
    return {
      ok: true,
      url: `https://${host}/candidate/jobboard/vacancy/2/adv/`,
      note: "rewritten from a candidate/FAQ path to the advertised vacancy list",
    };
  }

  // ---- Lever -----------------------------------------------------------
  if (isHostOrSubdomainOf(host, "lever.co")) {
    const company = segments[0];
    if (!company || PORTAL_SEGMENTS.has(company.toLowerCase())) {
      return { ok: false, reason: "Lever URL with no company segment" };
    }
    return { ok: true, url: `https://jobs.lever.co/${company}`, note: segments.length > 1 ? "trimmed to the board root" : null };
  }

  // ---- Avature ---------------------------------------------------------
  // Measured across this firm set, Avature is not hosting job boards at all.
  // Goldman's is a candidate login portal; Barclays' /GraduatesAndInterns is a
  // talent-pool signup form titled "Let's keep in touch" that collects a name
  // and an email and lists no jobs; William Blair's returns an empty body.
  //
  // Refused rather than parsed, for two reasons. There is nothing to read, so a
  // source registered here would fetch cleanly forever and report zero listings
  // - indistinguishable from a board with no open roles. And a signup form is
  // exactly where an account gets created, which is the single thing that turns
  // reading public data into accepting somebody's terms.
  //
  // Not a statement about Avature generally: a real Avature board elsewhere
  // would be worth a connector. It is a statement about what these three URLs
  // are.
  if (isHostOrSubdomainOf(host, "avature.net")) {
    return {
      ok: false,
      reason: "Avature talent-pool/candidate portal - a signup form, not a job board",
    };
  }

  // ---- Everything else -------------------------------------------------
  // iCIMS, Oracle HCM and Eightfold boards carry meaningful query strings, so
  // they are left alone. A bare account path is still refused.
  const last = segments[segments.length - 1]?.toLowerCase();
  if (last && PORTAL_SEGMENTS.has(last) && !url.search) {
    return { ok: false, reason: `ends in /${last} - an account page, not a board` };
  }

  return { ok: true, url: url.toString(), note: null };
}
