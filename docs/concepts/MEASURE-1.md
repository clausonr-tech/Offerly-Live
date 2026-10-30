# MEASURE-1 — three measurements on the free rig

AGENT-M, 11 October 2026. Branch `perf/draft-pipeline`, worktree
`.claude/worktrees/draft-pipeline-perf`. **No Anthropic API call and no
`ANTHROPIC_API_KEY`**: every model call went through `scripts/draft-cli-eval.ts`,
i.e. `runClaude` on the Claude Code CLI on the owner's subscription. Nothing
here was billed. Nothing under `src/` was edited, and nothing was committed.

Five rig runs, **92 drafts, 92 reviews, 19 guard retries = 203 model calls, 0
errored**. Measurement 1 needed no run of its own: the harness persists
`preReviewBody` and `body` per scenario, so k was measured from the same five
runs.

| | |
|---|---|
| HEAD, start and end | `9e58fef888c4a6a08093c4c30d79736b97bc4b25` (unchanged) |
| `git status --short` at start | clean |
| `git stash list` at start | empty (nothing stashed, nothing popped) |
| model | `claude-sonnet-5-5` via the CLI |
| notional cost | **$5.72** of subscription accounting, billed to nobody |
| wall clock | **9 min 8 s** for the five runs (two jobs in parallel), + 20 s smoke run |

## The file-hash check — the prompts did not move under me

`shasum src/lib/draft-prompt.ts src/lib/draft-review.ts src/lib/draft-pipeline.ts`
was taken immediately **before and after each of the five runs** (10 hashings).
All thirty lines were identical:

```
0c182b242170b4f839b6a3fe873af1d6800b9b40  src/lib/draft-prompt.ts
b212bdff0ae19291b5dec3930d39b4ced996b026  src/lib/draft-review.ts
d88778c3bf735e7f725ce4f176919df6fe5b3a01  src/lib/draft-pipeline.ts
```

`git rev-parse HEAD` was also taken before and after each run: `9e58fef` ten
times out of ten. **No arm is contaminated and all five are comparable.** (Raw
logs: `jobA.log`, `jobB.log` in the session scratchpad; the per-arm `### ARM` /
`--- HASH BEFORE` / `--- HASH AFTER` blocks are the proof.)

---

# MEASUREMENT 1 — the reviewer's real edit-span count k

Probe: `scripts/probe/k-measure.ts` (new). It reads the five `--json` outputs,
takes each draft's **pre-review body** and **post-review body**, keeps only the
text above the sign-off and below the greeting line (the harness's own
`bodyParts`, copied verbatim), splits it with the harness's own `sentencesOf`,
normalises U+2019→U+0027 and U+201C/D→U+0022 the way `draft-review.ts`'s
`loose()` does, and aligns the two sentence lists by LCS. Contiguous
disagreements are the **spans**.

Measured on the **88 drafts where the guard accepted the edit** (the 4 rejected
ones have no edit to align; the harness does not persist a rejected revised
body).

### The k histogram

k = contiguous changed spans, i.e. the number of `{find, replace}` pairs a patch
schema would have to emit:

| k | drafts | share |
|---|---:|---:|
| 0 | 1 | 1.1% |
| 1 | 16 | 18.2% |
| 2 | **52** | **59.1%** |
| 3 | 17 | 19.3% |
| 4 | 2 | 2.3% |

**median 2, mean 2.03, max 4.** k=1: 18.2%. k=2: 59.1%. k≥3: 21.6%.

It is **not bimodal** and it is remarkably stable — median 2 in every one of the
five arms and in both profiles:

| arm | n | median k | mean k | k≥3 |
|---|---:|---:|---:|---:|
| guard-full | 27 | 2 | 2.11 | 22.2% |
| guard-sparse | 26 | 2 | 2.08 | 30.8% |
| noise-A | 12 | 2 | 1.75 | 8.3% |
| noise-B | 11 | 2 | 1.91 | 18.2% |
| noise-C | 12 | 2 | 2.17 | 16.7% |
| profile=full | 39 | 2 | 2.03 | 17.9% |
| profile=sparse | 49 | 2 | 2.04 | 24.5% |

### The number that actually decides it: a span is not a sentence

