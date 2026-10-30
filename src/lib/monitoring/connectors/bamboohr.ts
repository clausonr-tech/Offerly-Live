import "server-only";
import { createHash } from "crypto";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";
import { safeFetch } from "../safe-fetch";

/**
 * BambooHR (`<account>.bamboohr.com`).
 *
 * Two public, unauthenticated JSON endpoints:
 *
 *   GET https://<account>.bamboohr.com/careers/list          - the whole board
 *   GET https://<account>.bamboohr.com/careers/<id>/detail   - one posting
 *
 * Verified 19 September 2026 against both accounts board discovery found.
 *
 * WHAT ROBOTS.TXT ACTUALLY SAYS
 * -----------------------------
 * `<account>.bamboohr.com/robots.txt` disallows exactly two paths:
 * `/jobs/embed.php` and `/jobs/embed2.php`. Everything else, `/careers/`
 * included, is permitted. Worth stating plainly because the UltiPro decision
 * next door went the other way on the same question, and the difference is
 * not obvious from the outside - it is which endpoint the vendor chose to
 * close.
 *
 * WHY THE DISCOVERED URLS ARE NOT USED AS GIVEN
 * ---------------------------------------------
 * Discovery recorded `fcp.bamboohr.com/js/jobs2.php` - an embed script - and
 * `centurion.bamboohr.com/careers/1751`, a single posting. Neither is a board.
 * Registering either verbatim would have pointed the generic connector at a
 * script or at one job forever, so this connector takes only the ACCOUNT from
 * whatever URL it is handed and builds the board URL itself.
 */

const USER_AGENT = "OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 15000;

/**
 * Detail fetches per pass.
 *
 * The list endpoint carries no description at all, so every new listing wants
 * one. These are small-team boards - the two known accounts run 5 and 7
 * openings - and monitor-run puts internship-shaped titles at the front of the
 * queue, so this cap is generous rather than binding.
 */
const MAX_DETAIL = 25;
const DETAIL_GAP_MS = 500;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&#(\d{2,5});/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, "&");
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The account and the host it lives on.
 *
 * Both TLDs BambooHR serves are accepted, and the HOST is carried rather than
 * rebuilt from the account. Board discovery matches
 * `.bamboohr.(com|co.uk)`, so hardcoding `.com` here would have this
 * connector decline a URL the discovery table promises it can read - the two
 * would disagree silently, and the firm would fall back to the generic
 * connector and a Chromium launch per check.
 *
 * Only `.com` has been verified live (19 September 2026, against `fcp` and
 * `centurion`). A `.co.uk` account is read on the same paths, and if it turns
 * out not to serve them the connector reports the HTTP status honestly, which
 * is the designed failure mode rather than a guess.
 */
export type BambooBoardRef = { account: string; host: string };

export function parseBambooBoard(rawUrl: string): BambooBoardRef | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    // Exact suffix match on a dot boundary - never a bare endsWith, which
    // would accept `evilbamboohr.com` as this vendor.
    const suffix = [".bamboohr.com", ".bamboohr.co.uk"].find((s) => host.endsWith(s));
    if (!suffix) return null;

    const account = host.slice(0, host.length - suffix.length);
    // `www` is the marketing site, and a dotted prefix is a nested subdomain
    // that would build a different host from the one assessed.
    if (!account || account === "www" || account.includes(".")) return null;
    return { account, host };
  } catch {
    return null;
  }
}

/** The account alone, for callers that do not build URLs. */
export function parseBambooAccount(rawUrl: string): string | null {
  return parseBambooBoard(rawUrl)?.account ?? null;
}

export type BambooListRow = {
  id?: string | number;
  jobOpeningName?: string;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  location?: { city?: string | null; state?: string | null } | null;
  isRemote?: boolean | null;
};

type BambooListResponse = { meta?: { totalCount?: number }; result?: BambooListRow[] };

type BambooDetailResponse = {
  result?: {
    jobOpening?: {
      jobOpeningName?: string;
      jobOpeningShareUrl?: string;
      description?: string;
      departmentLabel?: string | null;
      employmentStatusLabel?: string | null;
      location?: {
        city?: string | null;
        state?: string | null;
        addressCountry?: string | null;
      } | null;
    };
  };
};

function readLocation(
  location: { city?: string | null; state?: string | null } | null | undefined,
  isRemote?: boolean | null,
): string | null {
  const parts = [location?.city, location?.state].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  if (parts.length) return parts.join(", ");
  // Only when the board says so - "Remote" is a stated fact here, not our
  // reading of an empty city field.
  return isRemote ? "Remote" : null;
}

/**
 * The board rows as listings.
 *
 * Exported for the fixture tests: this is where every field decision lives,
 * and it is the half of the connector that does not need a network.
 */
