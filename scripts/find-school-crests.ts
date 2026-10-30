/**
 * Find each school's sharpest icon on its own website.
 *
 *   npx tsx --env-file=.env.local scripts/find-school-crests.ts            # every school
 *   npx tsx --env-file=.env.local scripts/find-school-crests.ts nyu.edu    # just these
 *
 * The favicon service /api/crest used to rely on alone tops out at 16-64px
 * for hundreds of schools, which is why crests were blurry. Most schools
 * publish something much better for phones' home screens - an
 * apple-touch-icon (usually 180px) or a sized <link rel="icon">. This reads
 * the homepage's <link> tags plus the standard /apple-touch-icon.png paths,
 * measures every candidate. When the site has nothing sharp either (NYU's
 * only icon is a 16px .ico), it falls back to the seal or logo on the
 * school's Wikipedia article; with neither, the favicon service stays. Writes schools.crest_url / crest_width, and
 * crest_checked_at for every school it looked at.
 *
 * Polite: 8 schools at a time, one homepage and a handful of icon fetches
 * each, 10s timeouts.
 */

import { eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { schools } from "@/db/schema";

// A browser's user agent for school sites (several refuse anything else);
// Wikimedia asks API clients to identify themselves instead.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const WIKI_UA = "OfferlyCrestFinder/1.0 (school crests for student profiles)";
/**
 * A site icon at or above this is trusted to be sharp. 180 is the standard
 * apple-touch-icon; smaller "touch" icons are often upscaled blurs (Baruch's
 * 144px one is), so below it the Wikipedia seal wins.
 */
const SHARP = 180;

/** Width of a PNG / JPEG / GIF / WebP / ICO (largest entry); 0 unknown. */
export function imageWidth(b: Uint8Array): number {
  if (b.length < 24) return 0;
  if (b[0] === 0x89 && b[1] === 0x50) return ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
  if (b[0] === 0x47 && b[1] === 0x49) return b[6] | (b[7] << 8);
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9; ) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xc3) return (b[i + 7] << 8) | b[i + 8];
      i += 2 + len;
    }
    return 0;
  }
  if (b[0] === 0x52 && b[8] === 0x57 && b[12] === 0x56) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    if (kind === "VP8L") return 1 + (b[21] | ((b[22] & 0x3f) << 8));
    if (kind === "VP8 ") return (b[26] | (b[27] << 8)) & 0x3fff;
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    const n = b[4] | (b[5] << 8);
    let best = 0;
    for (let i = 0; i < n && 6 + i * 16 < b.length; i++) best = Math.max(best, b[6 + i * 16] || 256);
    return best;
  }
  return 0;
}

const isSvg = (b: Uint8Array, type: string) =>
  type.includes("svg") || /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.slice(0, 300)));

async function get(url: string, maxBytes: number, ua = UA): Promise<{ bytes: Uint8Array; type: string; url: string } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": ua }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c.subarray(0, Math.min(c.length, size - o)), o);
      o += c.length;
    }
    return { bytes, type: res.headers.get("content-type") ?? "", url: res.url };
  } catch {
    return null;
  }
}

