// The video interview evaluation framework: WER normalisation, finance-term
// scoring, grader metrics, repeatability, manifest validation, dataset
// adapters, privacy-safe output, and the separation of reference-transcript
// from ASR-transcript results. Groq and Claude are stubs; the network guard
// fails any real request, so these tests cost nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import "./helpers/no-network";
import { currencyCounts, fillerCounts, fillerTokens, normalizeForWer, numberCounts, phraseRecall, timestampCoverage, wer, wordErrors } from "@/lib/video-interview/eval/text-metrics";
import { RequestBudget, RequestLimitReached } from "@/lib/video-interview/eval/budget";
import { evalGradeCall } from "@/lib/video-interview/eval/live";
import { cohenKappa, graderMetrics, humanAgreement, macroF1, mae, prf, repeatability, spearman, stdDev, type GradedItem } from "@/lib/video-interview/eval/grader-metrics";
import { trainingEligible, validateManifest, type ManifestItem } from "@/lib/video-interview/eval/manifest";
import { LicenseConfirmationRequired, fromCommonVoice, fromEarnings21, fromLibriSpeech } from "@/lib/video-interview/eval/adapters";
import { dryRunDeps, estimateCalls, runEvaluation, selectItems, type EvalDeps } from "@/lib/video-interview/eval/runner";
import { REFUSAL, buildGradingPrompt, gradingPromptHash, GRADING_RUBRIC_VERSION, classifyScore, type ModelCall } from "@/lib/video-interview/grading";

const SYNTHETIC = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/eval/fixtures/synthetic-manifest.json"), "utf8"));
const manifest = () => {
  const v = validateManifest(SYNTHETIC);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.manifest;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------- WER and normalisation ----------

test("normalisation makes spoken and written finance language compare equal", () => {
  const pairs: [string, string][] = [
    ["Revenue grew 10% to $2.5 billion in Q3.", "revenue grew ten percent to two point five billion dollars in q three"],
    ["It's 1,000 units", "it's one thousand units"],
    ["EBITDA was $25 million", "ebitda was twenty five million dollars"],
    ["FY26 guidance", "f y twenty six guidance"],
    ["one hundred and five", "105"],
  ];
  for (const [a, b] of pairs) assert.deepEqual(normalizeForWer(a), normalizeForWer(b), `${a} / ${b}`);
  assert.deepEqual(normalizeForWer("So, um, uh, the the deal - closed."), ["so", "the", "the", "deal", "closed"], "hesitations dropped, repeats kept");
});

test("WER counts substitutions, insertions and deletions against the reference", () => {
  const c = wordErrors("the cat sat on the mat".split(" "), "the cat sat on a big mat".split(" "));
  assert.deepEqual({ s: c.substitutions, i: c.insertions, d: c.deletions }, { s: 1, i: 1, d: 0 });
  assert.equal(wer(c), 2 / 6);
  const del = wordErrors("a b c".split(" "), ["a"]);
  assert.equal(del.deletions, 2);
  assert.equal(wer(wordErrors([], ["x"])), null, "WER is undefined with no reference words");
  assert.equal(wer(wordErrors(normalizeForWer("Ten percent."), normalizeForWer("10%"))), 0);
});

test("numbers, currency, finance terms and entities are scored separately", () => {
  const ref = normalizeForWer("Margins rose 3% on revenue of $4.2 billion and EBITDA of $900 million.");
  const hyp = normalizeForWer("Margins rose 3 percent on revenue of four point two billion dollars and EBITDA of 90 million dollars.");
  assert.deepEqual(numberCounts(ref, hyp), { tp: 2, fp: 1, fn: 1 }, "900 million was misheard as 90 million: one missed, one wrong");
  assert.deepEqual(currencyCounts(ref, hyp), { tp: 1, fp: 1, fn: 1 });
  assert.deepEqual(phraseRecall(["EBITDA", "enterprise value", "revenue"], "Revenue and EBITDA were up."), { matched: 2, total: 3 });
  assert.equal(timestampCoverage([{}, {}], 4), 0.5);
  assert.equal(timestampCoverage(null, 4), 0);
});

// ---------- grader metrics ----------

test("MAE, Spearman (with ties), macro F1, precision/recall and kappa", () => {
  assert.equal(mae([[10, 20], [30, 30]]), 5);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([1, 1, 2, 3], [1, 1, 2, 3]), 1, "ties get average ranks");
  assert.equal(spearman([1, 2], [1, 2]), null, "too few items");
  assert.equal(macroF1(["strong", "poor", "average"], ["strong", "poor", "average"]), 1);
  assert.equal(macroF1(["strong", "strong"], ["poor", "poor"]), 0);
  assert.deepEqual(prf(3, 1, 2), { precision: 0.75, recall: 0.6, f1: 0.667, tp: 3, fp: 1, fn: 2 });
  assert.equal(cohenKappa(["strong", "poor", "average"], ["strong", "poor", "average"]), 1);
  assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
});

const graded = (over: Partial<GradedItem> & { id: string }): GradedItem => ({
  kind: "technical",
  outcome: "graded",
  human: { overall: 80, scores: { grammarClarity: 80, pacePauses: 80, fillers: 80, structure: 80, relevance: 80, completeness: 80, logic: 80, concision: 80 }, classification: "strong" },
  model: { overall: 70, scores: { structure: 70 }, classification: "average" },
  expectedCovered: [1, 2, 3],
  modelCovered: [1, 2, 4],
  expectedErrorCount: 0,
  modelErrorCount: 0,
  expectedStar: null,
  modelStar: null,
  ...over,
});

