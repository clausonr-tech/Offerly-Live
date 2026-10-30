import { decodeEntities as decodeHtmlEntities } from "../html-entities";
import { enclosedBlocks, enclosedText, openTags, stripTags } from "./scan-tags";
import type { RawItem } from "./types";

// Feed parsing for RSS 2.0, RSS 1.0 (RDF) and Atom. Regex rather than an XML
// library, as finance-news.ts always did: feeds in the wild are frequently not
// well-formed XML, and a strict parser drops a whole feed over one bad
// ampersand where these patterns still recover every item.
//
// A feed body is up to three megabytes of somebody else's markup, so the
// structural work - finding the items, finding an element inside one, removing
// tags - goes through scan-tags.ts, whose scans are linear. The old patterns
// for the same job were quadratic on a feed built from unclosed openers, and a
// regex cannot be interrupted by the fetch's timeout (security review,
// 10 October 2026). What is left here reads attributes out of one tag's
// attribute text, which scan-tags caps.

// No feed carries more items than this, nor an item longer than this; a body
// claiming otherwise is being measured for how long it can be made to parse.
const MAX_ITEMS = 500;
const BLOCK_LIMIT = 100_000;

function tag(block: string, name: string): string | null {
  const inner = enclosedText(block, name);
  return inner === null ? null : unwrap(inner);
}

function unwrap(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value.trim());
  return isNaN(d.getTime()) ? null : d;
}

// Publishers disagree on where the photo lives: media:content, media:thumbnail,
// an enclosure, or an <img> inside the description HTML. Checking all four is
// what lets most trade stories carry a picture.
export function extractImage(block: string): string | null {
  // Each pattern reads one tag's attribute text, so the first tag of its kind
  // that actually carries the attribute wins - as the old whole-block patterns
  // also found the first one that matched in full.
  const first = (names: string[], pattern: RegExp, markup = block) => {
    for (const { attrs } of openTags(markup, names, 200)) {
      const m = attrs.match(pattern);
      if (m) return m[1];
    }
    return null;
  };
  const media = first(["media:content", "media:thumbnail"], /\surl=["']([^"']{1,2000})["']/i);
  const enclosure = first(["enclosure"], /\surl=["']([^"']{1,2000})["'][^>]{0,2000}type=["']image/i);
  const inline = first(["img"], /\ssrc=["']([^"']{1,2000})["']/i, decodeHtmlEntities(block));
  for (const found of [media && decodeHtmlEntities(media), enclosure && decodeHtmlEntities(enclosure), inline]) {
    if (found && isWebUrl(found)) return found;
  }
  return null;
}

/** Only http(s) addresses are ever stored: a javascript: or data: link in a feed must never reach a student's page. */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Feed HTML to plain text: tags removed, entities decoded, whitespace collapsed. */
function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = decodeHtmlEntities(stripTags(decodeHtmlEntities(html)))
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function linkOf(block: string): string | null {
  const rss = tag(block, "link");
  if (rss && /^https?:/.test(decodeHtmlEntities(rss))) return decodeHtmlEntities(rss);
  // Atom: prefer rel="alternate" (or no rel), never rel="self"/"replies".
  for (const { attrs } of openTags(block, ["link"], 200)) {
    const href = attrs.match(/href=["']([^"']{1,2000})["']/i)?.[1];
    const rel = attrs.match(/rel=["']([^"']{1,200})["']/i)?.[1];
    if (href && (!rel || rel === "alternate") && isWebUrl(decodeHtmlEntities(href))) return decodeHtmlEntities(href);
  }
  const guid = tag(block, "guid");
  return guid && /^https?:/.test(guid) ? decodeHtmlEntities(guid) : null;
}

/**
 * An item's `<source url="...">Publisher</source>`, as Google News writes it:
 * the url must be the element's first attribute, as it always was.
 */
function sourceElement(block: string): { url: string; name: string } | null {
  const [tagFound] = openTags(block, ["source"], 1);
  const url = tagFound?.attrs.match(/^\s+url=["']([^"']{0,2000})["']/i)?.[1];
  const name = url === undefined ? null : enclosedText(block, "source");
  return url === undefined || name === null ? null : { url, name };
}

/**
 * Items from an RSS or Atom feed. `trustSource`: take each item's publisher
 * from its <source> element - only for Google News, which names the real
 * publisher there. Any other feed could use <source> to pass its stories off
 * as the Wall Street Journal's (security review, 30 September 2026).
 */
export function parseFeed(xml: string, fallback: { publisher: string; domain: string }, opts: { trustSource?: boolean } = {}): RawItem[] {
  const blocks = enclosedBlocks(xml, ["item", "entry"], { max: MAX_ITEMS, blockLimit: BLOCK_LIMIT });
  const items: RawItem[] = [];
  for (const block of blocks) {
    const title = plainText(tag(block, "title"));
    const url = linkOf(block);
    if (!title || !url) continue;
    const source = opts.trustSource ? sourceElement(block) : null;
    const description = plainText(
      tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content:encoded") ?? tag(block, "content"),
    );
    items.push({
      title,
      url,
      description,
      publisher: source ? decodeHtmlEntities(unwrap(source.name)) : fallback.publisher,
      publisherDomain: source ? domainOf(source.url) : fallback.domain,
      imageUrl: extractImage(block),
      publishedAt: parseDate(
        tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date"),
      ),
    });
  }
  return items;
}

/**
 * Google News wraps every result: the link is a Google redirect, the title ends
 * "- Publisher", and the description is a list of links rather than a summary.
 * So the publisher comes from <source>, the suffix is stripped, and the
 * description is dropped rather than stored as noise.
 */
export function parseGoogleNews(xml: string): RawItem[] {
  return parseFeed(xml, { publisher: "", domain: "" }, { trustSource: true }).map((item) => {
    const suffix = ` - ${item.publisher}`;
    return {
      ...item,
      title: item.publisher && item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title,
      description: null,
      imageUrl: null,
    };
  });
}
