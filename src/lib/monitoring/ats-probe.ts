import "server-only";
import { isInconclusive } from "./http-outcome";

/**
 * Finding a firm's job board when nobody has told us where it is.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * Of 22,575 directory rows, 17,772 have a website and only 1,912 carry any
 * careers URL - and five of those point at a known ATS. Venture capital is the
 * starkest: 2,149 firms, 1,863 websites, zero careers URLs. So for the great
 * majority of the directory the question is not "which connector reads this
 * board" but "where is the board", and `discover-boards.ts` cannot help,
 * because it works by reading links off a careers page we do not have.
 *
 * THE TRICK
 * ---------
 * Boards on these platforms are addressed by a short token derived from the
 * company's own name, and each platform's public API answers 404 for a token
 * that does not exist and 200 with the postings for one that does. So a board
 * can be found by asking rather than by searching: derive the likely tokens
 * from the firm's domain, ask each platform, and a 200 is proof rather than
 * an inference.
 *
 * Requests go to the ATS vendors' APIs, not to the firms' own servers, which
 * is the property that makes this affordable at directory scale and polite at
 * any scale.
 *
 * WHY A 200 IS NOT AUTOMATICALLY PROOF
 * ------------------------------------
 * Some APIs answer 200 with an empty collection for an unknown tenant, which
 * would make every firm look like it has a board with no jobs. That is the
 * single failure mode that would quietly poison the directory, so no platform
 * is used for probing until `scripts/ats-probe-live-check.ts` has shown that
 * it answers a KNOWN-GOOD token and a DELIBERATELY BOGUS one differently.
 * `provenDiscriminating` records the outcome of that check, and the sweep
 * refuses to probe with a platform where it is false.
 *
 * This is the same standard that produced the Ashby, SmartRecruiters and
 * Workable connectors and rejected Getro's: an endpoint nobody has seen
 * respond is a guess with types on it.
 */

type ProbeOutcome = {
  /** A board really exists at this token. */
  found: boolean;
  /** How many postings came back - 0 with found=true is a real, empty board. */
  listings: number;
  httpStatus: number;
  /**
   * The answer was neither yes nor no, and must not be recorded as either.
   *
   * This distinction was missing from the first version and the live check
   * caught it immediately: Personio answered a bogus token with 429, and
   * "any status that is not 200 means no board" turned a rate limit into the
   * assertion that the firm has no Personio board. Across a sweep that is the
   * worse direction of two bad ones - the firm is written off with a stated
   * reason nobody will revisit, exactly the invisibility that hid 59 wrongly
   * rejected internships.
   *
   * Inconclusive means: ask again later, record nothing now.
   */
  inconclusive?: boolean;
  /** Populated when the response was not conclusive, for the audit trail. */
  note?: string;
};

/**
 * Statuses that mean "we did not get an answer", not "no".
 *
 * 429 is the vendor throttling us, and 5xx is the vendor being broken; both
 * are certain to appear in a sweep of thousands of firms and neither says
 * anything about whether a board exists. 0 is our own request failing.
 */
// Re-exported rather than redefined: monitor-run needs the same rule, and two
// copies of "which statuses are not answers" would drift the moment one of
// them learned about a new one. See src/lib/monitoring/http-outcome.ts.
export { isInconclusive };

/** The shared front half of every interpreter: statuses that decide the
 *  outcome before the body is even looked at. Returns null when the caller
 *  should go on and read the body. */
function statusVerdict(status: number): ProbeOutcome | null {
  if (isInconclusive(status)) {
    return {
      found: false,
      listings: 0,
      httpStatus: status,
      inconclusive: true,
      note: status === 429 ? "rate limited - no answer, not a negative" : "transport or vendor error",
    };
  }
  if (status !== 200) return { found: false, listings: 0, httpStatus: status };
  return null;
}