export function bambooRowsToListings(
  rows: BambooListRow[],
  /** The full board host, e.g. `fcp.bamboohr.com` - not the account alone, so
   *  a `.co.uk` board keeps its own TLD in the links we store and show. */
  host: string,
): NormalizedListing[] {
  const listings: NormalizedListing[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const title = row.jobOpeningName?.trim();
    if (!title || row.id === undefined || row.id === null) continue;

    const id = String(row.id);
    // A board that returns the same id twice must not produce two rows.
    if (seen.has(id)) continue;
    seen.add(id);

    const url = `https://${host}/careers/${encodeURIComponent(id)}`;
    const department = row.departmentLabel?.trim() || null;

    listings.push({
      externalJobId: id,
      title: decodeEntities(title).replace(/\s+/g, " ").trim(),
      division: department,
      location: readLocation(row.location, row.isRemote),
      /**
       * The list endpoint carries no description, so this starts as the title
       * and department - the same position Breezy and Getro are in - and
       * `enrich` replaces it with the real text. Deliberately not left empty:
       * a listing whose detail fetch fails still reaches a reviewer with
       * something that names the role.
       */
      descriptionRaw: department
        ? `${decodeEntities(title).replace(/\s+/g, " ").trim()} - ${department}`
        : decodeEntities(title).replace(/\s+/g, " ").trim(),
      employmentType: row.employmentStatusLabel?.trim() || null,
      applicationUrl: url,
      listingUrl: url,
      // The list endpoint states no posting date, and types.ts forbids
      // inventing one. The detail endpoint does not carry it either.
      publishedAt: null,
    });
  }

  return listings;
}

export const bambooHrConnector: SourceConnector = {
  id: "bamboohr",

  canHandle: (source: SourceRef) => parseBambooBoard(source.careersUrl) !== null,

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const board = parseBambooBoard(source.careersUrl);
    if (!board) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await safeFetch(
      `https://${board.host}/careers/list`,
      { headers, timeoutMs: TIMEOUT_MS },
    );

    if (response.status === 304) {
      return { listings: [], etag: source.lastEtag, contentHash: "", httpStatus: 304, notModified: true };
    }
    if (!response.ok) {
      return { listings: [], etag: null, contentHash: "", httpStatus: response.status, notModified: false };
    }

    const body = (await response.json()) as BambooListResponse | null;
    // The endpoint returns `{meta, result}`. Anything else means the account
    // moved or the shape changed, and an empty result is the honest way for
    // that to show up - as a source that stopped producing.
    const rows = Array.isArray(body?.result) ? body.result : [];

    const listings = bambooRowsToListings(rows, board.host);

    return {
      listings,
      etag: response.headers.get("etag"),
      // Hashed over what was EXTRACTED, per the contract in types.ts.
      contentHash: sha256(
        listings
          .map((l) => `${l.externalJobId}|${l.title}|${l.location ?? ""}|${l.listingUrl}`)
          .sort()
          .join("\n"),
      ),
      httpStatus: response.status,
      notModified: false,
    };
  },

  async enrich(listings: NormalizedListing[]): Promise<NormalizedListing[]> {
    const out = [...listings];
    let fetched = 0;

    for (let i = 0; i < out.length && fetched < MAX_DETAIL; i++) {
      const listing = out[i];
      const board = parseBambooBoard(listing.listingUrl);
      if (!board || !listing.externalJobId) continue;
      if (listing.descriptionRaw.trim().length >= 120) continue;

      // Sequential with a gap rather than parallel: this runs inside the slot
      // fetch-pool already granted for this source, so it must not turn one
      // polite request into a burst against the same host.
      if (fetched > 0) await new Promise((r) => setTimeout(r, DETAIL_GAP_MS));
      fetched += 1;

      try {
        const response = await safeFetch(
          `https://${board.host}/careers/${encodeURIComponent(listing.externalJobId)}/detail`,
          {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            timeoutMs: TIMEOUT_MS,
          },
        );
        if (!response.ok) continue;

        const body = (await response.json()) as BambooDetailResponse | null;
        const opening = body?.result?.jobOpening;
        if (!opening) continue;

        const description = stripHtml(opening.description ?? "");
        // A page that parsed to nothing is a page we did not understand.
        // Keeping the stub is honest; storing an empty description is not.
        if (!description) continue;

        out[i] = {
          ...listing,
          title: opening.jobOpeningName?.trim()
            ? decodeEntities(opening.jobOpeningName).replace(/\s+/g, " ").trim()
            : listing.title,
          division: opening.departmentLabel?.trim() || listing.division,
          location: readLocation(opening.location) ?? listing.location,
          descriptionRaw: description,
          employmentType: opening.employmentStatusLabel?.trim() || listing.employmentType,
        };
      } catch {
        // Best-effort by contract: a detail page that fails keeps its stub and
        // is re-queued next pass by monitor-run's still-thin check.
      }
    }

    return out;
  },
};
