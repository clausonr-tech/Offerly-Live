# The harness: `scripts/draft-cli-eval.ts`

Written 11 October 2026. Every number below came out of a real run of the
script, printed in full at the end.

The rig every change to the draft pipeline gets measured on. It generates real
drafts through the real prompts, runs the real review pass and the real guard,
scores both versions, and writes JSON so two runs can be diffed mechanically.

**It costs nothing.** The transport is `runClaude`
(`src/lib/news/claude-cli.ts`), the Claude Code CLI on the owner's
subscription — the same thing the news pipeline runs on. No `ANTHROPIC_API_KEY`
reaches the model process (`claude-cli.ts` strips it), so an accidental API bill
is not possible from here. The project's $10 API budget stays reserved for the
one thing this rig cannot do: measure latency.

---

## Running it

```bash
npx tsx scripts/draft-cli-eval.ts --scenarios=3                    # look at three drafts
npx tsx scripts/draft-cli-eval.ts --scenarios=12 --json=before.json --quiet
#   ... change a prompt, a check or the guard ...
npx tsx scripts/draft-cli-eval.ts --scenarios=12 --json=after.json --compare=before.json --quiet
```

No `--env-file` and no secrets: nothing in the path reads the database or an
API key. In a git worktree, `node_modules` has to exist — symlinking the main
checkout's is enough (`ln -s "$(git rev-parse --path-format=absolute --git-common-dir)/../node_modules" node_modules`).

| Flag | What it does |
|---|---|
| `--scenarios=N` | How many situations to draft. Default 3. Each one is a draft call plus a review call (plus a retry call when the guard rejects). |
| `--filter=<substring>` | Only situations whose sorted box mix contains the substring: `--filter=first.alum`, `--filter=thanks`, `--filter=first.met+first.referred`. |
| `--profile=full\|sparse` | `full` answers every question; `sparse` answers only the required ones in lowercase shorthand with a Gmail signature. Thin input is where a stitched-together email shows most. |
| `--seed=<string>` | Fixes *which* situations get picked. Default `offerly`. The same seed and count always pick the same situations, so two runs are comparable; a different seed gives a different sample of the same corpus. |
| `--concurrency=N` | Situations in flight at once. Default 4, following `draft-live-eval.ts`. **Each one spawns a `claude` process**, and each process is a whole model call, so 12 is not a free lunch. |
| `--model=<id>` | CLI model. Default `claude-sonnet-5-5`. |
| `--timeout=<ms>` | Per model call. Default 180,000. |
| `--retry-before=<ms>` | The guard-retry window the real pipeline applies (`reviewRetryBeforeMs`, default 60,000). Raise it to exercise the retry path, which real CLI durations often push past. |
| `--no-review` | Draft only: no review call, no guard. The cheap way to score a change to the drafting prompt alone. |
| `--json=<path>` | One record per scenario plus an `aggregate` block and a `meta` block. |
| `--compare=<path>` | Per-metric delta against an earlier `--json` run, metrics that moved first. **This is the mode to use.** |
| `--quiet` | Aggregates only. Failures are still printed: a scenario that errored is a finding. |
| `--help` | The list above. |

Scenarios come from `sims()` in `scripts/draft-occasions-sim.ts` — every valid
multi-box combination of the picker's occasions, answered the way a student
would, in both profiles. Nothing new was invented: the same corpus
`draft-occasions-sim` and `draft-live-eval` already grade against.

---

## What it runs

`runDraftPipeline` (`src/lib/draft-pipeline.ts`), reproduced over the CLI. Every
prompt, check and guard is **imported, never reimplemented**: `buildDraftPrompt`
and `finishDraft`, `draftChecks`, `buildReviewPrompt` / `guardRevision` /
`reviewOutputSchema` / `studentNotesFromReview`, `findBlockedLanguage`,
`situationTypes`, and `draftIssues` for the grading. The control flow is the
pipeline's: the guard's one retry, the review never failing the draft,
`finishDraft` re-applied after an accepted edit, notes deduped, `forStudent`
checks re-run on the email that actually goes out and filtered through
`APP_HANDLES`.

Three things it copies rather than imports, because `src/` may not be edited
from here:

- **`draftOutputSchema`** — declared privately in `draft-pipeline.ts`. The copy
  is checked on every run: `assertSchemaMatchesPipeline()` reads the real
  declaration out of the source file and compares every field name, nested ones
  included, **before any model call**. If they drift the script refuses to run
  and names the fields. (Verified: adding a field to the copy aborts with
  `This script has fields the pipeline doesn't: bogusDrift`.)
- **`APP_HANDLES`** — the private regex that drops notes the app already
  handles. It filters notes only, so a drift there changes no score.
- **The final blocked-language gate** — the pipeline throws; the rig records
  `blockedLanguage: true` and keeps scoring, because a throw would hide every
  other number for that scenario.

### Where it deliberately differs from production