TESTER-1's break-even table is parameterised on k, with each span assumed to be
**one rewritten sentence**. That assumption is false on real review output:

- **median 2 sentences per changed span**, mean 2.77, max 9. Only **55 of 179
  spans (31%) are a single sentence**; **84 of 179 (47%) are three sentences or
  more**.
- Counted as sentence slots rather than spans, the same 88 drafts give **median
  k = 7**, mean 6.48 — and **98.9% of drafts are at k≥3**, which on TESTER-1's
  own table is already past break-even on both corpora.
- **75% of the editable body's characters (median 77%) sit inside a changed
  span.** So `find` alone re-emits three quarters of the body, and `replace`
  re-emits the rewritten three quarters.

### Characters changed vs body length

| | median | mean |
|---|---:|---:|
| pre-side chars inside changed spans (`find` payload) | 547 | 529 |
| post-side chars inside changed spans (`replace` payload) | 435 | 458 |
| editable body chars | 689 | 701 |
| **(find + replace) / body** | **1.45×** | **1.39×** |

**(find + replace) ≥ the whole body on 77 of 88 drafts (87.5%).**

### The payload arithmetic, TESTER-1's method

Following `docs/concepts/TEST-A.md` T3 / `scripts/probe/edits-arith.ts`: 3.7
chars per token, both payloads serialised with `JSON.stringify`, and
**`problems[]` counted** — it exists in both schemas and its `quote` already
repeats the span. `problems[]` is built identically for both sides from each
draft's **real measured problem count** (median 4, mean 4.22 per draft), so it
cannot bias the comparison.

