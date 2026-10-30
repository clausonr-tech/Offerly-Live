import "server-only";

/**
 * Asking a site's robots.txt whether we may read a page, at the moment we
 * read it.
 *
 * WHAT WAS MISSING
 * ----------------
 * This codebase already reasons carefully about robots.txt - it refused a
 * Google Jobs scraper partly because `google.com/robots.txt` disallows
 * `/search`, refused UltiPro's board endpoint on the same grounds, and built
 * the Kroll connector around a sitemap precisely because Kroll's robots.txt
 * advertises the sitemap while disallowing `/api/`.
 *
 * But every one of those was a HUMAN reading robots.txt once, while writing a
 * connector. Nothing read it at runtime. The generic connector fetches 63
 * careers pages that arrived from discovery, and follows listing links off
 * them to arbitrary URLs, having never asked any of those sites anything. The
 * policy existed; the enforcement did not.
 *
 * WHERE THIS IS ENFORCED, AND WHERE IT IS NOT
 * -------------------------------------------
 * Enforced on the paths that fetch URLs nobody assessed: the generic
 * connector's board fetches and its detail-page follows, and board discovery.
 *
 * NOT applied to the vendor APIs behind the specialist connectors
 * (Greenhouse, Lever, Ashby, Workday, Oracle, iCIMS, Getro and the rest).
 * Those are a small, fixed set of documented endpoints, each assessed when
 * its connector was written, and each is a published API meant to be read by
 * software. Running a generic robots check over them would either change
 * nothing or break a working connector on a rule written for search-engine
 * crawlers - and it would do so silently, which is the failure mode this file
 * exists to remove. `ROBOTS_EXEMPT_HOSTS` lists them with that reasoning
 * attached, so the exemption is a decision on the record rather than an
 * oversight.
 *
 * FAILING OPEN, DELIBERATELY
 * --------------------------
 * A robots.txt that cannot be fetched - timeout, 500, DNS failure - is
 * treated as permission. That is what the standard says (absence of
 * robots.txt means no restriction), and the alternative is worse: a crawler
 * that stops reading a firm the moment that firm's CDN has a bad minute, and
 * reports it as a coverage gap.
 *
 * A 4xx is also permission. A 403 on robots.txt itself is not a prohibition
 * on the site; it is a misconfigured server.
 */

import { safeFetch } from "./safe-fetch";

/** The token we match groups against, lowercased. Must be a substring of the
 *  crawler's real User-Agent header, or we would be honouring rules written
 *  for somebody else. */
export const ROBOTS_AGENT = "offerlymonitor";

const FETCH_TIMEOUT_MS = 8000;

/** robots.txt is a text file. Reading more than this of one is reading
 *  something else - a host answering /robots.txt with a video, or a bomb that
 *  expands into the crawl's memory. Google's own published limit is 500KB. */
const MAX_ROBOTS_BYTES = 512 * 1024;

/** The most Allow/Disallow rules one host's policy may hold. See the comment
 *  at the break in parseRobots for why a cap belongs here at all. */
const MAX_RULES = 2000;

/** How long a parsed robots.txt is trusted. Long enough that a crawl cycle
 *  costs one request per host, short enough that a site changing its mind is
 *  honoured the same day. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Hosts whose robots.txt is deliberately not consulted, with the reason.
 *
 * Every entry is a documented API endpoint that a connector was written
 * against after a human assessed it. Adding a host here is a decision, not a
 * convenience - it belongs to the same standard that said yes to Kroll's
 * sitemap and no to Google Jobs.
 */
export const ROBOTS_EXEMPT_HOSTS = new Set([
  "boards-api.greenhouse.io", // documented public job board API
  "api.lever.co", // documented public postings API
  "api.ashbyhq.com", // documented public posting API
  "api.smartrecruiters.com", // documented public postings API
  "apply.workable.com", // documented public widget API
  "api.getro.com", // public collection search behind their own boards
  "api-higher.gs.com", // Goldman's own board API, assessed in goldman.ts
]);

type RobotsRule = { allow: boolean; path: string };
type RobotsPolicy = { rules: RobotsRule[]; fetchedAt: number };

const cache = new Map<string, RobotsPolicy>();

/**
 * Parses the subset of robots.txt that actually decides anything here:
 * User-agent grouping, Allow and Disallow.
 *
 * Crawl-delay and Sitemap are ignored on purpose - pacing is already handled
 * by fetch-pool.ts per domain, and sitemaps are a discovery input rather than
 * a permission.
 *
 * Group selection follows the standard: the most specific matching group
 * wins, so a block naming us beats a wildcard block, and if we are named
 * anywhere the wildcard block does not apply at all.
 */
