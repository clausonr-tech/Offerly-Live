# PLAN-B v2 — accuracy architecture, revised against the CLI rig

Revises `PLAN-B-accuracy.md` and `PLAN-B-accuracy-v1-full.md` (both v1) against
`HARNESS.md`, `scripts/draft-cli-eval.ts` and `BASELINE.md`. Everything in v1
stands unless contradicted here.

Labels: **MEASURED-RIG** = a real CLI run of the full pipeline (11 reviewed
drafts, `claude-sonnet-5-5`, sparse multi-box). **MEASURED-PURE** = a
deterministic probe of the real functions, no model. **ESTIMATED** = derived.

## What changed from v1

| Change | Why |
|---|---|
| **R2 (reconcile examples with voice policy) promoted to #1** | MEASURED-RIG: 11/11 pre-review drafts had zero contractions, every post-review draft ≥3. The review makes the email human and pays for it on every draft. The examples are the cause. |
| **R1 split; the expensive half demoted #1 → #7 behind a kill criterion** | MEASURED-RIG `guardAcceptRate` 1.0 (11/11 accepted, 0 retries). v1 ranked the per-span guard #1 on a premise now unsupported at this sample size. |
| **New R11: specimen-phrasing contagion** | MEASURED-RIG: the review replaced canned lines with `VOICE_RULES`' *own* printed example verbatim in 2 of 3 edits. |
| **`plan.sentences`: deletion → A/B** | Unread (MEASURED-PURE) but `PLAN_RULES` says "write the body from the plan, sentence for sentence" — may be load-bearing as forced reasoning. |
| **Review-gating: closed, not deferred** | MEASURED-RIG `lintForReview` 0 before *and* after on 3/3 while the review found 12–13 problems. |
| **New conflict C11** | The reviewer's rule 6b offers "Happy to work around your schedule." as an acceptable opener while `VOICE_RULES` names that same line as the stock phrasing to replace. |

## 1. Ranked

| # | Change | Risk | Cost | Confidence |
|---|---|---|---|---|
| 1 | **R2** — reconcile the example corpus with the voice policy | changing examples changes every draft of that type | Medium | High |
| 2 | **R1a** — the three confirmed guard false positives, **no alignment** | Low | Low | High |
| 3 | **R11** — stop the rules teaching their own phrasings | a rule without a specimen is vaguer | Low | Medium-High |
| 4 | **R3** — plaintext review-outcome record | privacy: codes and counts only, never content | Low | High |
| 5 | **R6′** — two-tier lint, four voice checks, dead-check cull | false positives on gold | Medium | High on tiering |
| 6 | **R7** — fix the deterministic fixers (em-dash splice first) | a bad rewrite ships with no model in the loop | Low | High |
| 7 | **R1b** — per-span alignment | highest in the plan: Frankenstein prose; monotone alignment cannot represent a cross-paragraph reorder | High | Low-Medium |
| 8 | **R8′** — prompt truth-up (C1–C3, C5, C11) | Low | Low | Medium |
| 9 | **R5** — `detailSurvived` with an anchor rule | stricter anchor rejects more | Medium | High |
| 10 | **R10′** — who's-who code check; `plan.sentences` A/B | deleting forced reasoning may cost fact accuracy | Low | Medium |

## 2. What 11/11 acceptance does and does not license

**(a) 0/11 is a weak bound.** One-sided 95% upper bound on the true rejection
rate with zero events in 11 trials is `1 − 0.05^(1/11)` = **23.8%**. Consistent
with one rejection in five. It rules out "rejection is normal", not "rejection
matters".

**(b) THE RIG CANNOT OBSERVE TWO OF THE THREE CONFIRMED MODES, BY CONSTRUCTION.**
`hasResumePdf` is forced false and every rig draft runs `studentResumeSummary`
only, so **M10 (resume-PDF proper-noun rejection) is structurally invisible at
any sample size**. The scenario corpus is simulated answers from one profile
that never types private topics, so **M12 (the private-detail shrink-floor
rejection — the safety-relevant one) is effectively invisible too.** Any reading
of 0/11 as evidence of rarity over-generalises from a sample that could never
contain the two worst cases.

**(c) The modes are confirmed bugs regardless of rate.**

### Sample size to settle R1b (exact binomial, one-sided 95%, zero observed)

| To rule out a true rate of | drafts |
|---|---|
| ≥10% | **29** |
| ≥5% | **59** |
| ≥2% | **149** |

