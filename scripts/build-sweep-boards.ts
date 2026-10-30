// Build the board list the Archive sweep reads, across every industry.
//
//   npx tsx --conditions=react-server scripts/build-sweep-boards.ts
//
// No database. Reads two kinds of file already on disk and merges them:
//
//   scripts/data/monitored-boards.json  - sources the crawler already has
//   scripts/data/probed-*.json          - boards a probe sweep FOUND but that
//                                         were never written to the database
//
// WHY THE SECOND HALF MATTERS
// ---------------------------
// Every one of the 106 monitored sources is an investment bank. Private
// equity, hedge funds, venture capital and real estate appear only as a bank's
// secondary desk, so an Archive sweep over the monitored list alone spends
// hours confirming that investment banks are investment banks.
//
// The 19 September probe sweeps found 82 boards in those industries and staged
// them as JSON. They were never applied to the database, and then the database
// was lost - but the JSON survived, which is the whole reason probe results
// are written to files before they are written to rows.
//
// So the Archive can be asked about them now, without waiting for a restore.
// These carry tier `discovery`, which is what enrollment.ts assigns a firm
// whose board has been found - not a claim that anything is crawling them yet.
import { readFileSync, writeFileSync, readdirSync } from "fs";

const OUT = "scripts/data/sweep-boards.json";
const MONITORED = "scripts/data/monitored-boards.json";
const DATA_DIR = "scripts/data";

type Board = {
  slug: string;
  name: string;
  tier: string;
  careersUrl: string;
  connectorId: string;
  sectorCategory: string | null;
  /** Where this row came from, so a surprising entry can be traced. */
  origin: string;
};

type ProbeHit = {
  slug: string;
  name: string;
  category: string;
  connectorId: string | null;
  boardUrl: string;
};

function load<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const boards: Board[] = [];
/**
 * Deduplicated on the BOARD URL, not the firm.
 *
 * One firm can legitimately appear twice - a bank monitored at its careers
 * page and probed onto a Greenhouse board are two different things to ask the
 * Archive about. Two rows pointing at the same URL are not.
 */
const seenUrl = new Set<string>();

function add(board: Board) {
  const key = board.careersUrl.replace(/\/+$/, "").toLowerCase();
  if (!key || seenUrl.has(key)) return;
  seenUrl.add(key);
  boards.push(board);
}

const monitored = load<{ boards: Omit<Board, "origin">[] }>(MONITORED);
for (const b of monitored?.boards ?? []) {
  add({ ...b, origin: "monitored" });
}
const monitoredCount = boards.length;

let probeFiles = 0;
for (const file of readdirSync(DATA_DIR).sort()) {
  if (!file.startsWith("probed-") || !file.endsWith(".json")) continue;
  const report = load<{ hits?: ProbeHit[] }>(`${DATA_DIR}/${file}`);
  const hits = report?.hits ?? [];
  if (!hits.length) continue;
  probeFiles += 1;

  for (const hit of hits) {
    if (!hit.boardUrl || !hit.slug) continue;
    add({
      slug: hit.slug,
      name: hit.name ?? hit.slug,
      // What enrollment.ts assigns a firm whose board has been found. Not a
      // claim that anything is crawling it.
      tier: "discovery",
      careersUrl: hit.boardUrl,
      connectorId: hit.connectorId ?? "generic",
      sectorCategory: hit.category ?? null,
      origin: file,
    });
  }
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note:
        "Monitored sources plus every staged probe hit, so the Archive sweep covers all industries " +
        "rather than only the investment banks the crawler happens to hold today. Rebuild after a " +
        "database restore so this does not describe an older set of sources than the crawler has.",
      count: boards.length,
      boards,
    },
    null,
    1,
  )}\n`,
);

const byIndustry = boards.reduce<Record<string, number>>((acc, b) => {
  const key = b.sectorCategory ?? "(none)";
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

console.log(`${boards.length} boards written to ${OUT}`);
console.log(`  ${monitoredCount} already monitored, ${boards.length - monitoredCount} staged from ${probeFiles} probe reports\n`);
console.log("By industry:");
for (const [industry, n] of Object.entries(byIndustry).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${industry.padEnd(26)} ${String(n).padStart(4)}`);
}
