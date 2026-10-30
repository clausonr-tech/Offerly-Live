/**
 * Repair rot, upgrade soft logos, and fill gaps in src/lib/firm-logos.json
 * with Brandfetch - preferring the firm's VECTOR artwork when Brandfetch has
 * it, and never keeping a Brandfetch answer the firm's own original beats.
 *
 * Modes:
 *
 * (default)  Three passes:
 *   1. ROT + UPGRADE - every stored URL is re-checked; dead ones get a
 *      Brandfetch candidate, and alive entries below KEEP_ABOVE get one too,
 *      switching only when Brandfetch is UPGRADE_MARGIN sharper.
 *   2. FILL - every "none" entry gets a candidate: the harvest found nothing
 *      sharp, or (for "redirects to ...") full coverage was asked for
 *      (2026-10-06) and Brandfetch often still has the original brand.
 *
 * --improve [--baseline <git-ref>]  One walk over the whole manifest:
 *   - brandfetch entries are re-shopped across every variant, and judged
 *     against the firm's ORIGINAL harvested file from the baseline manifest
 *     (default: the last pre-Brandfetch commit). The original wins ties -
 *     a firm's own file over a third party's copy - which restores the
 *     originals the first Brandfetch pass replaced without being better.
 *   - stored harvested entries below vector quality get one cheap try at
 *     Brandfetch's vector icon (icon.svg), which beats any raster.
 *   - "none" entries get the full candidate chain again (the vector variants
 *      are new since the first fill).
 *
 * --recheck  Re-vets every recorded brandfetch entry against the current bar
 *   and restores the committed entry for any that fail - for when a filter
 *   (like PHOTO_COLORS) is added after a run.
 *
 * Candidates must pass the harvester's own bar: measure() decodes them, and
 * they are rejected for white-only artwork, extreme aspect, photographs
 * (PHOTO_COLORS), or tileScore below MIN_SCORE. Accepted entries store a
 * sentinel ("brandfetch", "brandfetch:icon-svg", "brandfetch:symbol",
 * "brandfetch:logo", "brandfetch:logo-svg") rather than a URL, so the client
 * id stays in the environment and /api/crest builds the real address.
 *
 * Usage:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/refresh-firm-logos.ts [mode] [--apply] [--sample N]
 *
 * Without --apply nothing is written. After an --apply run, bump
 * CREST_VERSION in src/lib/crest-version.ts (browser caches are 30-day
 * immutable) and commit both.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { measure, tileScore } from "./find-firm-logos";

const MANIFEST = path.join(process.cwd(), "src", "lib", "firm-logos.json");
/** The last commit before Brandfetch entries existed: the all-harvested manifest. */
const PRE_BRANDFETCH_REF = "3164b96";

type Entry = { u: string; px: number; from: string } | { none: string };

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const WIKI_UA = "OfferlyCrest/1.0 (school crests for student profiles)";

const CONCURRENCY = 16;
const TIMEOUT_MS = 15_000;
/** Below this effective tile score the letter tile is cleaner (harvester's MIN_EFFECTIVE). */
const MIN_SCORE = 32;
/**
 * A stored raster at or above this is kept without asking Brandfetch for
 * rasters; only the vector icon could still beat it.
 */
const KEEP_ABOVE = 205;
/** An upgrade must beat the stored score by this factor, not move sideways. */
const UPGRADE_MARGIN = 1.25;
/**
 * More distinct colours than this (in measure()'s 12-bit sample) and the
 * artwork is a photograph, not a logo - a founder's headshot or an office
 * doorway used as a site icon. Calibrated 2026-10-06: photos measured 119-123,
 * the most colourful real logo (a gradient ring) 68.
 */
const PHOTO_COLORS = 90;

// ----------------------------------------------------------------- fetching

/** Same acceptance rule as /api/crest's fetchImage: an image by label or by ico magic bytes. */
async function fetchesAsImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": url.includes("wikimedia.org") ? WIKI_UA : BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 50) return false; // a 1px tracking gif is not a logo
    const isIco = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
    return type.startsWith("image/") || isIco;
  } catch {
    return false;
  }
}