| | Pipeline | Here |
|---|---|---|
| Transport | Anthropic SDK | `claude` CLI, subscription |
| Model | per plan (`REGISTRY.draft`: Opus 5 paid / Sonnet 5 free; review fixed Sonnet 5) | one CLI model for both calls |
| Effort / thinking / fast mode | low-or-medium, adaptive thinking, fast mode on the paid draft call | **none of these exist on the CLI** |
| Resume | the PDF as a base64 document block when no summary exists | `studentResumeSummary` only; `hasResumePdf` is forced false |
| Prompt cache | explicit `cache_control` breakpoints | whatever the CLI does on its own |
| Guard retry | a second turn (assistant message + correction) | the CLI is single-turn, so the retry is one prompt: the review prompt, the previous edit as JSON, then the pipeline's correction sentence verbatim |

---

## What each metric means

Everything is reported **pre-review and post-review**, so the review pass's
effect is visible rather than assumed. `Pre` is the draft as the drafting model
wrote it with `finishDraft` applied; `Post` is the email that would reach the
student.

### The existing graders

| Metric | Meaning |
|---|---|
| `issuesPre` / `issuesPost` | `draftIssues(sim, draft)` findings — the simulation grader: word ceiling, em dashes, placeholders, signature, missing typed answers, multiple asks, paragraph-per-box, lead-box opening, plus `fluencyIssues`. |
| `lintForReviewPre` / `lintForReviewPost` | `draftChecks(...).forReview`: what the reviewer is handed. |
| `lintForStudentPost` | `draftChecks(...).forStudent`: what only the student can fix. |
| `lintCleanPre` / `lintCleanPost` | How many drafts scored **zero** on `forReview`. Watch this one if you ever plan to gate the review call on the lint: FINDINGS-probe showed a template-prose draft scoring clean. |

### The review and the guard

| Metric | Meaning |
|---|---|
| `reviewApplied` / `reviewRejected` / `reviewErrored` | Guard outcome per draft. The rejection reason is printed **verbatim**, and tallied under "Guard rejections, verbatim". |
| `guardAcceptRate` | `applied / reviewed`. A headline number for the project: a rejected edit means every fix in it was thrown away. |
| `reviewRetried` | The guard rejected and the reviewer got its one more try. |
| `reviewRetrySkippedForTime` | The guard rejected, but the request was already older than `--retry-before`, so the pipeline would not have retried either. Not a bug — raise `--retry-before` to test the retry itself. |
| `problems`, `problemsMean`, `problemsNeedsStudent` | The review's own `problems` list, and how many it marked `needsStudent`. Kinds are tallied separately (`flow`, `tone`, `structure`, …). |

### Length

`wordsPreMean` / `wordsPostMean` are the words between the greeting and
`Best,`; `overCeilingPre` / `overCeilingPost` count drafts past the type's
`maxWords` (the longest ceiling involved, as `draftIssues` does), and
`overCeilingWordsPost` is by how much in total.

### Voice — what `draftChecks` does not measure

Straight out of `docs/concepts/FINDINGS-probe.md`: a draft that broke four
`VOICE_RULES` scored **one** finding on `draftChecks`. These four close that gap,
and they are the same four the 300-draft simulation numbers in
`draft-prompt.ts` already named.

| Metric | Meaning |
|---|---|
| `contractionsPre/PostMean`, `contractionRatePre/PostMean`, `zeroContractionPre/Post` | Contraction count and per-100-word rate, and how many drafts had **none**. `VOICE_RULES`: "use them naturally". 255 of 300 simulated drafts used none. |
| `longestIRunPre/PostMean`, `threeIStartsPre/Post` | The longest run of consecutive sentences opening with "I", and how many drafts hit three — which `VOICE_RULES` bans outright. |
| `cannedLinesPre/Post`, `cannedResume*`, `cannedFlexibility*`, `cannedEasyOut*` | The three courtesy lines `VOICE_RULES` names. Two families count: the stock versions the simulations found ("my resume for your reference", "happy to work around your schedule") **and the exact phrasings `VOICE_RULES` itself prints as the fresh alternative** — a rule's own example pasted into every email is a template too. The matched words are printed verbatim so a human can judge the call. |
| `pleasantryOpenPre/Post` | The email opens on "I hope this finds you well" rather than the specific thing. 57 of 300 simulated drafts did. |
| `repeatedSentencesPre/Post` | Sentences of five words or more appearing **word for word in more than one scenario's email**. Different situations should not produce identical sentences; this is the measurable version of "300 drafts read as one template", and the number to watch when a change claims to add variety. The repeated sentences themselves are printed. |

### Cost

`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` and
`costUsdSubscription`, summed over every call (draft, review, retry).
**`costUsdSubscription` is subscription accounting** — what those tokens would
have cost on the API — not a charge. Nothing in a run of this script bills
anything.

---

## What it cannot tell us

1. **Production latency. At all.** The CLI exposes no `effort`, no `thinking`
   and no `speed: "fast"`, and every call pays process startup. `draftMsMean`,
   `reviewMsMean` and `totalMsMean` are here to spot a *gross* regression (a
   call that now takes 90 seconds) and for nothing else. The app's draft call
   runs fast mode on the paid plan and its review call runs adaptive thinking;
   neither is reachable from here. Latency work needs the API, which is what
   the $10 is for.
