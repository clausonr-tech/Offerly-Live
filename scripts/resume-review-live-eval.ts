// Does the resume review's adaptive thinking earn what it costs?
//
//   npx tsx --conditions=react-server --env-file=.env.local \
//     scripts/resume-review-live-eval.ts --thinking=adaptive --json=a.json
//
// SPENDS API CREDITS. Six calls per run - five critics and a synthesis - each
// at the registry's `resumeReview` config, which is the most expensive
// configuration in the product: high effort (xhigh on the paid tier) with
// adaptive thinking and a 6,000-token ceiling, six times over.
//
// Why this exists: the draft review sat at medium + adaptive for a month
// because no script could reach it (audit/REVIEW-CONFIG-2026-10-12.md). When
// it was finally measured, turning thinking off halved the wait and lost
// nothing any instrument could see. This config has the same shape - careful
// reading of a document against a rubric - and nobody has measured it.
//
// GROUND TRUTH, rather than a judgement call. The fixture is a synthetic
// resume with twelve planted flaws, each one something a DIMENSIONS brief in
// lib/resume-review names explicitly, spread across all five critics. The
// score is how many of the twelve the review actually names. Detection is
// keyword matching, the same approach scripts/help-assistant-eval.ts uses:
// crude, transparent, and identical across arms, which is what matters when
// the arms are being compared with each other.

import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { runResumeReviewCalls } from "../src/lib/resume-review";
import { getModelConfig, type Effort, type ModelConfig, type Thinking } from "../src/lib/model-registry";

const RESUME = `MAYA OKAFOR
Atlanta, GA | maya.okafor@example.edu | (404) 555-0142

OBJECTIVE
Incredibly passionate and detail-oriented team player seeking a world-class
finance internship where I can leverage my skills.

EDUCATION
Duke University, Durham, NC
Bachelor of Science in Economics, Expected 2029

MY JOURNEY
Pinecrest Wealth Partners - Summer Analyst Intern
May 2024 - Aug 2024
- Responsible for maintaining the weekly dividend screen.
- Assisted with various research projects for the consumer team.
- Builds models used in client portfolio reviews.

Duke Investment Club - Consumer Sector Analyst
06/2023-09/2023
- Presented stock pitches to the club.

SKILLS
Finacial Modeling, Excel, PowerPoint

REFERENCES
Available upon request.`;

/** Each flaw is something a DIMENSIONS brief names explicitly. `detect` is matched against every issue, note and rewrite the review returns. */
const FLAWS: { id: string; dimension: string; what: string; detect: RegExp }[] = [
  { id: "F1", dimension: "honest", what: "an objective statement, which banking convention bans", detect: /objective/i },
  { id: "F2", dimension: "honest", what: "a references line", detect: /\breferences?\b/i },
  { id: "F3", dimension: "honest", what: "no GPA in Education", detect: /\bgpa\b/i },
  { id: "F4", dimension: "bullets", what: '"Responsible for" opening a bullet', detect: /responsible for/i },
  { id: "F5", dimension: "bullets", what: '"Assisted with various research projects" - weak verb, no outcome', detect: /assisted with|\bvarious\b/i },
  // The only flaw that is a PROPERTY of a bullet rather than a literal string in
  // it, so it is the only one whose detector has to cover paraphrase. The first
  // version matched "measurable" and missed "don't say how many, on what" -
  // scoring one arm's vocabulary rather than its findings. Both arms named this
  // flaw; only one used the word the regex knew.
  { id: "F6", dimension: "bullets", what: "a bullet with no number, decision or consequence", detect: /quantif|no number|\bmetric|measurable|how many|duties,? not outcomes|no outcome|no result/i },
  { id: "F7", dimension: "ats", what: '"MY JOURNEY" instead of a heading a parser knows', detect: /my journey|section heading|standard.{0,24}head|heading.{0,24}standard/i },
  { id: "F8", dimension: "tone", what: '"incredibly passionate", "world-class" - inflated adjectives', detect: /world-class|incredibly|inflated|adjective|superlative/i },
  { id: "F9", dimension: "polish", what: "two date formats (May 2024 - Aug 2024 vs 06/2023-09/2023)", detect: /date format|inconsistent.{0,24}date|06\/2023/i },
  { id: "F10", dimension: "polish", what: '"detail-oriented team player" - cliché filler', detect: /team player|detail-oriented|clich|filler/i },
  { id: "F11", dimension: "polish", what: '"Builds models" - present tense on a finished role', detect: /tense|\bbuilds\b/i },
  { id: "F12", dimension: "polish", what: '"Finacial" - a typo in the skills line', detect: /finacial|typo|spelling|misspel/i },
];

