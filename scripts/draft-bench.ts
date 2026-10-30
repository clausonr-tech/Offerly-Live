// What the draft pipeline costs before a single token is bought.
//
//   npx tsx scripts/draft-bench.ts           the human table
//   npx tsx scripts/draft-bench.ts --json    the same numbers, for diffing a run against a baseline
//
// No API call, no database, no secret: every number here comes from building
// the real prompts with buildDraftPrompt and buildReviewPrompt. The point is
// that a prompt or algorithm change can be compared with the run before it -
// prompt size moves money and latency on every draft, and a cache prefix that
// gets shorter costs more than most of what a rewrite buys back.
//
// Token counts are ESTIMATES (see CHARS_PER_TOKEN). Counting them for real
// means asking the model, which this harness deliberately never does; the
// estimate is stable, so a diff between two runs is meaningful even where the
// absolute number is a few percent out.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMAIL_TYPES, type EmailTypeId } from "../src/lib/draft-templates";
import { buildDraftPrompt, type DraftPromptInput } from "../src/lib/draft-prompt";
import { buildReviewPrompt } from "../src/lib/draft-review";
import { draftChecks } from "../src/lib/draft-lint";
import { OCCASIONS } from "../src/lib/draft-occasions";
import { sims, type Sim } from "./draft-occasions-sim";

/**
 * The ratio the workflow doc measures these prompts at. Kept as one constant
 * so every number in the report moves together if it is ever recalibrated
 * against a real token count.
 */
const CHARS_PER_TOKEN = 3.7;

const tokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function size(text: string) {
  return { chars: text.length, bytes: bytes(text), tokens: tokens(text) };
}

// ---------------------------------------------------------------- the matrix

// One student, one recipient, one set of typed answers, taken from the
// multi-box simulations rather than invented here, so the only thing that
// differs between two rows of the per-type table is the type itself.
const BASE: Sim = sims()[0];

const boxesForType = (() => {
  const byType = new Map<EmailTypeId, string[]>();
  for (const occasion of OCCASIONS) {
    for (const section of occasion.sections) {
      for (const box of section.boxes) byType.set(box.typeId, [...(byType.get(box.typeId) ?? []), box.id]);
    }
  }
  return byType;
})();

type Row = {
  kind: "type" | "mix";
  id: string;
  label: string;
  /** The lead type, then any also-true types. */
  types: EmailTypeId[];
  boxIds: string[];
  input: DraftPromptInput;
};

const typeRows: Row[] = EMAIL_TYPES.map((t) => {
  // A single checked box for this type where the picker has one, so the
  // combination examples behave the way they would for a real student.
  const boxIds = (boxesForType.get(t.id) ?? []).slice(0, 1);
  return {
    kind: "type",
    id: t.id,
    label: t.label,
    types: [t.id],
    boxIds,
    input: { ...BASE.input, type: t.id, alsoTypes: [], boxIds, situationSummary: t.label },
  };
});

const mixRows: Row[] = sims().map((s) => ({
  kind: "mix",
  id: s.id,
  label: `${s.profile} · ${s.situation.summary}`,
  types: [s.input.type, ...(s.input.alsoTypes ?? [])],
  boxIds: s.input.boxIds ?? [],
  input: s.input,
}));

const rows = [...typeRows, ...mixRows];

// ------------------------------------------------ a draft to review, offline
//
// The review prompt's size depends on the draft it is reviewing, so sizing it
// needs a body. The fixture drafts are keyed by simulation id, so every
// multi-box row is measured against the draft written for that exact
// situation. A per-type row has no fixture of its own and is measured against
// one fixed body - its facts and its automatic checks are still its own, but
// its review-prompt number is comparable across types rather than realistic.
const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "draft-fixtures", "occasion-drafts.txt");

function fixtureDrafts(): Map<string, { subject: string; body: string }> {
  const parts = readFileSync(FIXTURES, "utf8").split(/^=== (\d+)\s*$/m).slice(1);
  const out = new Map<string, { subject: string; body: string }>();
  for (let i = 0; i < parts.length; i += 2) {
    const [subjectLine, ...rest] = parts[i + 1].replace(/^\n/, "").split("\n");
    if (rest[0]?.startsWith("Notes:")) rest.shift();
    out.set(parts[i], { subject: subjectLine.replace(/^Subject:\s*/, ""), body: rest.join("\n").trim() });
  }
  return out;
}

