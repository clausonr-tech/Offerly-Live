import { NEWS_USER_AGENT } from "./fetch";
import { safeFetch } from "./safe-fetch";
import { decodeEntities as decodeHtmlEntities } from "../html-entities";

// Finding a story's own photo on its page, in the order a publisher intends:
//
//   1. the share image (og:image / twitter:image) - the one photo the editors
//      picked to stand for the article wherever it is linked. It is never an
//      ad or a sidebar, because it is not on the page at all, only in its head.
//   2. the image in the article's structured data (JSON-LD NewsArticle.image).
//   3. every real photo INSIDE the article body, top first - skipping anything
//      that sits in an ad, a sidebar, a "related stories" rail, a byline or a
//      logo. Tried when the share images fail a check, not only when a page
//      has none.
//
// Every candidate is still checked afterwards (image-probe.ts for size and
// shape, the vision check for what it shows); this file only finds them.

export type ImageCandidate = { url: string; source: "share" | "jsonld" | "article" };

const HEAD_LIMIT = 600_000;
const BODY_LIMIT = 2_500_000;

/**
 * GET a page, reading only as far as needed: up to </head> when the share
 * image is all that is wanted, the whole page (capped) otherwise.
 */
export async function fetchPage(
  url: string,
  opts: { wholePage?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: true; html: string; finalUrl: string } | { ok: false; status: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    const { res, url: finalUrl } = await safeFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": NEWS_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok || !res.body) return { ok: false, status: res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const limit = opts.wholePage ? BODY_LIMIT : HEAD_LIMIT;
    let html = "";
    while (html.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (!opts.wholePage && /<\/head>/i.test(html)) break;
    }
    controller.abort();
    return { ok: true, html, finalUrl };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

// Every pattern below is bounded - a tag's attributes to a few thousand
// characters, a block to tens of thousands - and no page is scanned past
// SCAN_LIMIT. Unbounded `[^>]*` and `[\s\S]*?` backtrack quadratically on a
// page built to defeat them ("<p" repeated, never closed), and a regex cannot
// be interrupted by the fetch's timeout: one crafted page would stall the
// whole news run (security review, 30 September 2026).
const SCAN_LIMIT = 600_000;
const scan = (html: string) => (html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function absolute(src: string, base: string): string | null {
  const cleaned = decodeEntities(src.trim());
  if (!cleaned || cleaned.startsWith("data:")) return null;
  try {
    const u = new URL(cleaned, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

const SHARE_KEYS = ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"];

/** The share image and the structured-data image, in that order. */
export function shareImages(page: string, base: string): ImageCandidate[] {
  const html = scan(page);
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || html.length) + 7);
  const found: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | null, source: ImageCandidate["source"]) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      found.push({ url, source });
    }
  };

  const metas = [...head.matchAll(/<meta\b[^>]{0,4000}>/gi)].map((m) => m[0]);
  for (const key of SHARE_KEYS) {
    for (const tag of metas) {
      const name = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
      if (name === key) push(absolute(attr(tag, "content") ?? "", base), "share");
    }
  }
  for (const tag of head.matchAll(/<link\b[^>]{0,2000}?rel=["']image_src["'][^>]{0,2000}>/gi)) push(absolute(attr(tag[0], "href") ?? "", base), "share");

  for (const block of html.matchAll(/<script\b[^>]{0,2000}?type=["']application\/ld\+json["'][^>]{0,2000}>([\s\S]{0,200000}?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    for (const node of flattenJsonLd(data)) {
      const type = [node["@type"]].flat().map(String).join(" ");
      if (!/Article|NewsArticle|Report|BlogPosting/i.test(type)) continue;
      for (const image of [node.image].flat()) {
        const url = typeof image === "string" ? image : typeof image === "object" && image ? (image as { url?: string }).url : null;
        if (typeof url === "string") push(absolute(url, base), "jsonld");
      }
    }
  }
  return found;
}

function flattenJsonLd(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.flatMap(flattenJsonLd);
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  return [obj, ...(Array.isArray(obj["@graph"]) ? flattenJsonLd(obj["@graph"]) : [])];
}

// Where the article's own text starts. The first match wins; a page with none
// of these has no body we can trust to be the article.
const BODY_START = [
  /<[a-z]{1,20}\b[^>]{0,2000}?itemprop=["']articleBody["'][^>]{0,2000}>/i,
  /<article\b[^>]*>/i,
  /<[a-z]{1,20}\b[^>]{0,2000}?class=["'][^"']{0,500}?\b(?:article[-_]?body|article__body|article[-_]?content|story[-_]?body|entry[-_]?content|post[-_]?content|post[-_]?body|content[-_]?body)\b[^"']{0,500}["'][^>]{0,2000}>/i,
  /<main\b[^>]*>/i,
];

// Blocks inside an article that are never its photo.
const STRIP_BLOCKS = /<(aside|nav|footer|form|iframe|ins|script|style|template|svg)\b[\s\S]{0,100000}?<\/\1>/gi;
// An image whose surroundings say ad, promo, sidebar, related stories, byline or logo.
// Not "thumbnail" (WordPress marks the featured image "post-thumbnail") and not
// "headshot" (a people-move story's lead photo is one).
const NOT_EDITORIAL =
  /\b(?:ad|ads|advert\w*|dfp|gpt|sponsor\w*|promo\w*|partner\w*|related|recommend\w*|more[-_]stories|read[-_]?more|trending|popular|newsletter|subscribe|paywall|widget|sidebar|rail|outbrain|taboola|share|social|author\w*|avatar|byline|logo\w*|icon\w*|badge|emoji|teaser|carousel|slider|swiper)\b/i;
const AD_HOSTS = /(doubleclick|googlesyndication|googleadservices|adnxs|amazon-adsystem|criteo|pubmatic|rubiconproject|moatads|scorecardresearch|outbrain|taboola|facebook\.com\/tr|quantserve|adsrvr|bat\.bing|pixel)/i;

// "<div />" or '<span class="x"/>' - a slash standing on its own at the end.
// Not the last character of an unquoted value: minified pages write links as
// <a href=/2026/09/next-story/>, and reading that slash as self-closing left
// the link off the stack, so the related-story photo inside it passed as the
// article's own (5 October 2026, caught by the generated tests).
const SELF_CLOSING = /(?:^|\s|["'])\/\s*$/;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The class, id and data-* values on a tag - where an ad slot or a rail names itself. */
function classesOf(attrs: string): string {
  return [...attrs.matchAll(/\s(?:class|id|data-[a-z-]{1,40})\s*=\s*["']([^"']{0,500})["']/gi)].map((c) => c[1]).join(" ");
}

function bestSrc(tag: string, base: string): string | null {
  const srcset = attr(tag, "data-srcset") ?? attr(tag, "srcset");
  if (srcset) {
    const widest = srcset
      .split(",")
      .map((part) => {
        const [u, w] = part.trim().split(/\s+/);
        return { u, w: Number.parseInt(w ?? "0", 10) || 0 };
      })
      .sort((a, b) => b.w - a.w)[0];
    if (widest?.u) return absolute(widest.u, base);
  }
  for (const name of ["data-src", "data-lazy-src", "data-original", "data-full-src", "src"]) {
    const v = attr(tag, name);
    if (v) return absolute(v, base);
  }
  return null;
}

// A link to the photo's own file (a lightbox) or back to the article itself
// is still the article's photo. A link anywhere else is a teaser for another
// page.
const IMAGE_FILE = /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i;

function samePage(a: URL, b: URL): boolean {
  const strip = (u: URL) => `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  return strip(a) === strip(b);
}

/**
 * Whether an image sits inside a link to some other page. Every tile in a
 * "related articles" or "more stories" rail is one - a photo wrapped in a link
 * to a different story - whatever the rail's class names call it. Markets
 * Media's rail is "c-other-events-box" in a swiper slider, which no list of
 * rail words caught, so its tiles reached the photo step (5 October 2026).
 */
function linksElsewhere(hrefs: (string | null)[], base: string): boolean {
  let page: URL;
  try {
    page = new URL(base);
  } catch {
    return false;
  }
  for (const href of hrefs) {
    if (!href) continue;
    const raw = decodeEntities(href.trim());
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
    let target: URL;
    try {
      target = new URL(raw, page);
    } catch {
      continue;
    }
    if (IMAGE_FILE.test(target.pathname) || samePage(target, page)) continue;
    return true;
  }
  return false;
}

/** Where the article's body starts on its page, or -1 when nothing marks one. */
function bodyStart(page: string): number {
  const html = scan(page);
  for (const re of BODY_START) {
    const m = re.exec(html);
    if (m) return m.index;
  }
  return -1;
}

/**
 * Every photo inside the article body, top first, at most `max`. Never one
 * from an ad slot, a sidebar, a related-stories rail, a byline or a logo,
 * never one that links to another page (a teaser for a different story), and
 * never one the page itself marks as small. The photo step tries them in
 * order, so a lead image that is too small or the wrong shape no longer costs
 * the story the good photo further down.
 */
export function articleImages(html: string, base: string, max = 6): ImageCandidate[] {
  const start = bodyStart(html);
  if (start < 0) return [];
  const region = html.slice(start, start + 200_000).replace(STRIP_BLOCKS, " ");
  const found: ImageCandidate[] = [];
  const seen = new Set<string>();
  const wrappers: string[] = [];
  // The href of each open element that is a link, null for the rest.
  const links: (string | null)[] = [];
  // Walk the tags in order, keeping the chain of elements each image sits
  // inside: an image is judged by its own wrappers (a div.ad-slot, a
  // ul.related-stories), not by whatever came just before it on the page.
  const open: string[] = [];
  for (const m of region.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,40})\b([^>]{0,4000})>/g)) {
    const [tag, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at >= 0) {
        open.length = at;
        wrappers.length = at;
        links.length = at;
      }
      continue;
    }
    if (name !== "img") {
      if (!VOID_TAGS.has(name) && !SELF_CLOSING.test(attrs)) {
        open.push(name);
        wrappers.push(classesOf(attrs));
        links.push(name === "a" ? attr(tag, "href") : null);
      }
      continue;
    }
    const classes = [...wrappers, classesOf(attrs)].join(" ");
    if (NOT_EDITORIAL.test(classes) || NOT_EDITORIAL.test(attr(tag, "alt") ?? "")) continue;
    if (linksElsewhere(links, base)) continue;
    const width = Number.parseInt(attr(tag, "width") ?? "", 10);
    const height = Number.parseInt(attr(tag, "height") ?? "", 10);
    if ((width && width < 300) || (height && height < 150)) continue;
    const src = bestSrc(tag, base);
    if (!src || AD_HOSTS.test(src) || /\.(svg|gif)(\?|$)/i.test(src) || seen.has(src)) continue;
    seen.add(src);
    found.push({ url: src, source: "article" });
    if (found.length >= max) break;
  }
  return found;
}

/** The first photo inside the article body - see articleImages. */
export function articleImage(html: string, base: string): ImageCandidate | null {
  return articleImages(html, base, 1)[0] ?? null;
}

// Lines inside an article body that are the page talking, not the story.
const BOILERPLATE =
  /^(?:advertisement|sign up|subscribe|register|log ?in|read more|related|share this|follow us|click here|copyright|all rights reserved|reporting by|editing by|writing by|our standards|this article|this story|get the latest|download the|listen to|watch:|photo:|image:|\(reuters\)\s*$)/i;
const MAX_TEXT = 6000;

/**
 * The article's own words: the paragraphs of its body, in order, without
 * captions, ads, rails, bylines or sign-up prompts. Empty when the page has
 * no marked body - a paywall page usually leaves only a teaser, which the
 * summary step treats as too little to go on.
 */
export function articleText(html: string): string {
  const start = bodyStart(html);
  if (start < 0) return "";
  const region = html.slice(start, start + 400_000).replace(STRIP_BLOCKS, " ").replace(/<figure\b[\s\S]{0,50000}?<\/figure>/gi, " ");
  const paragraphs: string[] = [];
  let length = 0;
  for (const m of region.matchAll(/<p\b([^>]{0,2000})>([\s\S]{0,20000}?)<\/p>/gi)) {
    if (NOT_EDITORIAL.test(classesOf(m[1]))) continue;
    const text = decodeHtmlEntities(m[2].replace(/<[^>]{1,4000}>/g, " ")).replace(/\s+/g, " ").trim();
    if (text.length < 40 || BOILERPLATE.test(text)) continue;
    paragraphs.push(text);
    length += text.length + 1;
    if (length >= MAX_TEXT) break;
  }
  return paragraphs.join("\n").slice(0, MAX_TEXT);
}

const DESCRIPTION_KEYS = ["og:description", "twitter:description", "description"];

/**
 * The publisher's own one- or two-sentence description of the story, from
 * the page head - what shows under the headline when the story is shared.
 * Paywalled pages still carry it, so it is often all there is to read of a
 * Wall Street Journal or Financial Times story. Null when none says anything
 * beyond a few words.
 */
export function pageDescription(page: string): string | null {
  const html = scan(page);
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || Math.min(html.length, 200_000)) + 7);
  const found: string[] = [];
  for (const tag of [...head.matchAll(/<meta\b[^>]{0,4000}>/gi)].map((m) => m[0])) {
    const name = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (!DESCRIPTION_KEYS.includes(name)) continue;
    const content = decodeHtmlEntities(attr(tag, "content") ?? "").replace(/\s+/g, " ").trim();
    if (content.length >= 60) found.push(content);
  }
  return found.sort((a, b) => b.length - a.length)[0] ?? null;
}

// WordPress saves every upload again at fixed sizes, named by them:
// photo-150x150.jpg, photo-573x379.jpg. Feeds and rails link the small ones.
const WP_SIZED = /-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp|avif))$/i;

/**
 * The original upload behind a WordPress resized copy, or null when the URL
 * is not one. Markets Media's feed gives a 150x150 thumbnail, which fails the
 * size check, of the very photo the article shows at 724x441.
 */
export function fullSizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!WP_SIZED.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(WP_SIZED, "$1");
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

// Filenames a publisher gives its placeholder, logo or site-wide default. The
// photo step also counts how many different stories share one image URL: a
// default shows up on many.
const GENERIC_IMAGE = /(logo|default|placeholder|fallback|no[-_]?image|social[-_]?(share|post|default|card|image)|og[-_]?(default|image[-_]?default)|share[-_]?default|avatar|favicon|sprite|blank|spacer|brand[-_]?(image|card))/i;

export function isGenericImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return GENERIC_IMAGE.test(decodeURIComponent(u.pathname));
  } catch {
    return true;
  }
}
