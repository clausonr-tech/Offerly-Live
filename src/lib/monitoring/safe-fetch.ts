import "server-only";
import { withAmbientDeadline } from "./deadline";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import zlib from "node:zlib";

/**
 * Outbound fetch for URLs the monitor did not choose.
 *
 * THE PROBLEM
 * -----------
 * Most URLs this system fetches are ones an admin registered. The detail pages
 * in `SourceConnector.enrich` are not: those come from whatever the scraped
 * index page said, so a hostile or merely compromised careers page can hand the
 * crawler any address it likes and have it fetched from inside our network -
 * cloud instance metadata at 169.254.169.254, an internal admin route on
 * localhost, a service on a private subnet. The response is then stored as a
 * job description and shown to an admin, so this is not even a blind SSRF: it
 * exfiltrates.
 *
 * The existing "does this page mention the job title" check in generic.ts is
 * not a defence. Whoever controls the index page controls the title too, and
 * the JSON-LD path has no such check at all.
 *
 * WHAT THIS DOES
 * --------------
 * Resolves the hostname and refuses any address in a private, loopback,
 * link-local or otherwise reserved range, then follows redirects BY HAND,
 * re-checking every hop. Redirect handling is the part that is easy to get
 * wrong: a pre-flight check followed by `redirect: "follow"` is no protection
 * at all, because the attacker simply returns a 302 to the address they
 * actually wanted. `redirect: "manual"` plus a re-check per hop is the whole
 * point of this file.
 *
 * DNS REBINDING
 * -------------
 * Checking a name and then letting fetch() connect is two lookups, and a
 * hostile DNS server can answer "public" to the first and 127.0.0.1 to the
 * second. So requests go through pinnedFetch below, whose socket resolves the
 * name through guardedLookup: the check runs inside the very lookup the
 * connection uses, and an address it refuses is never connected to. The name
 * stays the name - TLS SNI and the Host header are unchanged - so CDNs work
 * as they do with fetch (security review, 30 September 2026).
 *
 * TIME AND BYTES, NOT JUST ADDRESSES
 * ----------------------------------
 * An address check decides WHETHER we talk to a host. It says nothing about
 * how long that host may hold us, or how much it may send - and both of those
 * were unbounded (security review, 6 October 2026).
 *
 * The timeout used to be cleared the moment the response HEADERS arrived,
 * because that is when the underlying request promise resolves. Everything
 * after that - the entire body - ran with no deadline and no armed signal. A
 * host that answers "200 OK" in 50ms and then drips one byte every two
 * seconds forever was never cut off: `res.text()` simply never settled, and
 * because the crawler reads bodies inside `fetch-pool.ts` (one of twelve
 * slots, held until the task settles), twelve such hosts stall the whole
 * run's remaining sources, which then burn their 180s budgets waiting for a
 * slot. So the body phase gets a deadline of its own, and the deadline aborts
 * the request rather than merely rejecting a promise - the socket has to go.
 *
 * The caller's own signal is honoured too. `workday`, `oracle-hcm`,
 * `eightfold` and `icims` all construct an AbortController and pass it;
 * `safeFetch` destructured `timeoutMs` out of the init and then handed the
 * transport only its own signal, so every one of those was silently dropped.
 *
 * Bytes are capped on the DECOMPRESSED stream, in two places. `pinnedFetch`
 * counts what comes out of the gzip/deflate/brotli decoder, because that is
 * where the asymmetry lives: a 100KB response can expand to gigabytes, and
 * zlib's own `maxOutputLength` option is only honoured for the one-shot
 * convenience methods, not for streams (measured on Node 24). `safeFetch`
 * then caps the body it hands back whatever the encoding was, cancelling the
 * reader and aborting the request the way `readCapped` does on the news side.
 * Going over the cap is an error, not a truncation: half a JSON payload or
 * half a careers page is not a smaller version of the same answer, and every
 * connector already treats a fetch error as "no data from this source".
 */

const MAX_REDIRECTS = 5;

