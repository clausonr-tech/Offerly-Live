import { lookup } from "node:dns/promises";
import net from "node:net";
import { hopFetch, isBlockedV4, isBlockedV6 } from "../monitoring/safe-fetch";

// Every request the news pipeline makes goes to an address a third party chose:
// a feed's links, a page's og:image, a sitemap listed in robots.txt, and each
// redirect along the way. The pipeline runs on the owner's laptop, next to a
// dev server wired to the live database and a home network. So (security
// review, 30 September 2026):
//
//   - only http and https;
//   - only the web ports (80, 443, 8080, 8443);
//   - never a loopback, private, link-local or otherwise internal address,
//     checked on the resolved IPs - inside the connection's own DNS lookup, so
//     the address checked is the address connected to - and again on every
//     redirect hop, which is followed by hand rather than by fetch;
//   - never more than a set number of bytes read, however the server sends
//     them - a timeout limits how long, not how much.

const MAX_REDIRECTS = 5;

/**
 * Whether an IP address is on the public internet. The crawler's check
 * (lib/monitoring/safe-fetch.ts), not a copy of it: this file used to have its
 * own, which read IPv6 by its text, so `http://[::ffff:127.0.0.1]:3001/` -
 * which a URL normalises to `[::ffff:7f00:1]` - passed as public and reached
 * the dev server on this laptop (security review, 30 September 2026). The
 * crawler's version expands every IPv6 spelling and refuses what it cannot read.
 */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !isBlockedV4(ip);
  if (net.isIPv6(ip)) return !isBlockedV6(ip);
  return false;
}

/** A news page, photo or sitemap is on a web port; anything else is a probe of some other service. */
const WEB_PORTS = new Set([80, 443, 8080, 8443]);

export class UnsafeUrlError extends Error {}

/** Throws unless the URL is http(s) to a host whose every address is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`scheme ${url.protocol}`);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!WEB_PORTS.has(port)) throw new UnsafeUrlError(`port ${port}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(`host ${host}`);
  }
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new UnsafeUrlError(`host ${host} is not public`);
  return url;
}

/**
 * fetch, but only to public http(s) addresses, with every redirect checked
 * the same way. Returns the response and the address it finally came from.
 */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    // Pinned: the connection resolves the host through the same check, so a
    // name that answers "public" to assertPublicUrl and 127.0.0.1 a moment
    // later is never connected to (DNS rebinding).
    // A ceiling even when the caller forgets one.
    //
    // Every caller here does pass a cap to readCapped, so nothing overruns
    // today - but the cap lived entirely in the callers, so the next one to
    // read a body directly got an unbounded read of a third-party response on
    // the operator's own machine. hopFetch's own maxBytes bounds what a
    // COMPRESSED body inflates to, which readCapped cannot see at all, so the
    // two are not alternatives.
    const res = await hopFetch(current, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      maxBytes: MAX_NEWS_BODY_BYTES,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new UnsafeUrlError("too many redirects");
}

/**
 * A response body, read up to `maxBytes`. "truncate" keeps the first
 * `maxBytes` (a feed cut short still parses); "reject" returns null (an image
 * cut short is not an image).
 */
/**
 * The most any single news fetch may inflate to.
 *
 * Generous next to what the callers ask readCapped for (3MB for a feed, 8MB
 * for a sitemap): this is the backstop that bounds a compressed body, not the
 * per-caller limit.
 */
const MAX_NEWS_BODY_BYTES = 24_000_000;

export async function readCapped(res: Response, maxBytes: number, mode: "truncate" | "reject"): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      if (mode === "reject") return null;
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))));
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
