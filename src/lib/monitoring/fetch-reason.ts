import "server-only";

import { isDeadlineExpired } from "./deadline";

/**
 * WHY a read produced no answer, in one word the database can group by.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * On 11 October 2026, 12,303 of 28,597 check runs - 43% of every read the
 * crawler has ever made, and 44.7% of its total wall clock - carried the
 * single message `inconclusive: HTTP 0 - not an answer about this firm`.
 * One string, for a dozen unrelated causes, because the message was built
 * from the status number and the actual Error was discarded by a bare
 * `catch {}`.
 *
 * The cost of that was not abstract. Three separate diagnoses of the HTTP-0
 * population were attempted from the outside - "the static HTML is being
 * discarded", "Chromium rescues what Node times out on", "the local resolver
 * is failing" - and all three were wrong or unrepresentative, because the
 * only evidence available was a hostname and a zero. A fourteen-host sample
 * then found six returning HTTP 200 with 44-233KB of body, which no theory
 * had predicted.
 *
 * So: stop guessing. Every catch that swallows an error names it instead, the
 * name reaches `monitoring_check_runs.error_message`, and the bucket reports
 * on itself from then on.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No `err.message` is ever interpolated into the stored string - only a value
 * from the closed vocabulary below. Messages from this codebase carry
 * hostnames and resolved IP addresses (see safe-fetch.ts's
 * BlockedAddressError), and an error message from a third-party page is
 * untrusted text. A fixed vocabulary is also the only form a `GROUP BY` can
 * count.
 *
 * `unclassified` is kept distinct from every real cause on purpose. If the
 * catch-all grows, that is a fact worth seeing rather than one to hide inside
 * a plausible-looking neighbour.
 */
export const FETCH_FAILURE_REASONS = [
  /** robots.txt disallows the path. Not a failure - a refusal we chose. */
  "robots_disallowed",
  /** The URL itself is unusable: unparseable, wrong scheme, non-web port. */
  "invalid_url",
  /** DNS gave us nothing. */
  "dns_unresolved",
  /** Resolved, but to a private/reserved address. Refused by design. */
  "ssrf_blocked",
  /** More hops than MAX_REDIRECTS. */
  "redirect_limit",
  /** The certificate did not verify. */
  "tls_error",
  /** Nothing is listening, or the network cannot reach it. */
  "connect_refused",
  /** The connection was established and then dropped. */
  "connect_reset",
  /** The request was still running when its own timeout fired. */
  "static_timeout",
  /** The per-source budget cancelled the work. Ours, not the board's. */
  "deadline_exceeded",
  /** Chromium would not start. A fact about this machine. */
  "browser_launch_failed",
  /** The page never reached a settled state inside the navigation timeout. */
  "nav_timeout",
  /** The tab went away mid-read - usually the deadline closing it. */
  "page_closed",
  /** The in-page script threw. */
  "evaluate_failed",
  /** Genuinely unrecognised. Should stay small; if it grows, read it. */
  "unclassified",
] as const;

export type FetchFailureReason = (typeof FETCH_FAILURE_REASONS)[number];

const BLOCKED_ADDRESS = /^Refused to fetch: /;

/**
 * Name an error, without trusting anything inside it.
 *
 * Pure, total, and never throws: it runs inside `catch` blocks on the crawl's
 * hot path, and a classifier that can fail would turn a diagnosable failure
 * into an undiagnosable one.
 *
 * Order matters. The deadline is checked first because its abort surfaces as
 * whatever the aborted operation threw, so a cancelled fetch looks exactly
 * like a timed-out one from the outside.
 */