/**
 * The ceiling on a single decompressed response body.
 *
 * Sized off the largest thing the crawl legitimately reads, which is a
 * sitemap, not a careers page: rendered boards run a few hundred KB and the
 * vendor JSON payloads less than that. 16MB leaves an order of magnitude of
 * headroom over anything observed while still bounding the worst case to
 * roughly 190MB across all twelve pool slots. Overridable per call -
 * `robots.ts` asks for far less, because robots.txt is a text file.
 */
export const MAX_BODY_BYTES = 16_000_000;

/** A body that went past its cap. The request is aborted when this is raised,
 *  so the host stops sending rather than being politely ignored. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Refused to read: response body exceeded ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** A hop that ran out of time, saying WHICH phase ran out. The distinction
 *  matters when reading crawl logs: "headers" is a host that never answered,
 *  "body" is a host that answered and then stalled or dripped. */
export class FetchTimeoutError extends Error {
  constructor(phase: "headers" | "body", ms: number) {
    super(`Timed out after ${ms}ms waiting for the response ${phase}`);
    this.name = "FetchTimeoutError";
  }
}

/** Reserved IPv4 ranges, as [network, prefix-length]. Anything matching is
 *  refused. Sourced from the IANA special-purpose registry rather than the
 *  usual "10/8, 172.16/12, 192.168/16" shorthand, because the interesting
 *  targets are the ones outside that shorthand: 169.254.169.254 (cloud
 *  metadata) and 100.64/10 (carrier NAT) are neither private nor loopback. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local - cloud metadata lives here
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // documentation
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // documentation
  ["203.0.113.0", 24],   // documentation
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, includes 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function isBlockedV4(ip: string): boolean {
  const addr = v4ToInt(ip);
  if (addr === null) return true; // unparseable is refused, not allowed
  for (const [net, bits] of BLOCKED_V4) {
    const base = v4ToInt(net);
    if (base === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (base & mask)) return true;
  }
  return false;
}

/**
 * An IPv6 address as its eight 16-bit groups, or null if it cannot be read.
 *
 * Written because matching on the TEXT of a v6 address does not work: the
 * same address has many spellings, and `new URL()` hands back a normalised
 * one that is rarely the spelling an attacker typed.
 */
function expandV6(addr: string): number[] | null {
  let text = addr;

  // A trailing dotted quad ("::ffff:169.254.169.254") is rewritten to hex so
  // there is only one shape to reason about below.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = v4ToInt(dotted[2]);
    if (v4 === null) return null;
    text = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;

  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) =>
    g === "" ? 0 : parseInt(g, 16),
  );
  if (groups.length !== 8) return null;
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function intToV4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

/**
 * IPv6 addresses the crawler may not reach.
 *
 * THE BYPASS THIS USED TO HAVE
 * ----------------------------
 * The previous version tested the TEXT of the address, and matched the
 * IPv4-mapped form with `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`. But `new URL()`
 * normalises IPv6 before this ever sees it:
 *
 *   http://[::ffff:169.254.169.254]/  ->  hostname [::ffff:a9fe:a9fe]
 *
 * The dotted quad is gone, so that regex never matched. Worse, the fallback
 * read the first group with `addr.split(":")[0]`, which for anything starting
 * `::` is the EMPTY STRING - and the guard for that was `if (!head) return
 * false`, meaning allowed. So every address beginning `::` was permitted
 * except the two literal strings checked above it, and
 * `http://[::ffff:169.254.169.254]/` reached the cloud metadata endpoint
 * through the generic connector's detail-page follow.
 *
 * That is the exact attack the comment said it was defending against. Found
 * by safe-fetch.test.ts.
 */
