// Draw a hand-check sample from the review agent's decisions, and score it.
//
// WHY THIS EXISTS. The agent has examined ~240 rejected listings and released
// none of them. That is either correctly strict or uselessly strict, and no
// amount of further engineering can tell the difference - only a person
// reading its verdicts can. Everything else waiting on "the agent's accuracy"
// is waiting on this file.
//
// WHAT IS BEING MEASURED, and it is not what you would guess. With zero
// releases there is no release precision to compute. The quantity that matters
// is the FALSE DENIAL RATE: of the listings the agent denied, how many were
// real undergraduate finance internships? That is the number that says whether
// the rule behind 46% of all rejections is right.
//
// WHY THE SAMPLE IS STRATIFIED. A uniform sample of denials would be almost
// entirely obvious non-internships - "Systems Administrator", "1099 Process
// Server" - and 40 of those teach nothing. If the true false-denial rate is a
// few percent, a uniform 40 finds zero or one case and cannot distinguish 1%
// from 10%. So the sample is drawn per REASON, which is the closest thing to a
// difficulty axis the data has: a denial that got as far as "re-read the page:
// it does not describe an internship" is a judgement call, and one that
// stopped at "no student or internship language" is usually not.
//
// WHAT 40 BUYS, stated honestly: roughly plus or minus 15 points. It
// distinguishes "about right" from "badly wrong". It does not distinguish 2%
// from 6%, and nothing this size will.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/review-agent-sample.ts --draw 40
//     -> writes scripts/data/handcheck-<date>.tsv for a person to fill in
//   ... --score scripts/data/handcheck-<date>.tsv
//     -> reads the filled-in file and reports the rate with an interval
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const DRAW = arg("draw");
const SCORE = arg("score");

/** The column a person fills in. Three legal values, and nothing else. */
const VERDICTS = ["agree", "WRONG", "unsure"] as const;

