// Measure what the title rule costs in recall.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/recall-sample.ts --draw
//   ...                                                                        --score FILE
//
// THE RULE AND WHY IT NEEDS MEASURING. `TITLE_INTERNSHIP_PATTERN` rejects a
// listing whose title names no internship. It is the single largest reason for
// rejection in this system and nobody has ever put a number on what it costs.
// Every argument about widening or narrowing it has therefore been
// unfalsifiable.
//
// THE DENOMINATOR, which has been wrong four times. The roadmap said 8,441.
// Stored verdicts say 9,840. Re-running only the listings whose STORED reason
// was this rule gives 7,159. Measured properly - every listing in the corpus,
// re-classified through the current classifier - it is about 10,000, because
// listings that used to be rejected for another reason now fall through to this
// one and belong in the stratum too. This script computes it rather than
// quoting it.
//
// WHY STRATIFIED AND NOT A BLIND DRAW. A 1,200-example uniform sample spends
// about three quarters of its labels in the remainder, where misses are
// rarest, and still cannot say much about the strata where recall is actually
// lost. The strata below are assigned BY PRIORITY so that each listing lands in
// exactly one - measured 13 October 2026, they partition the stratum exactly,
// which is what makes the weighted estimate valid rather than double-counted.
//
// THE POPULATION IS WHAT THE AGENT CAN ACTUALLY EXAMINE, which is narrower
// than "everything this rule rejects" and deliberately so. The agent only
// re-reads listings that are still `open`, not already examined, and not on a
// portfolio board. A first version of this script drew from the whole stratum
// and 451 rows produced only 104 the agent would touch - so the labels would
// have described open listings while the weighting claimed to describe all of
// them. A biased estimate is worse than none.
//
// It is also the population worth measuring. A closed listing we wrongly
// rejected is a historical miss with no remedy; an open one is a student's
// missing opportunity today.
//
// WHAT THE AGENT MAY AND MAY NOT SETTLE. The labeller is the review agent,
// which re-reads the real page. Its denials were hand-checked at 40/40 - but
// on its OWN denials, a different population from this one, so that number
// does not transfer and is not used here. A human slice of the agent's labels
// on THIS population is required before any rate is quoted, and --score
// refuses to print one without it.
import { sql } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { classifyListing } from "../src/lib/monitoring/classify";
import type { NormalizedListing } from "../src/lib/monitoring/connectors/types";
import { openScriptDb, rowsOf } from "./_db";

const DRAW = process.argv.includes("--draw");
const FILL_FROM_AGENT = process.argv.includes("--fill-from-agent");
const SCORE_AT = process.argv.indexOf("--score");

/**
 * Strata, in priority order. The FIRST one a listing qualifies for owns it.
 *
 * Ordered most-specific first, so a Dutch title with student language in the
 * body counts once, as a language case. Sizes are computed, never assumed.
 */
const STRATA: { key: string; label: string; test: (title: string, body: string) => boolean }[] = [
  {
    key: "A",
    label: "a non-English internship noun in the title",
    test: (t) =>
      /\b(stagiair|stagiaire|stagista|praktik|werkstudent|becari|tirocin|estagi|est[aá]gio|pasant|alternan)/i.test(t),
  },
  {
    key: "B",
    label: "an undergraduate-year word in the title",
    test: (t) => /\b(underclassm|sophomore|freshman|winternship|fellowship|scholar)/i.test(t),
  },
  {
    key: "C",
    label: "a year and a junior-sounding word in the title",
    test: (t) => /20\d\d/.test(t) && /\b(analyst|associate|graduate|junior|entry|campus|program)/i.test(t),
  },
  {
    key: "D",
    label: "student language in the body, nothing in the title",
    test: (_t, b) =>
      /\b(undergraduat|penultimate|currently (enrolled|studying)|bachelor|university student|rising (junior|senior))/i.test(b),
  },
  {
    key: "E",
    label: "the body names an internship",
    test: (_t, b) => /\b(internship|intern program|placement year|year in industry)/i.test(b),
  },
  { key: "F", label: "the remainder", test: () => true },
];