test("grader metrics: scores, classes, expected points, factual errors, STAR and outcomes", () => {
  const star = { situation: true, task: false, action: true, result: true, reflection: false };
  const m = graderMetrics([
    graded({ id: "a" }),
    graded({ id: "b", expectedErrorCount: 2, modelErrorCount: 1 }),
    graded({ id: "c", expectedErrorCount: 0, modelErrorCount: 1 }),
    graded({ id: "d", kind: "behavioral", modelCovered: null, expectedStar: star, modelStar: { ...star, reflection: true, action: false } }),
    graded({ id: "e", outcome: "parse_failed", model: { overall: null, scores: {}, classification: null }, modelCovered: null, modelErrorCount: null }),
  ]);
  assert.equal(m.items, 5);
  assert.equal(m.graded, 4, "a parse failure is not scored as if graded");
  assert.equal(m.overallMae, 10);
  assert.equal(m.dimensionMae.structure, 10);
  assert.deepEqual([m.expectedPoints.tp, m.expectedPoints.fp, m.expectedPoints.fn], [6, 3, 3], "three technical items: {1,2} right, 4 wrong, 3 missed");
  assert.deepEqual([m.factualErrorDetection.tp, m.factualErrorDetection.fp, m.factualErrorDetection.fn], [1, 1, 0]);
  assert.deepEqual([m.star.action.tp, m.star.action.fn], [0, 1]);
  assert.deepEqual([m.star.reflection.fp], [1]);
  assert.equal(m.star.situation.f1, 1);
  assert.equal(m.outcomeRates.parse_failed, 0.2);
});

test("repeatability: score spread and classification flips across identical runs", () => {
  const r = repeatability(
    new Map([
      ["a", [{ overall: 70, classification: "average" }, { overall: 74, classification: "average" }]],
      ["b", [{ overall: 74, classification: "average" }, { overall: 76, classification: "strong" }]],
      ["c", [{ overall: null, classification: null }, { overall: 50, classification: "average" }]],
    ]),
  );
  assert.equal(r.runs, 2);
  assert.equal(r.meanScoreStdDev, 1.5);
  assert.equal(r.maxScoreStdDev, 2);
  assert.equal(r.classificationFlipRate, 0.5, "one of two comparable items changed class");
});

test("human-to-human agreement is computed from the first two blind reviews", () => {
  const s = (n: number) => ({ grammarClarity: n, pacePauses: n, fillers: n, structure: n, relevance: n, completeness: n, logic: n, concision: n });
  const h = humanAgreement([
    { a: { overall: 80, scores: s(80), classification: "strong" }, b: { overall: 76, scores: s(76), classification: "strong" } },
    { a: { overall: 50, scores: s(50), classification: "average" }, b: { overall: 60, scores: s(60), classification: "average" } },
    { a: { overall: 20, scores: s(20), classification: "poor" }, b: { overall: 30, scores: s(30), classification: "poor" } },
  ]);
  assert.equal(h.reviewPairs, 3);
  assert.equal(h.overallMae, 8);
  assert.equal(h.classAgreement, 1);
  assert.equal(h.spearman, 1);
});

// ---------- manifest validation ----------

test("the committed synthetic manifest is valid, evaluation-only and not training data", () => {
  const m = manifest();
  assert.equal(m.items.length, 7);
  assert.ok(m.items.every((i) => i.permittedUse === "evaluation" && !trainingEligible(i)));
  assert.ok(m.items.every((i) => i.mediaPath === null), "no audio is committed");
});

test("entries without licence, consent basis or permitted use are rejected", () => {
  for (const field of ["license", "consentBasis", "permittedUse"]) {
    const m = clone(SYNTHETIC);
    delete m.items[0][field];
    const v = validateManifest(m);
    assert.equal(v.ok, false, field);
    assert.ok(!v.ok && v.errors.some((e) => e.includes(field)), field);
  }
  const m = clone(SYNTHETIC);
  m.items[0].license = "";
  assert.equal(validateManifest(m).ok, false, "an empty licence is not a licence");
});

test("protected characteristics are refused, and accents only come from the dataset", () => {
  for (const key of ["gender", "age", "ethnicity", "race"]) {
    const m = clone(SYNTHETIC);
    m.items[0].slices[key] = "x";
    const v = validateManifest(m);
    assert.ok(!v.ok && v.errors.some((e) => /protected-characteristic/.test(e)), key);
  }
  const nested = clone(SYNTHETIC);
  nested.items[0].source.speakerGender = "x";
  assert.equal(validateManifest(nested).ok, false, "unknown keys are rejected anywhere");
  const guessed = clone(SYNTHETIC);
  guessed.items[0].slices.accent = "us-south";
  assert.ok(!validateManifest(guessed).ok, "an accent without accentSource dataset");
  guessed.items[0].slices.accentSource = "dataset";
  assert.ok(validateManifest(guessed).ok, "allowed when the dataset supplied it");
});

test("held-out data can never be marked for training", () => {
  const e21 = clone(SYNTHETIC);
  e21.items[0].source.dataset = "earnings21";
  e21.items[0].permittedUse = "both";
  assert.ok(!validateManifest(e21).ok);
  for (const split of ["test", "dev", "test-clean", "dev-other", "validation"]) {
    const m = clone(SYNTHETIC);
    m.items[0].source.split = split;
    m.items[0].permittedUse = "training";
    assert.ok(!validateManifest(m).ok, split);
  }
  const train = clone(SYNTHETIC);
  train.items[0].source.split = "train";
  train.items[0].permittedUse = "both";
  const v = validateManifest(train);
  assert.ok(v.ok);
  assert.equal(trainingEligible(v.manifest.items[0]), true, "only an explicit, non-held-out training entry is eligible");
});

test("grader items need reviews, adjudication and duration; live ASR needs media", () => {
  const m = clone(SYNTHETIC);
  m.items[0].reviews = null;
  m.items[1].adjudicated = null;
  m.items[2].durationSec = null;
  const v = validateManifest(m);
  assert.ok(!v.ok);
  assert.equal(v.errors.length, 3);
  assert.ok(!validateManifest(SYNTHETIC, { requireMedia: true }).ok, "synthetic items have no audio, so a live ASR run refuses them");
  const escape = clone(SYNTHETIC);
  escape.items[0].mediaPath = "../../etc/passwd";
  assert.ok(!validateManifest(escape).ok);
  const unblinded = clone(SYNTHETIC);
  unblinded.items[0].reviews[0].blind = false;
  assert.ok(!validateManifest(unblinded).ok, "reviews must be blind");
});

// ---------- dataset adapters ----------

const wrap = (items: ManifestItem[]) => ({ manifestVersion: 1, name: "t", items });

