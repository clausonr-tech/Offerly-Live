import "server-only";
import { safeFetch } from "../safe-fetch";
import { createHash } from "crypto";
import { resolvedPublicHttpUrl } from "../../safe-url";
import type { ConnectorFetchResult, NormalizedListing, SourceConnector, SourceRef } from "./types";

/**
 * Eightfold AI (`*.eightfold.ai`), used here by Citigroup.
 *
 * Two search endpoints exist on these tenants and only one of them works
 * without credentials:
 *
 *   /api/apply/v2/jobs   -> 403 {"message": "Not authorized for PCSX"}
 *   /api/pcsx/search     -> 200, the same JSON the board itself renders from
 *
 * The error message on the first names the second, which is the only reason
 * the dead end is worth recording here: a future reader hitting that 403 should
 * not conclude the tenant needs an API key.
 *
 * Paged with start/num. Results carry `postedTs`, a real posting timestamp.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 20000;
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const PAGE_GAP_MS = 400;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type EightfoldRef = { origin: string; domain: string };

/**
 * Tenant origin plus the `domain` query parameter the API requires.
 *
 * The domain is the firm's own site, not the Eightfold host: `citi.eightfold.ai`
 * expects `domain=citi.com`. Passing the Eightfold hostname there returns
 * "Tenant not identified", which looks like an outage rather than a bad
 * parameter - so it is derived from the tenant label here instead of guessed.
 */
function parseEightfoldUrl(rawUrl: string): EightfoldRef | null {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.endsWith(".eightfold.ai")) return null;
    const tenant = url.hostname.split(".")[0];
    if (!tenant) return null;
    // An explicit ?domain= on the stored URL always wins - some tenants use a
    // domain that is not simply "<tenant>.com".
    const domain = url.searchParams.get("domain") ?? `${tenant}.com`;
    return { origin: url.origin, domain };
  } catch {
    return null;
  }
}

type EightfoldPosition = {
  id?: number | string;
  displayJobId?: string;
  name?: string;
  locations?: string[];
  department?: string;
  postedTs?: number;
  creationTs?: number;
  positionUrl?: string;
};

async function fetchPage(
  ref: EightfoldRef,
  start: number,
): Promise<EightfoldPosition[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(`${ref.origin}/api/pcsx/search`);
    url.searchParams.set("domain", ref.domain);
    url.searchParams.set("query", "");
    url.searchParams.set("location", "");
    url.searchParams.set("start", String(start));
    url.searchParams.set("num", String(PAGE_SIZE));

    const res = await safeFetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      data?: { positions?: EightfoldPosition[] };
      positions?: EightfoldPosition[];
    };
    return body.data?.positions ?? body.positions ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Eightfold timestamps are seconds on some tenants and milliseconds on
 *  others. Anything below this threshold is seconds. */
const MS_CUTOFF = 1e11;

function toIso(ts: number | undefined): string | null {
  if (!ts) return null;
  const ms = ts < MS_CUTOFF ? ts * 1000 : ts;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const eightfoldConnector: SourceConnector = {
  id: "eightfold",

  canHandle(source: SourceRef): boolean {
    return parseEightfoldUrl(source.careersUrl) !== null;
  },

  async fetch(source: SourceRef): Promise<ConnectorFetchResult> {
    const ref = parseEightfoldUrl(source.careersUrl);
    if (!ref) {
      return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
    }

    const listings: NormalizedListing[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));

      const positions = await fetchPage(ref, page * PAGE_SIZE);
      if (!positions) {
        if (page === 0) {
          return { listings: [], etag: null, contentHash: "", httpStatus: 0, notModified: false };
        }
        break;
      }
      if (positions.length === 0) break;

      let added = 0;
      for (const p of positions) {
        const id = String(p.id ?? p.displayJobId ?? "");
        if (!id || !p.name || seen.has(id)) continue;
        seen.add(id);
        added++;

        /**
         * `positionUrl` is a PATH on most tenants, not a URL.
         *
         * It was passed straight through, which is where 3,488 relative
         * `listing_url`s came from - every one a dead link once it leaves this
         * board, and all of them withheld from students by the absolute-URL
         * check in posting-quality.ts. Resolved against the tenant origin it
         * came from, which is what the stored URL always should have been: the
         * constructed fallback below has been absolute all along, so a tenant
         * that omits `positionUrl` was never affected and one that sends it
         * always was.
         *
         * Falls back when resolution yields nothing openable rather than
         * trusting a bad value, because this connector can always construct a
         * working address from the id.
         */
        const listingUrl =
          resolvedPublicHttpUrl(p.positionUrl, ref.origin) ??
          `${ref.origin}/careers/job/${id}?domain=${ref.domain}`;
        listings.push({
          externalJobId: p.displayJobId ?? id,
          title: p.name,
          division: p.department ?? null,
          location: p.locations?.[0] ?? null,
          // This endpoint returns no prose; position_details would, at one
          // request per role. Title plus department is what the classifier
          // reads, and Eightfold titles are unusually complete - they carry
          // the programme, location and cycle year.
          descriptionRaw: [p.name, p.department].filter(Boolean).join(" - "),
          employmentType: null,
          applicationUrl: listingUrl,
          listingUrl,
          publishedAt: toIso(p.postedTs ?? p.creationTs),
          deadlineAt: null,
        });
      }
      // A tenant that ignores `start` would otherwise return page 0 forever.
      if (added === 0) break;
    }

    const contentHash = listings.length
      ? sha256(listings.map((l) => `${l.externalJobId}|${l.title}`).sort().join("\n"))
      : sha256("empty");

    return { listings, etag: null, contentHash, httpStatus: 200, notModified: false };
  },
};
