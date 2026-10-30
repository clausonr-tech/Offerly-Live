import "server-only";

/**
 * The identity of a BOARD, as opposed to the identity of a firm or of a URL.
 *
 * Four boards in this set are currently fetched twice under two firm names,
 * and between them they hold 313 duplicate listing rows: Stifel and Miller
 * Buckfire (149), Cantor Fitzgerald and BGC (84), Cowen and TD (40), Mizuho
 * and Greenhill (40). Every one of those pairs is a single employer running a
 * single board, so the second fetch buys nothing and the second copy of each
 * listing then has to be classified, reviewed and deduplicated by hand
 * downstream.
 *
 * The obvious fix - compare `careersUrl` strings - does not work, and the
 * pairs above are exactly why:
 *
 *   https://stifel.wd5.myworkdayjobs.com/Stifel_External
 *   https://stifel.wd5.myworkdayjobs.com/en-US/Stifel_External?workerSubType=Intern
 *
 * Different strings, same board. Locale prefixes, filter query strings and
 * trailing slashes all vary between two firms' careers pages linking at the
 * same place, so identity has to be derived from the parts of the URL the ATS
 * itself treats as the board - the tenant and the site - and nothing else.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a merge. Two firms sharing a board stay two firms: students search for
 * Miller Buckfire by name and a posting on Stifel's board may genuinely be a
 * Miller Buckfire role. This only decides which firm POLLS the board; the
 * other is attached to the same source through `parentFirmId`, which exists in
 * the schema for this and is currently null on all 106 sources.
 *
 * Not a claim that two firms sharing a board are the same company. It is only
 * a claim that fetching the URL twice returns the same bytes.
 */

/** A stable, comparable key for the board behind a URL. */
export type BoardIdentity = {
  /** `connector:tenant[:site]`, lowercased. Equal keys mean one board. */
  key: string;
  /** The URL that should actually be polled, once. */
  canonicalUrl: string;
};

/** Locale segments Workday and others put in front of the site id. */
const LOCALE = /^[a-z]{2}([-_][A-Za-z]{2})?$/;

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Path segments with the locale prefix removed.
 *
 * Kept separate from the segment list itself because `en-US` is a real
 * segment to a URL parser and noise to every ATS here.
 */
function segmentsWithoutLocale(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  return segments[0] && LOCALE.test(segments[0]) ? segments.slice(1) : segments;
}

/**
 * The identity of the board a URL points at, or null when the URL carries no
 * board identity we can name.
 *
 * Null is not an error and must not be treated as "no duplicate". It means
 * *this function cannot tell*, which is the honest answer for a bespoke
 * careers page, and the caller falls back to comparing normalized URLs - a
 * weaker test that catches the exact-match case and nothing else.
 */
