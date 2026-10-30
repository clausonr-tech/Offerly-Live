/**
 * THE OPTIONAL FULL-DATASET AUDIT.
 *
 *     npm run test:form-adv-full
 *
 * Not part of the standard suite, and deliberately not matched by its glob
 * (scripts/test/*.test.ts stops at the directory boundary). Everything here
 * asserts a property of the real 2.9MB SEC extract - how many firms carry a
 * website, how many domains collide, whether the directory's 22,000 rows
 * actually join - and none of it can be answered by a fixture.
 *
 * The parser, the normaliser, the blocklist and the index are NOT tested
 * here. They are tested in scripts/test/form-adv.test.ts against committed
 * fixtures, and they always run.
 *
 * If the extract is absent this file FAILS with instructions rather than
 * skipping: you asked for the full audit by name, so "it isn't here" is the
 * answer, not silence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  domainOf,
  indexByDomain,
  isNotAFirmSite,
  sizeIn,
  type AdvFile,
} from "../../../src/lib/monitoring/form-adv-parse";
import { shapeProblem } from "../helpers/form-adv-fixture";

const DATA_PATH = "scripts/data/form-adv-firms.json";

function loadExtract(): AdvFile {
  let raw: string;
  try {
    raw = readFileSync(DATA_PATH, "utf8");
  } catch {
    throw new Error(
      `The optional full-dataset audit needs ${DATA_PATH}, which is gitignored and ` +
        "rebuilt from the SEC feed. It is NOT part of a clean checkout.\n\n" +
        "  npx tsx --conditions=react-server scripts/ingest-form-adv.ts\n\n" +
        "The standard suite (`npm test`) does not need this file and covers the parser, " +
        "the normaliser and the index from committed fixtures.",
    );
  }
  const parsed = JSON.parse(raw) as AdvFile;
  if (!Array.isArray(parsed.firms)) throw new Error(`${DATA_PATH} has no firms array`);
  return parsed;
}

const extract = loadExtract();
const { index, collisions } = indexByDomain(extract.firms);

test("the extract loaded and is the size the product assumes", () => {
  // A silent zero is the failure this codebase keeps paying for: every firm
  // reads as unknown size and enrollment rejects them all for one wrong
  // reason.
  assert.ok(extract.firms.length > 10_000, `only ${extract.firms.length} firms in the file`);
  assert.ok(index.size > 1_000, `only ${index.size} domains indexed`);
});

test("the population of the firm directory still joins to it", () => {
  // The number that decides whether any of this was worth doing. Measured at
  // 45% when the extract was built; the floor is set well under that so
  // ordinary feed movement does not fail the suite, but a COLLAPSE does.
  const directory = JSON.parse(readFileSync("src/lib/firm-seeds-bulk.json", "utf8")) as {
    name: string;
    website: string | null;
  }[];
  assert.ok(directory.length > 20_000, `directory has only ${directory.length} rows`);

  let matched = 0;
  for (const row of directory) if (sizeIn(index, row.website)) matched += 1;
  const rate = (matched / directory.length) * 100;
  console.log(`  [full audit] ${matched}/${directory.length} directory rows sized (${rate.toFixed(1)}%)`);
  assert.ok(rate > 30, `the join collapsed to ${rate.toFixed(1)}%`);
});

test("every record in the extract has the shape the type promises", () => {
  const bad: string[] = [];
  for (const firm of extract.firms) {
    const problem = shapeProblem(firm);
    if (problem) bad.push(`${firm.name}: ${problem}`);
  }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} malformed records`);
});

test("no platform host became a firm key across the whole extract", () => {
  // The fixture proves the rule; this proves the rule was applied 23,000
  // times. One linkedin.com key silently sizes every firm pointing there as
  // whichever filer was parsed first.
  const leaked = [...index.keys()].filter((d) => isNotAFirmSite(d));
  assert.deepEqual(leaked, [], `platform hosts in the index: ${leaked.join(", ")}`);
});

test("domain collisions are counted, not hidden", () => {
  // Real and expected - key.com alone covers three filers. This exists so the
  // number is visible and a sudden jump is noticeable, not to drive it to 0.
  const worst = [...collisions.reduce((m, c) => m.set(c.domain, (m.get(c.domain) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`  [full audit] ${collisions.length} shared-domain records; worst: ${worst.map(([d, n]) => `${d} x${n + 1}`).join(", ")}`);
  assert.ok(collisions.length < extract.firms.length * 0.2, "a fifth of the feed collided - the parser is picking a shared host");
});

test("every stored domain is already normalised", () => {
  // The output of domainOf must be a valid input to domainOf, or re-reading
  // stored data drifts away from the data it was built from.
  const drifted: string[] = [];
  for (const firm of extract.firms) {
    if (!firm.domain) continue;
    if (domainOf(firm.domain) !== firm.domain) drifted.push(firm.domain);
  }
  assert.deepEqual(drifted.slice(0, 20), [], `${drifted.length} domains are not in normal form`);
});

test("the join holds however a URL is written, across a large sample", () => {
  const sample = [...index.keys()].slice(0, 500);
  for (const domain of sample) {
    const bare = sizeIn(index, domain);
    assert.ok(bare, domain);
    for (const variant of [`https://${domain}`, `https://www.${domain}`, `http://${domain}/careers`]) {
      assert.deepEqual(sizeIn(index, variant), bare, `${variant} lost the match`);
    }
  }
});

test("zero AUM exists in the real feed and survives as zero", () => {
  const zero = extract.firms.find((f) => f.domain && f.aum === 0);
  if (!zero) {
    console.log("  [full audit] no zero-AUM firm with a domain in this build of the feed");
    return;
  }
  const got = sizeIn(index, zero.domain);
  assert.ok(got);
  assert.equal(got.aum, 0, "zero AUM must not be read as unknown");
});