Command: `npx tsx scripts/draft-cli-eval.ts --scenarios=30 --seed=guardrate --profile=full --retry-before=600000 --json=guard-30.json --quiet`
(`--profile=full` because full answers produce more typed details, which is what
the typed-detail rule keys on; `--retry-before=600000` because real CLI durations
exceed the 60s default and the retry path has never been exercised.)
30 ≈ $1.50 notional, ~13 min. Billed to nobody.

**Pre-committed decision rule:** ≥2 rejections in 30 → build R1b. 0–1 in 30 →
R1a only; re-measure at 149 opportunistically. 0 in 149 → R1b is dead; log the
guard's *near*-misses instead so the rate can be watched without the machinery.

`guardAcceptRate` is a count, not one of the 58 continuous metrics, so the
22-of-58 noise floor does not apply; HARNESS lists it among the metrics that
held still between identical runs.

### 2.4 The lint is a veto, never a score

`lintForReview` is 0 on both sides for ~7 drafts in 8, so
`after_.length > before_.length` compares 0 to 0. Comparing ∅ to ∅ by category
is still comparing nothing. Therefore:

1. **Default-allow.** A span passes on the hard invariants: no new proper noun,
   no new number, placeholder multiset preserved, greeting untouched, cohesion intact.
2. **The lint contributes only a veto**: reject a span if `spanLint(revised)`
   contains a **category** absent from `spanLint(original)`. Never reward a span
   for reducing findings; never reject because the lint found nothing.
3. **Delete the count comparison outright**, not generalise it.
4. **"Did the edit help?" is not a request-time question.** The review's value
   shows in `contractionRatePost`, `cannedLines` and its own `tone`/`flow`
   problems — none of which `draftChecks` sees. The guard's job: *permit
   everything provably not a fabrication, and nothing else.*
5. **Tier-2 diagnostics must never enter the veto set.** A contraction change is
   exactly the edit the rig shows the review making on 11/11 drafts; a guard that
   could veto it would destroy the review's largest measured contribution.

## 3. R11 — the rules teach their own phrasings

MEASURED-RIG: canned courtesy lines 4 → 1, replaced by `VOICE_RULES`' own
printed example **"Any time that suits you works for me"** verbatim in 2 of 3
edits; `repeatedSentencesPost` 2 in both runs. This is M16's mechanism one level
up: **a demonstration beats an instruction**, which also explains the 300-draft
result (every rule followed, template voice anyway).

**Class N — negative specimens (what NOT to write). Keep quoted.** Quoting a
banned phrasing is the precise discriminator and does not cause it to be written.

**Class P — positive specimens that are a complete reusable sentence. Rewrite as
descriptions.** In `VOICE_RULES`: "My resume's attached in case it's useful";
"Any time that suits you works for me" (*measured contaminating*); "No worries
at all if the timing's wrong"; "I'm a sophomore at Duke, and I'm also from
Atlanta."; "Following up on my note in case it got buried." In the reviewer's
rule 6/6b list: "Emily Tran suggested I reach out to you."; "I watched your
episode on community banking…"; "Ben and I had our call. Thank you again for
connecting us."; "Could you confirm my application was received?"; "Happy to
work around your schedule." (also C11); "As a fellow Duke student…"; "a fellow
Duke alum" / "where I gather you also studied".

Rewrite pattern — description plus a testable constraint:
> "Offer flexibility in your own words, built from something specific to this
> email. Do not use a stock phrasing, and do not reuse any wording printed in
> these rules."

"in wording that would not fit another email" is testable: it is what
`repeatedSentencesPre/Post` measures.

**Class S — specimens demonstrating structure (word order, where a sentence
ends). Keep, but label** *"the wording below illustrates a shape; never copy it."*

**Plus one global rule near the top of `VOICE_RULES` and `REVIEW_SYSTEM`:**
> "Every phrasing quoted in these rules is an illustration of a shape, never a
> phrase to use. If a sentence you write matches a phrasing quoted here word for
> word, rewrite it."

Risk: `"a fellow Duke alum"` is both a contaminating specimen and the phrase the
guard's shared-school regex protects — changing it touches that regex.

