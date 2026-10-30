import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { logoDomain } from "@/lib/firm-logo-domain";
import { clientIpFrom } from "@/lib/login-throttle";
import { rateLimit } from "@/lib/rate-limit";
import { emailDomain } from "@/lib/school-verification";

/**
 * Serves a school's crest from our own origin.
 *
 * Needed because the avatar tints its disc with the crest's own border colour,
 * and reading a pixel out of an image means drawing it to a canvas - which
 * taints, and then refuses to be read, for anything cross-origin. The favicon
 * service sends no CORS headers, so the browser cannot sample it directly.
 * Proxying makes the bytes same-origin and the canvas readable.
 *
 * Two things it is not: it is not an open proxy, because the outbound URL is
 * built here and only its query string comes from the caller - there is no
 * input that can redirect the fetch at an internal host. And it is not a new
 * dependency on Google from the browser: it removes one, since every student's
 * browser was previously requesting their own school's domain from Google
 * directly on every page that renders a feed.
 *
 * It takes no session, because a crest is drawn on the sign-up and firm pages
 * before anyone is signed in. What bounds it instead, in the shape
 * lib/news/image-proxy uses:
 *
 *   - the answer for a (domain, size) is KEPT, so the crests a page needs are
 *     resolved once however many times they are asked for - and "no crest" is
 *     kept too, which is what stops an unknown domain being looked up
 *     upstream again on every request;
 *   - requests arriving while one is resolving SHARE it rather than each
 *     starting their own;
 *   - only a request that has to go and find out is COUNTED, against the
 *     caller's address by the shared limiter. Ordinary page loads never reach
 *     the meter, so the limit can be generous and still bound a loop.
 *
 * The key is the domain this route NORMALISED plus a size from a fixed set -
 * never the raw query string, which would make "a.com", "x@a.com" and
 * "A.com." three keys and three upstream fetches for one school.
 */
const SOURCE = "https://www.google.com/s2/favicons";
// Wikimedia asks every client to identify itself; school sites are fine with it.
const UA = "OfferlyCrest/1.0 (school crests for student profiles)";

/** An icon. Anything larger is not one, and is not read into memory. */
const MAX_BYTES = 2_000_000;

/** Whether the upstream already says its body is too big to be an icon. */
function tooBig(res: Response): boolean {
  const len = Number(res.headers.get("content-length") ?? 0);
  return Number.isFinite(len) && len > MAX_BYTES;
}

/**
 * The school's own sharp crest, when scripts/find-school-crests.ts found one.
 * The URL comes from our database, never from the request, so this is not a
 * way to make the server fetch an address of the caller's choosing.
 */
