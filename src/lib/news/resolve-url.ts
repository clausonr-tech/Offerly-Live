import { gunzipSync } from "node:zlib";
import { NEWS_USER_AGENT } from "./fetch";
import { readCapped, safeFetch } from "./safe-fetch";
import { enclosedBlocks, enclosedText, openTags } from "./scan-tags";

// A story that reached us through Google News carries a news.google.com link,
// not the publisher's. Asking Google to unwrap each one would be two requests
// to Google per story, from the same machine whose Google News searches feed
// the whole pipeline - the fastest way to get those searches throttled. So the
// story is found on the PUBLISHER's side instead:
//
//   1. the news sitemap the publisher lists in its robots.txt for search
//      engines - its own recent articles with their addresses, headlines and
//      often their photo (Reuters, WSJ, Bloomberg, FT, ...);
//   2. failing that, the links on its homepage, matched by the words in the
//      address ("/insurers-raise-cat-bond-issuance-to-record").
//
// One or two fetches per publisher per run, however many of its stories need
// resolving.

export type SitemapEntry = { loc: string; title: string | null; image: string | null; date: Date | null };

const MAX_AGE_DAYS = 5;
const MAX_DOWNLOAD = 8_000_000;
const MAX_SITEMAP = 16_000_000;

async function get(url: string, timeoutMs = 15_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { res } = await safeFetch(url, { signal: controller.signal, headers: { "User-Agent": NEWS_USER_AGENT } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const buf = await readCapped(res, MAX_DOWNLOAD, "truncate");
    if (!buf) return null;
    // A .xml.gz sitemap is served as a gzip file, not with gzip transfer
    // encoding. Capped: a small file can inflate to gigabytes.
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: MAX_SITEMAP }) : buf;
    return raw.toString("utf8").slice(0, MAX_SITEMAP);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cdata(s: string): string {
  return s
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// A sitemap is up to sixteen megabytes of a publisher's markup and a homepage
// three of them, so the elements are found by scanning rather than with lazy
// `[\s\S]*?` and `[^>]*` patterns, which backtrack quadratically on markup
// made of unclosed openers and cannot be interrupted by the fetch's timeout
// (security review, 10 October 2026). The caps below are far above any real
// sitemap: they bound the crafted case without reaching the honest one.
const MAX_SITEMAP_ENTRIES = 500_000;
const MAX_ENTRY_CHARS = 50_000;
const MAX_HOMEPAGE_LINKS = 5_000;

function tagText(block: string, name: string): string | null {
  const inner = enclosedText(block, name);
  return inner === null ? null : cdata(inner);
}

/** The entries of a urlset sitemap, or the child sitemaps of an index. */
export function parseSitemap(xml: string): { entries: SitemapEntry[]; children: { loc: string; date: Date | null }[] } {
  const entries: SitemapEntry[] = [];
  for (const block of enclosedBlocks(xml, ["url"], { max: MAX_SITEMAP_ENTRIES, blockLimit: MAX_ENTRY_CHARS })) {
    const loc = tagText(block, "loc");
    if (!loc || !/^https?:\/\//i.test(loc)) continue;
    const when = tagText(block, "news:publication_date") ?? tagText(block, "lastmod");
    const date = when ? new Date(when) : null;
    entries.push({
      loc,
      title: tagText(block, "news:title"),
      image: ((img) => (img && /^https?:\/\//i.test(img) ? img : null))(tagText(block, "image:loc")),
      date: date && !Number.isNaN(date.getTime()) ? date : null,
    });
  }
  const children: { loc: string; date: Date | null }[] = [];
  for (const block of enclosedBlocks(xml, ["sitemap"], { max: MAX_SITEMAP_ENTRIES, blockLimit: MAX_ENTRY_CHARS })) {
    const loc = tagText(block, "loc");
    const when = tagText(block, "lastmod");
    const date = when ? new Date(when) : null;
    if (loc) children.push({ loc, date: date && !Number.isNaN(date.getTime()) ? date : null });
  }
  return { entries, children };
}

const NEWSY = /news|latest|today|yesterday|recent|google|articles?[-_]?sitemap|post[-_]sitemap/i;

/** A publisher's recent articles, from its news sitemap or, failing that, its homepage links. */
export async function publisherArticles(domain: string, now: Date = new Date()): Promise<SitemapEntry[]> {
  const host = domain.replace(/^www\./, "");
  const origins = [`https://www.${host}`, `https://${host}`];
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;
  // Only the publisher's own site: a robots.txt or sitemap naming another
  // host - an internal address, someone else's page - is how a hostile site
  // would steer this pipeline's requests (security review, 30 September 2026).
  const ownSite = (raw: string) => {
    try {
      const h = new URL(raw).hostname.toLowerCase();
      return h === host || h.endsWith(`.${host}`);
    } catch {
      return false;
    }
  };
  const fresh = (e: SitemapEntry) => (!e.date || e.date.getTime() >= cutoff) && ownSite(e.loc);

  for (const origin of origins) {
    const robots = await get(`${origin}/robots.txt`, 8_000);
    if (!robots) continue;
    const listed = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).filter(ownSite);
    // News sitemaps first; a general sitemap is a fallback, since it can be huge.
    const ordered = [...listed.filter((u) => NEWSY.test(u)), ...listed.filter((u) => !NEWSY.test(u))].slice(0, 4);
    const out: SitemapEntry[] = [];
    for (const sitemap of ordered) {
      const xml = await get(sitemap);
      if (!xml) continue;
      const { entries, children } = parseSitemap(xml);
      out.push(...entries.filter(fresh));
      if (children.length) {
        // An index: its newest children (or the ones named for news). Eight,
        // because Reuters and Insurance Business split three days of articles
        // across that many; three found 5 of 103 Reuters stories.
        const pick = [...children]
          .sort((a, b) => Number(NEWSY.test(b.loc)) - Number(NEWSY.test(a.loc)) || (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
          .filter((c) => (!c.date || c.date.getTime() >= cutoff) && ownSite(c.loc))
          .slice(0, 8);
        for (const child of pick) {
          const childXml = await get(child.loc);
          if (childXml) out.push(...parseSitemap(childXml).entries.filter(fresh));
        }
      }
      if (out.length >= 30) break;
    }
    if (out.length) return out;
    break;
  }

  // No usable sitemap: the article links on the homepage.
  for (const origin of origins) {
    const html = await get(origin, 12_000);
    if (!html) continue;
    const links = new Set<string>();
    for (const { attrs } of openTags(html, ["a"], MAX_HOMEPAGE_LINKS)) {
      const href = attrs.match(/href=["']([^"'#]{1,2000})["']/i)?.[1];
      if (!href) continue;
      try {
        const u = new URL(href, origin);
        if (u.hostname.replace(/^www\./, "") !== host) continue;
        if (slugWords(u.toString()).length >= 4) links.add(u.toString());
      } catch {
        /* not a link */
      }
    }
    return [...links].map((loc) => ({ loc, title: null, image: null, date: null }));
  }
  return [];
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "as", "at", "by", "with", "from", "is", "its", "it", "after", "over", "into", "be", "are", "that", "this", "s"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9$%.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w && !STOP.has(w));
}

/** The words in an article address's last path segment: "/2026/09/insurers-raise-cat-bonds" -> insurers, raise, cat, bonds. */
export function slugWords(url: string): string[] {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const slug = [...parts].reverse().find((p) => /[a-z].*-.*[a-z]/i.test(p)) ?? "";
    return words(slug.replace(/\.\w+$/, "").replace(/-\d{6,}$|-[0-9a-f]{8,}$/i, "").replace(/[-_]/g, " "));
  } catch {
    return [];
  }
}

function overlap(a: string[], b: string[]): { jaccard: number; covered: number; shared: number } {
  const A = new Set(a);
  const B = new Set(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return { jaccard: union ? shared / union : 0, covered: A.size ? shared / A.size : 0, shared };
}

/**
 * The publisher's own entry for a headline, or null. A sitemap title must
 * match closely; an address matched by its words alone must share most of the
 * headline's words, and at least four of them - two stories about one company
 * share its name, not a whole headline.
 */
export function matchHeadline(headline: string, entries: SitemapEntry[]): SitemapEntry | null {
  const want = words(headline);
  if (want.length === 0) return null;
  let best: { entry: SitemapEntry; score: number } | null = null;
  for (const entry of entries) {
    let score = 0;
    if (entry.title) {
      const o = overlap(want, words(entry.title));
      if (o.jaccard >= 0.7 || (o.covered >= 0.85 && o.shared >= 4)) score = 1 + o.jaccard;
    } else {
      const o = overlap(want, slugWords(entry.loc));
      if (o.shared >= 4 && (o.jaccard >= 0.6 || o.covered >= 0.75)) score = o.jaccard;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry ?? null;
}
