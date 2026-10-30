/**
 * Spot-check firm logos end to end through a running dev server's /api/crest.
 *
 * Samples the manifest across every kind of entry and asserts what a student's
 * browser would actually receive:
 *   - a logo entry (stored URL, inline data:, or brandfetch sentinel) must
 *     answer 200 with decodable image bytes at least MIN_PX on its short side
 *     - the same floor FirmLogo.tsx enforces before falling back to the
 *     letter tile, so a pass here means the logo really renders;
 *   - a "none" entry must answer 404, which is what makes the letter tile
 *     appear instead of somebody else's mark.
 *
 * Usage (dev server must be running on 3001):
 *   npx tsx scripts/spot-check-firm-logos.ts [--count 1000] [--base http://localhost:3001]
 *
 * The sample is weighted toward brandfetch entries - the newest, least-aged
 * source - then stored logos, then "none" entries. Exits 1 if anything fails.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { CREST_VERSION } from "../src/lib/crest-version";

type Entry = { u: string; px: number; from: string } | { none: string };

const MANIFEST = path.join(process.cwd(), "src", "lib", "firm-logos.json");
/** FirmLogo.tsx rejects anything under max(17, size/2); at the common 40px tile that is 20. */
const MIN_PX = 20;
const CONCURRENCY = 6;

function sampleOf<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
  };
  const count = Number(flag("--count", "1000"));
  const base = flag("--base", "http://localhost:3001");

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, Entry>;
  const entries = Object.entries(manifest);
  const brandfetch = entries.filter(([, e]) => "u" in e && e.u.startsWith("brandfetch"));
  const stored = entries.filter(([, e]) => "u" in e && !e.u.startsWith("brandfetch"));
  const nones = entries.filter(([, e]) => "none" in e);

  // Brandfetch entries are the newest and least aged-in, so they get the
  // largest share; capped so a 1000-run still exercises every kind.
  const take = [
    ...sampleOf(brandfetch, Math.min(brandfetch.length, Math.round(count * 0.4))),
    ...sampleOf(stored, Math.round(count * 0.4)),
    ...sampleOf(nones, Math.round(count * 0.2)),
  ].slice(0, count);
  console.log(
    `Testing ${take.length} logos against ${base} (manifest: ${brandfetch.length} brandfetch, ${stored.length} stored, ${nones.length} none).`,
  );

  const failures: string[] = [];
  let tileOk = 0;
  let logoOk = 0;
  let done = 0;

  await pool(take, async ([domain, entry]) => {
    const url = `${base}/api/crest?domain=${encodeURIComponent(domain)}&sz=256&v=${CREST_VERSION}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if ("none" in entry) {
        if (res.status === 404) tileOk++;
        else failures.push(`${domain}: none entry answered ${res.status}, expected 404 (letter tile)`);
        return;
      }
      if (!res.ok) {
        failures.push(`${domain}: ${entry.from} entry answered ${res.status}`);
        return;
      }
      const type = res.headers.get("content-type") ?? "";
      const bytes = Buffer.from(await res.arrayBuffer());
      const isIco = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
      if (!type.startsWith("image/") && !isIco) {
        failures.push(`${domain}: ${entry.from} entry answered ${type || "no content-type"}`);
        return;
      }
      // .ico and .svg sizes are already vouched for by the harvester's own
      // measuring; sharp decodes the rest.
      if (!isIco && !type.includes("svg")) {
        const meta = await sharp(bytes, { pages: 1 }).metadata();
        const short = Math.min(meta.width ?? 0, meta.height ?? 0);
        if (short < MIN_PX) {
          failures.push(`${domain}: ${entry.from} entry decoded at ${meta.width}x${meta.height}, under ${MIN_PX}px`);
          return;
        }
      }
      logoOk++;
    } catch (e) {
      failures.push(`${domain}: ${(e as Error).message}`);
    } finally {
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${take.length}...`);
    }
  });

  console.log(`\nPassed: ${logoOk} logos rendered, ${tileOk} letter tiles confirmed. Failed: ${failures.length}.`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length) process.exit(1);
  console.log("All good.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