export function isBlockedV6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip any zone index

  const groups = expandV6(addr);
  // Unparseable is refused, not allowed - the same rule isBlockedV4 follows.
  if (!groups) return true;

  /**
   * An IPv4 address wearing a v6 hat, in either of its two shapes.
   *
   * `::ffff:a.b.c.d` is the IPv4-MAPPED form and `::a.b.c.d` the deprecated
   * IPv4-COMPATIBLE one. Both reduce to an IPv4 address, and `new URL()`
   * renders both in hex - `::ffff:7f00:1` and `::7f00:1` - so neither looks
   * like an IPv4 address by the time it arrives here. Handling only the
   * mapped form left `http://[::127.0.0.1]/` reaching loopback.
   *
   * Judged as the IPv4 address it actually is, whichever spelling it came in.
   * This also subsumes `::` and `::1`, which resolve to 0.0.0.1 and 0.0.0.0
   * and are caught by the 0.0.0.0/8 rule on the v4 side.
   */
  if (
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0 || groups[5] === 0xffff)
  ) {
    return isBlockedV4(intToV4(((groups[6] << 16) | groups[7]) >>> 0));
  }

  // Two more ways to wrap an IPv4 address (security review, 30 September
  // 2026): NAT64's 64:ff9b::/96 carries it in the last two groups, 6to4's
  // 2002::/16 in the two after the prefix. Judged as that IPv4 address.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedV4(intToV4(((groups[6] << 16) | groups[7]) >>> 0));
  }
  if (groups[0] === 0x2002) return isBlockedV4(intToV4(((groups[1] << 16) | groups[2]) >>> 0));

  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

export class BlockedAddressError extends Error {
  constructor(reason: string) {
    super(`Refused to fetch: ${reason}`);
    this.name = "BlockedAddressError";
  }
}

/** Throws unless `raw` is an http(s) URL on a normal port whose hostname
 *  resolves entirely to public addresses. Every resolved address is checked,
 *  not just the first - a name resolving to one public and one private address
 *  would otherwise pass while Node might still connect to the private one. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError(`not a valid URL (${raw.slice(0, 80)})`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(`scheme ${url.protocol} is not http(s)`);
  }

  // A job board does not live on port 22 or 6379. Restricting to the web ports
  // removes a whole class of internal-service probing for no practical cost.
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443 && port !== 8080 && port !== 8443) {
    throw new BlockedAddressError(`port ${port} is not a web port`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address needs no DNS and must still be checked.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isBlockedV4(host)) throw new BlockedAddressError(`${host} is a reserved address`);
    return url;
  }
  if (host.includes(":")) {
    if (isBlockedV6(host)) throw new BlockedAddressError(`${host} is a reserved address`);
    return url;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedAddressError(`${host} did not resolve`);
  }
  if (addresses.length === 0) throw new BlockedAddressError(`${host} resolved to nothing`);

  for (const { address, family } of addresses) {
    const blocked = family === 6 ? isBlockedV6(address) : isBlockedV4(address);
    if (blocked) throw new BlockedAddressError(`${host} resolves to ${address}, a reserved address`);
  }

  return url;
}

export type Resolved = { address: string; family: number };
export type Resolver = (host: string) => Promise<Resolved[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true });
const isPublicResolved = (a: Resolved) => !(a.family === 6 ? isBlockedV6(a.address) : isBlockedV4(a.address));

/** The ports a job board is allowed to live on. See `assertPublicUrl` for why
 *  the list is this short. Exported because the render proxy enforces the
 *  same list on traffic Chromium originates, where there is no URL for
 *  `assertPublicUrl` to look at. */
export const WEB_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

/**
 * Every address a name resolves to, or a BlockedAddressError if any of them
 * is one we refuse. A literal address is judged as itself and resolves to
 * itself - no DNS involved, and no way to answer differently a moment later.
 *
 * Shared by `guardedLookup` (which hands the result straight to the socket)
 * and by the render proxy (which dials the result itself). Both need the
 * property that the address CHECKED is the address CONNECTED TO; a helper
 * that returns the addresses, rather than a boolean, is what makes that
 * possible. `resolve` and `allowed` are for tests.
 */