| whole-body base | unit | patch | whole body | delta |
|---|---|---:|---:|---:|
| editable middle only (TESTER-1's base) | spans | 490 tok | 389 tok | **+26%** |
| editable middle only | sentence slots | 518 tok | 389 tok | **+33%** |
| the real full body the reviewer emits | spans | 490 tok | 404 tok | **+21%** |
| the real full body | sentence slots | 518 tok | 404 tok | **+28%** |

The patch is smaller on **10 of 88 drafts (11.4%)**; the per-draft median delta
is **+27%**. Using the editable middle as the whole-body base is the
conservative choice *against* this conclusion — it makes the body look smaller
than it is — and the patch still loses by a quarter.

Broken out by each draft's own measured k (spans, editable base):

| measured k | drafts | patch | whole | delta |
|---:|---:|---:|---:|---:|
| 0 | 1 | 12 tok | 201 tok | −94% |
| 1 | 16 | 451 tok | 350 tok | **+29%** |
| 2 | 52 | 526 tok | 412 tok | **+28%** |
| 3 | 17 | 458 tok | 372 tok | **+23%** |
| 4 | 2 | 388 tok | 349 tok | **+11%** |

**There is no k at which the patch wins, including k=1.** That is the finding
that was not visible before: TESTER-1's k=1 row showed −59%/−48% because k=1
there meant *one sentence*. Measured, k=1 means *one contiguous region*, which
averages 451 tokens of `find` + `replace` because the region is most of the
body. The delta narrows as k rises only because more spans means smaller spans.
The one case that wins (−94%) is the single draft where the review changed
nothing above the sign-off and the patch degenerates to `edits: []`.

### The apostrophe trap — checked, and it did not bite here

Normalisation was applied as instructed. It changed nothing on this corpus, and
the reason is worth recording:

- **0 of 88** pre-review bodies and **0 of 88** post-review bodies contain
  U+2019 **above the sign-off**. Mean k is 2.03 with normalisation and 2.03
  without; the inflation is 0.00 spans per draft.
- The literal U+2019 that `signatureLines` emits lands in `Duke University ’29`,
  which is **below `Best,`** and therefore outside the compared region in both
  the guard and this measurement. The trap is real for anything that compares
  whole bodies; it is inert for anything that compares above the sign-off.
- Lower-casing as well as quote-normalising changes the span count on **0 of
  88** drafts, so no observed edit was case-only.

This does not retire the risk D16 names. It says the risk lives in the
signature, not in the prose, and that a patch applier working above the sign-off
would not have hit it **on this corpus of 88 drafts**.

## VERDICT on the patch schema

**A LOSS. Not a wash — a loss at every k the reviewer actually produces.** A
`{find, replace}` patch costs **+26% more output tokens** than re-emitting the
whole body (+21% against the real full body), is smaller on only 11% of drafts,
and is bigger than the whole body on 87.5% of them. The claim it was ranked on
(−30–50% of review generation time) is not merely overstated; its sign is
wrong.

The mechanism is one sentence: **the reviewer does not rewrite sentences, it
rewrites regions.** Median 2 spans per draft, median 2 sentences per span, 75%
of the body inside a span. A patch that quotes 75% of the body as `find` and
then supplies its replacement is the whole body twice.

Recommendation: **close D16 as rejected on measurement, not deferred.** The one
remaining argument for a patch schema is correctness, not cost — it would let
the guard judge spans rather than bodies — and that case must be made on
Measurement 2's rejection modes, where it is now much stronger (see below), and
costed as **+26% output tokens**, not as a saving.

---

# MEASUREMENT 2 — the guard rejection rate against the pre-committed rule

```
npx tsx scripts/draft-cli-eval.ts --scenarios=30 --seed=guardrate --profile=full   --retry-before=600000 --json=guard-full.json   --quiet
npx tsx scripts/draft-cli-eval.ts --scenarios=30 --seed=guardrate --profile=sparse --retry-before=600000 --json=guard-sparse.json --quiet
```

| | guard-full | guard-sparse |
|---|---:|---:|
| scenarios requested / **drafted** | 30 / **30** | 30 / **26** |
| `errored` | **0** | **0** |
| `reviewRan` | 30 | 26 |
| `reviewApplied` | 27 | 26 |
| **`reviewRejected`** | **3** | **0** |
| `reviewRetried` (first-turn rejections) | **12** | 2 |
| `reviewRetrySkippedForTime` | 0 | 0 |
| `guardAcceptRate` | **0.900** | 1.000 |
| `problems` / `problemsMean` | 133 / 4.43 | 111 / 4.27 |
| notional cost | $2.4449 | $1.3871 |

**A harness limitation found while running this: `--profile=sparse` cannot
reach 30.** `sims()` returns **87** situations, **61 `full` and 26 `sparse`**,
so `--scenarios=30 --profile=sparse` silently returns 26 and the run reports
`scenarios: 26`. The sparse arm is therefore n=26, not n=30, and the
pre-committed rule's "in 30" denominator is unreachable on that profile at any
seed. `HARNESS.md` should say so.

## THE DECISION

**The pre-committed rule is: ≥2 rejections in 30 → the per-span guard gets
built.**

**guard-full returned 3 rejections in 30. The rule fires. R1b / the per-span
guard IS BUILT.**

I am not renegotiating it and I am not softening it with the sparse arm's 0/26.
The rule named one arm and one number; the arm it named returned 3.

| | rate | 95% two-sided CI | one-sided 95% upper |
|---|---:|---|---:|
| guard-full, final rejections | 3/30 = **10.0%** | [2.1%, 26.5%] | 23.9% |
| guard-sparse, final rejections | 0/26 = 0.0% | [0.0%, 13.2%] | 10.9% |
| all five arms pooled | 4/92 = 4.3% | [1.2%, 10.8%] | 9.7% |
| **guard-full, FIRST-TURN rejections** | 12/30 = **40.0%** | [22.7%, 59.4%] | 56.6% |
| all five arms, first-turn | 19/92 = **20.7%** | [12.9%, 30.4%] | 28.8% |

The 11-of-11 result that D5 was corrected on is now bounded from the other
side: on the full profile the guard rejects the first review turn **40% of the
time**, and the one-sided 95% *lower* bound on that is 25%. The sparse profile,
which the only previous run sampled, is the quiet one (2/26 first-turn).
**PLAN-B §2.3's reason for choosing `--profile=full` was right, and it is why
the earlier 11/11 saw nothing.**

## Every rejection, verbatim

### Final rejections — 3, and all three are the same reason

```
dropped something the student typed: "both from Atlanta"
```

| scenario | boxes | lead type | retried? | problems |
|---|---|---|---|---:|
| 610 | `first.met+first.recruiter` | `cold_after_meeting` | yes, and the retry failed too | 6 |
| 628 | `first.alum+first.conference+first.recruiter+first.referred` | `cold_referral` | yes, and the retry failed too | 8 |
| 638 | `first.met+first.pointed+first.recruiter` | `cold_after_meeting` | yes, and the retry failed too | 3 |

All three were drafts whose pre-review body said some variant of *"I was glad
to learn we are both from Atlanta"*, and all three lost the **whole** edit set —
6, 8 and 3 reported problems' worth of fixes, discarded.

**My judgement: all three are FALSE POSITIVES, and they are one new confirmed
bug, not three.** Proved deterministically, no model, in
`scripts/probe/anchor-both.ts`, which imports the real `detailScore` /
`detailSurvived` / `contentWords` / `DETAIL_COMMON`:

```
detail: "both from Atlanta"
contentWords: ["both","Atlanta"]
  "both":    capitalised=false inDETAIL_COMMON=false -> ANCHOR (weight 1, losing it rejects the whole edit)
  "Atlanta": capitalised=true  inDETAIL_COMMON=false -> ANCHOR (weight 1, losing it rejects the whole edit)

variant                                 score  anchorsLost  survived?
as drafted (the guard's baseline)        1.00  []           yes
folded into the intro sentence           0.50  ["both"]     NO -> guard rejects the whole edit
    "I'm a sophomore at Duke studying economics, and I grew up in Atlanta too."
reworded, fact intact                    0.50  ["both"]     NO -> guard rejects the whole edit
    "It was good to hear you're from Atlanta as well - so am I."
reworded, fact intact                    0.50  ["both"]     NO -> guard rejects the whole edit
    "Another Atlanta native here."
reworded, keeps the word both            1.00  []           yes
fact genuinely removed                   0.00  ["both","atlanta"] NO (correctly)
```

The function word **"both"** is classified as an **anchor** — it is four letters
long, so `contentWords` keeps it, and it is in neither `CONTENT_STOP` nor
`DETAIL_COMMON`, so `detailScore` gives it weight 1 and `detailSurvived`
rejects any body that lost it. The shared-hometown *fact* is intact in three of
the four rewrites above; only the word "both" is gone.

And the reviewer is **instructed to produce exactly that rewrite**
(`src/lib/draft-review.ts:64`): *"Common ground (a shared school or hometown)
goes inside the sentence that introduces the student, never tacked on as a short
last sentence"*. Moving "we are both from Atlanta" into the sentence that
introduces Maya is the single most likely way to lose the word "both". **The
guard rejects an edit the reviewer was told to make** — the same shape as the
three already-confirmed false positives, on a rule nobody had measured firing.

The caveat on this judgement: the harness persists the rejection reason but
**not the rejected revised body**, so I am reasoning from the reason string, the
pre-review body, the reviewer's own instruction and a deterministic
demonstration of the mechanism — not from the three literal rewrites. The
variant sentences above are mine, labelled as illustrations. That gap is worth
closing: `ScenarioRecord` already carries `revisedBody` inside `ReviewOutcome`
and simply does not persist it.

### Genuine-defect rejections — 1, counted separately

```
made the writing worse: introduced connector that isn't a cause
```

| scenario | boxes | lead type | retried? |
|---|---|---|---|
| 803 (noise-B) | `first.alum+first.referred` | `cold_referral` | yes, and the retry failed too |

This is the lint-category veto, and it is the guard catching a real writing
defect the edit introduced, so it is **not** a false positive. I log it
separately because the decision rule should turn on false positives — and
because it is arguably outside the remit PLAN-B §2.4 sets for the guard
("permit everything provably not a fabrication, and nothing else"): a bad
connector is a style defect, not a fabrication, and the price of vetoing it is
every other fix in the edit. I cannot judge it harder than that without the
rejected body.

**Counted against the rule: 3 false positives and 0 genuine fabrications in the
guard-full arm of 30.** The rule fires on false positives alone.

## The retry path — exercised for the first time, and it works

`--retry-before=600000` did its job. **The retry fired 19 times across the five
runs; `reviewRetrySkippedForTime` was 0 everywhere**, so no retry was ever
skipped for age — which is what happened on the earlier 60 s default, and why
the path had never run.

| | first-turn rejections (`reviewRetried`) | rescued by the retry | still rejected after it |
|---|---:|---:|---:|
| guard-full | 12 | 9 | 3 |
| guard-sparse | 2 | 2 | 0 |
| noise-A | 0 | 0 | 0 |
| noise-B | 2 | 1 | 1 |
| noise-C | 3 | 3 | 0 |
| **total** | **19** | **15 (79%)** | **4** |

**The retry rescued 15 of 19 rejections.** That is the single most consequential
operational fact in this report after the k verdict, and it cuts two ways:

1. It is why the headline rejection rate looks small. The *first-turn* rate on
   the full profile is 40%; the surviving rate is 10%. Any argument about the
   guard that quotes `guardAcceptRate` is quoting a number the retry already
   repaired.
2. **It costs a whole extra review call on 40% of full-profile drafts.** Not
   free: in production that is a second review round-trip in the student's
   latency path, on a call `reviewMsMean` puts at 13.8 s on this rig. A
   per-span guard that stopped vetoing whole edit sets would remove most of
   those 19 extra calls — which is a *latency* argument for R1b that neither
   plan makes.
3. All three "both from Atlanta" rejections survived the retry. The correction
   sentence names the dropped detail verbatim and the reviewer still could not
   satisfy the guard — consistent with a guard condition the reviewer cannot
   meet without undoing the rewrite it was told to make.

A reporting gap: the harness records *that* a retry happened but not the
**first-turn** reason that caused it. For the 15 rescued cases I cannot say
which guard rule fired. If 15 first-turn reasons were logged, this measurement
would have 19 labelled rejections instead of 4.

## The caveat this number must be read with — STATED PROMINENTLY

**This rate is about SOME guard modes only, and no sample size fixes that.**

The rig forces `hasResumePdf: false` and every scenario runs the
`studentResumeSummary` path, so **M10, the resume-PDF proper-noun rejection, is
structurally invisible here at any n**. The scenario corpus is simulated answers
from one student profile (Maya Okafor, Duke) that **never types a private
topic**, so **M12, the private-detail shrink-floor rejection — the
safety-relevant one — is effectively invisible too.**

So: **10% is not the guard's rejection rate. It is the rejection rate of the
remaining modes, on one model, on one simulated student, on this corpus.** Two
of the three previously confirmed modes could not have appeared in these 92
drafts however many I ran. Do not quote 10% as a total. Do not quote 0/26 on
sparse as evidence of anything about the resume or private-detail paths.

---

# MEASUREMENT 3 — the noise bands

Three **identical** arms, `--scenarios=12 --seed=offerly --retry-before=600000`,
no code change between them (hashes above, 6 hashings, all identical):

```
noise-A  drafted 12  errored 0   88 s   $0.7678
noise-B  drafted 12  errored 0   78 s   $0.5112
noise-C  drafted 12  errored 0   93 s   $0.5483
```

Probe: `scripts/probe/noise-bands.ts`. **55 metrics** are compared: the
`aggregate` block has 58 keys, three of which (`scenarios`, `drafted`,
`errored`) describe the run rather than the drafts.

**First, D21 reproduced exactly.** Metrics that moved between two identical
arms: **armB vs armA 28 of 55** (= 28 of 58 counting the three run-shape keys —
the same 28 the builder's control arm reported), **armC vs armA 21 of 55**, and
**29 of 55 took more than one value across the three**. The control was not a
fluke.

## Classification rule — stated before the numbers were looked at

| class | rule | what it licenses |
|---|---|---|
| **LOW-NOISE** | range across the three arms is 0, or range ≤ 5% of the mean | usable at n=12 |
| **MEDIUM** | range ≤ 25% of the mean | needs n≥24; at n=12 only a delta bigger than the band means anything |
| **UNUSABLE-AT-THIS-N** | range > 25% of the mean | no single-pair delta at n=12 is interpretable |
| **DEGENERATE** | 0 in all three arms | **no variance AND no baseline rate** — the D21 trap: nothing can regress against it, so a pass condition written on it is unfalsifiable |

## The table

| metric | armA | armB | armC | range | range/mean | class |
|---|---:|---:|---:|---:|---:|---|
| `cannedFlexibilityPre` | 3 | 3 | 3 | 0 | 0.0% | LOW-NOISE |
| `cannedFlexibilityPost` | 3 | 3 | 3 | 0 | 0.0% | LOW-NOISE |
| `cannedLinesPost` | 11 | 11 | 11 | 0 | 0.0% | LOW-NOISE |
| `cannedResumePre` | 8 | 8 | 8 | 0 | 0.0% | LOW-NOISE |
| `cannedResumePost` | 8 | 8 | 8 | 0 | 0.0% | LOW-NOISE |
| `issuesPre` | 12 | 12 | 12 | 0 | 0.0% | LOW-NOISE |
| `issuesPreMean` | 1 | 1 | 1 | 0 | 0.0% | LOW-NOISE |
| `lintCleanPre` | 8 | 8 | 8 | 0 | 0.0% | LOW-NOISE |
| `lintCleanPost` | 12 | 12 | 12 | 0 | 0.0% | LOW-NOISE |
| `lintForReviewPre` | 4 | 4 | 4 | 0 | 0.0% | LOW-NOISE |
| `pleasantryOpenPre` | 2 | 2 | 2 | 0 | 0.0% | LOW-NOISE |
| `reviewRan` | 12 | 12 | 12 | 0 | 0.0% | LOW-NOISE |
| `threeIStartsPre` | 1 | 1 | 1 | 0 | 0.0% | LOW-NOISE |
| `zeroContractionPre` | 12 | 12 | 12 | 0 | 0.0% | LOW-NOISE |
| `wordsPostMean` | 104.83 | 105.50 | 104.42 | 1.08 | 1.0% | LOW-NOISE |
| `wordsPreMean` | 118.25 | 120.17 | 121.42 | 3.17 | 2.6% | LOW-NOISE |
| `longestIRunPostMean` | 1.417 | 1.5 | 1.417 | 0.083 | 5.7% | MEDIUM |
| `reviewMsMean` | 10144 | 9576 | 10158 | 582 | 5.8% | MEDIUM |
| `inputTokens` | 62 | 58 | 58 | 4 | 6.7% | MEDIUM |
| `outputTokens` | 39420 | 37388 | 40692 | 3304 | 8.4% | MEDIUM |
| `guardAcceptRate` | 1 | 0.917 | 1 | 0.083 | 8.5% | MEDIUM |
| `reviewApplied` | 12 | 11 | 12 | 1 | 8.6% | MEDIUM |
| `cannedLinesPre` | 11 | 12 | 11 | 1 | 8.8% | MEDIUM |
| `totalMsMean` | 23959 | 21819 | 23634 | 2140 | 9.2% | MEDIUM |
| `cacheReadTokens` | 178620 | 200224 | 196255 | 21604 | 11.3% | MEDIUM |
| `problems` | 48 | 47 | 53 | 6 | 12.2% | MEDIUM |
| `problemsMean` | 4 | 3.917 | 4.417 | 0.5 | 12.2% | MEDIUM |
| `issuesPostMean` | 0.5 | 0.583 | 0.583 | 0.083 | 14.9% | MEDIUM |
| `issuesPost` | 6 | 7 | 7 | 1 | 15.0% | MEDIUM |
| `repeatedSentencesPost` | 13 | 14 | 12 | 2 | 15.4% | MEDIUM |
| `longestIRunPreMean` | 1.5 | 1.417 | 1.667 | 0.25 | 16.4% | MEDIUM |
| `repeatedSentencesPre` | 10 | 11 | 12 | 2 | 18.2% | MEDIUM |
| `contractionRatePostMean` | 2.141 | 1.681 | 2.067 | 0.46 | 23.4% | MEDIUM |
| `draftMsMean` | 13807 | 10919 | 11311 | 2888 | 24.0% | MEDIUM |
| `contractionsPostMean` | 2.333 | 1.75 | 2.25 | 0.583 | 27.6% | **UNUSABLE-AT-THIS-N** |
| `costUsdSubscription` | 0.768 | 0.511 | 0.548 | 0.257 | 42.1% | **UNUSABLE-AT-THIS-N** |
| `zeroContractionPost` | 2 | 2 | 1 | 1 | 60.0% | **UNUSABLE-AT-THIS-N** |
| `cacheWriteTokens` | 84439 | 24286 | 25494 | 60153 | 134.5% | **UNUSABLE-AT-THIS-N** |
| `reviewRetried` | 0 | 2 | 3 | 3 | 180.0% | **UNUSABLE-AT-THIS-N** |
| `cannedEasyOutPre` | 0 | 1 | 0 | 1 | 300.0% | **UNUSABLE-AT-THIS-N** |
| `pleasantryOpenPost` | 0 | 1 | 0 | 1 | 300.0% | **UNUSABLE-AT-THIS-N** |
| `reviewRejected` | 0 | 1 | 0 | 1 | 300.0% | **UNUSABLE-AT-THIS-N** |
| `threeIStartsPost` | 0 | 1 | 0 | 1 | 300.0% | **UNUSABLE-AT-THIS-N** |
| `blockedLanguage` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `cannedEasyOutPost` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `contractionsPreMean` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `contractionRatePreMean` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `lintForReviewPost` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `lintForStudentPost` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `overCeilingPre` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `overCeilingPost` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `overCeilingWordsPost` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `problemsNeedsStudent` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `reviewErrored` | 0 | 0 | 0 | 0 | — | DEGENERATE |
| `reviewRetrySkippedForTime` | 0 | 0 | 0 | 0 | — | DEGENERATE |

**16 LOW-NOISE, 18 MEDIUM, 9 UNUSABLE-AT-THIS-N, 12 DEGENERATE.**

## How a future A/B must cite this

1. **Name the class of every metric in your pass condition before you run.** A
   pass condition on a DEGENERATE metric is unfalsifiable — that is precisely
   how D21's headline threshold (`overCeilingPost`) got written, and
   `overCeilingPost` is **still 0 in all three arms here**, together with
   `overCeilingPre` and `overCeilingWordsPost`. **Twelve of the 55 metrics
   cannot carry a pass condition at n=12 at all.**
2. **At n=12, only the 16 LOW-NOISE metrics are usable, and the usable band is
   2.6%.** The best MEDIUM metric still moves 5.7% on identical code and the
   worst moves 24%. A 12-scenario A/B claiming a 10% improvement in
   `contractionRatePostMean` (23.4% band) or `draftMsMean` (24.0% band) has
   measured nothing.
3. **`guardAcceptRate` is NOT noise-free, and PLAN-B §2.3 is wrong about it.**
   It says "`guardAcceptRate` is a count, not one of the 58 continuous metrics,
   so the 22-of-58 noise floor does not apply; HARNESS lists it among the
   metrics that held still between identical runs." Measured here on identical
   code and an identical seed: **1.000, 0.917, 1.000** — MEDIUM, 8.5%. Its
   components move too: `reviewApplied` 12/11/12, `reviewRejected` 0/1/0,
   `reviewRetried` **0/2/3**. A guard-rate A/B at n=12 can produce a whole
   rejection out of nothing, and `reviewRetried` is the noisiest count on the
   board at 180%. **That is why Measurement 2 was run at n=30 per arm and why
   its result is quoted with a binomial interval rather than as a point.**
4. **Always run the same-code control arm (D21).** One control arm gives you
   "28 of 55 moved". Three arms give you a per-metric band, which is the thing
   you can actually threshold against. Three arms of 12 cost **$1.83 notional
   and 4.3 minutes**. There is no excuse for an uncontrolled A/B on this rig.
5. **For a MEDIUM metric, n≥24 is a floor, not a guarantee** — this table says
   nothing about how the bands shrink with n, because every arm here was n=12
   (see below).

---

# Total notional cost and wall time

| run | drafted | errored | model calls | notional $ | wall |
|---|---:|---:|---:|---:|---:|
| smoke (`--scenarios=1 --seed=smoke`) | 1 | 0 | 2 | 0.0569 | 20 s |
| `guard-full` | 30 | **0** | 72 | 2.4449 | 5 m 31 s |
| `guard-sparse` | 26 | **0** | 54 | 1.3871 | 3 m 36 s |
| `noise-A` | 12 | **0** | 24 | 0.7678 | 1 m 28 s |
| `noise-B` | 12 | **0** | 26 | 0.5112 | 1 m 18 s |
| `noise-C` | 12 | **0** | 27 | 0.5483 | 1 m 33 s |
| **total** | **93** | **0** | **205** | **$5.7162** | **9 m 28 s** (two jobs in parallel) |

Tokens over the five JSON runs: output 340,311; input 468; cache read
1,335,506; cache write 497,025. `costUsdSubscription` is subscription
accounting — what those tokens would have cost on the API — **not a charge.
Nothing in this session was billed, and the project's $10 API budget is
untouched.**

**`errored` is 0 in all five runs**, so all five are comparable and nothing was
averaged over a failure. Measurement 1 reads all five; Measurement 2's decision
reads `guard-full` alone, as the rule specified; Measurement 3 reads the three
noise arms alone.

---

# What this cannot tell us

1. **Two of the three confirmed guard modes, at any sample size.** Restated
   because it is the most important limitation in the document:
   `hasResumePdf` is forced false and the corpus never types a private topic,
   so **M10 (resume-PDF proper-noun) and M12 (private-detail shrink floor) are
   invisible here by construction**. The 10% in Measurement 2 is the remaining
   modes only.
2. **Production latency.** CLI durations include process startup and expose no
   `effort`, no `thinking` and no `speed: "fast"`. `draftMsMean` moved 24% on
   identical code. The retry's latency cost in production is an *argument*, not
   a measurement — the 13.8 s `reviewMsMean` is a CLI number.
3. **Opus.** Both calls ran one CLI model (`claude-sonnet-5-5`). The k
   distribution is Sonnet 5.5's editing behaviour. A model that rewrote single
   sentences instead of regions would change the Measurement 1 verdict, and
   nothing here rules that out for Opus 5 on the paid draft path.
4. **How the noise bands shrink with n.** Every noise arm was n=12. The
   "needs n≥24" label is the conservative inference that a band of 5–25% at
   n=12 should be re-measured before being trusted at a larger n — **it is not
   a measurement that n=24 is sufficient.** If a future A/B depends on a MEDIUM
   metric, run three arms at that A/B's own n.
5. **The rejected revised bodies.** The harness persists the rejection reason
   but not the edit that was rejected, and not the *first-turn* reason behind
   the 15 rescued retries. So 15 of the 19 observed rejections are unlabelled,
   and my false-positive judgement on the three "both from Atlanta" cases rests
   on the reason string plus a deterministic demonstration of the mechanism,
   not on the three literal rewrites.
6. **One student.** Maya Okafor, Duke, two profiles of thoroughness. "both from
   Atlanta" is *her* typed common ground; the false positive is a property of
   `detailScore`'s anchor rule, not of Atlanta, but its 10% rate is the rate at
   which this one corpus happens to put a short function word in a typed
   detail.
7. **Real traffic.** Nothing here touches the database, the archive,
   `runAiFeature`, quota, routing or fallback. The production guard rejection
   rate remains unmeasured, which is still the argument for D8's
   review-outcome record.
8. **Whether the patch schema is right for *correctness*.** Measurement 1
   settles its cost and nothing else. The case that per-span judging would stop
   whole edit sets being discarded is now supported by Measurement 2 — but it
   must be costed at **+26% output tokens**, not booked as a saving.

---

# Artefacts

| | |
|---|---|
| `scripts/probe/k-measure.ts` | Measurement 1: span alignment, k histogram, chars-changed, payload arithmetic. Takes any number of `--json` files; `--rows` prints per-draft rows. |
| `scripts/probe/anchor-both.ts` | Measurement 2: the deterministic proof that `"both"` is an anchor, importing the real `detailScore`/`detailSurvived`. |
| `scripts/probe/noise-bands.ts` | Measurement 3: per-metric spread and classification over N identical arms. |
| run JSON and logs | session scratchpad: `guard-full.json`, `guard-sparse.json`, `noise-{A,B,C}.json`, `jobA.log`, `jobB.log`. Throwaway; the probes regenerate every number from them. |

Nothing was committed. Nothing under `src/` was touched.