test("Common Voice import never reads speaker attributes and keeps test evaluation-only", () => {
  const tsv = "client_id\tpath\tsentence\tup_votes\tdown_votes\tage\tgender\taccents\n" + "abc123\tcommon_voice_en_1.mp3\tThe market closed higher.\t2\t0\tfifties\tfemale\tUnited States English\n";
  const items = fromCommonVoice(tsv, { split: "test", clipsDir: "clips", allowTraining: true });
  const json = JSON.stringify(items);
  assert.doesNotMatch(json, /fifties|female|abc123/, "age, gender and the speaker id are never copied");
  assert.equal(items[0].permittedUse, "evaluation", "test stays evaluation even with allowTraining");
  assert.equal(items[0].slices.accent, null, "accent only on request");
  assert.equal(fromCommonVoice(tsv, { split: "test", clipsDir: "clips", includeDatasetAccent: true })[0].slices.accentSource, "dataset");
  assert.ok(validateManifest(wrap(items)).ok);
});

test("LibriSpeech keeps official partitions apart; Earnings-21 is always held out", () => {
  const trans = "1089-134686-0000 HE HOPED THERE WOULD BE STEW FOR DINNER\n1089-134686-0001 STUFF IT INTO YOU\n";
  const test = fromLibriSpeech(trans, { partition: "test-clean", chapterDir: "test-clean/1089/134686", allowTraining: true });
  assert.equal(test.length, 2);
  assert.ok(test.every((i) => i.permittedUse === "evaluation" && i.slices.audio === "clean"));
  assert.equal(test[0].mediaPath, "test-clean/1089/134686/1089-134686-0000.flac");
  const train = fromLibriSpeech(trans, { partition: "train-clean-100", chapterDir: "x", allowTraining: true });
  assert.ok(train.every((i) => i.permittedUse === "both"));
  assert.ok(fromLibriSpeech(trans, { partition: "train-clean-100", chapterDir: "x" }).every((i) => i.permittedUse === "evaluation"), "training needs an explicit opt-in");

  const nlp = "token|speaker|ts|endTs|punctuation|case|tags|wer_tags\nRevenue|1||||UC|[]|[]\nwas|1||||LC|[]|[]\nfour|1||||LC|['0:MONEY']|[]\nbillion|1||||LC|['0:MONEY']|[]\nat|1||||LC|[]|[]\nAcme|1||||UC|['1:ORG']|[]\nCorp|1|||.|UC|['1:ORG']|[]\n";
  const audio = { release: "earnings21-v1.0 (commit abc1234)", audioLicense: "Evaluation use confirmed for this release", audioLicenseSource: "https://example.test/confirmation-2026-09-29" };
  const e21 = fromEarnings21(nlp, { fileId: "4320211", mediaPath: "media/4320211.mp3", audio });
  assert.equal(e21.license, audio.audioLicense, "the AUDIO licence, as supplied - never assumed from the transcript LICENSE");
  assert.equal(e21.source.version, audio.release);
  assert.equal(e21.source.licenseSource, audio.audioLicenseSource);
  assert.equal(e21.verbatimFillers, false);
  assert.equal(e21.permittedUse, "evaluation");
  assert.equal(trainingEligible(e21), false);
  assert.deepEqual(e21.annotations?.namedEntities, ["Acme Corp"]);
  assert.deepEqual(e21.annotations?.numbers, ["four billion"]);
  assert.equal(e21.referenceTranscript, "Revenue was four billion at Acme Corp.");
  assert.ok(validateManifest(wrap([...test, ...train, e21])).ok);
});

// ---------- the runner, with Groq and Claude stubbed ----------

const GOOD_JUDGEMENT = {
  summary: "ok",
  strengths: [],
  improvements: [],
  grammarNotes: [],
  coveredPoints: [1, 2],
  factualErrors: [],
  star: { situation: true, task: true, action: true, result: true, reflection: false },
  scores: { grammarClarity: 7, structure: 7, relevance: 8, completeness: 6, logic: 7, concision: 7 },
};

/** A Groq stand-in that drops the item's last word, with word timings. */
function stubGroq(m: ReturnType<typeof manifest>): Pick<EvalDeps, "transcriber" | "readMedia"> {
  const byId = new Map(m.items.map((i) => [i.id, i]));
  return {
    readMedia: async (item) => ({ bytes: Buffer.from(item.id), contentType: "audio/wav", filename: "x.wav" }),
    transcriber: {
      name: "stub-groq",
      transcribe: async ({ bytes }) => {
        const words = byId.get(bytes.toString())!.referenceTranscript.split(" ").slice(0, -1);
        return { text: `GROQ ${words.join(" ")}`, words: words.map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.3 })) };
      },
    },
  };
}

test("end-to-end keeps reference-transcript and Groq-transcript grading separate", async () => {
  const m = manifest();
  const seen: { transcript: string }[] = [];
  const claude: ModelCall = async ({ user }) => {
    seen.push({ transcript: user.split("<transcript>\n")[1].split("\n</transcript>")[0] });
    // Grades the Groq version lower, so the two conditions differ.
    return user.includes("GROQ") ? { ...GOOD_JUDGEMENT, scores: { ...GOOD_JUDGEMENT.scores, relevance: 3, logic: 3 } } : GOOD_JUDGEMENT;
  };
  const report = await runEvaluation(m, { ...stubGroq(m), gradeCall: claude }, { mode: "end-to-end", runs: 1 }, { test: true });
  assert.equal(seen.length, 12, "two gradings per item");
  const ref = seen.filter((s) => !s.transcript.startsWith("GROQ"));
  const asr = seen.filter((s) => s.transcript.startsWith("GROQ"));
  assert.equal(ref.length, 6);
  assert.equal(asr.length, 6);
  for (const i of m.items.filter((x) => x.tasks.includes("grader"))) assert.ok(ref.some((s) => s.transcript === i.referenceTranscript), `${i.id}: graded on its verified reference`);
  const e2e = report.endToEnd!;
  assert.notEqual(e2e.reference.overallMae, e2e.asrTranscript.overallMae);
  assert.ok((e2e.delta.meanAbsoluteScoreShift ?? 0) > 0, "the transcript's effect is measured");
  assert.ok(report.asr!.summary.corpusWer! > 0, "one inserted and one deleted word per item");
  assert.equal(report.asr!.summary.withTimestampsRate, 1);
});