export function parseRobots(text: string, agent: string = ROBOTS_AGENT): RobotsRule[] {
  const named: RobotsRule[] = [];
  const wildcard: RobotsRule[] = [];
  let rulesSeen = 0;

  let appliesToUs = false;
  let appliesToAll = false;
  // A blank line ends a group; consecutive User-agent lines share one group.
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) {
      appliesToUs = false;
      appliesToAll = false;
      lastLineWasAgent = false;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      /**
       * A group header names a PRODUCT TOKEN (RFC 9309 §2.2.1), and the
       * comparison is an exact, case-insensitive one on that token.
       *
       * Two things substring matching got wrong (security review, 10 October
       * 2026). `agent.includes("")` is true, so a malformed `User-agent:`
       * with no value claimed us - which put its rules in `named`, and
       * because a file that names us anywhere discards its wildcard group,
       * threw away the site's real policy (`Disallow: /` included) over a
       * blank line. And matching in the other direction let any token
       * CONTAINING ours claim us, so a site writing rules for
       * `superofferlymonitorbot` was writing them for us.
       *
       * A value-less line is ignored rather than treated as a group header,
       * so it neither opens a group nor ends the one in progress.
       */
      const token = value.toLowerCase();
      if (!token) continue;
      // A new group starts unless we are still in a run of agent lines.
      if (!lastLineWasAgent) {
        appliesToUs = false;
        appliesToAll = false;
      }
      // A version suffix is not part of the product token, and sites do write
      // one ("User-agent: OfferlyMonitor/1.0"). Dropping it keeps a rule
      // somebody wrote FOR us honoured, which is the direction to err in.
      const product = token.split("/")[0];
      if (token === "*") appliesToAll = true;
      else if (product === agent) appliesToUs = true;
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (field !== "allow" && field !== "disallow") continue;
    if (!appliesToUs && !appliesToAll) continue;

    // "Disallow:" with an empty value means allow everything - it is the
    // standard's way of writing an empty prohibition, and treating it as a
    // prohibition on "" would block every URL on the site.
    if (field === "disallow" && value === "") continue;

    // Every rule is matched against every URL this host serves us, so the
    // rule COUNT is a per-URL cost the host chooses. A file with a hundred
    // thousand rules is not a site stating a policy. Google stops reading a
    // robots.txt at 500KB for the same reason; this is the same limit
    // expressed in the unit that actually costs us anything.
    if (++rulesSeen > MAX_RULES) break;

    const rule: RobotsRule = { allow: field === "allow", path: value };
    if (appliesToUs) named.push(rule);
    if (appliesToAll) wildcard.push(rule);
  }

  // If the file names us anywhere, its wildcard group does not apply to us.
  return named.length ? named : wildcard;
}

/**
 * Does a robots path pattern match this URL path? Supports the two wildcards
 * real robots.txt files use: `*` for any run, `$` for end.
 *
 * NOT A REGEX, AND THAT IS THE POINT
 * ----------------------------------
 * This used to build `new RegExp("^" + pattern-with-each-*-as-.*)` and run it
 * against the path. Both halves of that are attacker-chosen: the pattern
 * comes from the crawled host's own robots.txt, and the path comes from a
 * link on a scraped index page. `Disallow: /*a*a*a*a*a*a*a*a*b` against a
 * path of a few hundred `a`s and no `b` is the textbook catastrophic
 * backtracking case - V8's engine tries every way of splitting the run
 * between the stars, which is polynomial in the path length with the exponent
 * set by the number of stars. Measured on Node 24 with that exact pattern:
 * 69ms at 30 characters of path, 382ms at 40, 2.1 SECONDS at 50, and the path
 * comes off a scraped link, so its length is the attacker's to choose. The
 * try/catch around it caught compilation errors, which is not the failure
 * that happens.
 *
 * What made that a crawl-wide outage rather than one slow source: the match
 * is synchronous, so a wedged regex blocks the event loop, and the per-source
 * budget in monitor-run.ts is a setTimeout raced against the work - a timer
 * cannot fire while the loop is blocked. The hourly scheduled-crawl.sh lock
 * then logs SKIPPED for every later run while the stuck process holds it.
 *
 * So the matcher is a straight segment walk instead. The pattern splits on
 * `*` into literal segments; the first must sit at the start, each later one
 * is found with indexOf from where the previous one ended, and a trailing `$`
 * means the last segment must land at the end. Greedy with no backtracking:
 * taking the EARLIEST occurrence of each segment can never lose a match that
 * a later occurrence would have found, because a `*` matches any run. That is
 * linear in the path length per segment, and the segment count is bounded
 * below, so the whole thing is bounded by construction rather than by luck.
 *
 * One deliberate difference from the regex: a `$` anywhere but the end is now
 * a literal dollar sign. In the regex it was an anchor mid-pattern, which
 * made the rule match nothing at all - no real robots.txt means that, and
 * treating it as the character it looks like is both safer and closer to what
 * the standard says.
 *
 * WHEN THE ANSWER IS NEITHER YES NOR NO
 * -------------------------------------
 * The caps below used to answer `false`, with a comment claiming that was
 * "the same answer the old code gave a pattern that would not compile". That
 * was wrong twice over (security review, 10 October 2026). The patterns the
 * caps turn away - 513 characters, twenty stars - COMPILED fine in the old
 * version and were enforced; the try/catch never saw them. And `false` from
 * `matches` does not mean "unenforceable", it means "this rule does not
 * apply to this URL", so a `Disallow` the old code honoured became silently
 * absent. A cap that fails OPEN in the project's only robots-compliance gate
 * is new permissiveness dressed as compatibility.
 *
 * So an unenforceable pattern now says so, and `isPathAllowed` reads it
 * CONSERVATIVELY: a `Disallow` it cannot evaluate is treated as applying, and
 * an `Allow` it cannot evaluate as not applying. The worst case is a page the
 * crawl declines to read, which is the right way round for a politeness gate.
 */

