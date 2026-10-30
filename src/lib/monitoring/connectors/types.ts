import "server-only";

import type { FetchFailureReason } from "../fetch-reason";

// What every connector normalizes a raw listing into, regardless of source.
// Deliberately narrow: this is everything downstream code (dedup, hashing,
// classification) actually needs, not everything a job feed could offer.
export type NormalizedListing = {
  externalJobId: string | null;
  title: string;
  division: string | null;
  location: string | null;
  descriptionRaw: string;
  employmentType: string | null;
  applicationUrl: string | null;
  listingUrl: string;
  // ISO date string, and ONLY set when the source itself states one - never
  // inferred or estimated. See detectedListings.publishedAt in the schema
  // for why this can't be confused with "when we first saw it."
  publishedAt: string | null;

  /**
   * The application deadline, ISO, when the SOURCE states one outright.
   *
   * Structured sources hand this over as data - TalentLink's feed carries
   * "Application Deadline:15 Nov 2026 11:55 PM EST" in every entry - and
   * without somewhere to put it the connector parses a real date and then
   * drops it on the floor. Never inferred: a connector that cannot read a
   * deadline leaves this null rather than estimating one.
   */
  deadlineAt?: string | null;
};

export type ConnectorFetchResult = {
  listings: NormalizedListing[];
  etag: string | null;
  /**
   * Identity of what was EXTRACTED, not of the page it came from.
   *
   * Hashing the raw HTML looks equivalent and is not. Career pages carry
   * rotating banners, CSRF tokens, timestamps and build ids, so a page hash
   * reports "changed" on almost every check and the diff below it runs for
   * nothing. Worse in the other direction: a page can be byte-identical while
   * a listing's own detail changes behind a stable URL, and a page hash calls
   * that "unchanged" and never looks.
   *
   * Derived from the normalized listings, so it moves when and only when the
   * thing being monitored moves.
   */
  contentHash: string;
  httpStatus: number;
  /** True when the source reported 304 Not Modified / an unchanged ETag - the
   *  caller should treat this as "no change" without inspecting `listings`. */
  notModified: boolean;

  /**
   * The page's readable text, for sources that have no parseable board.
   *
   * Set only by connectors that fetched a human-facing page rather than an
   * API - in practice the generic one. It exists so the caller can watch for
   * an OPENING ANNOUNCEMENT on firms that will never yield a listing: 64 of
   * 110 monitored firms point their careers link at a contact form or a
   * homepage, and the only thing that ever changes is a sentence. See
   * lib/monitoring/announcements.ts.
   *
   * Never used when `listings` is non-empty. A board that parses is a better
   * source than prose about one.
   */
  pageText?: string | null;

  /**
   * True when the connector knows it did not return the whole board.
   *
   * The caller CLOSES any stored listing absent from a fetch, and without this
   * flag a truncated read is indistinguishable from a board that shrank. The
   * two are opposite facts: one means "there was more and we stopped", the
   * other means "those postings ended". Recording a live internship as closed
   * is worse than not seeing it at all, because it looks like an answer.
   *
   * Set by the connectors that have a ceiling they can hit - the generic
   * candidate cap and iCIMS's page cap. A connector that reads a whole board
   * in one response leaves it false, which is the truthful default.
   */
  truncated?: boolean;
  /**
   * What the vendor's own Retry-After header asked for, in milliseconds.
   *
   * Only meaningful alongside an inconclusive status. Present so the
   * scheduler can obey a vendor that tells us when to come back instead of
   * guessing - apply.workable.com answers 429 with nine hours, and retrying
   * hourly inside that window is how a temporary block becomes a lasting one.
   */
  retryAfterMs?: number;

  /**
   * What this read SPENT, per stage, in milliseconds.
   *
   * Six separate investigations had to measure by hand what this answers, and
   * one constant was set from 24 hand-timed sources out of roughly 5,000:
   * `STATIC_TIMEOUT_MS`, cut from 20s to 8s on that evidence. A per-source
   * timeout cannot be set at all without knowing each source's own
   * distribution, so this is the thing that has to exist first.
   *
   * Reported only by connectors that have distinct stages to report - in
   * practice the generic one, which is 97.3% of sources. Absent means "not
   * reported", which is a fact; it must never be defaulted to zero, because a
   * zero would read as "instant" in exactly the percentile maths this exists
   * to feed.
   */
  timings?: { staticMs?: number; renderMs?: number };

  /**
   * Why an EMPTY result is empty, when the connector can tell.
   *
   * "No listings" and "listings behind a search form nobody filled in" look
   * identical downstream - both are a healthy source producing nothing - and
   * that is how a board can go unread for months without ever registering as
   * a gap. Only set when the page gives real evidence; null means "genuinely
   * nothing found", which stays the honest default.
   */
  blockedBy?: "search_form" | null;

  /**
   * WHY an inconclusive read was inconclusive.
   *
   * Only meaningful alongside a status `isInconclusive` accepts - in practice
   * httpStatus 0, which is how every connector reports a read it could not
   * complete. For three weeks that was 43% of all check runs under one
   * message, because the Error was discarded by a bare `catch {}` and the
   * message was built from the number.
   *
   * Optional by design: 20 of the 21 connectors never set it and compile
   * unchanged. A connector that cannot tell the causes apart leaves it unset,
   * which is honest - `unclassified` means "we looked and could not name it",
   * absent means "we never looked".
   *
   * See lib/monitoring/fetch-reason.ts for the closed vocabulary.
   */
  inconclusiveReason?: FetchFailureReason | null;

  /**
   * How many bytes of body this read actually brought back.
   *
   * `monitoring_check_runs.response_bytes` has existed since the table did and
   * has never meant anything: it was written as `result.contentHash.length`,
   * which is the length of a sha256 hex string, so every one of the 6,236
   * non-null rows reads exactly 64. A column that always holds the same number
   * reads as data and answers nothing, and it cost an investigation on
   * 11 October 2026 that had to be abandoned for want of it.
   *
   * Optional, and absent means "this connector does not report it" rather than
   * zero - the distinction the old column could not make.
   */
  responseBytes?: number | null;
};

export type SourceRef = {
  careersUrl: string;
  sourceType: string;
  lastEtag: string | null;
};

export interface SourceConnector {
  /** Matches `firm_monitoring_sources.connectorId`. */
  id: string;
  canHandle(source: SourceRef): boolean;
  fetch(source: SourceRef): Promise<ConnectorFetchResult>;

  /**
   * Optionally fills in real detail for listings the caller has already
   * decided are NEW, by fetching each listing's own page.
   *
   * Separate from fetch() because only the caller knows what is new - a
   * connector sees a page, not the history. That split is the point: an index
   * page gives a title and a link, the description worth classifying lives one
   * click away, and paying for that click on every listing on every check
   * would multiply request volume by listings-per-page to re-learn what we
   * already knew.
   *
   * Best-effort by contract. A connector that cannot enrich simply omits this;
   * a listing whose detail page fails keeps whatever the index page gave it.
   */
  enrich?(listings: NormalizedListing[]): Promise<NormalizedListing[]>;

  /**
   * How many listings `enrich` will actually fetch in one call, if it caps.
   *
   * The caller charges an enrichment attempt per listing it hands over (see
   * `enrichmentAttempts`), and a listing that is charged five attempts without
   * one request ever being made can never be published - permanently. The
   * generic connector fetches at most 25 details per call and returns the rest
   * unchanged, so handing it a hundred thin listings charged seventy-five of
   * them for nothing.
   *
   * Absent means "no cap": every listing handed over is attempted.
   */
  maxEnrichPerCheck?: number;
}
