// Drafts a spread of multi-box situations with the REAL models - draft, then
// review - and grades both versions with the simulations' checks, so the review
// pass's effect is measured rather than assumed.
//
//   npx tsx --conditions=react-server --env-file=.env.local scripts/draft-live-eval.ts [reportFile]
//   npx tsx --conditions=react-server --env-file=.env.local scripts/draft-live-eval.ts out.md --concurrency=1 --json=t.json
//
// This spends API credits (about $1-3 for the 20 situations on Sonnet 5), which
// is why it is the only script in scripts/ that calls the API. It never touches
// the database or anyone's quota.
//
// LATENCY. Everything else this project times runs on the `claude` CLI, which
// has no `effort`, no `thinking` setting and no fast mode, so every timing in
// docs/concepts is transport, not the paid path a student waits on. This script
// is the only one that runs `runDraftPipeline` with the real `ModelConfig`, so
// it is the only place the production number can come from. It now reports
// `PipelineTimings` - draft, lint, review and the guard's retry, split.
//
//   --concurrency=N  calls in flight (default 4). **Pass 1 for a timing run**:
//                    four requests on one key queue behind each other, and a
//                    queued call's duration is not the latency a student sees.
//   --json=<path>    the per-scenario timings and their distribution.
//   --limit=N        only the first N of the 20 situations, for a smoke run.
//   --draft-model=<id>  --draft-effort=<level>  --draft-thinking=<mode>
//                    override the DRAFT call. `between_tools` is the only way to
//                    run Claude Sonnet 5.5 with thinking off - it rejects
//                    `disabled`, which is what blocks bumping eleven registry rows
//                    to the 5.5 generation. Always run a control arm in the same
//                    sitting.
//   --review-effort=low|medium|high|xhigh|max
//   --review-thinking=adaptive|disabled
//                    override the REVIEW call's config. The review is ~72% of
//                    the wait and ~79% of the output tokens, and it is the only
//                    call in the pipeline that runs at medium effort with
//                    adaptive thinking - so this is the one knob worth turning,
//                    and the CLI rig cannot see it at all. Always run a control
//                    arm in the same sitting: API latency varies with load.
//   --drafts-json=<path>
//                    the emails in `draft-cli-eval.ts --json` shape, so
//                    `draft-reply-grader.ts` can grade what the PAID path
//                    actually wrote. Free: the grader runs on the subscription.

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { draftIssues, sims } from "./draft-occasions-sim";
import { situationTypes } from "../src/lib/draft-occasions";
import { runDraftPipeline, type PipelineResult, type PipelineTimings } from "../src/lib/draft-pipeline";
import { getModelConfig, getSubCallConfig, type Effort, type ModelConfig, type Thinking } from "../src/lib/model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

// Read from the registry, not copied from it. This used to be a literal with
// the comment "not importable here: it's server-only" - true only because this
// script was the one that ran without --conditions=react-server. A rig whose
// whole job is measuring the production config must not keep its own copy of
// it; that is how the review's config went a month unexamined.
/** The registry's free-tier draft config, before any --draft-* override. */
const DRAFT_BASE: ModelConfig = getModelConfig("draft", "free");
// Sonnet 5, per million tokens.
const PRICE = { input: 2, output: 10 };

