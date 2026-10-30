/**
 * Offerly video interview evaluation. See docs/VIDEO_INTERVIEW_EVALUATION.md.
 *
 *   npm run eval:video -- --mode grader --estimate            # counts only
 *   npm run eval:video -- --mode end-to-end                   # no-cost dry run (stubs)
 *   npm run eval:video -- --mode grader --live --max-calls 10 --max-items 5
 *
 * Without --live nothing leaves this machine: the providers are stubs and the
 * report is marked DRY RUN. With --live, --max-calls must be at least the
 * estimated number of calls, or the run refuses to start.
 *
 * Privacy: the console shows fixture counts and aggregate metrics only.
 * Transcripts and feedback appear (console and JSON) only with --debug, which
 * is for local inspection - never share a --debug report. Nothing is written
 * to Offerly's database; model calls use no student's account or quota.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateManifest } from "../../src/lib/video-interview/eval/manifest";
import { dryRunDeps, estimateCalls, runEvaluation, selectItems, type EvalDeps, type EvalMode } from "../../src/lib/video-interview/eval/runner";
import { evalGradeCall, renderMarkdown, reportMeta } from "../../src/lib/video-interview/eval/live";
import { RequestBudget } from "../../src/lib/video-interview/eval/budget";
import { OpenAICompatibleTranscriber, transcriptionConfigFromEnv } from "../../src/lib/video-interview/transcription";

const ROOT = process.cwd();
const DEFAULT_MANIFEST = "scripts/eval/fixtures/synthetic-manifest.json";
const DEFAULT_OUT = "local-data/eval-reports";
/** OpenAI's and Groq's upload ceiling for one transcription request. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg" };

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "usage: npm run eval:video -- --mode asr|grader|end-to-end [options]",
      "  --manifest <file>   manifest JSON (default: synthetic fixtures)",
      "  --estimate          print the API calls a run would make, then exit",
      "  --live              make real API calls (otherwise: no-cost dry run with stubs)",
      "  --max-calls <n>     required with --live: the hard cap on actual provider requests",
      "                      (every transcription fetch, Claude attempt, retry and fallback)",
      "  --runs <n>          identical runs, for repeatability (1-10, default 1)",
      "  --max-items <n>     only the first n items (cheap smoke runs)",
      "  --plan free|pro     which plan's model routing to evaluate (default free)",
      "  --out <dir>         report directory (default local-data/eval-reports)",
      "  --debug             include transcripts and feedback - LOCAL ONLY",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const a: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) usage(`unexpected argument ${k}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      a[k.slice(2)] = next;
      i++;
    }
    else a[k.slice(2)] = true;
  }
  const known = new Set(["mode", "manifest", "estimate", "live", "max-calls", "runs", "max-items", "plan", "out", "debug"]);
  for (const k of Object.keys(a)) if (!known.has(k)) usage(`unknown option --${k}`);
  const mode = a.mode as EvalMode;
  if (!["asr", "grader", "end-to-end"].includes(mode)) usage("--mode must be asr, grader or end-to-end");
  const int = (k: string, lo: number, hi: number, dflt?: number) => {
    if (a[k] === undefined) return dflt;
    const n = Number(a[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) usage(`--${k} must be an integer from ${lo} to ${hi}`);
    return n;
  };
  const plan = (a.plan ?? "free") as "free" | "pro";
  if (plan !== "free" && plan !== "pro") usage("--plan must be free or pro");
  const out = path.resolve(ROOT, String(a.out ?? DEFAULT_OUT));
  for (const forbidden of ["src", "public", "scripts", "drizzle"]) {
    if (out === path.join(ROOT, forbidden) || out.startsWith(path.join(ROOT, forbidden) + path.sep)) usage(`--out may not be inside ${forbidden}/ - reports stay out of the codebase`);
  }
  return {
    mode,
    manifest: path.resolve(ROOT, String(a.manifest ?? DEFAULT_MANIFEST)),
    estimate: a.estimate === true,
    live: a.live === true,
    maxCalls: int("max-calls", 1, 100_000),
    runs: int("runs", 1, 10, 1)!,
    maxItems: int("max-items", 1, 100_000),
    plan,
    out,
    debug: a.debug === true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawText = readFileSync(args.manifest, "utf8");
  const validation = validateManifest(JSON.parse(rawText), { requireMedia: args.live && args.mode !== "grader" });
  if (!validation.ok) {
    console.error(`Manifest rejected (${validation.errors.length} problem(s)):`);
    for (const e of validation.errors.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }
  const manifest = validation.manifest;
  const items = selectItems(manifest, args.mode, args.maxItems);
  const estimate = estimateCalls(items, args.mode, args.runs);
  console.log(
    `[eval] ${args.mode}: ${estimate.items} item(s) x ${args.runs} run(s) -> ${estimate.asrCases} transcription + ${estimate.gradingCases} grading case(s); ` +
      `at least ${estimate.minimumRequests} provider request(s) (retries and fallbacks add more, capped by --max-calls), ~${estimate.audioMinutes} audio min`,
  );
  if (args.estimate) return;
  if (estimate.items === 0) {
    console.log("[eval] no items in this manifest fit this mode.");
    return;
  }

  let deps: EvalDeps;
  const observed = new Map<string, number>();
  if (args.live) {
    if (args.maxCalls === undefined || args.maxCalls < estimate.minimumRequests) {
      usage(`--live needs --max-calls >= ${estimate.minimumRequests} (one request per case, before any retry). Nothing was sent.`);
    }
    const stt = transcriptionConfigFromEnv();
    if (args.mode !== "grader" && !stt) usage("--live asr/end-to-end needs TRANSCRIPTION_API_KEY (server env). Nothing was sent.");
    if (args.mode !== "asr" && !process.env.ANTHROPIC_API_KEY) usage("--live grader/end-to-end needs ANTHROPIC_API_KEY. Nothing was sent.");
    const manifestDir = path.dirname(args.manifest);
    // Every outbound request - transcription fetches, and each Claude
    // attempt, retry and fallback - claims one from this budget first.
    const budget = new RequestBudget(args.maxCalls);
    deps = {
      budget,
      transcriber: stt
        ? new OpenAICompatibleTranscriber(stt, budget.countingFetch("transcription"))
        : { name: "none", transcribe: async () => { throw new Error("unconfigured"); } },
      gradeCall: evalGradeCall(args.plan, observed, budget),
      readMedia: async (item) => {
        const abs = path.resolve(manifestDir, item.mediaPath!);
        if (!abs.startsWith(manifestDir + path.sep)) throw new Error("media outside manifest directory");
        const type = MEDIA_TYPES[path.extname(abs).toLowerCase()];
        if (!type) throw new Error("unsupported media type");
        const bytes = readFileSync(abs);
        if (bytes.length > MAX_MEDIA_BYTES) throw new Error("media over 25MB");
        return { bytes, contentType: type, filename: path.basename(abs) };
      },
    };
    console.log(`[eval] LIVE: external API calls will be made - at most ${args.maxCalls} request(s), counted individually.`);
  } else {
    deps = dryRunDeps(manifest);
    console.log("[eval] DRY RUN: stub providers, no network. Metrics are not meaningful.");
  }

  const meta: Record<string, unknown> = reportMeta({
    mode: args.mode,
    runs: args.runs,
    plan: args.plan,
    manifestName: manifest.name,
    manifestSha256: createHash("sha256").update(rawText).digest("hex"),
    items: estimate.items,
    dryRun: !args.live,
  });
  const report = await runEvaluation(manifest, deps, { mode: args.mode, runs: args.runs, maxItems: args.maxItems, debug: args.debug }, meta);
  if (observed.size) report.meta.modelsObserved = Object.fromEntries(observed);

  mkdirSync(args.out, { recursive: true });
  const stamp = String(report.meta.timestamp).replace(/[:.]/g, "-");
  const base = path.join(args.out, `${args.mode}-${stamp}${args.live ? "" : "-dryrun"}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(report));

  // Aggregates only.
  if (report.asr) {
    const a = report.asr.summary;
    console.log(`[eval] ASR corpus WER ${a.corpusWer ?? "-"}, failed ${a.failedRate ?? "-"}, number F1 ${a.numbers.f1 ?? "-"}, currency F1 ${a.currency.f1 ?? "-"}, filler F1 ${a.fillers?.f1 ?? "n/a (no verbatim references)"}`);
  }
  const g = report.grader?.primary ?? report.endToEnd?.reference;
  if (g) console.log(`[eval] grader (reference transcript) MAE ${g.overallMae ?? "-"}, Spearman ${g.spearman ?? "-"}, macro-F1 ${g.classMacroF1 ?? "-"}`);
  if (report.endToEnd) console.log(`[eval] end-to-end MAE ${report.endToEnd.asrTranscript.overallMae ?? "-"} (delta ${report.endToEnd.delta.overallMaeDelta ?? "-"})`);
  if (report.humanAgreement) console.log(`[eval] human-human MAE ${report.humanAgreement.overallMae ?? "-"} over ${report.humanAgreement.reviewPairs} reviewer pair(s)`);
  if (args.debug && report.debug) {
    console.log("[eval] --debug: per-case details (local only):");
    for (const d of report.debug) console.log(JSON.stringify(d));
  }
  if (report.requests) {
    const q = report.requests;
    console.log(`[eval] requests: ${q.attempted} attempted of ${q.limit} allowed (${q.succeeded} ok, ${q.failed} failed, ${q.retried} retries, ${q.fallback} fallbacks, ${q.refusedByLimit} refused by the limit)`);
  }
  if (report.incomplete) console.log(`[eval] STOPPED EARLY: ${report.incomplete.reason}. Metrics cover completed cases only (${JSON.stringify(report.cases?.completed)}).`);
  console.log(`[eval] wrote ${path.relative(ROOT, base)}.json and .md`);
}

main().catch((err) => {
  // The message only - an error object can carry request details.
  console.error("[eval] failed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