async function storedCrest(domain: string): Promise<Response | null> {
  const db = await getDb();
  const [row] = await db
    .select({ crestUrl: schools.crestUrl })
    .from(schools)
    .where(eq(schools.emailDomain, domain))
    .limit(1);
  if (!row?.crestUrl?.startsWith("https://")) return null;
  try {
    const res = await fetch(row.crestUrl, {
      headers: { "user-agent": UA },
      next: { revalidate: 60 * 60 * 24 * 30 },
      signal: AbortSignal.timeout(10_000),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/") || tooBig(res)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    return new Response(bytes, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=2592000, immutable",
        // An SVG is a document that can carry script. Served from our origin,
        // it must not be able to run any if opened directly.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return null;
  }
}
/**
 * A firm's own sharp logo, when scripts/find-firm-logos.ts found one.
 *
 * Same rule as the school crest: the URL comes from a file in this repository,
 * never from the request. "none" is an answer too - the firm's domain is a
 * social profile, redirects to another company, or has nothing sharper than a
 * blur - and it stops the favicon service being asked, because what it would
 * return is exactly the wrong or blurry logo the harvester rejected.
 *
 * Loaded on first use rather than imported, so the school-only requests that
 * make up most of this route's traffic never parse it.
 */
type FirmLogoEntry = { u: string; px: number; from: string } | { none: string };
let firmLogos: Promise<Record<string, FirmLogoEntry>> | null = null;

async function storedFirmLogo(domain: string): Promise<Response | "none" | null> {
  firmLogos ??= import("@/lib/firm-logos.json").then((m) => m.default as Record<string, FirmLogoEntry>);
  const entry = (await firmLogos)[logoDomain(domain)];
  if (!entry) return null;
  if ("none" in entry) return "none";
  // An icon the firm's page embeds inline, stored whole in the manifest.
  if (entry.u.startsWith("data:image/")) return dataImage(entry.u);
  // scripts/refresh-firm-logos.ts verified Brandfetch has this firm; the
  // client id lives in the environment, not the committed manifest. The
  // sentinel names which asset: the square icon as vector ("icon-svg", the
  // sharpest kind) or raster ("brandfetch"), the firm's bare mark ("symbol"),
  // or the wordmark ("logo-svg"/"logo") for firms with no square mark whose
  // wordmark still reads at tile size.
  if (entry.u.startsWith("brandfetch")) {
    const url = brandfetchUrl(domain, BRANDFETCH_SENTINELS[entry.u]);
    return url ? fetchImage(url) : null;
  }
  if (!entry.u.startsWith("https://")) return null;
  return fetchImage(entry.u);
}

/**
 * Brandfetch's logo CDN, tried after the manifest and before Google's
 * favicons. fallback/404 makes an unknown firm answer 404 rather than a
 * generated lettermark, so a miss falls through instead of masquerading as a
 * logo. Skipped entirely until BRANDFETCH_CLIENT_ID is set.
 */
/** Manifest sentinel -> the Brandfetch asset it stands for. */
const BRANDFETCH_SENTINELS: Record<string, string> = {
  brandfetch: "icon.png",
  "brandfetch:icon-svg": "icon.svg",
  "brandfetch:symbol": "symbol.svg",
  "brandfetch:logo": "logo.png",
  "brandfetch:logo-svg": "logo.svg",
};

function brandfetchUrl(domain: string, asset = "icon.png"): string | null {
  const id = process.env.BRANDFETCH_CLIENT_ID;
  if (!id || !asset) return null;
  const host = encodeURIComponent(logoDomain(domain) || domain);
  // SVG assets are vector-or-nothing - a firm without one answers 404 and
  // falls through rather than getting a rasterised stand-in. Rasters are
  // asked for at 512, plenty for the largest tile drawn.
  const size = asset.endsWith(".svg") ? "" : "w/512/h/512/";
  return `https://cdn.brandfetch.io/${host}/${size}fallback/404/${asset}?c=${encodeURIComponent(id)}`;
}

function dataImage(uri: string): Response | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(;[a-z0-9=-]+)*?(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!m) return null;
  const bytes = m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": m[1].toLowerCase(),
      "cache-control": "public, max-age=2592000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}

async function fetchImage(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": url.includes("wikimedia.org") ? UA : BROWSER_UA },
      next: { revalidate: 60 * 60 * 24 * 30 },
      signal: AbortSignal.timeout(10_000),
    });
    const type = res.headers.get("content-type") ?? "";
    if (tooBig(res)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    // Some firm sites serve their .ico as octet-stream; the bytes say what it is.
    const isIco = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
    if (!res.ok || (!type.startsWith("image/") && !isIco)) return null;
    return new Response(bytes, {
      headers: {
        // By the bytes, not the label: EY serves its .ico as image/jpeg, and
        // with nosniff below a browser would trust the label and show nothing.
        "content-type": isIco ? "image/x-icon" : type,
        "cache-control": "public, max-age=2592000, immutable",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return null;
  }
}

// Several firm sites refuse anything that does not look like a browser.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const SIZES = new Set([32, 64, 128, 256]);

/** The longest a DNS name can be, so one request cannot carry a novel of a key. */
const MAX_DOMAIN_LENGTH = 253;

/**
 * Lookups one address may cause. Far above what any amount of ordinary use
 * needs: a page is a few dozen distinct crests, each found once per window
 * however often it is drawn, and a whole school's students behind one campus
 * NAT share this count. It bounds a loop asking for invented domains, which is
 * the only traffic that reaches it.
 */
export const CREST_LOOKUP_LIMIT = 150;
export const CREST_LOOKUP_WINDOW_MS = 10 * 60_000;

/**
 * Who a fresh lookup is charged to, or null when there is nobody to charge it
 * to and it therefore must not happen.
 *
 * The meter used to fall back to the literal subject "unknown", which made one
 * bucket out of every caller whose address did not resolve - so one of them
 * could spend the 150 and this route, which renders on the sign-up and firm
 * pages before anyone is signed in, would refuse crests to all the rest. A
 * shared bucket is not a per-caller limit; it is a lever on everyone in it.
 *
 * In production there is always a proxy in front of this app setting the
 * header (lib/login-throttle clientIpFrom), so a request whose address does
 * not resolve is not an ordinary caller: it gets the kept answer or "no
 * crest", and no upstream lookup is spent on it. `npm run dev` on a laptop,
 * on the other hand, has no proxy and resolves nothing for EVERY request, and
 * crests have to render while someone is working on the app - so outside
 * production one shared local bucket is exactly the right answer.
 */
export function lookupSubject(
  ip: string | null,
  production: boolean = process.env.NODE_ENV === "production",
): string | null {
  if (ip) return ip;
  return production ? null : "local-dev";
}

/** A crest found is good for half an hour in memory; "none" for ten minutes. */
const CACHE_TTL_MS = 30 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 600;
const CACHE_MAX_BYTES = 16_000_000;

type Entry = { status: number; bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string>; at: number; ttl: number };

// Insertion-ordered, so the oldest entry is the first one a Map iterates.
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry>>();

function cached(key: string, now: number): Entry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function keep(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  let held = 0;
  for (const e of cache.values()) held += e.bytes.length;
  for (const [k, e] of cache) {
    if (held <= CACHE_MAX_BYTES && cache.size <= CACHE_MAX_ENTRIES) break;
    held -= e.bytes.length;
    cache.delete(k);
  }
}

/** A kept answer, served again. A Response body reads once, so it is rebuilt. */
function replay(entry: Entry): Response {
  return new Response(entry.status === 200 ? entry.bytes : null, {
    status: entry.status,
    headers: entry.headers,
  });
}

async function entryFor(res: Response | null, now: number): Promise<Entry> {
  if (!res) {
    return {
      status: 404,
      bytes: new Uint8Array(0),
      headers: { "cache-control": "public, max-age=600" },
      at: now,
      ttl: MISS_TTL_MS,
    };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: res.status, bytes, headers, at: now, ttl: res.status === 200 ? CACHE_TTL_MS : MISS_TTL_MS };
}

/**
 * Where a crest comes from, in order of sharpness: the school's own crest, the
 * firm manifest, Brandfetch, then Google's favicons. null means there is none,
 * and that answer is kept like any other.
 */
async function findCrest(domain: string, sz: number): Promise<Response | null> {
  const stored = await storedCrest(domain);
  if (stored) return stored;

  const firm = await storedFirmLogo(domain);
  if (firm === "none") return null;
  if (firm) return firm;

  // No stored answer, or the stored URL has rotted since the harvest: ask
  // Brandfetch before settling for Google's often-16px favicon.
  const bfUrl = brandfetchUrl(domain);
  if (bfUrl) {
    const bf = await fetchImage(bfUrl);
    if (bf) return bf;
  }

  try {
    const upstream = await fetch(`${SOURCE}?domain=${encodeURIComponent(domain)}&sz=${sz}`, {
      // The upstream answer for a given domain changes about as often as a
      // university rebrands.
      next: { revalidate: 60 * 60 * 24 * 30 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok || tooBig(upstream)) return null;
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    return new Response(bytes, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/png",
        // Public, unlike the avatar route: a school crest is not personal data,
        // and every student at that school wants the same bytes.
        "cache-control": "public, max-age=2592000, immutable",
      },
    });
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("domain") ?? "").toLowerCase().trim();
  const size = Number(url.searchParams.get("sz") ?? 256);

  // Reuses the address parser's own domain rule rather than a second regex, so
  // "what counts as a domain" has one definition in this codebase - and its
  // ANSWER, not merely its verdict, because the normalised host is what every
  // lookup and the cache key below are keyed on.
  const domain = raw.length > 0 && raw.length <= MAX_DOMAIN_LENGTH ? emailDomain(`x@${raw}`) : null;
  if (!domain) {
    return new Response("Bad request", { status: 400 });
  }
  const sz = SIZES.has(size) ? size : 256;

  const key = `${domain}\u0000${sz}`;
  const hit = cached(key, Date.now());
  if (hit) return replay(hit);

  // Resolved from the headers of THIS request, by the one rule the login
  // throttle uses - and null unless it is really an address.
  const subject = lookupSubject(clientIpFrom(req.headers));

  // EVERY per-caller answer is decided here, outside the shared promise.
  //
  // It used to be decided inside it, and `inFlight` is a sharing channel just
  // like the cache: the first request for a (domain, size) registers its own
  // promise, and every other request arriving while it runs is handed that
  // promise's answer at the `inFlight.get(key)` above. So one address over its
  // budget produced a 429 that every other visitor asking for the same school
  // crest received, with no meter of their own ever consulted - crests blank
  // across the sign-up, firm and feed pages for as long as the hammering
  // lasted. The `ttl: 0` guard was written for the cache and does nothing for
  // this second channel.
  //
  // Making the per-subject lock a try-lock (lib/rate-limit) is what turned
  // this from "150 requests first" into "two at once", because a refusal is
  // now reachable while under budget - so the two changes have to land
  // together.
  if (!subject) {
    // Nobody to charge: answer "no crest" rather than lumping every such
    // caller into one bucket they can spend on each other (lookupSubject).
    // no-store keeps it out of their cache as well as ours.
    return replay({
      status: 404,
      bytes: new Uint8Array(0),
      headers: { "cache-control": "no-store" },
      at: Date.now(),
      ttl: 0,
    });
  }
  const gate = await rateLimit("crest:lookup", subject, CREST_LOOKUP_LIMIT, CREST_LOOKUP_WINDOW_MS);
  if (!gate.allowed) {
    return replay({
      status: 429,
      bytes: new Uint8Array(0),
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))),
        // private, no-store, as /api/news-image has for its own refusal: this
        // is one caller's budget, and a shared cache storing it under the URL
        // alone would suppress a crest for everyone who asked next.
        "cache-control": "private, no-store",
      },
      at: Date.now(),
      ttl: 0,
    });
  }

  // Someone is already finding this one out; wait on theirs. This check sits
  // AFTER the meter, not before it, and the two have to stay in that order.
  // Before the meter it was airtight - check and register with no await
  // between them, so a second request could not slip past both - and moving
  // the meter in front of the registration put an await there, which let a
  // burst for one domain start a lookup each. After the meter it is airtight
  // again: this continuation runs the get and the set with nothing awaited in
  // between, so any request that resumes later sees the registration.
  const shared = inFlight.get(key);
  if (shared) return replay(await shared);

  // Registered before the first await of the lookup, for the same reason. What
  // is shared is only the LOOKUP, which is the same answer for everybody - not
  // the metering, which is this caller's own.
  const work = (async (): Promise<Entry> => entryFor(await findCrest(domain, sz), Date.now()))();
  inFlight.set(key, work);
  try {
    const entry = await work;
    // A refusal - or an answer given because this caller could not be metered
    // at all - is that caller's answer, never the kept one for everybody. Both
    // carry ttl 0, which is what says "do not keep this".
    if (entry.ttl > 0 && entry.bytes.length <= MAX_BYTES) keep(key, entry);
    return replay(entry);
  } finally {
    inFlight.delete(key);
  }
}