export function boardIdentity(careersUrl: string, connectorId: string): BoardIdentity | null {
  let url: URL;
  try {
    url = new URL(careersUrl);
  } catch {
    return null;
  }

  const host = stripWww(url.hostname);
  const segments = segmentsWithoutLocale(url.pathname);

  switch (connectorId) {
    // ---- Tenant + site -------------------------------------------------
    // Workday's board is the tenant host plus the site id. Everything after
    // the site id is a filter or a posting, and the locale is presentation.
    case "workday": {
      const site = segments[0];
      if (!site) return null;
      return {
        key: `workday:${host}:${site.toLowerCase()}`,
        canonicalUrl: `https://${url.hostname}/${site}`,
      };
    }

    // Oracle's site number is the board; the host is the pod it happens to be
    // provisioned on. Two firms on one pod are NOT one board, so both are part
    // of the key.
    case "oracle-hcm": {
      /**
       * Three places Oracle puts the site id, and all three occur here.
       *
       * The first version read only the query forms and missed
       * `/hcmUI/CandidateExperience/en/sites/CX_1003`, which is the shape
       * Cantor Fitzgerald and BGC both use - so that pair was caught by the
       * URL fallback rather than by identity. It worked only because the two
       * URLs happened to be byte-identical; a locale difference or a trailing
       * slash between them and the duplicate would have gone unnoticed.
       */
      const site =
        url.searchParams.get("siteNumber") ??
        /siteNumber=([^,&;]+)/i.exec(url.href)?.[1] ??
        /\/sites\/([^/?#]+)/i.exec(url.pathname)?.[1] ??
        null;
      if (!site) return null;
      return { key: `oracle-hcm:${host}:${site.toLowerCase()}`, canonicalUrl: careersUrl };
    }

    // ---- Single-token boards -------------------------------------------
    // One path segment names the whole board on each of these.
    case "greenhouse":
    case "lever":
    case "ashby":
    case "smartrecruiters":
    case "workable":
    case "recruitee":
    case "teamtailor":
    case "breezy":
    case "jazzhr":
    case "pinpoint":
    case "rippling":
    case "comeet":
    case "jobvite": {
      const token = tokenForSingleTokenBoard(connectorId, url, segments);
      if (!token) return null;
      return {
        key: `${connectorId}:${token.toLowerCase()}`,
        canonicalUrl: canonicalSingleTokenUrl(connectorId, url, token),
      };
    }

    // Personio and some Recruitee/Teamtailor tenants name the board in the
    // SUBDOMAIN rather than in a path segment.
    case "personio": {
      const sub = host.split(".")[0];
      if (!sub) return null;
      return { key: `personio:${sub}`, canonicalUrl: `https://${host}/xml` };
    }

    // ---- Host-is-the-board ----------------------------------------------
    // iCIMS, TalentLink, Eightfold and the two firm-specific connectors have
    // one board per host, so the host IS the identity. Query strings on these
    // are filters over a single board, not separate boards.
    case "icims":
    case "talentlink":
    case "eightfold":
    case "successfactors":
    case "goldman":
    case "kroll":
      return { key: `${connectorId}:${host}`, canonicalUrl: careersUrl };

    // ---- Many firms per fetch -------------------------------------------
    // A portfolio board is one board covering many firms, which is the whole
    // reason to want it. Its identity is the collection, so two funds pointing
    // at the same collection are fetched once.
    case "getro":
    case "consider": {
      const collection = segments[0] ?? host.split(".")[0];
      if (!collection) return null;
      return { key: `${connectorId}:${host}:${collection.toLowerCase()}`, canonicalUrl: careersUrl };
    }

    // ---- No identity to derive ------------------------------------------
    // A bespoke careers page has no tenant and no token. Comparing normalized
    // URLs is the only test available, and saying so beats inventing a key
    // that would collide two unrelated pages on the same corporate host -
    // `careers.example.com/ib` and `careers.example.com/markets` are two
    // boards, and any host-based key would call them one.
    default:
      return null;
  }
}

/** Where each single-token platform keeps its token. */
function tokenForSingleTokenBoard(
  connectorId: string,
  url: URL,
  segments: string[],
): string | null {
  const host = stripWww(url.hostname);

  switch (connectorId) {
    // `{account}.recruitee.com`, `{account}.breezy.hr`, `{account}.teamtailor.com`,
    // `{account}.applytojob.com` - subdomain, with a path form as a fallback.
    case "recruitee":
    case "breezy":
    case "teamtailor":
    case "jazzhr": {
      const sub = host.split(".")[0];
      if (sub && sub !== "jobs" && sub !== "www") return sub;
      return segments[0] ?? null;
    }
    // Greenhouse's embed widget names the board in `?for=`, and the connector
    // reads the first path segment otherwise. Both forms appear on real
    // careers pages, so both resolve to the same key.
    case "greenhouse": {
      const forParam = url.searchParams.get("for");
      if (forParam) return forParam;
      return segments[0] === "embed" ? (segments[1] ?? null) : (segments[0] ?? null);
    }
    // SmartRecruiters and Workable nest the board under a fixed prefix on a
    // shared host: `jobs.smartrecruiters.com/{company}`,
    // `apply.workable.com/{account}`.
    default:
      return segments[0] ?? null;
  }
}

function canonicalSingleTokenUrl(connectorId: string, url: URL, token: string): string {
  switch (connectorId) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${token}`;
    case "lever":
      return `https://jobs.lever.co/${token}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${token}`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${token}`;
    case "workable":
      return `https://apply.workable.com/${token}`;
    default:
      // Subdomain-addressed boards are already canonical at their origin.
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
}

/**
 * The fallback identity for connectors with no derivable board key.
 *
 * Deliberately conservative - host and path only, with the query string kept,
 * because on a bespoke careers page `?dept=ib` genuinely is a different board
 * from `?dept=markets`. Dropping it here would merge two real sources and the
 * loss would be invisible.
 */
export function normalizedUrlKey(careersUrl: string): string {
  try {
    const url = new URL(careersUrl);
    const path = url.pathname.replace(/\/+$/, "");
    const query = [...url.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `url:${stripWww(url.hostname)}${path}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return `url:${careersUrl.trim().toLowerCase()}`;
  }
}

/** The key to dedup on: the board's own identity when we can name it, a
 *  normalized URL when we cannot. Never throws - an unparseable URL still
 *  gets a stable key so it can be compared to itself. */
export function dedupKey(careersUrl: string, connectorId: string): string {
  return boardIdentity(careersUrl, connectorId)?.key ?? normalizedUrlKey(careersUrl);
}

/**
 * The identity of a LISTING, across boards.
 *
 * `dedupKey` above stops one board being fetched twice. This stops one
 * POSTING being stored twice, which is a different problem and a new one: it
 * arrived with the Getro connector.
 *
 * A portfolio board republishes its companies' postings, and its `url` field
 * points straight at the underlying board - a Getro row for an Isar Aerospace
 * job carries `boards.greenhouse.io/isaraerospace/jobs/4980390101`. So the
 * same posting can legitimately reach us twice: once from the fund's portfolio
 * board and once from the employer's own Greenhouse, with different
 * `externalJobId`s and different source rows. Nothing downstream would notice,
 * and a student would see it twice.
 *
 * The application URL is the identity, because it is the thing a student
 * actually clicks, and two rows pointing at one application are one
 * opportunity however many boards advertise it.
 */
export function listingDedupKey(listing: {
  listingUrl: string;
  applicationUrl?: string | null;
  title: string;
  firmId?: string | null;
}): string {
  const url = listing.applicationUrl ?? listing.listingUrl;
  try {
    const parsed = new URL(url);
    /**
     * Tracking parameters are not identity.
     *
     * Portfolio boards append their own attribution - `?gh_src=`, `utm_*` -
     * to the very same posting URL, which is exactly the case this has to see
     * through. Everything else in the query is kept, because on some boards
     * the job id IS a query parameter.
     */
    const params = [...parsed.searchParams.entries()]
      .filter(([k]) => !/^(utm_|gh_src|gh_jid$|source$|ref$|src$)/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `listing:${host}${path}${params ? `?${params}` : ""}`.toLowerCase();
  } catch {
    /**
     * No usable URL - fall back to the firm and the title.
     *
     * Weaker on purpose, and scoped to one firm: two different firms can both
     * post "2027 Summer Analyst" and those are two real opportunities. Within
     * one firm, the same title twice is far more likely to be one posting
     * seen down two paths.
     */
    return `listing:${listing.firmId ?? "?"}:${listing.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
  }
}