const DRAFTS = fixtureDrafts();
const STAND_IN = DRAFTS.get(BASE.id)!;

// ------------------------------------------------------- prefixes and suffix

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

const built = rows.map((row) => {
  const { system, userText } = buildDraftPrompt(row.input);
  const draft = (row.kind === "mix" ? DRAFTS.get(row.id) : undefined) ?? STAND_IN;
  const checks = draftChecks(row.input, draft.body).forReview;
  const review = buildReviewPrompt(row.input, draft, checks);
  return { row, system, userText, review, checks, reviewedFixture: row.kind === "mix" && DRAFTS.has(row.id) };
});

// The genuinely invariant head and tail: not the pieces the builder happens to
// put first and last, but the bytes every situation in the matrix shares, which
// is what a cache breakpoint could actually sit behind.
const systems = built.map((b) => b.system);
const headLen = systems.reduce((n, s) => Math.min(n, commonPrefix(systems[0], s)), systems[0].length);
const tailLen = systems.reduce((n, s) => Math.min(n, commonSuffix(systems[0], s)), systems[0].length);
const HEAD = systems[0].slice(0, headLen);
const TAIL = systems[0].slice(systems[0].length - tailLen);

// The reviewer's system prompt is meant to be constant; a change that makes it
// per-request would quietly destroy its cache, so it is checked rather than
// assumed.
const reviewSystems = new Set(built.map((b) => b.review.system));

// --------------------------------------------------------- where types diverge

type Pair = { a: string; b: string; chars: number; bytes: number; shareOfA: number };

function divergence(a: (typeof built)[number], b: (typeof built)[number]): Pair {
  const chars = commonPrefix(a.system, b.system);
  return {
    a: a.row.id,
    b: b.row.id,
    chars,
    bytes: bytes(a.system.slice(0, chars)),
    shareOfA: chars / a.system.length,
  };
}

const typeBuilt = built.filter((b) => b.row.kind === "type");
const typePairs: Pair[] = [];
for (let i = 0; i < typeBuilt.length; i++) {
  for (let j = i + 1; j < typeBuilt.length; j++) typePairs.push(divergence(typeBuilt[i], typeBuilt[j]));
}
const byChars = [...typePairs].sort((x, y) => x.chars - y.chars);
const median = byChars[Math.floor(byChars.length / 2)];

const named = (a: EmailTypeId, b: EmailTypeId) =>
  divergence(typeBuilt.find((x) => x.row.id === a)!, typeBuilt.find((x) => x.row.id === b)!);

// Two situations that share a lead type but not the box mix: the case the
// current single breakpoint at the end of the system prompt cannot cache.
const sameLeadPair = (() => {
  const mixes = built.filter((b) => b.row.kind === "mix");
  for (let i = 0; i < mixes.length; i++) {
    for (let j = i + 1; j < mixes.length; j++) {
      if (mixes[i].row.types[0] !== mixes[j].row.types[0]) continue;
      if (mixes[i].row.boxIds.join("+") === mixes[j].row.boxIds.join("+")) continue;
      return { pair: divergence(mixes[i], mixes[j]), a: mixes[i].row, b: mixes[j].row };
    }
  }
  return null;
})();

// ------------------------------------------------------------------ the report

const measured = built.map((b) => {
  const middle = b.system.slice(HEAD.length, b.system.length - TAIL.length);
  return {
    kind: b.row.kind,
    id: b.row.id,
    label: b.row.label,
    types: b.row.types,
    boxIds: b.row.boxIds,
    draftSystem: {
      total: size(b.system),
      head: size(HEAD),
      perType: size(middle),
      tail: size(TAIL),
    },
    draftUser: size(b.userText),
    reviewSystem: size(b.review.system),
    reviewUser: size(b.review.userText),
    reviewedFixtureDraft: b.reviewedFixture,
    automaticChecks: b.checks.length,
  };
});