test("the grader sees exactly the production prompt", async () => {
  const m = manifest();
  const item = m.items[0];
  let got: { system: string; user: string } | null = null;
  await runEvaluation(m, { ...stubGroq(m), gradeCall: async (a) => ((got ??= { system: a.system, user: a.user }), GOOD_JUDGEMENT) }, { mode: "grader", runs: 1, maxItems: 1 }, {});
  const q = item.question!;
  assert.deepEqual(got, buildGradingPrompt({ kind: q.kind, prompt: q.prompt, topic: q.topic, difficulty: q.difficulty, expectedPoints: q.expectedPoints, transcript: item.referenceTranscript }));
});

test("reports are privacy-safe by default; transcripts appear only with debug", async () => {
  const m = manifest();
  const deps = { ...stubGroq(m), gradeCall: (async () => GOOD_JUDGEMENT) as ModelCall };
  const plain = JSON.stringify(await runEvaluation(m, deps, { mode: "end-to-end", runs: 1 }, {}));
  for (const i of m.items.filter((x) => x.tasks.includes("grader"))) {
    assert.ok(!plain.includes(i.referenceTranscript.slice(0, 40)), `${i.id}: no reference text`);
    assert.ok(plain.includes(i.id), "fixtures are identified by id");
  }
  assert.ok(!plain.includes("GROQ"), "no ASR text");
  const withDebug = JSON.stringify(await runEvaluation(m, deps, { mode: "end-to-end", runs: 1, debug: true }, {}));
  assert.ok(withDebug.includes(m.items[0].referenceTranscript.slice(0, 40)));
});

test("parse failures, refusals and model errors are counted, not scored", async () => {
  const m = manifest();
  const replies: unknown[] = [{ nope: true }, REFUSAL, "throw", GOOD_JUDGEMENT, GOOD_JUDGEMENT, GOOD_JUDGEMENT];
  let n = 0;
  const call: ModelCall = async () => {
    const r = replies[n++ % replies.length];
    if (r === "throw") throw new Error("overloaded");
    return r;
  };
  const report = await runEvaluation(m, { ...stubGroq(m), gradeCall: call }, { mode: "grader", runs: 1 }, {});
  const rates = report.grader!.primary.outcomeRates;
  assert.equal(rates.parse_failed, 0.167);
  assert.equal(rates.refusal, 0.167);
  assert.equal(rates.model_error, 0.167);
  assert.equal(report.grader!.primary.graded, 3);
});

test("repeat runs measure grader stability", async () => {
  const m = manifest();
  let run = 0;
  const call: ModelCall = async () => {
    const bump = Math.floor(run++ / 6) % 2 === 0 ? 0 : 3;
    return { ...GOOD_JUDGEMENT, scores: { ...GOOD_JUDGEMENT.scores, relevance: 5 + bump, logic: 5 + bump } };
  };
  const report = await runEvaluation(m, { ...stubGroq(m), gradeCall: call }, { mode: "grader", runs: 2 }, {});
  assert.equal(report.grader!.repeatability.runs, 2);
  assert.ok(report.grader!.repeatability.meanScoreStdDev! > 0);
  assert.equal(report.grader!.perRun.length, 2);
});