async function fixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 750;
  for (const line of RESUME.split("\n")) {
    page.drawText(line, { x: 54, y, size: 10, font });
    y -= 13.5;
  }
  return Buffer.from(await doc.save());
}

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Run with --env-file=.env.local.");

  const base = getModelConfig("resumeReview", flag("plan") === "pro" ? "pro" : "free");
  const effort = flag("effort") as Effort | null;
  const thinking = flag("thinking") as Thinking | null;
  // --no-fast because this org's fast-mode limit for Opus 5 is ZERO tokens a
  // minute, so a pro-tier config carrying speed:"fast" 429s on the first call.
  // Production survives that - ai-runner drops speed and retries the same model
  // before descending the chain - but this rig calls the pipeline directly and
  // has no such retry, so the flag is how the pro tier gets measured at all.
  const cfg: ModelConfig = {
    ...base,
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
    ...(flag("no-fast") !== null ? { speed: null } : {}),
  };

  console.log(`resume review: ${cfg.model}, effort ${cfg.effort}, thinking ${cfg.thinking}, maxTokens ${cfg.maxTokens}`);
  console.log(`${FLAWS.length} planted flaws across ${new Set(FLAWS.map((f) => f.dimension)).size} dimensions\n`);

  const pdf = await fixturePdf();
  const client = new Anthropic();
  const started = Date.now();
  const { usage, review, rejected } = await runResumeReviewCalls(client, cfg, { pdf });
  const ms = Date.now() - started;

  if (rejected || !review) {
    console.log(`** the review rejected the fixture as "${rejected ?? "empty"}" - it is supposed to read as a resume **`);
    process.exitCode = 1;
    return;
  }

  // Every string the student would see, which is what the flaw has to appear in.
  const haystack = [
    review.summary,
    ...review.strengths,
    ...review.improvements,
    ...review.dimensions.flatMap((d) => [d.label, ...(d.notes ?? []), ...(d.issues ?? []).map((i) => `${i.title ?? ""} ${i.detail ?? ""}`)]),
    ...review.rewrites.map((r) => `${r.before ?? ""} ${r.after ?? ""}`),
  ].join("\n");

  const found = FLAWS.filter((f) => f.detect.test(haystack));
  const missed = FLAWS.filter((f) => !f.detect.test(haystack));
  const cost = (usage.input_tokens * 2 + usage.output_tokens * 10) / 1e6; // Sonnet 5, $/MTok

  console.log(`FOUND ${found.length} of ${FLAWS.length} planted flaws`);
  for (const f of found) console.log(`  found   ${f.id} [${f.dimension}] ${f.what}`);
  for (const f of missed) console.log(`  MISSED  ${f.id} [${f.dimension}] ${f.what}`);
  console.log(`\nwall clock ${ms} ms for six calls`);
  console.log(`tokens ${usage.input_tokens} in, ${usage.output_tokens} out  ~$${cost.toFixed(4)}`);
  console.log(`issues raised: ${review.dimensions.reduce((n, d) => n + (d.issues?.length ?? 0), 0)}  rewrites: ${review.rewrites.length}`);
  for (const d of review.dimensions) console.log(`  ${String(d.label).padEnd(24)} score ${d.score ?? "-"}  issues ${(d.issues ?? []).length}`);

  const jsonPath = flag("json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ meta: { ranAt: new Date().toISOString(), cfg, ms, usage, costUsd: Number(cost.toFixed(4)) }, found: found.map((f) => f.id), missed: missed.map((f) => f.id), review }, null, 2)}\n`,
    );
    console.log(`\nWrote ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