**Test:** `--scenarios=12 --seed=specimen`, before/after. `cannedFlexibility`
(rule's-own-phrasing arm) post-review **must reach 0**; `cannedLinesPost`,
`repeatedSentencesPost`, `problemsNeedsStudent`, `issuesPost` must not rise;
`guardAcceptRate` must not fall (catches a shared-school regex break). n=12 is
adequate *only* because these are the low-noise metrics.
Offline gate first: `scripts/draft-specimen-test.ts` asserts no Class-P string
appears in `VOICE_RULES`/`REVIEW_SYSTEM` and that the global rule is present in
both. This is what stops specimens creeping back later.

## 4. R6′ — the two tiers

**Verdict on the FILLER question: the rule is right, the examples are stale — but
the rule must not be a `forReview` problem until the examples are fixed.** While
the examples still teach the phrase, a `forReview` finding puts drafter and
reviewer in direct opposition on every draft. So: move the pleasantry arm to
Tier 2 now (one line); fix the examples; promote it back with a 0%-gold assertion.

**Tier 1, `forReview` (veto-eligible):** patterns gold does NOT contain —
MEASURED-PURE 0.0% of gold: spaced-hyphen dash, double space, space before
punctuation, lowercase sentence start, repeated word, capital after colon; plus
the comma-splice and discovery checks once narrowed.

**Tier 2, `voiceReport` (diagnostic only):** patterns gold DOES contain —
contraction rate, I-runs, canned courtesy lines, the pleasantry arm, `", and
thank you"`. Never sent to the reviewer, never in the veto set. Promotion is
per-check, only once the gold rate reaches 0, enforced by the calibration test.

### The four voice checks, calibrated honestly

- **(a) Contractions.** 75.0% of gold has zero. **There is no threshold at which
  an absolute "zero contractions is a defect" check passes gold.** Corpus
  diagnostic only until R2c brings gold under 25%. Type exemptions are
  load-bearing: `first.inbox`, `first.recruiter`, `TEAM_RECIPIENT`/`RECRUITER_ROLE`,
  offer decisions, professor letters.
- **(b) Consecutive "I" openings.** Gold: ≥3 → 28.1%, ≥4 → 10.4%, ≥5 → 3.6%.
  `VOICE_RULES` bans three; gold breaks that in over a quarter of cases. Ship at
  **≥5** as Tier 2; report `longestIRun` continuously.
- **(c) Canned courtesy lines.** The *concepts* are gold-frequent (resume line
  27.1%, flexibility 20.8%), so flagging the concept is wrong. Flag only exact
  stock strings: `for your reference` (32 in gold), `do not hesitate to` (8),
  `I look forward to hearing from you` (5), `I hope all is well` (3), `thank you
  in advance` (2) — plus, per R11, the rules' own printed phrasings. **Never
  auto-fix:** a deterministic replacement produces a new template.
- **(d) Discovery phrasing — widened then narrowed.** The naive widening is
  wrong: `I saw/noticed … you` matches 6 gold examples and all 6 are **true
  negatives** ("I saw the announcement that you…") — legitimate observations
  about the recipient's news, which is not banned. The discriminator is a
  commonality marker, not `you`:
  ```
  /\bI (?:noticed|saw|see|gather|learned|found|was (?:glad|excited|happy) to (?:see|learn|find)|realized|came across)\b[^.!?]{0,60}?\b(?:we(?:'re| are)? both|we share|you (?:are |were )?also|you (?:too|as well)|(?:also|too)\b[^.!?]{0,20}\b(?:from|at|studied|went))\b/i
  ```
  plus a required object from a commonality class (school, hometown, club,
  employer, or a token in `detectedOverlaps`). Catches the probe's "you are also
  from Atlanta", excludes all 6 gold hits. **Gold rate 0% by construction → the
  only one of the four that qualifies for Tier 1 on arrival.**

### Dead checks — a correction, then the cull

**A never-firing check costs no reviewer attention** (`AUTOMATIC CHECKS FLAGGED`
lists only findings). What it actually costs is maintenance and **false
confidence** — which is precisely how four voice defects went unchecked for 300
simulated drafts. Better reason to cull.

- **Delete from the lint, move to `finishDraft` as auto-fixes (8):** double
  space; space before punctuation; repeated word; lowercase sentence start;
  capital after colon; dash as punctuation; split "to then"; "also"+"too". All
  0.0% on gold; all deterministic transforms.
- **Widen — mis-specified (3):** discovery-as-announcement; student called an
  alum; "both" doubled with "too". Zero firings means the regex is wrong, not
  that the defect is absent.
- **Keep as-is — rare but consequential (4):** congratulations after the ask;
  class year beside the signature; common ground tacked on; too many "Thank you"
  openers. Zero firings is the desired state.
- **Widen `ASK`:** matches only 18.2% of gold (35/192), so "dropped the ask" and
  the congratulations-ordering check are inert on ~82% of shapes. Add `would you
  be free`, `any chance you`, `I'd love to` + `call|chat|talk|hear`, `let me know
  if`, a question containing `minutes`. Threshold: **≥70% recall, 100% precision**
  on a hand-labelled 40-body sample committed with the test.

### Calibration test — the ratchet

`scripts/draft-lint-calibration.ts` extends `draft-lint-corpus.ts` and asserts:
every Tier-1 check's gold hit rate is **0.0%** across all 234 example bodies
(non-zero fails the build); no Tier-2 finding appears in `forReview`; no Tier-2
category appears in the guard's veto set; `fluencyIssues` on the 42 Volume V
examples is **exactly 3**, cross-checking that the harness has not drifted.

## 5. `plan.sentences` — A/B, default keep

A single flag drives both schema and prompt so they cannot drift and the rig's
`assertSchemaMatchesPipeline()` keeps passing:
```ts
export const PLAN_SENTENCES = true;   // the A/B switch
```
Test at **n=24** (not 12 — `issuesPre` is in the rig's noisy set, 1→3 between
identical runs). Kill criteria, any of which means keep: `issuesPre` rises, detail
retention falls, `wrong_person` problems rise, `lintForReviewPre` rises.
`outputTokens` is the only expected gain and does not justify the change alone.
**Default outcome is keep.** Better alternative to deleting: assert every typed
detail appears in ≥1 planned sentence, as a pure code check that localises a
dropped detail before the body is read.

## 6. Phases

**Phase 0 — cheap, high-certainty, no model.** R1a (M12 first, safety-relevant)
· R6′ tier split + delete the count comparison · R11 offline gate then the
Class-P rewrites · R3 (the only instrument that can measure the production rate)
· C1/C2/C3/C5/C11 prompt truth-up.

**Phase 1 — measure on the free rig, each with a kill criterion.** R1b rate
measurement (30, both profiles) · R11 A/B (12) · R2a+R2b A/B (≥12 paired) ·
R10′ A/B (24).

**Phase 2 — conditional.** R7 auto-fixes · R5 `detailSurvived` · discovery regex
to Tier 1 and `ASK` widened · **R2c the example-corpus edit, with Kai's sign-off
and the rate table** · R1b **only if** ≥2 rejections in 30.

**Regression gate at every step:** `draft-review-test.ts` ≥71/71 ·
`draft-lint-corpus.ts --json` diffed against baseline · `draft-bench.ts --json`
diffed against baseline · `draft-occasions-sim.ts lint-examples` must stay at 3
findings · `npm run typecheck` (one pre-existing `LayoutProps` error). A rig run
with `errored > 0` is not a comparable run.

## 7. Where v2 is weakest

1. **R1b's expected value is genuinely uncertain and this plan does not resolve
   it — it specifies how to.** If 30 drafts come back 0/30, do not build it.
2. **Every rig number is `claude-sonnet-5-5` with no effort, thinking, fast mode
   or resume-PDF path.** Production drafts run Opus-low. A change that helps
   Sonnet 5.5 is not thereby proven to help Opus.
3. **R2c is the highest-value change and the one an agent is least entitled to
   make.** The measured case is strong; the examples are the product's taste.
4. **R11's Class-P/Class-S boundary is a judgement call.** If the A/B shows the
   rewrites made the reviewer vaguer (watch `problemsNeedsStudent`, `issuesPost`),
   the answer is more Class S, not more rewriting.
5. **Tier 2 is a holding pen, and holding pens leak.** The calibration test's
   0%-gold promotion condition is what makes it a ratchet rather than a
   graveyard. If that assertion is dropped, this design degrades into the one it
   replaced.

## 8. A third place to check for specimen contagion

`BOX_FACTS` and the `WHO'S WHO` block print specimen phrasings ("The student met
the RECIPIENT in person"), and the drafter's `plan.people` examples print role
phrasings ("Rachel Stein: the recipient, whom the student met at the panel"). If
verbatim copying shows up there too, the fix is one global rule in every prompt
rather than three local edits — and `repeatedSentencesPost` would catch it.