/** How many to label per stratum. A small stratum is a census - no sampling
 *  error at all - and the big ones get enough to bound their rate. */
const QUOTA: Record<string, number> = { A: 9999, B: 9999, C: 9999, D: 150, E: 9999, F: 120 };

type Row = {
  id: string;
  firm: string;
  title: string;
  body: string;
  ext: string | null;
  div: string | null;
  loc: string | null;
  emp: string | null;
  app: string | null;
  url: string;
  pub: string | null;
  dead: string | null;
  sector: string;
  status: string;
  reviewStatus: string;
  examined: string | null;
  connectorId: string;
};

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

async function rejectedByTheTitleRule(db: Awaited<ReturnType<typeof openScriptDb>>["db"]) {
  const all = rowsOf<Row>(
    await db.execute(sql`
      SELECT l.id::text AS id, f.name AS firm, l.title, l.description_raw AS body,
             l.external_job_id AS ext, l.division AS div, l.location AS loc,
             l.employment_type AS emp, l.application_url AS app,
             COALESCE(l.listing_url,'') AS url, l.published_at::text AS pub,
             l.deadline_at::text AS dead,
             COALESCE(s.sector_category::text,'other_finance') AS sector,
             l.status::text AS status, l.review_status::text AS "reviewStatus",
             l.classification->'reviewAgent'->>'verdict' AS examined,
             s.connector_id::text AS "connectorId"
      FROM detected_listings l
      JOIN firm_monitoring_sources s ON s.id = l.source_id
      JOIN firms f ON f.id = s.firm_id
    `),
  );
  const out: Row[] = [];
  for (const r of all) {
    // Exactly the agent's own gates, so every drawn row is labellable. See the
    // note on the population at the top of this file.
    if (r.status !== "open") continue;
    if (!/^https?:\/\//.test(r.url)) continue;
    if (r.reviewStatus !== "rejected") continue;
    if (r.examined !== null) continue;
    if (r.connectorId === "getro") continue;
    // The COMPLETE listing. An earlier measurement in this work omitted
    // externalJobId behind an `as never` cast, and posting-quality's "no
    // description and no id" then fired on 4,381 real postings.
    const listing: NormalizedListing = {
      externalJobId: r.ext,
      title: r.title,
      division: r.div,
      location: r.loc,
      descriptionRaw: r.body,
      employmentType: r.emp,
      applicationUrl: r.app,
      listingUrl: r.url,
      publishedAt: r.pub,
      deadlineAt: r.dead,
    };
    const c = classifyListing(listing, r.sector as never);
    if (c.relevant) continue;
    if (!(c.matchedEvidence[0] ?? "").includes("matched no internship phrase")) continue;
    out.push(r);
  }
  return out;
}

async function draw() {
  const today = new Date().toISOString().slice(0, 10);
  const { db, close: closeDb } = await openScriptDb();
  try {
    const population = await rejectedByTheTitleRule(db);
    const byStratum = new Map<string, Row[]>();
    for (const r of population) {
      const s = STRATA.find((x) => x.test(r.title, r.body))!;
      const got = byStratum.get(s.key);
      if (got) got.push(r);
      else byStratum.set(s.key, [r]);
    }

    console.log(
      `the title rule currently rejects ${population.length} OPEN, unexamined listings\n` +
        `(the population the agent can label; see the note in this file)\n`,
    );
    console.log(`stratum  size   drawn  examinable`);
    const drawn: (Row & { stratum: string })[] = [];
    const sizes: Record<string, number> = {};
    for (const s of STRATA) {
      const rows = (byStratum.get(s.key) ?? []).filter((r) => /^https?:\/\//.test(r.url));
      sizes[s.key] = (byStratum.get(s.key) ?? []).length;
      shuffle(rows);
      const take = rows.slice(0, QUOTA[s.key] ?? 0);
      for (const r of take) drawn.push({ ...r, stratum: s.key });
      console.log(
        `   ${s.key}    ${String(sizes[s.key]).padStart(5)}  ${String(take.length).padStart(5)}  ${rows.length}   ${s.label}`,
      );
    }

    mkdirSync("scripts/data", { recursive: true });
    const stem = `scripts/data/recall-sample-${today}`;
    writeFileSync(
      `${stem}.json`,
      JSON.stringify({ drawnAt: today, population: population.length, sizes, drawn }, null, 2),
    );
    const tsv = [
      `# RECALL SAMPLE - the title rule, drawn ${today}`,
      `# ${population.length} listings are rejected because their title names no internship.`,
      `# Put ONE of these in YOUR_VERDICT, or a plain reason:`,
      `#   agree  - rightly rejected, this is not an undergraduate finance internship`,
      `#   WRONG  - this IS one and we are missing it`,
      `#   unsure - the page does not say`,
      `# Stratum sizes are in ${stem}.json and the estimate is weighted by them,`,
      `# so a small stratum here still stands for its real share.`,
      ["YOUR_VERDICT", "stratum", "firm", "title", "url", "id"].join("\t"),
      ...drawn.map((d) => ["", d.stratum, d.firm, d.title, d.url, d.id].join("\t")),
    ].join("\n");
    writeFileSync(`${stem}.tsv`, tsv);
    console.log(`\n${drawn.length} drawn -> ${stem}.tsv  (sizes in ${stem}.json)`);
    console.log(
      `\nThe agent labels these with:\n` +
        `  npm run review:agent -- --ids-from ${stem}.json --record-only\n` +
        `Then a human slice of the agent's labels is required before a rate is quoted.`,
    );
  } finally {
    await closeDb();
  }
}

/** Wilson, so a stratum with nothing wrong does not claim certainty. */
function wilson(wrong: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.96;
  const p = wrong / n;
  const z2n = (z * z) / n;
  const centre = (p + z2n / 2) / (1 + z2n);
  const half = (z / (1 + z2n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

function score(file: string) {
  const sizes = JSON.parse(readFileSync(file.replace(/\.tsv$/, ".json"), "utf8")).sizes as Record<
    string,
    number
  >;
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("YOUR_VERDICT"));
  const per = new Map<string, { n: number; wrong: number; unsure: number }>();
  for (const line of lines) {
    const [verdict, stratum] = line.split("\t");
    const v = (verdict ?? "").trim();
    if (!v) continue;
    const g = per.get(stratum) ?? { n: 0, wrong: 0, unsure: 0 };
    if (/^unsure$/i.test(v)) g.unsure += 1;
    else {
      g.n += 1;
      if (/^wrong$/i.test(v)) g.wrong += 1;
    }
    per.set(stratum, g);
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  console.log(`population ${total}\n`);
  console.log(`stratum  size   labelled  wrong   rate    weighted contribution`);
  let missed = 0;
  let anyLabelled = false;
  for (const s of STRATA) {
    const g = per.get(s.key);
    const size = sizes[s.key] ?? 0;
    if (!g || g.n === 0) {
      console.log(`   ${s.key}    ${String(size).padStart(5)}      -       -      -      (not labelled)`);
      continue;
    }
    anyLabelled = true;
    const rate = g.wrong / g.n;
    missed += size * rate;
    console.log(
      `   ${s.key}    ${String(size).padStart(5)}   ${String(g.n).padStart(7)}   ${String(g.wrong).padStart(4)}   ${(rate * 100).toFixed(1).padStart(5)}%   ${(size * rate).toFixed(0).padStart(6)} listings`,
    );
  }
  if (!anyLabelled) {
    console.log("\nNothing labelled yet.");
    return;
  }
  const unlabelled = STRATA.filter((s) => !per.get(s.key)?.n).map((s) => s.key);
  console.log(`\nESTIMATED REAL INTERNSHIPS BEING MISSED: ${missed.toFixed(0)} of ${total}`);
  const biggest = STRATA.map((s) => ({ s, g: per.get(s.key) })).filter((x) => x.g?.n);
  for (const { s, g } of biggest) {
    const { lo, hi } = wilson(g!.wrong, g!.n);
    console.log(
      `  stratum ${s.key}: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}% wrong ` +
        `=> ${Math.round((sizes[s.key] ?? 0) * lo)}-${Math.round((sizes[s.key] ?? 0) * hi)} listings`,
    );
  }
  if (unlabelled.length) {
    console.log(
      `\nINCOMPLETE: strata ${unlabelled.join(", ")} have no labels, so the total above\n` +
        `counts them as zero and is a FLOOR, not an estimate.`,
    );
  }
  console.log(
    `\nThis is the AGENT's view unless the labels are a person's. The agent's\n` +
      `40/40 hand-check was on its own denials, a different population, and does\n` +
      `not transfer - a human slice of these labels is what makes the number real.`,
  );
}

/**
 * Write the agent's recorded verdicts into the sample's verdict column.
 *
 * The agent writes its verdict onto the listing's classification, not into
 * this file, so without this step the labels exist and the estimate cannot see
 * them. The mapping is the only honest one available:
 *
 *   denied   -> agree   the rejection was right
 *   released -> WRONG   a real internship the rule is missing
 *   skipped  -> unsure  the agent could not read the page, which is not a
 *                       verdict about the rule and must not count either way
 *
 * The file is written with a marker saying the labels are the agent's, because
 * the rate they produce is the agent's view of the rule and not a measured
 * truth until a person has checked a slice of them.
 */
async function fillFromAgent(file: string) {
  const { db, close: closeDb } = await openScriptDb();
  try {
    const drawn = JSON.parse(readFileSync(file.replace(/\.tsv$/, ".json"), "utf8")) as {
      drawn: { id: string }[];
    };
    const verdicts = new Map(
      rowsOf<{ id: string; v: string | null }>(
        // `id::text = ANY(uuid[])` is a type error in Postgres; compare uuid to
        // uuid and cast the output instead.
        await db.execute(sql`
          SELECT id::text AS id, classification->'reviewAgent'->>'verdict' AS v
          FROM detected_listings
          WHERE id = ANY(${sql.raw(`ARRAY[${drawn.drawn.map((d) => `'${d.id}'`).join(",")}]::uuid[]`)})
        `),
      ).map((r) => [r.id, r.v]),
    );
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let filled = 0;
    const out = lines.map((line) => {
      if (!line.trim() || line.startsWith("#") || line.startsWith("YOUR_VERDICT")) return line;
      const cells = line.split("\t");
      const id = cells[5];
      const v = verdicts.get(id);
      if (!v || cells[0]) return line;
      cells[0] = v === "denied" ? "agree" : v === "released" ? "WRONG" : "unsure";
      filled += 1;
      return cells.join("\t");
    });
    const marked = [
      "# LABELS BELOW ARE THE AGENT'S, not a person's. The rate they produce is",
      "# the agent's view of this rule. A human slice is what makes it measured.",
      ...out,
    ].join("\n");
    writeFileSync(file, marked);
    console.log(`filled ${filled} verdicts from the agent's recorded labels into ${file}`);
  } finally {
    await closeDb();
  }
}

async function main() {
  if (FILL_FROM_AGENT && process.argv[process.argv.indexOf("--fill-from-agent") + 1]) {
    return fillFromAgent(process.argv[process.argv.indexOf("--fill-from-agent") + 1]);
  }
  if (DRAW) return draw();
  if (SCORE_AT >= 0 && process.argv[SCORE_AT + 1]) return score(process.argv[SCORE_AT + 1]);
  console.log("Pass --draw, or --score scripts/data/recall-sample-<date>.tsv");
}

main();