/** Icon URLs a homepage declares, largest-declared first. */
function iconLinks(html: string, base: string): string[] {
  const out: { href: string; size: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    const size = Number(/\bsizes=["']?(\d+)x\d+/i.exec(tag)?.[1] ?? (rel.includes("apple") ? 180 : 0));
    try {
      out.push({ href: new URL(href.replace(/&amp;/g, "&"), base).toString(), size });
    } catch {}
  }
  return out.sort((a, b) => b.size - a.size).map((o) => o.href);
}

async function siteIcon(domain: string): Promise<{ url: string; width: number } | null> {
  let page = await get(`https://www.${domain}/`, 400_000);
  if (!page) page = await get(`https://${domain}/`, 400_000);
  const base = page?.url ?? `https://www.${domain}/`;
  const origin = new URL(base).origin;
  const candidates = [
    ...(page ? iconLinks(new TextDecoder().decode(page.bytes), base) : []),
    `${origin}/apple-touch-icon.png`,
    `${origin}/apple-touch-icon-precomposed.png`,
  ];
  let best: { url: string; width: number } | null = null;
  for (const url of [...new Set(candidates)].slice(0, 6)) {
    if (!url.startsWith("https://")) continue;
    const img = await get(url, 2_000_000);
    if (!img) continue;
    // Vector: sharp at any size. Recorded as width 0 and preferred.
    if (isSvg(img.bytes, img.type)) return { url: img.url, width: 0 };
    const w = imageWidth(img.bytes);
    if (w > (best?.width ?? 0)) best = { url: img.url, width: w };
  }
  return best;
}

/**
 * The school's seal or logo from its Wikipedia article, as a 256px PNG.
 * Accepted only when the article is about an institution (not a
 * disambiguation page or a namesake) and the image file is a seal, logo,
 * crest or coat of arms - never a campus photo.
 */
async function wikipediaCrest(name: string): Promise<{ url: string; width: number } | null> {
  // Our names come from a federal list: "Baruch College (CUNY)",
  // "University of Washington-Tacoma Campus". Try the name as-is, then without
  // the bracket, then without the campus suffix.
  const variants = [
    name,
    name.replace(/\s*\(.*?\)\s*/g, " ").trim(),
    name.replace(/\s*\(.*?\)\s*/g, " ").trim().replace(/-[^-]*campus$/i, "").trim(),
  ];
  for (const v of [...new Set(variants)]) {
    const hit = await wikipediaImage(v);
    if (hit) return hit;
  }
  return null;
}

async function wikipediaImage(name: string): Promise<{ url: string; width: number } | null> {
  const title = encodeURIComponent(name.replace(/ /g, "_"));
  const res = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, 200_000, WIKI_UA);
  if (!res) return null;
  let d: { type?: string; description?: string; originalimage?: { source: string; width: number } };
  try {
    d = JSON.parse(new TextDecoder().decode(res.bytes));
  } catch {
    return null;
  }
  if (d.type !== "standard" || !d.originalimage) return null;
  if (!/universit|college|institute|school|academy|conservatory|seminary/i.test(d.description ?? "")) return null;
  const src = decodeURIComponent(d.originalimage.source);
  // A vector file is artwork - a seal, logo or wordmark. A raster must say so
  // in its name, or it may be a photo of the campus.
  const vector = /\.svg(\/|\.png|$|\?)/i.test(src);
  if (!vector && !/(seal|logo|coat[_ ]of[_ ]arms|crest|shield|arms|emblem|wordmark|insignia)/i.test(src)) return null;
  const clean = d.originalimage.source.replace(/\?.*$/, "");
  // Wikimedia renders SVG thumbnails only at its standard widths (250, 330,
  // 500...) - 256px is a 400. 330 is the smallest above avatar needs.
  return { url: vector ? clean.replace(/\/\d+px-/, "/330px-") : clean, width: vector ? 330 : d.originalimage.width };
}

/**
 * The school's own sharp icon, else its Wikipedia seal or logo. Null keeps the
 * favicon service - its reported size is not trusted to mean sharp: it pads
 * UT Austin's tiny seal onto a 256px canvas and upscales Baruch's to 144.
 */
async function bestIcon(domain: string, name: string): Promise<{ url: string; width: number } | null> {
  const site = await siteIcon(domain);
  if (site && (site.width === 0 || site.width >= SHARP)) return site;
  return (await wikipediaCrest(name)) ?? (site && site.width >= 96 ? site : null);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => a.includes("."));
  const db = await getDb();
  const rows = await db
    .select({ id: schools.id, domain: schools.emailDomain, name: schools.name })
    .from(schools)
    .where(only.length ? inArray(schools.emailDomain, only) : sql`true`);
  console.log(`Looking up ${rows.length} schools, 8 at a time.`);

  let i = 0;
  let done = 0;
  let found = 0;
  async function worker() {
    while (i < rows.length) {
      const row = rows[i++];
      const icon = await bestIcon(row.domain, row.name);
      const good = !!icon;
      await db
        .update(schools)
        .set({
          crestUrl: good ? icon.url : null,
          crestWidth: good ? icon.width : null,
          crestCheckedAt: new Date(),
        })
        .where(eq(schools.id, row.id));
      if (good) found++;
      if (++done % 100 === 0 || only.length) console.log(`${done}/${rows.length} checked, ${found} sharp crests found${only.length ? ` - ${row.domain}: ${icon ? `${icon.width || "svg"} ${icon.url}` : "none"}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`Done: ${found} of ${rows.length} schools have a sharp crest from their own site.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