test("estimates, dry runs and versioning", async () => {
  const m = manifest();
  assert.deepEqual(
    [estimateCalls(selectItems(m, "asr"), "asr", 3).totalCases, estimateCalls(selectItems(m, "grader"), "grader", 2).totalCases, estimateCalls(selectItems(m, "end-to-end", 2), "end-to-end", 1).totalCases],
    [21, 12, 6],
    "asr n*runs; grader n*runs; end-to-end n*runs ASR + 2n*runs grading",
  );
  const dry = await runEvaluation(m, dryRunDeps(m), { mode: "end-to-end", runs: 1 }, {});
  assert.equal(dry.asr!.summary.corpusWer, 0, "the dry-run 'transcriber' echoes the reference");
  assert.equal(dry.endToEnd!.reference.graded, 6, "the dry-run 'grader' goes through the real parser and combiner");
  assert.match(gradingPromptHash(), /^[0-9a-f]{16}$/);
  assert.equal(gradingPromptHash(), gradingPromptHash(), "deterministic");
  assert.match(GRADING_RUBRIC_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.deepEqual([classifyScore(80), classifyScore(60), classifyScore(10)], ["strong", "average", "poor"]);
});

test("the evaluator never touches the database or a student's quota", () => {
  for (const f of ["runner.ts", "manifest.ts", "text-metrics.ts", "grader-metrics.ts", "adapters.ts", "live.ts"]) {
    const src = readFileSync(path.join(process.cwd(), "src/lib/video-interview/eval", f), "utf8");
    assert.doesNotMatch(src, /getDb|@\/db\/|runAiFeature\(|sessions"|training-video|question-bank-db/, f);
  }
  const live = readFileSync(path.join(process.cwd(), "src/lib/video-interview/eval/live.ts"), "utf8");
  assert.match(live, /maxRetries: 0/, "SDK retries are off: every request is one the budget counted");
  assert.match(live, /budget\.begin\("anthropic"/);
  const cli = readFileSync(path.join(process.cwd(), "scripts/eval/video-interview-eval.ts"), "utf8");
  assert.doesNotMatch(cli, /console\.log\([^)]*referenceTranscript/, "the CLI never prints transcripts outside --debug");
});

// ---------- numbers and currency: precision, recall, F1 ----------

test("invented, missing and wrong numbers are all penalised", () => {
  const n = (r: string, h: string) => numberCounts(normalizeForWer(r), normalizeForWer(h));
  assert.deepEqual(n("growth of 5% and 7%", "growth of 5%"), { tp: 1, fp: 0, fn: 1 }, "missing");
  assert.deepEqual(n("growth of 5%", "growth of 6%"), { tp: 0, fp: 1, fn: 1 }, "incorrect");
  assert.deepEqual(n("growth of 5%", "growth of 5% in 2024 across 3 regions"), { tp: 1, fp: 2, fn: 0 }, "hallucinated extras cost precision");
  const c = (r: string, h: string) => currencyCounts(normalizeForWer(r), normalizeForWer(h));
  assert.deepEqual(c("$5 million", "5 million"), { tp: 0, fp: 0, fn: 1 }, "the amount without its unit is not a currency match");
  assert.deepEqual(c("$5 million", "$5 million and $2 million"), { tp: 1, fp: 1, fn: 0 });
});

// ---------- fillers ----------

test("fillers are matched by variant family, apart from WER", () => {
  assert.deepEqual(fillerTokens("Umm, so uhh I erm think, hmm, mm-hmm, yes"), ["um", "uh", "er", "hmm", "mhm"]);
  assert.deepEqual(fillerCounts("um so uh I think um", "umm so I think uh uh"), { tp: 2, fp: 1, fn: 1 });
  assert.deepEqual(normalizeForWer("umm so I think"), ["so", "i", "think"], "WER still drops them");
});

test("the filler metric is reported only for verbatim references", async () => {
  const m = manifest();
  const deps = { readMedia: async (i: ManifestItem) => ({ bytes: Buffer.from(i.id), contentType: "audio/wav", filename: "x" }), gradeCall: (async () => null) as ModelCall };
  const echo = { name: "echo", transcribe: async ({ bytes }: { bytes: Buffer }) => ({ text: m.items.find((i) => i.id === bytes.toString())!.referenceTranscript.replace(/\b(um|uh),?\s*/gi, ""), words: null }) };
  const verbatim = await runEvaluation(m, { ...deps, transcriber: echo }, { mode: "asr", runs: 1 }, {});
  assert.ok(verbatim.asr!.summary.fillers, "reported for verbatim fixtures");
  assert.equal(verbatim.asr!.summary.fillers!.recall, 0, "the transcriber dropped every filler");
  const stripped = clone(SYNTHETIC);
  for (const i of stripped.items) i.verbatimFillers = false;
  const v = validateManifest(stripped);
  assert.ok(v.ok);
  const plain = await runEvaluation(v.manifest, { ...deps, transcriber: echo }, { mode: "asr", runs: 1 }, {});
  assert.equal(plain.asr!.summary.fillers, null, "never inferred for references that omit fillers");
  const missing = clone(SYNTHETIC);
  delete missing.items[0].verbatimFillers;
  assert.ok(!validateManifest(missing).ok, "the annotation is required, not defaulted");
});

// ---------- two blind reviews, all pairs ----------

test("grader fixtures need two distinct blind reviews; agreement uses every pair", async () => {
  const one = clone(SYNTHETIC);
  one.items[0].reviews = one.items[0].reviews.slice(0, 1);
  const v1 = validateManifest(one);
  assert.ok(!v1.ok && v1.errors.some((e) => /at least two blind human reviews/.test(e)));
  const dup = clone(SYNTHETIC);
  dup.items[0].reviews[1].reviewer = dup.items[0].reviews[0].reviewer;
  assert.ok(!validateManifest(dup).ok, "the same reviewer twice is not two reviews");
  const named = clone(SYNTHETIC);
  named.items[0].reviews[0].reviewer = "Jane Smith";
  assert.ok(!validateManifest(named).ok, "pseudonymous codes only");

  const report = await runEvaluation(manifest(), dryRunDeps(manifest()), { mode: "grader", runs: 1 }, {});
  assert.equal(report.humanAgreement!.reviewPairs, 8, "five items x 1 pair + one item with three reviewers x 3 pairs");
});

// ---------- Earnings-21 licensing ----------

test("Earnings-21 media is not imported without a confirmed, release-specific audio licence", () => {
  const nlp = "token|speaker|ts|endTs|punctuation|case|tags|wer_tags\nHello|1||||UC|[]|[]\n";
  assert.throws(() => fromEarnings21(nlp, { fileId: "x", mediaPath: "m.mp3", audio: null }), LicenseConfirmationRequired);
  for (const missing of ["release", "audioLicense", "audioLicenseSource"] as const) {
    const audio = { release: "v1", audioLicense: "confirmed", audioLicenseSource: "https://example.test", [missing]: "  " };
    assert.throws(() => fromEarnings21(nlp, { fileId: "x", mediaPath: "m.mp3", audio }), LicenseConfirmationRequired, missing);
  }
  const ok = fromEarnings21(nlp, { fileId: "x", mediaPath: "m.mp3", audio: { release: "v1", audioLicense: "confirmed", audioLicenseSource: "https://example.test" } });
  const noVersion = clone(ok);
  noVersion.source.version = null;
  assert.ok(!validateManifest(wrap([noVersion])).ok, "a manifest entry without the release is rejected");
  const noSource = clone(ok);
  noSource.source.licenseSource = null;
  assert.ok(!validateManifest(wrap([noSource])).ok, "and without where the licence was confirmed");
  const training = clone(ok);
  training.permittedUse = "both";
  assert.ok(!validateManifest(wrap([training])).ok, "and it stays evaluation-only");
});

// ---------- the request budget ----------

test("the budget refuses a request before it would exceed the limit, and counts every kind", async () => {
  const b = new RequestBudget(3);
  b.begin("transcription").ok();
  b.begin("anthropic").fail();
  b.begin("anthropic", "retry").ok();
  assert.throws(() => b.begin("anthropic", "fallback"), RequestLimitReached);
  const s = b.summary();
  assert.deepEqual([s.attempted, s.succeeded, s.failed, s.retried, s.fallback, s.refusedByLimit], [3, 2, 1, 1, 0, 1]);
  assert.equal(s.byProvider.transcription.attempted, 1);

  let fetched = 0;
  const fetch = new RequestBudget(1).countingFetch("transcription", (async () => (fetched++, new Response("{}"))) as typeof globalThis.fetch);
  await fetch("https://stt.example.test");
  await assert.rejects(fetch("https://stt.example.test"), RequestLimitReached);
  assert.equal(fetched, 1, "the refused request was never sent");
});

/** A fake Anthropic client: fails the first `fail` calls with a capacity error. */
function fakeClient(fail: number, calls: { model: string; maxRetries: unknown }[]) {
  return () => ({
    messages: {
      parse: async (params: { model: string }, options?: { maxRetries?: number }) => {
        calls.push({ model: params.model, maxRetries: options?.maxRetries });
        if (calls.length <= fail) throw Object.assign(new Error("overloaded"), { capacity: true });
        return { model: params.model, stop_reason: "end_turn", parsed_output: GOOD_JUDGEMENT, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  }) as never;
}
const capacity = (e: unknown) => Boolean((e as { capacity?: boolean })?.capacity);
const noSleep = async () => {};

test("evaluator Claude calls: SDK retries off; retries and fallbacks counted explicitly", async () => {
  const calls: { model: string; maxRetries: unknown }[] = [];
  const b = new RequestBudget(10);
  const observed = new Map<string, number>();
  const call = evalGradeCall("free", observed, b, { client: fakeClient(3, calls), isRetryable: capacity, sleep: noSleep, retriesPerModel: 1 });
  const out = await call({ userId: "x", kind: "technical", system: "s", user: "u" });
  assert.deepEqual(out, GOOD_JUDGEMENT);
  assert.ok(calls.every((c) => c.maxRetries === 0), "no hidden SDK retries");
  assert.equal(calls.length, 4, "first try, retry, fallback, fallback's retry");
  assert.notEqual(calls[0].model, calls[2].model, "the third request went to the fallback model");
  const s = b.summary();
  assert.deepEqual([s.attempted, s.succeeded, s.failed, s.retried, s.fallback], [4, 1, 3, 2, 1]);
  assert.equal([...observed.values()].reduce((a, n) => a + n, 0), 1);
});

test("hitting the limit mid-case stops before the next request, and the run reports it", async () => {
  const calls: { model: string; maxRetries: unknown }[] = [];
  const b = new RequestBudget(2);
  const call = evalGradeCall("free", new Map(), b, { client: fakeClient(99, calls), isRetryable: capacity, sleep: noSleep });
  await assert.rejects(call({ userId: "x", kind: "technical", system: "s", user: "u" }), RequestLimitReached);
  assert.equal(calls.length, 2, "exactly the limit - the third request was never started");

  const m = manifest();
  const budget = new RequestBudget(3);
  const gradeCall = evalGradeCall("free", new Map(), budget, { client: fakeClient(0, []), isRetryable: capacity, sleep: noSleep });
  const report = await runEvaluation(m, { ...dryRunDeps(m), gradeCall, budget }, { mode: "grader", runs: 1 }, {});
  assert.deepEqual(report.incomplete, { reason: "request limit reached", limit: 3 });
  assert.equal(report.cases!.completed.grading, 3, "three cases done, the rest not started");
  assert.equal(report.cases!.planned.grading, 6);
  assert.equal(report.grader!.primary.items, 3, "metrics cover completed cases only");
  assert.equal(report.grader!.primary.outcomeRates.model_error, undefined, "the refused case is not scored as a model error");
  assert.equal(report.requests!.attempted, 3);
  assert.equal(report.requests!.refusedByLimit, 1);
});

// ---------- delivery-signal accuracy ----------

import { analyzeDelivery, computeDeliveryMetrics, detectDisfluencies, detectFillers, tokenize } from "@/lib/video-interview/delivery-metrics";
import { evaluateDeliveryItem, matchPauses, summarizeDelivery } from "@/lib/video-interview/eval/delivery-eval";
import { renderMarkdown } from "@/lib/video-interview/eval/live";

const MIXED = () => clone(manifest().items.find((i) => i.id === "syn.delivery.mixed-01")!);
const timed = (text: string, gapAfter: Record<number, number> = {}) => {
  let t = 0;
  return text.split(/\s+/).filter(Boolean).map((word, i) => {
    const w = { word, start: t, end: t + 0.3 };
    t += 0.4 + (gapAfter[i] ?? 0);
    return w;
  });
};

test("production and evaluation share one filler definition, contextual 'like' included", () => {
  const labels = (s: string) => detectFillers(tokenize(s)).map((f) => f.label);
  assert.deepEqual(labels("I like numbers and would like more, it looks like a win"), [], "verb and comparison 'like' are not fillers");
  assert.deepEqual(labels("it was, like, fine"), ["like"]);
  assert.deepEqual(labels("Basically it worked. We basically won."), ["basically"], "only clause-opening 'basically'");
  assert.deepEqual(labels("um actually it was sort of odd, you know what i mean"), ["um", "actually", "sort of", "you know what i mean"], "the long phrase once, no inner 'i mean'");
  assert.deepEqual(labels("umm uhh erm"), ["um", "uh", "er"], "spellings fold to their family");
  const text = "Um so I I think, like, you know, we won";
  assert.deepEqual(computeDeliveryMetrics({ transcript: text, durationMs: 10_000 }), analyzeDelivery({ transcript: text, durationMs: 10_000 }).metrics, "production metrics are the analysis' metrics");
});

test("missed and invented fillers are scored against the human annotation, never the transcript", () => {
  const item = MIXED();
  const ref = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: null }, { timing: false })!;
  assert.deepEqual([ref.fillers!.tp, ref.fillers!.fp, ref.fillers!.fn], [5, 0, 0], "on the verified text the detectors agree with the annotation");
  // ASR dropped "um" and the filler "like", and invented an "uh".
  const asrText = item.referenceTranscript.replace("um, ", "").replace(", like,", "").replace("I like the model", "uh I like the model");
  const asr = evaluateDeliveryItem(item, { text: asrText, words: null })!;
  assert.deepEqual([asr.fillers!.tp, asr.fillers!.fp, asr.fillers!.fn], [3, 1, 2]);
  assert.equal(asr.fillers!.byLabel.um.fn, 1, "missed um");
  assert.equal(asr.fillers!.byLabel.like.fn, 1, "missed filler like");
  assert.equal(asr.fillers!.byLabel.uh.fp, 1, "invented uh");
  assert.equal(asr.fillers!.byLabel.like.fp, 0, "'I like the model' is correctly not a filler");
});

test("repeated words and cut-off words are typed; ASR tidying is caught", () => {
  assert.deepEqual(detectDisfluencies(tokenize("I I think th- the model and co company")).map((d) => d.type), ["repetition", "cutoff", "cutoff"]);
  const item = MIXED();
  // The ASR merged "I I" and wrote the cut-off "th- the" as "the the".
  const asrText = item.referenceTranscript.replace("I I think", "I think").replace("Th- the model", "the the model");
  const r = evaluateDeliveryItem(item, { text: asrText, words: null })!;
  assert.equal(r.disfluencies!.cutoff.fn, 1, "the cut-off was lost");
  assert.equal(r.disfluencies!.repetition.fn, 1, "'I I' was merged away");
  assert.equal(r.disfluencies!.repetition.fp, 1, "and 'the the' appeared instead of the cut-off");
  assert.deepEqual([r.repeatedPhrases!.tp, r.repeatedPhrases!.fn], [1, 0]);
});

test("pause boundaries: within tolerance matches, beyond it is a miss and a false alarm", () => {
  const ref = [{ start: 6, end: 9.5, duration: 3.5, long: true }];
  assert.equal(matchPauses([{ start: 6.3, end: 9.2, duration: 2.9, long: false }], ref).tp, 1, "0.3s boundary error matches");
  const off = matchPauses([{ start: 6.8, end: 9.5, duration: 2.7, long: false }], ref);
  assert.deepEqual([off.tp, off.fp, off.fn], [0, 1, 1], "a 0.8s boundary error does not");
  assert.equal(matchPauses([{ start: 20, end: 22, duration: 2, long: false }], ref).tp, 0, "no overlap, no match");

  const item = MIXED();
  const words = item.referenceTranscript.split(/\s+/);
  // Pause after word 14 at ~6.0s? Build timings so a 3.5s gap starts at 6.0s.
  const idx = words.findIndex((_, i) => i * 0.4 + 0.3 >= 5.9);
  const asr = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: timed(item.referenceTranscript, { [idx]: 3.6 }) })!;
  assert.equal(asr.timed, true);
  assert.equal(asr.pauses!.tp, 1, "the long pause is found");
  assert.equal(asr.pauses!.long.tp, 1, "and counted as long");
  assert.ok(asr.pauses!.boundaryErrors[0] <= 0.5);
});

test("missing timestamps: timing signals cannot be measured, and annotated pauses count as missed", () => {
  const item = MIXED();
  const noTimes = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: null })!;
  assert.equal(noTimes.timed, false);
  assert.deepEqual([noTimes.pauses!.tp, noTimes.pauses!.fn], [0, 1]);
  const summary = summarizeDelivery([noTimes]);
  assert.equal(summary.pauses!.itemsWithoutTimestamps, 1);
  const onRef = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: null }, { timing: false })!;
  assert.equal(onRef.pauses, null, "the verified transcript has no timings: pauses are not scored there");
  assert.equal(onRef.wpm, null);
  assert.equal(onRef.scores.pacePauses, null);
});