export type ProbePlatform = {
  /** The connector that would poll it, or null when we cannot read it yet.
   *  A null here is still worth finding: it converts an unexplained silence
   *  into a named, countable gap, exactly as discover-boards.ts does. */
  connectorId: string | null;
  name: string;
  /** The URL to ask. Must be the endpoint the CONNECTOR reads, not a
   *  different one on the same vendor - probing a URL we never poll would
   *  prove the wrong thing. */
  probeUrl(token: string): string;
  /** Where a human (and the connector) would find the board itself. */
  boardUrl(token: string): string;
  /** Reads a response and decides whether a board is really there. */
  interpret(status: number, body: string): ProbeOutcome;
  /**
   * A token known to exist, used only by the live check to prove the endpoint
   * answers real and fake tokens differently.
   */
  knownGoodToken: string;
  /** Set to true only after the live check has confirmed discrimination. */
  provenDiscriminating: boolean;
  /**
   * Minimum gap between requests to THIS vendor, when it needs more than the
   * default.
   *
   * Personio is the reason this field exists: it answered all six control
   * probes with 429 even at a 400ms gap with a five second retry, so the
   * check could never conclude anything about it. A vendor that throttles is
   * not a vendor to push harder - it is one to ask more slowly.
   */
  minGapMs?: number;
};

/**
 * Tokens nothing should ever resolve for - SIX of them, not one.
 *
 * The count is the whole point, and it was learned the hard way. With a single
 * control, Workable and Recruitee both looked dangerous: they answered our one
 * bogus string with 404 but returned zero-listing boards for improbable sweep
 * tokens like "5ycapitalmanagementlimited", which is the exact signature of an
 * API that accepts anything. Six controls settled it in one run - both refused
 * all six, so they discriminate correctly and those hits were real accounts
 * that happen to be empty.
 *
 * One control can only ever prove that a platform rejects THAT string.
 */
export const BOGUS_TOKENS = [
  "zzqqnotarealboard99",
  "qxvbnmzzlkjhgf2026",
  "plmoknijbuhv9981",
  "zxcvbnmasdfghjkl77",
  "wertyuiopasdfgh12",
  "mnbvcxzlkjhgfds44",
] as const;

/** JSON body helper that never throws on the HTML error pages some of these
 *  vendors serve instead of JSON. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function countArray(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}


/**
 * The interpreter almost every platform needs.
 *
 * Six of these APIs answer the same shape: a JSON body with an array of
 * postings, at the top level or under one key. Each had its own copy of
 * "check the status, parse, count the array, complain if it is missing" -
 * six near-identical functions whose only difference was a property name.
 *
 * `key` is where the array lives; null means the body IS the array.
 */
function jsonArrayInterpreter(key: string | null, label: string) {
  return (status: number, body: string): ProbeOutcome => {
    const verdict = statusVerdict(status);
    if (verdict) return verdict;
    const parsed = parseJson(body);
    const value = key === null ? parsed : (parsed as Record<string, unknown> | null)?.[key];
    const count = countArray(value);
    if (count === null) {
      return { found: false, listings: 0, httpStatus: status, note: `200 without ${label}` };
    }
    return { found: true, listings: count, httpStatus: status };
  };
}

/**
 * Proof from an HTML board, for vendors that publish no JSON.
 *
 * Three of the platforms below answer every token with 200 and a page, so
 * `statusVerdict` alone can never tell a real tenant from a typo. Measured
 * 20 September 2026:
 *
 *   jobs.jobvite.com/<real>/jobs     15,636 bytes, a board
 *   jobs.jobvite.com/<bogus>/jobs   178,996 bytes, Jobvite's marketing site
 *                                   - byte-identical for two different
 *                                     bogus tokens
 *   jobs.dayforcehcm.com/<real>     416,386 bytes, carries JobPosting
 *   jobs.dayforcehcm.com/<bogus>    405,367 bytes, carries none
 *
 * So the proof is a marker only a real board emits, never the status and
 * never the size. `found: false` here means "a page, but not a board", which
 * is the honest reading and is recorded as such.
 *
 * The failure direction is deliberate: a real tenant with no open postings
 * may emit no marker and be read as absent. That is a miss we can revisit,
 * as against claiming a firm has a board it does not have - which is what
 * would file another company's postings under this firm's name.
 */