export async function checkedAddresses(
  hostname: string,
  resolve: Resolver = systemResolver,
  allowed: (a: Resolved) => boolean = isPublicResolved,
): Promise<Resolved[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? [{ address: host, family: 4 }]
    : host.includes(":")
      ? [{ address: host, family: 6 }]
      : null;

  const addresses = literal ?? (await resolve(host));
  if (addresses.length === 0) throw new BlockedAddressError(`${host} resolved to nothing`);
  const bad = addresses.find((a) => !allowed(a));
  if (bad) throw new BlockedAddressError(`${host} resolves to ${bad.address}, a reserved address`);
  return addresses;
}

/**
 * A DNS lookup for http(s).request that refuses internal addresses. Every
 * address the name resolves to must be public, and the ones handed back are
 * the ones the socket connects to - there is no second lookup to lie in.
 * `resolve` and `allowed` are for tests.
 */
function guardedLookup(resolve: Resolver = systemResolver, allowed: (a: Resolved) => boolean = isPublicResolved): LookupFunction {
  return ((hostname: string, options: { family?: number | string; all?: boolean }, callback: (err: Error | null, address: string | Resolved[], family?: number) => void) => {
    checkedAddresses(hostname, resolve, allowed)
      .then((addresses) => {
        const want = options?.family === 4 || options?.family === "IPv4" ? 4 : options?.family === 6 || options?.family === "IPv6" ? 6 : 0;
        const usable = want ? addresses.filter((a) => a.family === want) : addresses;
        if (usable.length === 0) throw new BlockedAddressError(`${hostname} has no IPv${want} address`);
        if (options?.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err: Error) => callback(err, "", 0));
  }) as LookupFunction;
}

/**
 * A single request, no redirects followed, whose connection resolves its host
 * through guardedLookup. Returns a standard Response - body decompressed as
 * fetch() would (gzip, deflate, br) - so callers read it the same way.
 */
export function pinnedFetch(
  raw: string | URL,
  init: Pick<RequestInit, "method" | "headers" | "signal" | "body"> & { maxBytes?: number } = {},
  test: { resolve?: Resolver; allowed?: (a: Resolved) => boolean } = {},
): Promise<Response> {
  const url = new URL(raw);
  const client = url.protocol === "https:" ? https : http;
  const headers = new Headers(init.headers);
  // The headers Node's fetch() adds on its own. Some sites refuse a request
  // without them (Banking Dive answered 403 until accept-language was sent).
  const defaults: Record<string, string> = { accept: "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "accept-encoding": "gzip, deflate", "user-agent": "node" };
  for (const [key, value] of Object.entries(defaults)) if (!headers.has(key)) headers.set(key, value);
  const method = (init.method ?? "GET").toUpperCase();
  // The bodies the connectors send: JSON or form text. Anything else is refused rather than sent wrong.
  let payload: Buffer | null = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") payload = Buffer.from(init.body);
    else if (init.body instanceof URLSearchParams) {
      payload = Buffer.from(init.body.toString());
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (init.body instanceof Uint8Array) payload = Buffer.from(init.body);
    else return Promise.reject(new TypeError("pinnedFetch sends only string, form or byte bodies"));
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    headers.set("content-length", String(payload.byteLength));
  }

  return new Promise<Response>((resolve, reject) => {
    const req = client.request(
      url,
      { method, headers: Object.fromEntries(headers), lookup: guardedLookup(test.resolve, test.allowed), signal: init.signal ?? undefined },
      (res) => {
        const status = res.statusCode ?? 0;
        const out = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(key, String(v));
        }
        /**
         * `content-encoding` is a LIST, not a token.
         *
         * The equality tests this used to do against the whole header string
         * matched none of `gzip, gzip`, `identity, gzip` or `GZIP ,gzip`, so
         * the decoder was silently skipped and the caller's `res.text()`
         * handed back compressed bytes as if they were a page - a parse that
         * finds no listings rather than an error that says why (security
         * review, 10 October 2026).
         *
         * Read properly: `identity` names no transformation and is dropped,
         * and what is left is applied outermost-last, so the LAST token is
         * the one to undo first. Only one layer is undone here, so a real
         * stack is refused outright rather than handed back half-decoded -
         * nothing legitimate on the web sends one, and guessing is how a
         * crawler ends up storing binary as a job description.
         */
        const layers = String(res.headers["content-encoding"] ?? "")
          .toLowerCase()
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token !== "" && token !== "identity");
        if (layers.length > 1) {
          res.destroy();
          reject(new TypeError(`Refused to read: stacked content-encoding (${layers.join(", ")})`));
          return;
        }
        const encoding = layers[layers.length - 1] ?? "";
        const decoder =
          encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;

        /**
         * The byte cap, on EVERY body.
         *
         * It used to live inside the `if (decoder)` branch, which made it a
         * no-op for the common case: an identity-encoded response had no cap
         * at all here and relied on each caller remembering to read through
         * one. A cap that only applies when the host chose to compress is not
         * a cap (security review, 10 October 2026).
         *
         * For a compressed body it counts what comes OUT of the decoder,
         * because that is where the asymmetry lives: a gzip bomb is small on
         * the wire and unbounded after it, and zlib's own `maxOutputLength`
         * is honoured only by the one-shot convenience methods, not by a
         * stream (measured on Node 24). Crossing the cap ends the body AND
         * destroys the socket, so the host stops sending.
         */
        const cap = init.maxBytes ?? MAX_BODY_BYTES;
        let written = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _enc, done) {
            written += chunk.byteLength;
            if (written > cap) return done(new BodyTooLargeError(cap));
            done(null, chunk);
          },
        });
        limit.on("error", () => res.destroy());
        let body: Readable;
        if (decoder) {
          // pipe() does not pass errors on; an aborted or broken response must still end the body.
          res.on("error", (err) => decoder.destroy(err));
          decoder.on("error", (err) => limit.destroy(err));
          body = res.pipe(decoder).pipe(limit);
          out.delete("content-encoding");
          out.delete("content-length");
        } else {
          /**
           * An identity body is handed back unwrapped, and capped one layer up.
           *
           * Piping it through `limit` as well looks tidier and is wrong: when a
           * consumer CANCELS this body - which safeFetch does on every redirect
           * hop - the web-stream adapter closes its controller and destroys the
           * transform, while the socket is still flowing into it, and the next
           * chunk throws ERR_INVALID_STATE ("Controller is already closed")
           * out of the adapter where nothing can catch it.
           *
           * The cap is not lost: safeFetch wraps every response in
           * boundedBody(), which counts bytes whatever the encoding. `limit`
           * exists for the one thing boundedBody cannot see - a compressed body
           * that inflates - which is why it stays on the decoder path above.
           * Callers that use pinnedFetch directly must apply their own cap;
           * lib/news/safe-fetch.ts now does.
           */
          body = res;
        }
        const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        try {
          resolve(new Response(empty ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers: out }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

/**
 * The transport safeFetch uses for one hop: pinnedFetch - except under Node's
 * test runner (NODE_TEST_CONTEXT is set only there), where it is the global
 * fetch, so tests that fake the network by replacing fetch, and the
 * no-network guard, keep working. The address checks before each hop run
 * either way; pinnedFetch's own lookup is tested directly in
 * pinned-fetch.test.ts. Nothing outside the test runner sets it.
 */
export function hopFetch(
  url: string | URL,
  init: Pick<RequestInit, "method" | "headers" | "signal" | "body"> & { maxBytes?: number },
): Promise<Response> {
  if (process.env.NODE_TEST_CONTEXT) return globalThis.fetch(url, { ...init, redirect: "manual" });
  return pinnedFetch(url, init);
}

/**
 * The same body, read through a byte cap and a deadline that can be stood
 * down once the body is done.
 *
 * Written as a stream rather than a buffered read because the callers are
 * `res.text()` and `res.json()`: they must keep working unchanged, and a
 * response that is going to be refused for its size should be refused while
 * it arrives, not after it has all been held in memory.
 *
 * `settled` is called exactly once, on every way out - finished, cancelled,
 * over the cap, or errored underneath us - so the body deadline is never left
 * armed on a connection that is already finished. `abort` ends the request
 * itself: a cap or a cancel that only stopped READING would leave the host
 * sending into a socket nobody drains.
 */
function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  settled: () => void,
  abort: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        settled();
        throw err;
      }
      if (chunk.done) {
        settled();
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        settled();
        const err = new BodyTooLargeError(maxBytes);
        abort(err);
        await reader.cancel(err).catch(() => {});
        controller.error(err);
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      settled();
      abort(reason);
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * fetch(), with every hop checked.
 *
 * Redirects are followed manually because `redirect: "follow"` would let a
 * page bounce us to an address `assertPublicUrl` had already refused. The
 * returned Response is whatever the final, checked hop gave back.
 *
 * `timeoutMs` bounds the wait for headers; `bodyTimeoutMs` bounds the read of
 * the body that follows, and defaults to the same number. Both are whole-
 * phase deadlines rather than idle timers on purpose: an idle timer is
 * exactly what a one-byte-every-two-seconds host defeats. `maxBytes` caps the
 * decompressed body. The caller's `signal` is honoured alongside all three.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { timeoutMs?: number; bodyTimeoutMs?: number; maxBytes?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20000, bodyTimeoutMs = timeoutMs, maxBytes = MAX_BODY_BYTES, ...rest } = init;
  let current = raw;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);

    const controller = new AbortController();
    const abort = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    /**
     * Three reasons to stop, not one.
     *
     * The caller's own signal used to be dropped on the floor: the connectors
     * that pass one (`workday`, `oracle-hcm`, `eightfold`, `icims`) wrap the
     * body read in it, so dropping it was precisely the reason their own
     * timeouts never fired.
     *
     * The run-wide deadline (lib/monitoring/deadline.ts) is folded in by
     * `withAmbientDeadline`, and it is the only thing that can reach a request
     * inside a connector that takes no signal of its own. The per-source
     * budget's stage checkpoints in monitor-run.ts stop a cancelled source
     * BETWEEN stages; this is what stops a read already in flight within one.
     * See deadline.ts for what the gap cost: a 180-second budget against reads
     * that ran for five hours.
     *
     * The per-hop timeouts still apply on top of both: a redirect chain must
     * not get 20 seconds per hop out of a budget meant for the whole source.
     */
    const upstream = withAmbientDeadline(rest.signal ?? undefined);
    if (upstream) {
      if (upstream.aborted) abort(upstream.reason);
      else upstream.addEventListener("abort", () => abort(upstream.reason), { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => abort(new FetchTimeoutError("headers", timeoutMs)),
      timeoutMs,
    );
    const disarm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    let response: Response;
    try {
      // Pinned: the address checked is the address connected to (see DNS REBINDING above).
      response = await hopFetch(url, { method: rest.method, headers: rest.headers, body: rest.body, signal: controller.signal, maxBytes });
    } catch (err) {
      disarm();
      throw err;
    }
    // Headers are in. This is where the old version stopped caring - the
    // timer was cleared here and nothing replaced it.
    disarm();

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        // Nobody reads a redirect's body, and an unread body keeps the socket
        // (and the fetch-pool slot above it) open until the process ends.
        await response.body?.cancel().catch(() => {});
        // Relative redirects are normal and resolve against the hop we just made.
        current = new URL(location, url).toString();
        continue;
      }
      // A 3xx with no Location is handed back whole, body included, like any
      // other response the caller has to make sense of.
    }

    // A HEAD, a 204 or a 304 has no body to bound, and the Response
    // constructor would refuse one anyway.
    if (!response.body) return response;

    const deadline = setTimeout(() => abort(new FetchTimeoutError("body", bodyTimeoutMs)), bodyTimeoutMs);
    return new Response(
      boundedBody(response.body, maxBytes, () => clearTimeout(deadline), abort) as ReadableStream<Uint8Array>,
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }

  throw new BlockedAddressError(`more than ${MAX_REDIRECTS} redirects`);
}