test("no annotation, no delivery metric - nothing is inferred from a transcript", () => {
  const item = MIXED();
  item.delivery = null;
  assert.equal(evaluateDeliveryItem(item, { text: item.referenceTranscript, words: null }), null);
  const partial = MIXED();
  partial.delivery = { verifiedBy: "human", method: "test", fillers: ["um"] };
  const r = evaluateDeliveryItem(partial, { text: "um well", words: null })!;
  assert.ok(r.fillers);
  assert.equal(r.pauses, null);
  assert.equal(r.disfluencies, null);
  assert.equal(r.repeatedPhrases, null);
  assert.equal(r.scores.fillers, null, "the filler score needs fillers AND repeated phrases AND a speaking time");
  const bad = clone(SYNTHETIC);
  bad.items.find((i: { id: string }) => i.id === "syn.delivery.mixed-01").delivery.pauses = [{ startSec: 1, endSec: 1.4 }];
  assert.ok(!validateManifest(bad).ok, "an annotated 'pause' shorter than the production threshold is rejected");
  const badLabel = clone(SYNTHETIC);
  badLabel.items.find((i: { id: string }) => i.id === "syn.delivery.mixed-01").delivery.fillers = ["uhm-ish"];
  assert.ok(!validateManifest(badLabel).ok, "filler labels are production's labels");
});