2. **Real cache behaviour.** The pipeline sets explicit `cache_control`
   breakpoints and the question that matters — whether the invariant head of the
   draft prompt caches across email types — cannot be asked here. The
   `cacheRead`/`cacheWrite` numbers are the CLI's own, on its own session
   lifecycle, and they move between identical runs.
3. **The resume-PDF path.** No document blocks over the CLI. Every draft runs
   `studentResumeSummary`. Anything about how the models read the PDF, or about
   the same PDF going into both calls, is invisible here.
4. **Opus vs Sonnet.** Both calls use one CLI model, so the paid plan's
   Opus draft call is not what gets measured, and a per-plan quality difference
   cannot be seen. A change that helps Sonnet is not thereby proven to help Opus.
5. **Quota, routing, fallback, the database, the archive.** `runAiFeature`,
   `generateDraft`, the `email_drafts` row and `archiveGenerated` are all
   outside the rig.
6. **Real students.** These are simulated answers from one student profile
   (Maya Okafor, Duke, two profiles of thoroughness). The archive is the only
   source of truth about real traffic.
7. **Small samples.** See the noise floor below.

### The noise floor

Two runs of the **same three scenarios** with **no change to the code**:
**22 of 58 metrics moved.** `draftMsMean` moved by 2.3 seconds, `issuesPre`
went 1 → 3, `problems` 12 → 13, `contractionRatePostMean` 2.88 → 3.67. Only
the hard ones held still (`reviewApplied`, `guardAcceptRate`,
`zeroContractionPre`, `overCeiling*`, `cannedLines*`).

So: a three-scenario delta proves nothing. Use `--scenarios=3` to look at
drafts, and 12 or more before claiming a metric moved. `--compare` marks every
metric that changed with `*` precisely so the unchanged ones are visible too.

---

## Headline numbers from the verification run

11 October 2026, `claude-sonnet-5-5`, seed `offerly`, two runs of scenarios
804/805/806 (`first.recruiter+first.referred`, `first.alum+first.met`,
`first.met+first.referred`, all `sparse`) plus an earlier 3-scenario run and a
`--filter=thanks` run of 2. **11 reviewed drafts in all.**

1. **The guard accepted every single edit: 11 of 11, `guardAcceptRate` 1.0.**
   Zero rejections, so zero retries — the retry path is the one piece of
   pipeline control flow this verification did **not** exercise. Worth saying
   plainly: the expectation going in was that rejections were common, and on
   this model and this corpus they were not. That is a finding about Sonnet 5.5
   on multi-box sparse situations, not a proof about Opus or about production.
2. **Every pre-review draft had zero contractions. 11 of 11.** Every
   post-review draft had at least three (`contractionRatePostMean` 2.9–3.7 per
   100 words). The review pass, not the drafting prompt, is what makes an
   Offerly email sound like a person — and the drafting prompt's own
   `VOICE_RULES` are not sent to the drafter. This reproduces the 255-of-300
   number in `draft-prompt.ts` exactly, and `draftChecks` sees none of it.
3. **`draftChecks` is near-silent on these drafts.** `lintForReview` was 0 for
   3 of 3 drafts in both JSON runs, before *and* after review, while the review
   itself reported 12–13 real problems (mostly `tone` and `flow`) and the voice
   metrics moved substantially. Any plan to gate the review call on
   `forReview.length` is still unsupported.
4. **The review fixes voice but re-templates it.** Canned courtesy lines went
   4 → 1 in the first run, and the review's replacement for the flexibility
   line was `VOICE_RULES`' own example — "Any time that suits you works for me"
   — word for word in two of three edits. `repeatedSentencesPost` was 2 in both
   JSON runs ("Emily Tran, who interned on the consumer team last summer,
   suggested I reach out to you.", "Thank you for your time!").
5. **`issuesPost` barely moves.** 1 → 1 and 3 → 2 across the two runs: the
   simulation grader is not where the review's value shows up. Its findings were
   real but narrow (a `[graduation month]` placeholder the sparse profile can't
   fill; a referral lead whose referrer slipped out of the opening).
6. **Cost: $0.14 of subscription accounting for 3 scenarios** (6 model calls),
   about 10,400 output tokens. Roughly $0.05 a scenario, billed to nobody.
   Twelve scenarios is well under a dollar of notional cost and about 5 minutes
   of wall clock at `--concurrency=4`.
7. **One transient failure in ~14 runs.** An early single-scenario run came back
   with a CLI-level error and the same scenario succeeded on the next attempt.
   The rig records the failure, prints it whatever `--quiet` says, counts it in
   `errored`, and exits non-zero. A run with `errored > 0` is not a comparable
   run.

---

## Related

- `docs/EMAIL_DRAFTING_WORKFLOW.md` — what the pipeline does, stage by stage.
- `docs/concepts/FINDINGS-probe.md` — why the CLI transport works, and the
  four things `draftChecks` misses.
- `scripts/draft-occasions-sim.ts` — the scenario corpus and `draftIssues`.
- `scripts/draft-live-eval.ts` — the same evaluation on the **API**, with the
  real per-plan model configs. That one costs money; this one does not.