async function draw(target: number) {
  const { db, close: closeDb } = await openScriptDb();
  try {
    const rows = await db
      .select({
        id: schema.detectedListings.id,
        title: schema.detectedListings.title,
        listingUrl: schema.detectedListings.listingUrl,
        classification: schema.detectedListings.classification,
        firmName: schema.firms.name,
      })
      .from(schema.detectedListings)
      .innerJoin(
        schema.firmMonitoringSources,
        eq(schema.firmMonitoringSources.id, schema.detectedListings.sourceId),
      )
      .innerJoin(schema.firms, eq(schema.firms.id, schema.firmMonitoringSources.firmId))
      .where(
        and(
          isNotNull(sql`${schema.detectedListings.classification}->'reviewAgent'`),
          eq(schema.detectedListings.reviewStatus, "rejected"),
        ),
      );

    type Row = (typeof rows)[number] & { why: string; verdict: string };
    const decided: Row[] = rows
      .map((r) => {
        const ra = ((r.classification ?? {}) as { reviewAgent?: { why?: string; verdict?: string } })
          .reviewAgent;
        return { ...r, why: ra?.why ?? "", verdict: ra?.verdict ?? "" };
      })
      // Only what the agent actually judged. A skip is "could not tell", which
      // is not a verdict to agree or disagree with.
      .filter((r) => r.verdict === "denied" && r.why);

    if (decided.length === 0) {
      console.log(
        "No denials recorded yet. The agent writes nothing in shadow mode -\n" +
          "run it once with --apply, or point this at a run that wrote.",
      );
      return;
    }

    // Stratify by reason, round-robin, so every reason the agent gives is
    // represented before any one of them fills the sample.
    const byReason = new Map<string, Row[]>();
    for (const r of decided) {
      const key = r.why.slice(0, 60);
      (byReason.get(key) ?? byReason.set(key, []).get(key)!).push(r);
    }
    for (const list of byReason.values()) shuffle(list);

    const picked: Row[] = [];
    const buckets = [...byReason.values()];
    for (let round = 0; picked.length < target; round++) {
      let took = 0;
      for (const b of buckets) {
        if (picked.length >= target) break;
        if (b[round]) {
          picked.push(b[round]);
          took++;
        }
      }
      if (took === 0) break; // every bucket exhausted
    }

    const stamp = new Date().toISOString().slice(0, 10);
    let out = path.join(process.cwd(), "scripts/data", `handcheck-${stamp}.tsv`);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    /**
     * NEVER OVERWRITE A FILE SOMEBODY MAY HAVE BEEN FILLING IN.
     *
     * The first version wrote `handcheck-<date>.tsv` unconditionally, and a
     * second draw on the same day silently replaced the first - which is how a
     * 40-row sample became a 5-row one minutes after it was handed over. The
     * file is half an hour of somebody's reading; it is not scratch.
     *
     * A suffix rather than a refusal, because wanting a second sample is
     * reasonable - what is not reasonable is losing the first.
     */
    if (fs.existsSync(out)) {
      let n = 2;
      while (fs.existsSync(path.join(process.cwd(), "scripts/data", `handcheck-${stamp}-${n}.tsv`))) {
        n += 1;
      }
      const next = path.join(process.cwd(), "scripts/data", `handcheck-${stamp}-${n}.tsv`);
      console.log(
        `${path.relative(process.cwd(), out)} already exists and was left alone.\n` +
          `Writing this draw to ${path.relative(process.cwd(), next)} instead.`,
      );
      out = next;
    }

    const header = [
      `# HAND CHECK - ${picked.length} of ${decided.length} recorded denials, drawn ${stamp}`,
      `#`,
      `# The question for each row: was this a real undergraduate finance internship?`,
      `# Open the url, read the posting, and put ONE of these in the YOUR_VERDICT column:`,
      `#`,
      `#   agree   - the agent was right to deny it`,
      `#   WRONG   - this IS a real undergraduate finance internship and should be published`,
      `#   unsure  - you could not tell from the page`,
      `#`,
      `# Leave nothing blank. Then:`,
      `#   npx tsx --env-file=.env.local --conditions=react-server \\`,
      `#     scripts/review-agent-sample.ts --score ${path.relative(process.cwd(), out)}`,
      `#`,
      `# Sampled per reason rather than uniformly: a uniform draw would be almost`,
      `# all obvious non-internships and would teach nothing about the hard cases.`,
      [`YOUR_VERDICT`, `firm`, `title`, `agent_reason`, `url`, `id`].join("\t"),
    ].join("\n");

    const body = picked
      .map((r) =>
        ["", r.firmName, r.title.replace(/\s+/g, " "), r.why, r.listingUrl ?? "", r.id].join("\t"),
      )
      .join("\n");

    fs.writeFileSync(out, `${header}\n${body}\n`);
    console.log(`${picked.length} rows drawn from ${byReason.size} distinct reasons.`);
    for (const [why, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(list.length).padStart(5)} available  ${why}`);
    }
    console.log(`\nWritten to ${out}`);
    console.log("Fill in the YOUR_VERDICT column, then re-run with --score.");
  } finally {
    await closeDb();
  }
}

/**
 * Split one row, whichever way the spreadsheet saved it.
 *
 * The file is written as tab-separated because titles contain commas. But a
 * person opens it in Numbers or Excel, and saving from either exports CSV with
 * quoted fields - so insisting on tabs turns "I filled it in" into "the
 * scorer says every row is blank", which is a bad way to spend somebody's
 * half hour. Tabs if there are tabs; otherwise CSV, respecting quotes.
 */
function cells(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}


/**
 * Reason phrases that mean "agree".
 *
 * The sheet asks for one of three words, and a person filling in forty rows
 * writes the REASON instead - which is more informative, not less. Kai's
 * hand-check of 13 October came back labelled "Full time" and "Page doesn't go
 * to internship site": both are statements that the denial was correct, and
 * discarding them as unparseable would have thrown away the whole exercise.
 *
 * Only phrases whose meaning is unambiguous live here, and every match is
 * PRINTED with how it was read, so a wrong reading is visible in the output
 * rather than buried in a rate. Anything else still counts as unrecognised: a
 * guess about what a label meant is worse than saying it was not understood.
 */
/**
 * A 95% interval for `wrong / judged` that does not lie at the boundary.
 *
 * WILSON, NOT WALD. Wald is `p +/- 1.96 * sqrt(p(1-p)/n)`, and at p = 0 that
 * entire term is zero: it printed "0.0% (95% CI 0.0% - 0.0%)", asserting the
 * rate is CERTAINLY zero on the strength of forty rows - directly above a note
 * saying the rate is not zero, only below about 8%. The headline contradicted
 * its own footnote, and the headline is the part that gets quoted.
 *
 * Wilson does not collapse at 0 or at n. For 0 wrong in 40 it gives 0% to
 * 8.8%, which agrees with the rule of three and is the honest answer: a clean
 * sweep of forty is good evidence of a LOW rate and no evidence of a zero one.
 */
export function wilsonInterval(
  wrong: number,
  judged: number,
): { lo: number; hi: number; halfWidth: number } {
  const z = 1.96;
  const rate = wrong / judged;
  const z2n = (z * z) / judged;
  const centre = (rate + z2n / 2) / (1 + z2n);
  const halfWidth =
    (z / (1 + z2n)) * Math.sqrt((rate * (1 - rate)) / judged + (z * z) / (4 * judged * judged));
  return {
    lo: Math.max(0, centre - halfWidth),
    hi: Math.min(1, centre + halfWidth),
    halfWidth,
  };
}

export const AGREE_PHRASES: { pattern: RegExp; readAs: string }[] = [
  {
    pattern: /^full[\s-]?time\b/i,
    readAs: "a full-time role, so not a student internship",
  },
  {
    pattern: /(do(es)?n.?.?t|not|never)[^.]*\b(go(es)?|lead|link|point|reach)[^.]*\b(internship|careers?|job|posting|site|page)/i,
    readAs: "the url does not reach an internship posting",
  },
  {
    pattern: /\bnot an?\b[^.]*\b(internship|student|intern)\b/i,
    readAs: "the page is not an internship posting",
  },
];

/** How a filled-in cell was understood, or null if it was not. */
export function readVerdict(raw: string): { verdict: string; readAs: string | null } | null {
  if ((VERDICTS as readonly string[]).includes(raw)) return { verdict: raw, readAs: null };
  // Case-insensitive match on the three exact words too: somebody typing
  // "Agree" has not made a mistake worth refusing.
  const exact = (VERDICTS as readonly string[]).find((v) => v.toLowerCase() === raw.toLowerCase());
  if (exact) return { verdict: exact, readAs: null };
  for (const p of AGREE_PHRASES) {
    if (p.pattern.test(raw)) return { verdict: "agree", readAs: p.readAs };
  }
  return null;
}

function score(file: string) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("YOUR_VERDICT"));

  const counts = { agree: 0, WRONG: 0, unsure: 0 } as Record<string, number>;
  const blank: string[] = [];
  const wrong: string[] = [];
  const unknown: string[] = [];
  /** label -> { readAs, n }, so the output can show how each was understood. */
  const interpreted = new Map<string, { readAs: string; n: number }>();

  for (const line of lines) {
    const [verdict, firm, title] = cells(line);
    const v = (verdict ?? "").trim();
    if (!v) {
      blank.push(`${firm}: ${title}`);
      continue;
    }
    const read = readVerdict(v);
    if (!read) {
      unknown.push(`${v} (${firm}: ${title})`);
      continue;
    }
    if (read.readAs) {
      const got = interpreted.get(v);
      if (got) got.n += 1;
      else interpreted.set(v, { readAs: read.readAs, n: 1 });
    }
    counts[read.verdict] += 1;
    if (read.verdict === "WRONG") wrong.push(`${firm}: ${title}`);
  }

  /**
   * A PARTLY FILLED FILE IS SCORED, with the gap stated.
   *
   * This used to refuse outright, which is the wrong trade: forty rows is half
   * an hour, and somebody who has done twenty should get the number those
   * twenty support rather than nothing. The sample is written round-robin
   * across reasons, so the first N rows are already spread over the reasons
   * rather than being all of the commonest one - which is what makes scoring a
   * prefix legitimate at all.
   *
   * Refused only when NOTHING is filled in, because then there is no number.
   */
  if (blank.length === lines.length) {
    console.log(`All ${blank.length} rows are still blank. Fill in the YOUR_VERDICT column:`);
    for (const b of blank.slice(0, 10)) console.log(`  - ${b}`);
    console.log(`\nUse exactly: ${VERDICTS.join(", ")}`);
    return;
  }
  if (blank.length) {
    console.log(
      `${lines.length - blank.length} of ${lines.length} rows filled in; ` +
        `scoring those and ignoring the rest.\n`,
    );
  }
  if (interpreted.size) {
    // Printed BEFORE the rate, because the rate depends on it. A reader who
    // disagrees with a reading needs to see it before the number it produced.
    console.log("How your labels were read:");
    for (const [label, { readAs, n }] of [...interpreted].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  "${label}" x${n}  ->  agree: ${readAs}`);
    }
    console.log("");
  }
  if (unknown.length) {
    console.log(`Unrecognised verdicts (use exactly: ${VERDICTS.join(", ")}, or a clear reason):`);
    for (const u of unknown.slice(0, 10)) console.log(`  - ${u}`);
    return;
  }

  /**
   * `unsure` is excluded from the denominator rather than counted either way.
   *
   * A page a person could not read is not evidence about the agent - it is the
   * same "could not tell" the agent records as a skip. Counting it as
   * agreement flatters the agent; counting it as wrong punishes it for a page
   * neither of you could read. Reported separately so the exclusion is visible.
   */
  const judged = counts.agree + counts.WRONG;
  if (judged === 0) {
    console.log("Every row was 'unsure' - nothing measurable here.");
    return;
  }

  const rate = counts.WRONG / judged;

  /**
   * WILSON, not Wald.
   *
   * Wald is `rate +/- 1.96 * sqrt(p(1-p)/n)`, and at p = 0 that whole term is
   * zero: it printed "0.0% (95% CI 0.0% - 0.0%)", which asserts the rate is
   * certainly zero from forty rows. It then sat directly above a note saying
   * the rate is NOT zero, only below about 8%. The headline contradicted its
   * own footnote, and the headline is the part that gets quoted.
   *
   * Wilson does not collapse at the boundary. For 0 wrong in 40 it gives
   * 0% to 8.8%, which agrees with the rule of three below and is the honest
   * answer: a clean sweep of forty is good evidence of a low rate and no
   * evidence at all of a zero one.
   */
  const { lo, hi, halfWidth } = wilsonInterval(counts.WRONG, judged);

  console.log(`judged ${judged} (agree ${counts.agree}, WRONG ${counts.WRONG}), unsure ${counts.unsure} excluded\n`);
  console.log(`FALSE DENIAL RATE: ${(rate * 100).toFixed(1)}%  (95% CI ${(lo * 100).toFixed(1)}% - ${(hi * 100).toFixed(1)}%)`);
  if (wrong.length) {
    console.log(`\nthe ones it got wrong - these are real internships it denied:`);
    for (const w of wrong) console.log(`  - ${w}`);
  }
  console.log(
    `\nWhat this supports: at n=${judged} the interval is about plus or minus ` +
      `${(halfWidth * 100).toFixed(0)} points. It separates "about right" from "badly wrong".\n` +
      `It does not separate 2% from 6%, and no sample this size will.`,
  );
  if (rate === 0) {
    console.log(
      `\nZero wrong in ${judged} does NOT mean the rate is zero - it means it is\n` +
        `below roughly ${((3 / judged) * 100).toFixed(0)}% (the rule of three). Enough to let the agent\n` +
        `write; not enough to stop measuring.`,
    );
  }
}

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// Guarded so the pure helpers above can be imported by a test without the
// script running a draw against the live database on import.
if (process.argv[1]?.endsWith("review-agent-sample.ts")) {
  if (SCORE) {
    score(SCORE);
  } else {
    void draw(Number(DRAW ?? 40));
  }
}
