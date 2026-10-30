// One polite HTTP GET for feeds. The timeout covers reading the body, not just
// the headers: the first version of the scout aborted only the connection, and
// a server that sent headers and then trickled its body hung the run for ten
// minutes. It goes through safeFetch (public http(s) addresses only, redirects
// checked) and reads at most maxBytes.

import { UnsafeUrlError, readCapped, safeFetch } from "./safe-fetch";

export const NEWS_USER_AGENT = "Mozilla/5.0 (compatible; OfferlyNews/1.0)";

export type FetchResult = { ok: true; text: string; url: string } | { ok: false; status: number | null; error: string };

export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; userAgent?: string; maxBytes?: number } = {},
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const { res, url: finalUrl } = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": opts.userAgent ?? NEWS_USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = await readCapped(res, opts.maxBytes ?? 3_000_000, "truncate");
    return { ok: true, text: new TextDecoder().decode(body ?? Buffer.alloc(0)), url: finalUrl };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (err instanceof UnsafeUrlError) return { ok: false, status: null, error: `refused: ${err.message}` };
    return { ok: false, status: null, error: aborted ? "timeout" : String(err instanceof Error ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. Order of results matches input. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}