function htmlMarkerInterpreter(opts: { proof: RegExp[]; countEach?: RegExp; label: string }) {
  return (status: number, body: string): ProbeOutcome => {
    const verdict = statusVerdict(status);
    if (verdict) return verdict;
    if (!opts.proof.some((re) => re.test(body))) {
      return { found: false, listings: 0, httpStatus: status, note: `200 without ${opts.label}` };
    }
    const count = opts.countEach ? (body.match(opts.countEach) ?? []).length : 0;
    return { found: true, listings: count, httpStatus: status };
  };
}

/**
 * Platforms worth asking.
 *
 * Ordered by how confident we are of reading the result: the five with
 * connectors come first, so a firm that is on two platforms is recorded on the
 * one we can actually poll.
 */
export const PROBE_PLATFORMS: ProbePlatform[] = [
  /**
   * The three added on 20 September, after their connectors were written.
   *
   * They sit first because their absence was costing real coverage: probing
   * has run across every industry WITHOUT them, so any firm whose board is on
   * Dayforce, BambooHR or Jobvite has been reported as having no board at all.
   * That is not a small set - Starwood Capital, Realterm and Stockbridge are
   * all in the monitored directory and all were invisible to the sweep.
   */
  {
    connectorId: "bamboohr",
    name: "BambooHR",
    // The endpoint the connector reads, not a different one on the same
    // vendor - a probe of a URL we never poll proves the wrong thing.
    probeUrl: (t) => `https://${encodeURIComponent(t)}.bamboohr.com/careers/list`,
    boardUrl: (t) => `https://${t}.bamboohr.com/careers`,
    knownGoodToken: "centurion", // 7 live postings, measured 20 Sep 2026
    provenDiscriminating: true,
    // A real account answers JSON; an unknown subdomain answers BambooHR's
    // own 45KB marketing page, identical for every bogus token tried.
    interpret: jsonArrayInterpreter("result", "a result array"),
  },
  {
    connectorId: "jobvite",
    name: "Jobvite",
    probeUrl: (t) => `https://jobs.jobvite.com/${encodeURIComponent(t)}/jobs`,
    boardUrl: (t) => `https://jobs.jobvite.com/${t}/jobs`,
    knownGoodToken: "starwoodcapitalgroup", // Starwood Capital, measured 20 Sep 2026
    provenDiscriminating: true,
    interpret: htmlMarkerInterpreter({
      // `jobvite.com/<x>/job` appears on the MARKETING page too, so it is not
      // proof; the jv- class prefix only appears on a rendered board.
      proof: [/class="jv-/i, /jv-job/i],
      countEach: /\/job\/[a-zA-Z0-9]/g,
      label: "a Jobvite board",
    }),
  },
  {
    connectorId: "dayforce",
    name: "Dayforce",
    probeUrl: (t) => `https://jobs.dayforcehcm.com/en-US/${encodeURIComponent(t)}/CANDIDATEPORTAL`,
    boardUrl: (t) => `https://jobs.dayforcehcm.com/en-US/${t}/CANDIDATEPORTAL`,
    knownGoodToken: "Realterm", // measured 20 Sep 2026; stockbridge also confirmed
    provenDiscriminating: true,
    // Dayforce renders a candidate-portal shell for ANY tenant string, so the
    // 200 says nothing. Only a real portal carries JobPosting.
    // Case-insensitive deliberately: Dayforce emits the marker with varying
    // capitalisation between tenants, and a case-sensitive `/JobPosting/`
    // reported a KNOWN-GOOD tenant as having no board. The control tokens
    // match none of it in any case.
    interpret: htmlMarkerInterpreter({
      proof: [/JobPosting/i],
      countEach: /JobPosting/gi,
      label: "an embedded JobPosting",
    }),
  },
  {
    connectorId: "greenhouse",
    name: "Greenhouse",
    probeUrl: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    boardUrl: (t) => `https://job-boards.greenhouse.io/${t}`,
    knownGoodToken: "miopartners", // 9 live postings during the 19 Sep VC sweep
    provenDiscriminating: true,
    interpret: jsonArrayInterpreter("jobs", "a jobs array"),
  },
  {
    connectorId: "lever",
    name: "Lever",
    probeUrl: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    boardUrl: (t) => `https://jobs.lever.co/${t}`,
    knownGoodToken: "seaportglobal", // Seaport Global, already monitored
    provenDiscriminating: true,
    interpret: jsonArrayInterpreter(null, "an array"),
  },
  {
    connectorId: "ashby",
    name: "Ashby",
    probeUrl: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    boardUrl: (t) => `https://jobs.ashbyhq.com/${t}`,
    knownGoodToken: "ashby", // Ashby's own board - verified 19 Sep
    provenDiscriminating: true,
    interpret: jsonArrayInterpreter("jobs", "a jobs array"),
  },
  {
    connectorId: "smartrecruiters",
    name: "SmartRecruiters",
    probeUrl: (t) =>
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t)}/postings?limit=1`,
    boardUrl: (t) => `https://jobs.smartrecruiters.com/${t}`,
    knownGoodToken: "smartrecruiters",
    /**
     * PERMANENTLY FALSE. Not a gap to close - a property of the API.
     *
     * Measured 19 September 2026 by scripts/ats-probe-live-check.ts:
     *
     *   real  "smartrecruiters"    -> 200, content[] with postings
     *   bogus "zzqqnotarealboard99" -> 200, content[] empty
     *
     * SmartRecruiters answers 200 for a company id that does not exist. So
     * probing here cannot find anything: every one of 17,772 firms would come
     * back as "a board with no jobs", thousands of sources would be
     * registered, and each would fetch cleanly forever while reporting
     * nothing - which is indistinguishable from a real board in a quiet
     * season. This is the exact failure the bogus-token half of the check was
     * written to catch, and it caught it on the first run.
     *
     * The CONNECTOR is unaffected and stays: it is only ever pointed at a
     * company id that came from a real link on a real careers page, where the
     * id is known rather than guessed.
     */
    provenDiscriminating: false,
    interpret(status, body) {
      const verdict = statusVerdict(status);
      if (verdict) return verdict;
      const parsed = parseJson(body) as { totalFound?: number; content?: unknown } | null;
      const content = countArray(parsed?.content);
      if (content === null) {
        return { found: false, listings: 0, httpStatus: status, note: "200 without content[]" };
      }
      return { found: true, listings: parsed?.totalFound ?? content, httpStatus: status };
    },
  },
  {
    connectorId: "workable",
    name: "Workable",
    probeUrl: (t) =>
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t)}?details=true`,
    boardUrl: (t) => `https://apply.workable.com/${t}`,
    knownGoodToken: "deliveroo",
    /**
     * Proven, but only after six negative controls.
     *
     * With one control this looked like SmartRecruiters: it refused our bogus
     * string yet returned zero-listing boards for sweep tokens as improbable
     * as "5ycapitalmanagementlimited". Measured 19 September 2026, six
     * nonsense tokens were ALL refused with 404, so the platform does
     * distinguish real tenants - those hits were real accounts sitting empty.
     *
     * A 200 here carries an account name and description even when `jobs` is
     * empty, which is what makes an empty board distinguishable from an absent
     * one. An empty board still enrols only at the discovery cadence, because
     * enrollment.ts treats "found but never parsed listings" as unverified.
     */
    provenDiscriminating: true,
    interpret: jsonArrayInterpreter("jobs", "a jobs array"),
  },

  // ---- No connector yet -------------------------------------------------
  // These are on discover-boards.ts's pattern list as `connector: "none"` -
  // we can already RECOGNISE them on a careers page and cannot read them.
  // Probing them still pays: it names the gap and sizes it, which is what
  // decides whether a connector is worth writing. A connector gets written
  // when the live check proves the endpoint, and not before.
  {
    connectorId: "recruitee",
    name: "Recruitee",
    probeUrl: (t) => `https://${encodeURIComponent(t)}.recruitee.com/api/offers/`,
    boardUrl: (t) => `https://${t}.recruitee.com`,
    knownGoodToken: "vinted", // verified 19 Sep: 200 with offers[], bogus 404
    /**
     * Proven, but only after six negative controls.
     *
     * With one control this looked like SmartRecruiters: it refused our bogus
     * string yet returned zero-listing boards for sweep tokens as improbable
     * as "5ycapitalmanagementlimited". Measured 19 September 2026, six
     * nonsense tokens were ALL refused with 404, so the platform does
     * distinguish real tenants - those hits were real accounts sitting empty.
     *
     * A 200 here carries an account name and description even when `jobs` is
     * empty, which is what makes an empty board distinguishable from an absent
     * one. An empty board still enrols only at the discovery cadence, because
     * enrollment.ts treats "found but never parsed listings" as unverified.
     */
    provenDiscriminating: true,
    interpret: jsonArrayInterpreter("offers", "an offers array"),
  },
  {
    connectorId: "getro",
    name: "Getro",
    /**
     * Probed by PAGE rather than by API, because Getro's API is addressed by
     * a numeric collection id that only the page knows. The board's own
     * Next.js state carries it, so one request both proves the board exists
     * and yields the id the connector needs.
     */
    probeUrl: (t) => `https://${encodeURIComponent(t)}.getro.com/jobs`,
    boardUrl: (t) => `https://${t}.getro.com/jobs`,
    knownGoodToken: "hv", // HV Capital - network 234, verified 19 Sep
    provenDiscriminating: true,
    interpret(status, body) {
      const verdict = statusVerdict(status);
      if (verdict) return verdict;
      /**
       * A NUMERIC network id, not merely the presence of __NEXT_DATA__.
       *
       * Getro's 404 page is the same Next.js app and ships __NEXT_DATA__ too,
       * so "does the page have app state" answers yes for every nonsense
       * token. The id is what distinguishes a board from an error page.
       */
      const id = /"network":\s*\{[^}]*"id":\s*"?(\d+)"?/.exec(body)?.[1] ?? null;
      if (!id) {
        return { found: false, listings: 0, httpStatus: status, note: "200 without a collection id" };
      }
      // The page does not state a job count; the connector fetches the board
      // itself. Reported as an unverified find, so it enrols at the discovery
      // cadence rather than as a demonstrated source.
      return { found: true, listings: 0, httpStatus: status };
    },
  },
  {
    connectorId: null,
    name: "Personio",
    probeUrl: (t) => `https://${encodeURIComponent(t)}.jobs.personio.de/xml`,
    boardUrl: (t) => `https://${t}.jobs.personio.de`,
    knownGoodToken: "personio",
    // Measured: 400ms is far too fast for this one. Six controls at 3s apart
    // is 18 seconds to check a platform, which is a fine price for an answer.
    minGapMs: 3000,
    /**
     * Not proven, and deliberately left that way.
     *
     * Measured 19 September 2026: a known-good token answers 200 with a real
     * job feed, but the bogus probe comes back 429 - even after a five second
     * backoff. Personio throttles harder than the check can push through, so
     * the bogus half has never actually been answered.
     *
     * A separate hand-run against a different non-tenant DID return 404,
     * which suggests it discriminates correctly. That is a suggestion, not a
     * demonstration, and the cost of being wrong here is inventing sources for
     * thousands of firms. It stays false until the check passes on its own.
     */
    provenDiscriminating: false,
    interpret(status, body) {
      const verdict = statusVerdict(status);
      if (verdict) return verdict;
      // One XML document rather than JSON - count the position elements.
      const positions = (body.match(/<position>/gi) ?? []).length;
      if (!/<workzag-jobs|<position>/i.test(body)) {
        return { found: false, listings: 0, httpStatus: status, note: "200 without a job feed" };
      }
      return { found: true, listings: positions, httpStatus: status };
    },
  },
  {
    connectorId: "breezy",
    name: "Breezy",
    probeUrl: (t) => `https://${encodeURIComponent(t)}.breezy.hr/json`,
    boardUrl: (t) => `https://${t}.breezy.hr`,
    knownGoodToken: "breezy",
    provenDiscriminating: true,
    interpret(status, body) {
      const verdict = statusVerdict(status);
      if (verdict) return verdict;
      const jobs = countArray(parseJson(body));
      if (jobs === null) {
        return { found: false, listings: 0, httpStatus: status, note: "200 without an array" };
      }
      return { found: true, listings: jobs, httpStatus: status };
    },
  },
];