/** A pattern either matches this path, does not, or is one this matcher will
 *  not evaluate. The third answer is a real answer, and the whole reason the
 *  return type is not a boolean - see WHEN THE ANSWER IS NEITHER above. */
export type PatternMatch = boolean | "unenforceable";

/** Patterns longer than this, or with more wildcards than this, are not
 *  evaluated. They are not a cost problem - the walk below is linear in the
 *  path per segment with no backtracking, so these caps buy no speed - they
 *  are a sanity bound: real robots.txt rules are paths, and anything at this
 *  scale is either broken or aimed at us, so it is answered
 *  "unenforceable" rather than guessed at. Measured against the rules the
 *  crawl actually meets, the longest was 97 characters with 3 stars. */
const MAX_PATTERN_LENGTH = 512;
const MAX_WILDCARDS = 16;

/** How much of a path is walked. A URL this long is not a page a site meant
 *  to publish - 8KB is the request-line ceiling every common server enforces
 *  - and past it the path is cut rather than walked. Whether the cut part
 *  would have completed a match is then unknown, so a miss on a truncated
 *  path is reported as "unenforceable" rather than as a clean miss. */
const MAX_PATH_LENGTH = 8192;

export function matches(pattern: string, path: string): PatternMatch {
  if (pattern === "") return false;
  if (!pattern.includes("*") && !pattern.includes("$")) return path.startsWith(pattern);
  if (pattern.length > MAX_PATTERN_LENGTH) return "unenforceable";

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");
  if (segments.length - 1 > MAX_WILDCARDS) return "unenforceable";

  // A path past the ceiling is cut. An anchored pattern cannot be judged at
  // all against a cut path, because the end it anchors to is the end that was
  // removed; for the rest, a match found inside the kept part is still a
  // match, while a miss is only a miss for the part that was kept.
  const truncated = path.length > MAX_PATH_LENGTH;
  if (truncated && anchored) return "unenforceable";
  const subject = truncated ? path.slice(0, MAX_PATH_LENGTH) : path;
  const miss: PatternMatch = truncated ? "unenforceable" : false;

  // The first segment is not preceded by a `*`, so it must sit at the start.
  const first = segments[0];
  if (!subject.startsWith(first)) return miss;
  let at = first.length;

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === "") {
      // A trailing `*` matches the rest; a trailing `*$` does too.
      if (last) return true;
      continue;
    }
    if (last && anchored) {
      // `...*foo$`: the pattern ends here, so foo must be what the path ends with.
      return subject.length - segment.length >= at && subject.endsWith(segment);
    }
    const found = subject.indexOf(segment, at);
    if (found === -1) return miss;
    at = found + segment.length;
  }

  // Unanchored, so whatever is left of the path is free to be anything.
  return anchored ? at === subject.length : true;
}

/**
 * Applies parsed rules to a path.
 *
 * Longest match wins, and Allow beats Disallow at equal length - which is the
 * behaviour every major crawler implements and the reason a site can write
 * `Disallow: /` followed by `Allow: /careers` and mean it.
 *
 * A rule the matcher will not evaluate is read in the direction that keeps
 * the site's wishes rather than ours: a `Disallow` counts as matching, an
 * `Allow` does not.
 */
export function isPathAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    const verdict = matches(rule.path, path);
    if (verdict === false) continue;
    if (verdict === "unenforceable" && rule.allow) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

async function policyFor(origin: string): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  let rules: RobotsRule[] = [];
  try {
    const response = await safeFetch(`${origin}/robots.txt`, {
      headers: { "user-agent": `OfferlyMonitor/1.0`, accept: "text/plain" },
      timeoutMs: FETCH_TIMEOUT_MS,
      // The body gets the same 8s and a text file's worth of bytes. Both
      // failures land in the catch below, which is the deliberate fail-open:
      // a host that will not hand over a readable robots.txt has not
      // prohibited anything.
      bodyTimeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_ROBOTS_BYTES,
    });
    // 4xx means no usable robots.txt, which means no restriction. Only a
    // 200 that actually parses can restrict anything.
    if (response.ok) rules = parseRobots(await response.text());
  } catch {
    // Failing open - see the header. A site's CDN having a bad minute must
    // not turn into a permanent coverage gap.
    rules = [];
  }

  const policy = { rules, fetchedAt: Date.now() };
  cache.set(origin, policy);
  return policy;
}

/** May we fetch this URL? Exempt hosts short-circuit to true. */
export async function isAllowedByRobots(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (ROBOTS_EXEMPT_HOSTS.has(url.hostname.toLowerCase())) return true;

  const policy = await policyFor(url.origin);
  return isPathAllowed(policy.rules, `${url.pathname}${url.search}`);
}