/** How well the firm's own stored artwork scores today (0 when dead or unmeasurable). */
async function scoreStored(entry: { u: string; px: number; from: string }, domain: string): Promise<number> {
  try {
    if (entry.u.startsWith("data:image/")) {
      const m = /^data:(image\/[a-z0-9.+-]+)(;[a-z0-9=-]+)*?(;base64)?,([\s\S]*)$/i.exec(entry.u);
      if (!m) return 0;
      const bytes = m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
      const measured = await measure(bytes, m[1].toLowerCase(), `data:${domain}`, "link");
      return measured ? tileScore(measured) : 0;
    }
    if (!entry.u.startsWith("https://")) return 0;
    const res = await fetch(entry.u, {
      headers: { "user-agent": entry.u.includes("wikimedia.org") ? WIKI_UA : BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return 0;
    const bytes = Buffer.from(await res.arrayBuffer());
    const measured = await measure(bytes, res.headers.get("content-type") ?? "", entry.u, "link");
    return measured ? tileScore(measured) : 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------- brandfetch

/** Variant -> { the asset path, the sentinel /api/crest resolves back }. */
const VARIANTS = {
  iconSvg: { asset: "icon.svg", sentinel: "brandfetch:icon-svg" },
  symbol: { asset: "symbol.svg", sentinel: "brandfetch:symbol" },
  icon: { asset: "icon.png", sentinel: "brandfetch" },
  logoSvg: { asset: "logo.svg", sentinel: "brandfetch:logo-svg" },
  logo: { asset: "logo.png", sentinel: "brandfetch:logo" },
} as const;
type Variant = keyof typeof VARIANTS;

function brandfetchUrl(domain: string, clientId: string, variant: Variant): string {
  const { asset } = VARIANTS[variant];
  // fallback/404: a miss must stay a miss or the letter tile never shows.
  // SVG assets are vector-or-nothing; rasters are asked for at 512.
  const size = asset.endsWith(".svg") ? "" : "w/512/h/512/";
  return `https://cdn.brandfetch.io/${encodeURIComponent(domain)}/${size}fallback/404/${asset}?c=${encodeURIComponent(clientId)}`;
}

const sentinelVariant = (u: string): Variant =>
  (Object.entries(VARIANTS).find(([, v]) => v.sentinel === u)?.[0] as Variant) ?? "icon";

/**
 * Brandfetch allows 1,000 requests per 5 minutes per IP; a burst past that
 * turns the whole run into 429s. ~3/s stays safely under.
 */
let lastBrandfetch = 0;
let brandfetchQueue: Promise<void> = Promise.resolve();
function brandfetchSlot(): Promise<void> {
  const mine = brandfetchQueue.then(async () => {
    const wait = lastBrandfetch + 334 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBrandfetch = Date.now();
  });
  brandfetchQueue = mine;
  return mine;
}

/**
 * One Brandfetch asset through the full bar, or null. The one 429 retry
 * covers a burst colliding with the rate window.
 */
async function brandfetchOne(domain: string, clientId: string, variant: Variant): Promise<{ px: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await brandfetchSlot();
    try {
      const res = await fetch(brandfetchUrl(domain, clientId, variant), {
        headers: { "user-agent": BROWSER_UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const m = await measure(bytes, type, `brandfetch:${VARIANTS[variant].asset}:${domain}`, "link");
      if (!m || m.whiteOnly || (m.colors ?? 0) > PHOTO_COLORS) return null;
      const score = tileScore(m);
      if (score < MIN_SCORE) return null;
      return { px: Math.round(score) };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The best Brandfetch asset for a firm: the vector icon if it exists (an SVG
 * beats any raster), else the raster icon, else - when the icon is soft or
 * missing - the vector wordmark. tileScore's aspect penalty keeps a wide
 * wordmark from beating a decent square.
 */
async function brandfetchBest(
  domain: string,
  clientId: string,
): Promise<{ px: number; sentinel: string } | null> {
  const vector = await brandfetchOne(domain, clientId, "iconSvg");
  if (vector) return { ...vector, sentinel: VARIANTS.iconSvg.sentinel };
  const icon = await brandfetchOne(domain, clientId, "icon");
  if (icon && icon.px >= 256) return { ...icon, sentinel: VARIANTS.icon.sentinel };
  const word = await brandfetchOne(domain, clientId, "logoSvg");
  const candidates: { px: number; sentinel: string }[] = [];
  if (icon) candidates.push({ ...icon, sentinel: VARIANTS.icon.sentinel });
  if (word) candidates.push({ ...word, sentinel: VARIANTS.logoSvg.sentinel });
  return candidates.sort((a, b) => b.px - a.px)[0] ?? null;
}

// ------------------------------------------------------------------- shared

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

function writeManifest(manifest: Record<string, Entry>) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    MANIFEST,
    "{\n" + Object.entries(sorted).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n",
  );
}

function gitManifest(ref: string): Record<string, Entry> {
  return JSON.parse(
    execSync(`git show ${ref}:src/lib/firm-logos.json`, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 }).toString(),
  ) as Record<string, Entry>;
}

const summarize = (label: string, list: string[]) =>
  list.length && console.log(`${label} (${list.length}): ${list.slice(0, 40).join(", ")}${list.length > 40 ? ", ..." : ""}`);

// -------------------------------------------------------------------- modes

async function improve(manifest: Record<string, Entry>, clientId: string, baselineRef: string, sample: number, apply: boolean) {
  const baseline = gitManifest(baselineRef);
  const entries = Object.entries(manifest);
  const vectored: string[] = [];
  const restored: string[] = [];
  const filled: string[] = [];
  let kept = 0;
  let done = 0;
  let used = 0;

  await pool(entries, async ([domain, entry]) => {
    done++;
    if (done % 1000 === 0) console.log(`  ${done}/${entries.length}... (vector ${vectored.length}, restored ${restored.length}, filled ${filled.length})`);
    if (used >= sample) return;

    if ("u" in entry && entry.u.startsWith("brandfetch")) {
      // Re-shop the variants, then let the firm's own original compete.
      used++;
      const best = await brandfetchBest(domain, clientId);
      const original = baseline[domain];
      const originalScore =
        original && "u" in original ? await scoreStored(original, domain) : 0;
      // The original wins ties: a firm's own file over a third party's copy.
      if (original && "u" in original && originalScore >= (best?.px ?? 0) && originalScore >= MIN_SCORE) {
        manifest[domain] = original;
        restored.push(domain);
      } else if (best && best.sentinel !== entry.u) {
        manifest[domain] = { u: best.sentinel, px: best.px, from: "brandfetch" };
        if (best.sentinel.endsWith("svg")) vectored.push(domain);
      } else {
        kept++;
      }
      return;
    }

    if ("u" in entry) {
      // A harvested original below vector quality: one cheap vector try.
      if (entry.px >= 500) return;
      used++;
      const vector = await brandfetchOne(domain, clientId, "iconSvg");
      if (vector && vector.px > entry.px * UPGRADE_MARGIN) {
        manifest[domain] = { u: VARIANTS.iconSvg.sentinel, px: vector.px, from: "brandfetch" };
        vectored.push(domain);
      }
      return;
    }

    // Still none: the vector variants are new since the first fill.
    used++;
    const best = await brandfetchBest(domain, clientId);
    if (best) {
      manifest[domain] = { u: best.sentinel, px: best.px, from: "brandfetch" };
      filled.push(domain);
    }
  });

  console.log(`\nImprove done. Vector upgrades: ${vectored.length}. Originals restored: ${restored.length}. Newly filled: ${filled.length}. Brandfetch kept as-is: ${kept}.`);
  summarize("Vectored", vectored);
  summarize("Restored", restored);
  summarize("Filled", filled);
  if (!apply) return console.log("\nDry run - nothing written. Re-run with --apply to update the manifest.");
  writeManifest(manifest);
  console.log(`\nWrote ${MANIFEST}. Now bump CREST_VERSION in src/lib/crest-version.ts and commit both.`);
}

async function recheck(manifest: Record<string, Entry>, clientId: string, sample: number, apply: boolean) {
  const committed = gitManifest("HEAD");
  const ours = Object.entries(manifest).filter(
    (pair): pair is [string, { u: string; px: number; from: string }] => "u" in pair[1] && pair[1].u.startsWith("brandfetch"),
  );
  console.log(`Recheck: re-vetting ${ours.length} brandfetch entries.`);
  const reverted: string[] = [];
  let done = 0;
  await pool(ours, async ([domain, entry]) => {
    if (done >= sample) return;
    done++;
    if (!(await brandfetchOne(domain, clientId, sentinelVariant(entry.u)))) {
      manifest[domain] = committed[domain] ?? { none: "no icon" };
      reverted.push(domain);
    }
    if (done % 500 === 0) console.log(`  recheck: ${done}/${ours.length}...`);
  });
  console.log(`Recheck done. Reverted ${reverted.length}.`);
  summarize("Reverted", reverted);
  if (!apply) return console.log("\nDry run - nothing written. Re-run with --apply to update the manifest.");
  writeManifest(manifest);
  console.log(`Wrote ${MANIFEST}.`);
}

async function repairAndFill(manifest: Record<string, Entry>, clientId: string, sample: number, apply: boolean, fillOnly: boolean) {
  let used = 0;

  // ----- pass 1: rot + upgrade -----
  const stored = fillOnly
    ? []
    : Object.entries(manifest).filter(
        (pair): pair is [string, { u: string; px: number; from: string }] =>
          "u" in pair[1] && (pair[1].u.startsWith("https://") || pair[1].u.startsWith("brandfetch")),
      );
  console.log(`${Object.keys(manifest).length} entries. Pass 1 (rot): checking ${stored.length} stored URLs${fillOnly ? " (--fill-only)" : ""}.`);

  const replaced: string[] = [];
  const upgraded: string[] = [];
  const stillDead: string[] = [];
  let checked = 0;
  let alive = 0;

  await pool(stored, async ([domain, entry]) => {
    checked++;
    if (used >= sample) return;
    const isBf = entry.u.startsWith("brandfetch");
    const current = isBf ? brandfetchUrl(domain, clientId, sentinelVariant(entry.u)) : entry.u;
    if (await fetchesAsImage(current)) {
      alive++;
      if (!isBf && entry.px < KEEP_ABOVE) {
        used++;
        const got = await brandfetchBest(domain, clientId);
        if (got && got.px > entry.px * UPGRADE_MARGIN) {
          manifest[domain] = { u: got.sentinel, px: got.px, from: "brandfetch" };
          upgraded.push(domain);
        }
      }
    } else if (!isBf) {
      used++;
      const got = await brandfetchBest(domain, clientId);
      if (got) {
        manifest[domain] = { u: got.sentinel, px: got.px, from: "brandfetch" };
        replaced.push(domain);
      } else {
        // Left in place: at request time /api/crest tries the dead URL, then
        // Brandfetch (who may learn the firm later), then Google, then the tile.
        stillDead.push(domain);
      }
    } else {
      stillDead.push(domain);
    }
    if (checked % 500 === 0) console.log(`  rot: ${checked}/${stored.length} checked...`);
  });
  console.log(
    `Pass 1 done. Alive: ${alive} (${upgraded.length} upgraded). Dead, Brandfetch replacement: ${replaced.length}. Dead, none: ${stillDead.length}.`,
  );

  // ----- pass 2: fill every none entry -----
  const fillable = Object.entries(manifest).filter((pair): pair is [string, { none: string }] => "none" in pair[1]);
  console.log(`Pass 2 (fill): trying Brandfetch for ${fillable.length} "none" entries.`);

  const filled: string[] = [];
  let tried = 0;
  await pool(fillable, async ([domain]) => {
    if (used >= sample) return;
    used++;
    tried++;
    const got = await brandfetchBest(domain, clientId);
    if (got) {
      manifest[domain] = { u: got.sentinel, px: got.px, from: "brandfetch" };
      filled.push(domain);
    }
    if (tried % 500 === 0) console.log(`  fill: ${tried}/${fillable.length} tried...`);
  });
  console.log(`Pass 2 done. Filled: ${filled.length} of ${tried} tried.`);

  summarize("Upgraded", upgraded);
  summarize("Rot repaired", replaced);
  summarize("Filled", filled);
  summarize("Still dead", stillDead);

  if (!apply) return console.log("\nDry run - nothing written. Re-run with --apply to update the manifest.");
  writeManifest(manifest);
  console.log(`\nWrote ${MANIFEST}. Now bump CREST_VERSION in src/lib/crest-version.ts and commit both.`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const sampleAt = args.indexOf("--sample");
  const sample = sampleAt >= 0 ? Number(args[sampleAt + 1]) || 25 : Infinity;
  const clientId = process.env.BRANDFETCH_CLIENT_ID;
  if (!clientId) {
    console.error("BRANDFETCH_CLIENT_ID is not set. Free client id: https://brandfetch.com/developers");
    console.error("Run with: npx tsx --env-file=.env.local --conditions=react-server scripts/refresh-firm-logos.ts");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, Entry>;

  if (args.includes("--improve")) {
    const refAt = args.indexOf("--baseline");
    return improve(manifest, clientId, refAt >= 0 ? args[refAt + 1] : PRE_BRANDFETCH_REF, sample, apply);
  }
  if (args.includes("--recheck")) return recheck(manifest, clientId, sample, apply);
  return repairAndFill(manifest, clientId, sample, apply, args.includes("--fill-only"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