test("timestamp errors change the pace/pauses score, measured with production's scoring", () => {
  const item = MIXED();
  const idx = item.referenceTranscript.split(/\s+/).findIndex((_, i) => i * 0.4 + 0.3 >= 5.9);
  const good = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: timed(item.referenceTranscript, { [idx]: 3.6 }) })!;
  // The same speech with the provider inventing two extra long gaps AFTER the
  // real pause (earlier ones would shift every later timestamp as well).
  const bad = evaluateDeliveryItem(item, { text: item.referenceTranscript, words: timed(item.referenceTranscript, { [idx]: 3.6, [idx + 8]: 4, [idx + 14]: 4 }) })!;
  assert.ok(good.scores.pacePauses && bad.scores.pacePauses);
  assert.equal(good.scores.pacePauses!.reference, bad.scores.pacePauses!.reference, "the reference score comes from the annotation only");
  const errGood = Math.abs(good.scores.pacePauses!.predicted! - good.scores.pacePauses!.reference!);
  const errBad = Math.abs(bad.scores.pacePauses!.predicted! - bad.scores.pacePauses!.reference!);
  assert.ok(errBad > errGood, `invented pauses move the score further from the human-derived one (${errGood} -> ${errBad})`);
  assert.deepEqual([bad.pauses!.tp, bad.pauses!.fp, bad.pauses!.fn], [1, 2, 0], "the real pause still matches; two invented");
  const s = summarizeDelivery([good, bad]);
  assert.equal(s.scoreError.pacePauses!.items, 2);
  assert.ok(s.scoreError.fillers, "the filler score error is reported too");
});