const PICKS: [profile: "full" | "sparse", boxes: string[]][] = [
  ["full", ["first.alum", "first.recruiter"]],
  ["full", ["first.alum", "first.referred"]],
  ["full", ["first.recruiter", "first.referred"]],
  ["full", ["first.alum", "first.met"]],
  ["full", ["first.met", "first.referred"]],
  ["full", ["first.alum", "first.met", "first.recruiter", "first.referred"]],
  ["full", ["first.conference", "first.recruiter"]],
  ["full", ["first.alum", "first.pointed"]],
  ["full", ["first.alum", "first.met", "first.pointed", "first.recruiter"]],
  ["full", ["first.conference", "first.pointed"]],
  ["full", ["thanks.chat", "thanks.helped"]],
  ["full", ["thanks.event", "thanks.helped"]],
  ["full", ["stay.congrats", "stay.update"]],
  ["full", ["stay.referrer", "stay.update"]],
  ["full", ["stay.congrats", "stay.referrer"]],
  ["full", ["stay.congrats", "stay.redirected", "stay.update"]],
  ["full", ["stay.referrer", "stay.second", "stay.update"]],
  ["sparse", ["first.not_alum", "first.recruiter"]],
  ["sparse", ["first.met", "first.referred"]],
  ["sparse", ["stay.redirected", "stay.second"]],
];

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Run with --env-file=.env.local.");
  const all = sims();
  // --limit exists so a smoke run can prove the script end to end for a few
  // cents before the full set is paid for.
  const limit = flag("limit") === null ? PICKS.length : Math.max(1, Number(flag("limit")));
  const chosen = PICKS.slice(0, limit).map(([profile, boxes]) => {
    const key = [...boxes].sort().join("+");
    const sim = all.find((s) => s.profile === profile && [...s.ids].sort().join("+") === key);
    if (!sim) throw new Error(`no simulation for ${profile} ${key}`);
    return sim;
  });

  // The DRAFT's config, overridable, so a model move can be measured before it
  // is decided. `--draft-thinking=between_tools` is the only way to run Claude
  // Sonnet 5.5 with thinking off: it rejects `disabled`, which is why eleven
  // registry rows cannot simply be bumped to the 5.5 generation. The guards in
  // lib/model-registry refuse a mode the chosen model would reject, so a typo
  // here fails before a request is sent rather than after.
  const draftConfig: ModelConfig = {
    ...DRAFT_BASE,
    ...(flag("draft-model") ? { model: flag("draft-model")! } : {}),
    ...(flag("draft-effort") ? { effort: flag("draft-effort") as Effort } : {}),
    ...(flag("draft-thinking") ? { thinking: flag("draft-thinking") as Thinking } : {}),
  };
  const draftOverridden = Boolean(flag("draft-model") || flag("draft-effort") || flag("draft-thinking"));
  if (draftOverridden)
    console.log(`draft config overridden: ${draftConfig.model}, effort ${draftConfig.effort}, thinking ${draftConfig.thinking}`);

  // The review's config, overridable, because it is the expensive call.
  const reviewEffort = flag("review-effort") as Effort | null;
  const reviewThinking = flag("review-thinking") as Thinking | null;
  const reviewConfig: ModelConfig = {
    ...DRAFT_REVIEW_CONFIG,
    ...(reviewEffort ? { effort: reviewEffort } : {}),
    ...(reviewThinking ? { thinking: reviewThinking } : {}),
  };
  if (reviewEffort || reviewThinking)
    console.log(`review config overridden: effort ${reviewConfig.effort}, thinking ${reviewConfig.thinking}`);

  const client = new Anthropic();
  const results: { sim: (typeof chosen)[number]; result?: PipelineResult; error?: string }[] = [];
  // Four at a time by default: fast enough, and well under rate limits. One at
  // a time for a timing run, so no call's duration includes another's queue.
  const concurrency = Math.max(1, Number(flag("concurrency") ?? 4));
  for (let i = 0; i < chosen.length; i += concurrency) {
    const batch = await Promise.all(
      chosen.slice(i, i + concurrency).map(async (sim) => {
        try {
          return { sim, result: await runDraftPipeline(client, sim.input, { draft: draftConfig, review: reviewConfig }) };
        } catch (err) {
          return { sim, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    results.push(...batch);
    console.log(`${results.length}/${chosen.length} drafted`);
  }

  let before = 0;
  let after = 0;
  let applied = 0;
  const timed: { id: string; profile: string; t: PipelineTimings }[] = [];
  // Shaped exactly like draft-cli-eval's --json so draft-reply-grader.ts reads
  // it unchanged: same keys, same meanings, `leadType` included because
  // ASK_SHAPE needs it to pick the right metric.
  const forGrader: Record<string, unknown>[] = [];
  const tokens = { input: 0, output: 0 };
  const report: string[] = ["# Live draft evaluation", ""];
  for (const { sim, result, error } of results) {
    report.push(`## ${sim.id} [${sim.profile}] ${sim.situation.summary}`, "");
    if (!result) {
      report.push(`ERROR: ${error}`, "");
      continue;
    }
    tokens.input += result.usage.input_tokens;
    tokens.output += result.usage.output_tokens;
    timed.push({ id: sim.id, profile: sim.profile, t: result.timings });
    forGrader.push({
      id: sim.id,
      profile: sim.profile,
      boxes: [...sim.ids].sort(),
      summary: sim.situation.summary,
      leadType: situationTypes(sim.situation)[0].id,
      ok: true,
      subject: result.draft.subject,
      body: result.draft.body,
      preReviewSubject: result.preReview.subject,
      preReviewBody: result.preReview.body,
      timings: result.timings,
    });
    const pre = draftIssues(sim, { ...result.preReview, notes: [] });
    const post = draftIssues(sim, { subject: result.draft.subject, body: result.draft.body, notes: [] });
    before += pre.length;
    after += post.length;
    if (result.review?.applied) applied++;
    report.push(
      `### Draft (${pre.length} check findings)`,
      pre.map((i) => `- ${i}`).join("\n"),
      "```",
      `Subject: ${result.preReview.subject}\n\n${result.preReview.body}`,
      "```",
      `### Review: ${result.review ? (result.review.applied ? "edit applied" : `edit NOT applied (${result.review.rejected ?? result.review.error})`) : "none"}`,
      (result.review?.problems ?? []).map((p) => `- [${p.kind}${p.needsStudent ? ", for student" : ""}] "${p.quote}" -> ${p.fix}`).join("\n"),
      result.review?.revisedBody ? "Rejected edit:\n```\n" + result.review.revisedBody + "\n```" : "",
      `### Final (${post.length} check findings)`,
      post.map((i) => `- ${i}`).join("\n"),
      "```",
      `Subject: ${result.draft.subject}\n\n${result.draft.body}`,
      "```",
      result.draft.notesForStudent.length ? `Notes for the student:\n${result.draft.notesForStudent.map((n) => `- ${n}`).join("\n")}` : "",
      "",
    );
  }
  const cost = (tokens.input * PRICE.input + tokens.output * PRICE.output) / 1e6;
  const summary =
    `${results.filter((r) => r.result).length}/${results.length} drafted · review edit applied on ${applied} · ` +
    `check findings ${before} before review -> ${after} after · ${tokens.input} input + ${tokens.output} output tokens ≈ $${cost.toFixed(2)}`;
  report.splice(2, 0, summary, "");
  // ---- the production latency table -------------------------------------
  // A median, not a mean: one retried draft doubles a mean of 20 and tells you
  // nothing about the wait a student actually gets.
  const stats = (xs: number[]) => {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
    return { n: v.length, min: v[0], p50: at(0.5), p90: at(0.9), max: v[v.length - 1], mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
  };
  const columns: [keyof PipelineTimings, string][] = [
    ["draftMs", "draft call"],
    ["lintMs", "lint (local)"],
    ["reviewMs", "review call"],
    ["reviewRetryMs", "review retry"],
    ["totalMs", "WHOLE PIPELINE"],
  ];
  const distribution = Object.fromEntries(
    columns.map(([k]) => [k, stats(timed.map((r) => r.t[k]).filter((x): x is number => typeof x === "number"))]),
  );

  const latency: string[] = [
    "## Production latency",
    "",
    `Draft: ${draftConfig.model}, effort ${draftConfig.effort}, thinking ${draftConfig.thinking}${draftOverridden ? " **(overridden)**" : ""}. ` +
      `Review: ${reviewConfig.model}, effort ${reviewConfig.effort}, thinking ${reviewConfig.thinking}` +
      `${reviewEffort || reviewThinking ? " **(overridden)**" : ""}. ` +
      `${concurrency} call${concurrency === 1 ? "" : "s"} in flight. ` +
      (concurrency === 1 ? "Nothing queued behind anything, so these are the waits a student gets." : "**Not a clean timing run - calls queued behind each other. Re-run with --concurrency=1.**"),
    "",
    "| stage | n | min | p50 | p90 | max | mean |",
    "|---|---|---|---|---|---|---|",
    ...columns.map(([k, label]) => {
      const s = distribution[k];
      return s
        ? `| ${label} | ${s.n} | ${s.min} | **${s.p50}** | ${s.p90} | ${s.max} | ${s.mean} |`
        : `| ${label} | 0 | - | - | - | - | - |`;
    }),
    "",
    "| scenario | draft | lint | review | retry | total |",
    "|---|---|---|---|---|---|",
    ...timed.map((r) => `| ${r.id} [${r.profile}] | ${r.t.draftMs} | ${r.t.lintMs} | ${r.t.reviewMs ?? "-"} | ${r.t.reviewRetryMs ?? "-"} | ${r.t.totalMs} |`),
    "",
  ];
  report.splice(3, 0, ...latency);
  const t50 = distribution.totalMs?.p50;
  const latencyLine = t50 === undefined || t50 === null ? "no timings recorded" : `median total ${(t50 / 1000).toFixed(1)}s on the paid path (${concurrency} in flight)`;

  const out = process.argv[2]?.startsWith("--") ? "draft-live-eval.md" : (process.argv[2] ?? "draft-live-eval.md");
  writeFileSync(out, report.join("\n"));
  const draftsPath = flag("drafts-json");
  if (draftsPath) {
    writeFileSync(
      draftsPath,
      `${JSON.stringify({ aggregate: { scenarios: results.length, drafted: forGrader.length, errored: results.length - forGrader.length }, scenarios: forGrader }, null, 2)}\n`,
    );
    console.log(`Emails for the grader written to ${draftsPath}`);
  }

  const jsonPath = flag("json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ meta: { ranAt: new Date().toISOString(), draftConfig, review: reviewConfig, concurrency, transport: "Anthropic API - this run cost real money", costUsd: Number(cost.toFixed(4)) }, distribution, scenarios: timed }, null, 2)}\n`,
    );
    console.log(`Timings written to ${jsonPath}`);
  }
  console.log(`${summary}\n${latencyLine}\nReport written to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