export function classifyFetchError(err: unknown): FetchFailureReason {
  try {
    if (isDeadlineExpired(err)) return "deadline_exceeded";

    const error = err as Error & { cause?: { code?: string }; code?: string };
    const name = typeof error?.name === "string" ? error.name : "";
    const message = typeof error?.message === "string" ? error.message : "";
    const code = error?.cause?.code ?? error?.code ?? "";

    // safe-fetch.ts's own refusals. Discriminated on the shapes it throws -
    // see the BlockedAddressError call sites there.
    if (name === "BlockedAddressError" || BLOCKED_ADDRESS.test(message)) {
      if (/did not resolve|resolved to nothing|has no IPv/.test(message)) return "dns_unresolved";
      if (/reserved address/.test(message)) return "ssrf_blocked";
      if (/not a valid URL|is not http\(s\)|not a web port/.test(message)) return "invalid_url";
      if (/redirects/.test(message)) return "redirect_limit";
      return "ssrf_blocked"; // a refusal we made, cause unrecognised
    }

    if (/Failed to launch the browser process/.test(message)) return "browser_launch_failed";
    if (/Target closed|Session closed|Protocol error/.test(message)) return "page_closed";
    if (/Evaluation failed/.test(message)) return "evaluate_failed";
    // Puppeteer's navigation timeout. Checked before the generic timeout
    // branch because both present as a TimeoutError.
    if (name === "TimeoutError" && /[Nn]avigation|waiting for/.test(message)) return "nav_timeout";

    if (/CERT|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|TLSV1|UNABLE_TO_VERIFY/i.test(code)) return "tls_error";
    if (/ERR_TLS|certificate|SSL routines/i.test(message)) return "tls_error";
    if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return "connect_refused";
    }
    if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
      return "connect_reset";
    }
    if (name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return "static_timeout";
    }
    if (/timeout|timed out/i.test(message)) return "static_timeout";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_unresolved";

    return "unclassified";
  } catch {
    // A classifier that throws inside a catch block would replace a named
    // failure with an unnamed one, which is the whole problem it exists for.
    return "unclassified";
  }
}

/**
 * Is a browser render worth attempting after the plain GET failed?
 *
 * The question matters because the two costs compound: a host that hangs pays
 * the static timeout AND then a Chromium launch and a navigation timeout.
 * Measured 11 October 2026, with reasons recorded: `static_timeout` failures
 * averaged 41.9 seconds and reached 53.5, against a 4.4-second median for
 * every other outcome.
 *
 * ONLY FOUR REASONS REFUSE THE RENDER, and each was checked against a real
 * browser rather than argued from first principles:
 *
 *  - `dns_unresolved`  - puppeteer's bundled Chromium follows the OS resolver,
 *                        so a name that does not resolve for Node does not
 *                        resolve for it either (`ENOTFOUND` ->
 *                        `ERR_NAME_NOT_RESOLVED`, verified).
 *  - `connect_refused` - verified on eight such hosts: `ECONNREFUSED` ->
 *                        `ERR_CONNECTION_REFUSED`, `EHOSTUNREACH` ->
 *                        `ERR_ADDRESS_UNREACHABLE`. All were parked domains
 *                        with A records and nothing listening.
 *  - `invalid_url`     - the address is unusable before any client sees it.
 *  - `redirect_limit`  - a loop is a loop in any client.
 *
 * EVERYTHING ELSE STILL RENDERS, and two of those are deliberate:
 *
 *  - `tls_error` is NOT refused, though it looks like the obvious candidate.
 *    Chromium performs AIA chasing to complete an incomplete certificate
 *    chain and Node's undici does not, so a server missing its intermediate
 *    fails the static fetch and loads perfectly in the browser - demonstrated
 *    against `incomplete-chain.badssl.com`, where Node reported
 *    UNABLE_TO_VERIFY_LEAF_SIGNATURE and Chromium returned HTTP 200.
 *  - `static_timeout` and `deadline_exceeded` are NOT refused either. A plain
 *    GET stalling is the canonical reason to try a real browser: some WAFs
 *    stall a bare fetch and serve a browser normally. They are the expensive
 *    case, and the fix for them is the shorter static timeout, not giving up
 *    on the page.
 *
 * An unrecognised or absent reason renders, which is the safe default: "we
 * could not name the failure" is not evidence that the page is unreachable.
 */
const NEVER_RENDER: ReadonlySet<FetchFailureReason> = new Set([
  "dns_unresolved",
  "connect_refused",
  "invalid_url",
  "redirect_limit",
]);

export function shouldEscalateToRender(reason: FetchFailureReason | null | undefined): boolean {
  if (!reason) return true;
  return !NEVER_RENDER.has(reason);
}