test("reports keep transcript, delivery, grading and end-to-end accuracy separate", async () => {
  const m = manifest();
  const report = await runEvaluation(m, dryRunDeps(m), { mode: "end-to-end", runs: 1 }, {});
  assert.ok(report.asr && report.delivery && report.endToEnd);
  assert.ok(report.delivery.onReferenceTranscript && report.delivery.onAsrTranscript, "both transcripts, reported apart");
  const md = renderMarkdown({ ...report, meta: { timestamp: "t", code: {}, manifest: { name: "n", sha256: "0".repeat(64), items: 7 }, transcription: {}, grader: { models: {} } } } as never);
  const order = ["## 1. Transcript accuracy", "## 2. Delivery-signal accuracy", "## 3. Claude grading accuracy", "## 4. End-to-end grade accuracy"].map((h) => md.indexOf(h));
  assert.ok(order.every((i) => i >= 0), "all four sections present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
  assert.ok(!JSON.stringify(report).includes("margin going up"), "no transcript text without --debug");
});

// ---------- delivery annotation integrity ----------

const withDelivery = (edit: (d: Record<string, unknown>, item: Record<string, unknown>) => void) => {
  const m = clone(SYNTHETIC);
  const item = m.items.find((i: { id: string }) => i.id === "syn.delivery.mixed-01");
  edit(item.delivery, item);
  return validateManifest(m);
};
const rejects = (v: ReturnType<typeof validateManifest>, re: RegExp) => assert.ok(!v.ok && v.errors.some((e) => re.test(e)), v.ok ? "accepted" : v.errors.join("; "));

test("annotated pauses must run forwards, fit the recording, and be in order without overlap", () => {
  rejects(withDelivery((d) => (d.pauses = [{ startSec: 9.5, endSec: 6 }])), /runs backwards/);
  rejects(withDelivery((d) => (d.pauses = [{ startSec: 6, endSec: 6 }])), /runs backwards or has no length/);
  rejects(withDelivery((d) => (d.pauses = [{ startSec: 18.5, endSec: 21 }])), /outside the recording/, );
  rejects(withDelivery((d) => (d.pauses = [{ startSec: -1, endSec: 1 }])), /./);
  rejects(withDelivery((d) => (d.pauses = [{ startSec: 2, endSec: 5 }, { startSec: 4, endSec: 7 }])), /overlaps/);
  rejects(withDelivery((d) => (d.pauses = [{ startSec: 10, endSec: 12 }, { startSec: 2, endSec: 4 }])), /out of chronological order/);
  assert.ok(withDelivery((d) => (d.pauses = [{ startSec: 2, endSec: 4 }, { startSec: 4, endSec: 6 }])).ok, "back-to-back pauses are fine");
});

test("speaking time must fit the recording, and WPM must agree with it", () => {
  rejects(withDelivery((d) => (d.speakingSec = 25)), /longer than the recording/);
  // 37 verified words over 18s implies ~123 wpm.
  const words = tokenize(MIXED().referenceTranscript).length;
  const implied = (words / 18) * 60;
  rejects(withDelivery((d) => (d.wordsPerMinute = Math.round(implied * 1.4))), /contradicts/);
  assert.ok(withDelivery((d) => (d.wordsPerMinute = Math.round(implied * 1.05))).ok, "within tolerance");
  assert.ok(withDelivery((d) => (delete d.speakingSec, (d.wordsPerMinute = 200))).ok, "WPM alone has nothing to contradict");
});

test("only annotation mistakes are rejected as duplicates, not repeated events", () => {
  rejects(withDelivery((d) => (d.repeatedPhrases = [{ phrase: "the margin going up", count: 3 }, { phrase: "The margin going up", count: 3 }])), /more than once/);
  assert.ok(withDelivery((d) => (d.fillers = ["um", "um", "like", "um"])).ok, "the same filler many times is normal");
  assert.ok(withDelivery((d) => (d.disfluencies = [{ type: "repetition", text: "I I" }, { type: "repetition", text: "I I" }])).ok, "so is the same stumble twice");
  rejects(withDelivery((d, item) => (item.durationSec = null)), /needs durationSec|durationSec/);
});

// ---------- delivery across ASR runs ----------

test("delivery is evaluated for every ASR run, with per-run rows, variability and failures by run", async () => {
  const m = manifest();
  const n = selectItems(m, "asr").length;
  const mixedId = "syn.delivery.mixed-01";
  let call = 0;
  const transcriber = {
    name: "per-run",
    transcribe: async ({ bytes }: { bytes: Buffer }) => {
      const run = Math.floor(call++ / n);
      const item = m.items.find((i) => i.id === bytes.toString())!;
      if (run === 2 && item.id === mixedId) throw new Error("provider hiccup");
      // Run 1 drops every "um"; runs 0 and 2 are faithful.
      return { text: run === 1 ? item.referenceTranscript.replace(/\bum,?\s*/gi, "") : item.referenceTranscript, words: null };
    },
  };
  const deps = { ...dryRunDeps(m), transcriber };
  const report = await runEvaluation(m, deps, { mode: "asr", runs: 3 }, {});
  const d = report.delivery!;
  assert.equal(d.asrRuns.length, 3, "every run, not only run 0");
  assert.deepEqual(d.asrRuns.map((r) => r.failedTranscriptions), [[], [], [mixedId]], "the failure belongs to run 3");
  assert.equal(d.failedTranscriptionsExcluded, 1);
  assert.deepEqual(d.asrRuns.map((r) => r.items), [4, 4, 3]);
  assert.equal(d.asrRuns[0].fillerF1, 1);
  assert.ok(d.asrRuns[1].fillerF1! < 1, "run 2 lost its fillers");
  assert.ok(d.acrossRuns.fillerF1 && d.acrossRuns.fillerF1.range > 0 && d.acrossRuns.fillerF1.stdDev > 0, "and the instability is visible");
  for (const k of ["wpmMae", "pauseF1", "fillerF1", "repetitionF1", "repeatedPhraseF1", "disfluencyF1", "paceScoreMae", "fillerScoreMae"] as const) assert.ok(k in d.asrRuns[0], k);
  assert.equal(d.onAsrTranscript!.items, 11, "the aggregate pools all runs' evaluations");

  // The verified-transcript side is a single computation, whatever --runs is.
  const once = await runEvaluation(m, { ...dryRunDeps(m) }, { mode: "asr", runs: 1 }, {});
  assert.deepEqual(d.onReferenceTranscript, once.delivery!.onReferenceTranscript);
  assert.equal(once.delivery!.acrossRuns.fillerF1, null, "no spread from a single run");
});