const sum = (ns: number[]) => ns.reduce((a, x) => a + x, 0);
const stats = (ns: number[]) => ({
  min: Math.min(...ns),
  median: [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)],
  max: Math.max(...ns),
  mean: Math.round(sum(ns) / ns.length),
});

const typeMeasured = measured.filter((m) => m.kind === "type");
const mixMeasured = measured.filter((m) => m.kind === "mix");

const report = {
  harness: "scripts/draft-bench.ts",
  charsPerToken: CHARS_PER_TOKEN,
  tokenCountsAre: "estimated from characters; no model was asked",
  matrix: { types: typeMeasured.length, multiBoxMixes: mixMeasured.length },
  invariant: {
    head: size(HEAD),
    tail: size(TAIL),
    reviewSystemIsConstant: reviewSystems.size === 1,
    reviewSystem: size([...reviewSystems][0]),
  },
  cachePrefix: {
    acrossEveryTypePair: { min: byChars[0], median, max: byChars[byChars.length - 1] },
    named: {
      "cold_email vs cold_referral": named("cold_email", "cold_referral"),
      "cold_email vs thank_you_chat": named("cold_email", "thank_you_chat"),
      "cold_email vs custom": named("cold_email", "custom"),
      "follow_up_1 vs follow_up_2": named("follow_up_1", "follow_up_2"),
    },
    sameLeadDifferentBoxes: sameLeadPair && {
      ...sameLeadPair.pair,
      a: `${sameLeadPair.a.id} ${sameLeadPair.a.boxIds.join("+")}`,
      b: `${sameLeadPair.b.id} ${sameLeadPair.b.boxIds.join("+")}`,
    },
  },
  aggregate: {
    perTypeDraftSystemChars: stats(typeMeasured.map((m) => m.draftSystem.total.chars)),
    perTypeBlockChars: stats(typeMeasured.map((m) => m.draftSystem.perType.chars)),
    perTypeDraftUserChars: stats(typeMeasured.map((m) => m.draftUser.chars)),
    mixDraftSystemChars: stats(mixMeasured.map((m) => m.draftSystem.total.chars)),
    mixDraftUserChars: stats(mixMeasured.map((m) => m.draftUser.chars)),
    mixReviewUserChars: stats(mixMeasured.map((m) => m.reviewUser.chars)),
    reviewUserCharsEveryRow: stats(measured.map((m) => m.reviewUser.chars)),
  },
  rows: measured,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (x: number) => x.toLocaleString("en-US");
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  console.log("DRAFT PIPELINE, OFFLINE BENCH");
  console.log(`${typeMeasured.length} email types · ${mixMeasured.length} multi-box situations · tokens estimated at ${CHARS_PER_TOKEN} chars/token, never counted by a model\n`);

  console.log("INVARIANT ACROSS EVERY SITUATION IN THE MATRIX");
  console.log(`  draft system head   ${n(HEAD.length)} ch  ${n(bytes(HEAD))} B  ~${n(tokens(HEAD))} tok`);
  console.log(`  draft system tail   ${n(TAIL.length)} ch  ${n(bytes(TAIL))} B  ~${n(tokens(TAIL))} tok`);
  console.log(
    `  review system       ${n(report.invariant.reviewSystem.chars)} ch  ~${n(report.invariant.reviewSystem.tokens)} tok  ` +
      `(constant: ${reviewSystems.size === 1 ? "yes" : `NO - ${reviewSystems.size} variants`})\n`,
  );

  const head = "type".padEnd(28) + "sys ch".padStart(9) + "~tok".padStart(8) + "per-type ch".padStart(13) + "user ch".padStart(9) + "~tok".padStart(7) + "rev user ch".padStart(13);
  console.log("ONE BOX, ONE TYPE");
  console.log(`  ${head}`);
  for (const m of [...typeMeasured].sort((a, b) => b.draftSystem.total.chars - a.draftSystem.total.chars)) {
    console.log(
      "  " +
        m.id.padEnd(28) +
        n(m.draftSystem.total.chars).padStart(9) +
        n(m.draftSystem.total.tokens).padStart(8) +
        n(m.draftSystem.perType.chars).padStart(13) +
        n(m.draftUser.chars).padStart(9) +
        n(m.draftUser.tokens).padStart(7) +
        n(m.reviewUser.chars).padStart(13),
    );
  }
  console.log("  (review-prompt sizes on these rows use one fixed stand-in body; the mixes below use the draft written for that situation)\n");

  console.log("MULTI-BOX MIXES (every valid combination the picker allows, from scripts/draft-occasions-sim.ts)");
  const a = report.aggregate;
  console.log(`  draft system  min ${n(a.mixDraftSystemChars.min)} ch · median ${n(a.mixDraftSystemChars.median)} · max ${n(a.mixDraftSystemChars.max)} (~${n(Math.round(a.mixDraftSystemChars.max / CHARS_PER_TOKEN))} tok)`);
  console.log(`  draft user    min ${n(a.mixDraftUserChars.min)} ch · median ${n(a.mixDraftUserChars.median)} · max ${n(a.mixDraftUserChars.max)}`);
  console.log(`  review user   min ${n(a.mixReviewUserChars.min)} ch · median ${n(a.mixReviewUserChars.median)} · max ${n(a.mixReviewUserChars.max)}   (each against the draft written for that situation)`);
  console.log("  biggest five:");
  for (const m of [...mixMeasured].sort((x, y) => y.draftSystem.total.chars - x.draftSystem.total.chars).slice(0, 5)) {
    console.log(`    ${m.id} ${n(m.draftSystem.total.chars)} ch (~${n(m.draftSystem.total.tokens)} tok) · ${m.types.join("+")} · ${m.label}`);
  }
  console.log("  smallest three:");
  for (const m of [...mixMeasured].sort((x, y) => x.draftSystem.total.chars - y.draftSystem.total.chars).slice(0, 3)) {
    console.log(`    ${m.id} ${n(m.draftSystem.total.chars)} ch (~${n(m.draftSystem.total.tokens)} tok) · ${m.types.join("+")} · ${m.label}`);
  }
  console.log();

  console.log("WHERE TWO SYSTEM PROMPTS DIVERGE - the prefix a shared cache entry could actually hold");
  const p = report.cachePrefix;
  console.log(`  every pair of types (${n(typePairs.length)} pairs)`);
  console.log(`    shortest  ${n(p.acrossEveryTypePair.min.chars)} ch / ${n(p.acrossEveryTypePair.min.bytes)} B  (${p.acrossEveryTypePair.min.a} vs ${p.acrossEveryTypePair.min.b}, ${pct(p.acrossEveryTypePair.min.shareOfA)} of the first prompt)`);
  console.log(`    median    ${n(p.acrossEveryTypePair.median.chars)} ch / ${n(p.acrossEveryTypePair.median.bytes)} B`);
  console.log(`    longest   ${n(p.acrossEveryTypePair.max.chars)} ch / ${n(p.acrossEveryTypePair.max.bytes)} B  (${p.acrossEveryTypePair.max.a} vs ${p.acrossEveryTypePair.max.b})`);
  for (const [label, d] of Object.entries(p.named)) {
    console.log(`  ${label.padEnd(30)} ${n(d.chars)} ch / ${n(d.bytes)} B  (${pct(d.shareOfA)} of the first prompt)`);
  }
  if (p.sameLeadDifferentBoxes) {
    const d = p.sameLeadDifferentBoxes;
    console.log(`  same lead type, different boxes  ${n(d.chars)} ch / ${n(d.bytes)} B  (${pct(d.shareOfA)})`);
    console.log(`    ${d.a}  vs  ${d.b}`);
  }
  console.log("\n  Today the draft system prompt carries ONE cache breakpoint, at its very end (cachedSystem in src/lib/draft-pipeline.ts),");
  console.log("  so a hit needs a byte-identical prompt: same type AND same box mix. The numbers above are what a breakpoint");
  console.log("  after the invariant head would be worth instead - and what it would cost to let per-type text move earlier.");
}