/**
 * Plausible board tokens for a firm, best first, capped.
 *
 * The cap is the budget. Requests are tokens x platforms x firms, so an
 * unbounded list of clever variants turns a sweep of 17,772 firms into
 * millions of requests. Three tokens is enough to catch the shapes that
 * actually occur - the bare domain label, the domain label with its hyphens
 * removed, and the firm's name compacted - and anything beyond that is
 * guessing at a rate that costs more than it finds.
 */
export function candidateTokens(website: string | null, firmName: string): string[] {
  const tokens: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    // Two characters cannot identify a company and would collide constantly.
    if (clean.length < 3 || clean.length > 40) return;
    if (!tokens.includes(clean)) tokens.push(clean);
  };

  if (website) {
    try {
      const host = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
      // The domain label: "baincapital" from "baincapital.com". Multi-part
      // public suffixes (.co.uk) make the second-to-last label the wrong
      // answer, so the FIRST label is used and the suffix simply dropped.
      const label = host.split(".")[0];
      push(label);
      if (label.includes("-")) push(label.replace(/-/g, ""));
    } catch {
      // A malformed website field contributes nothing rather than throwing.
    }
  }

  // The firm's own name, compacted. Catches boards named for the firm rather
  // than for the domain - "warburgpincusllc" is a real Greenhouse token in
  // this directory and is not derivable from warburgpincus.com.
  push(
    firmName
      .toLowerCase()
      .replace(/\b(llc|l\.l\.c\.|lp|l\.p\.|inc|inc\.|ltd|plc|llp|corp|corporation|company|co)\b/g, "")
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]/g, ""),
  );

  return tokens.slice(0, 3);
}

/** Platforms the sweep is allowed to use - those whose discrimination has
 *  actually been demonstrated. Empty until the live check is run and its
 *  results recorded, which is deliberate: the sweep should do nothing rather
 *  than something unproven. */
export function probablePlatforms(): ProbePlatform[] {
  return PROBE_PLATFORMS.filter((p) => p.provenDiscriminating);
}

/** Every (platform, token) pair a firm would be asked about, in order.
 *  Exposed so a caller can count the request budget before spending it. */
export function probePlan(
  website: string | null,
  firmName: string,
  platforms: ProbePlatform[] = probablePlatforms(),
): { platform: ProbePlatform; token: string }[] {
  const tokens = candidateTokens(website, firmName);
  const plan: { platform: ProbePlatform; token: string }[] = [];
  // Token-major order: a firm is far more likely to use its own domain label
  // on SOME platform than an odd variant on its most likely one, so the first
  // pass across all platforms uses the best token.
  for (const token of tokens) {
    for (const platform of platforms) {
      plan.push({ platform, token });
    }
  }
  return plan;
}
