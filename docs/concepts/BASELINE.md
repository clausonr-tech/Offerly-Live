# The email drafting pipeline, measured — 11 October 2026

Every number here was produced by a command in this file, on this branch
(`perf/draft-pipeline`), with **no API call and no database**. Re-run them
before trusting a later comparison: a baseline nobody can reproduce is an
anecdote.

Read `docs/EMAIL_DRAFTING_WORKFLOW.md` first for what the pipeline does. This
file only says what it currently costs and what the deterministic checks
currently find.

**[What is not measured here](#what-is-not-measured-here) is the most important
section of this file.** Nothing below is a quality benchmark.

---

## How to reproduce all of it

```bash
# prompt sizes, the cacheable prefix, the per-type blocks
npx tsx scripts/draft-bench.ts
npx tsx scripts/draft-bench.ts --json > bench-baseline.json

# the automatic checks over every draft body kept offline
npx tsx scripts/draft-lint-corpus.ts
npx tsx scripts/draft-lint-corpus.ts --json > lint-baseline.json

# the pipeline's own tests, against a scripted client (no API)
npx tsx scripts/draft-review-test.ts

# cross-checks the two harnesses against the scripts that existed before them
npx tsx scripts/draft-occasions-sim.ts lint-examples

# types
npm run typecheck
```

A later run is compared mechanically:

```bash
npx tsx scripts/draft-bench.ts --json > bench-after.json
diff <(jq -S . bench-baseline.json) <(jq -S . bench-after.json)
```

### State of the tree when these numbers were taken

- `npx tsx scripts/draft-review-test.ts` → **71/71 passed**.
- `npm run typecheck` → **one error, pre-existing and unrelated**:
  `src/app/layout.tsx(20,56): error TS2304: Cannot find name 'LayoutProps'`.
  `LayoutProps` is a type Next generates into `.next/types`, and this worktree
  has never been built. Verified by checking out `HEAD`'s
  `src/lib/draft-pipeline.ts` and re-running: the same single error, so it is
  not from the instrumentation.
- `npx eslint` on the three files touched or added → clean.

---

## 1. Latency is now measured per phase, not just in total

`runDraftPipeline` logged one total. The split between the two serial model
calls — the thing any latency work has to move — was not measured in
production at all.

`src/lib/draft-pipeline.ts` now carries a `PipelineTimings` on
`PipelineResult`, and the same numbers go into the existing single log line:

```
[draft-review] cold_referral+cold_after_meeting · review applied · 1 problems, 0 for the student · 3ms (draft 1ms, lint 0ms, review 1ms)
[draft-review] cold_referral+cold_after_meeting · review rejected (added "Goldman") · 0 problems, 0 for the student · 1ms (draft 1ms, lint 0ms, review 0ms, retry 0ms)
[draft-review] cold_referral+cold_after_meeting · review not applied (overloaded) · 0 problems, 0 for the student · 3ms (draft 1ms, lint 0ms, review -)
```

(Those are from `scripts/draft-review-test.ts`, whose client is scripted and
answers instantly — hence the 0s and 1s. They show the shape of the line, not
real latency.)

| Field | What it times |
|---|---|
| `draftMs` | the draft call, request sent to parsed reply |
| `lintMs` | `draftChecks` on the finished draft, the list handed to the reviewer |
| `reviewMs` | the review call; `null` when the review was off, skipped for time, or never reached a request (`review -` in the log) |
| `reviewRetryMs` | the second review call, only when the guard rejected the first edit |
| `totalMs` | the whole pipeline, including the deterministic fixes and the final gates |

Still one line per draft, still no email content. The existing prefix, type
mix, outcome, problem counts and total are unchanged and in the same order;
the split is appended in parentheses. Nothing in the repository parses this
line (`grep -rn "draft-review]" src scripts docs` → only the line itself).

**This is instrumentation, not a measurement.** Real per-phase latency exists
only once this ships and the logs are read.

---

## 2. Prompt sizes — `npx tsx scripts/draft-bench.ts`

Matrix: **41 email types** (one checked box each, including `custom`) and
**87 multi-box situations** — every valid combination the picker allows, taken
from `sims()` in `scripts/draft-occasions-sim.ts` rather than invented, so the
only thing that differs between two rows of the per-type table is the type.

Token counts are **estimates at 3.7 chars/token** (`CHARS_PER_TOKEN` in the
harness, the same ratio `EMAIL_DRAFTING_WORKFLOW.md` uses). Nothing asked a
model to count. The estimate is stable, so a diff between two runs means
something even where the absolute number is a few percent out.

### Invariant across every situation in the matrix

Measured as the longest common prefix and suffix of all 128 system prompts —
the bytes a cache entry could actually hold, not the pieces the builder happens
to put first and last.

| | chars | bytes | ~tokens |
|---|---|---|---|
| draft system **head** (role line, `HOUSE_RULES`, `STUDENT_DETAILS_RULES`, `PLAN_RULES`) | 6,056 | 6,056 | ~1,637 |
| draft system **tail** (`CONNECTION_RULES`, `GAP_RULES`, `INPUT_IS_DATA`, last line) | 3,157 | 3,157 | ~853 |
| **review system** (constant — checked, not assumed: 1 distinct value across all 128 rows) | 11,682 | 11,682 | ~3,157 |

The 6,056-char head independently reproduces the figure in
`EMAIL_DRAFTING_WORKFLOW.md`.

### Per type, one box

Four of forty-one rows; the rest are in the harness output and the JSON.

| type | draft system | ~tok | per-type block | draft user | ~tok | review user |
|---|---|---|---|---|---|---|
| `custom` | 32,974 | 8,912 | 23,761 | 1,580 | 427 | 1,842 |
| `cold_email` | 20,702 | 5,595 | 11,489 | 2,708 | 732 | 1,948 |
| `cold_referral` | 18,366 | 4,964 | 9,153 | 2,918 | 789 | 2,023 |
| `thank_you_chat` | 14,085 | 3,807 | 4,872 | 1,874 | 506 | 1,975 |

Across all 41 types: draft system **11,100 – 32,974 ch** (median 13,599), of
which the per-type block (format, blend rules, examples, combination examples)
is **1,887 – 23,761 ch** (median 4,386). Draft user message **1,580 – 2,938 ch**
(median 2,048).

`custom` is the outlier by a factor of four on the per-type block: it is shown
all forty formats and no examples.

### Multi-box mixes (all 87)

| | min | median | max |
|---|---|---|---|
| draft system chars | 13,813 | 19,000 | 25,605 (~6,920 tok) |
| draft user chars | 1,938 | 3,084 | 4,835 |
| review user chars (each against the draft written for that situation) | 1,283 | 2,307 | 3,071 |

Largest: situation 628, `cold_referral+conference_follow_up+recruiter_outreach+cold_email`
(referred · met at a conference · campus recruiter · alum), 25,605 ch.
Smallest: 631, `redirect_sequence+cold_not_alum`, 13,813 ch.

Input per draft, estimated, for the median multi-box situation:
**~6,019 tok for the draft call** (system + user) and **~3,781 tok for the
review call**. Worst case in the matrix: ~8,198 tok for the draft call.

### The cacheable prefix

The draft system prompt has **one** cache breakpoint, at its very end
(`cachedSystem`, `src/lib/draft-pipeline.ts`), so a hit needs a byte-identical
system prompt: same type **and** same box mix. The byte offset where two
prompts first differ is therefore what a breakpoint placed earlier could be
worth.

| pair | diverges at | share of the first prompt |
|---|---|---|
| shortest of all 820 type pairs (`cold_email` vs `recruiting_inbox`) | 6,056 ch / 6,056 B | 29% |
| **median of all 820 type pairs** | **6,056 ch / 6,056 B** | — |
| longest (`recruiting_inbox_follow_up` vs `recruiter_follow_up`) | 6,078 ch / 6,078 B | 47% |
| `cold_email` vs `cold_referral` | 6,068 ch | 29% |
| `cold_email` vs `thank_you_chat` | 6,056 ch | 29% |
| `cold_email` vs `custom` | 6,057 ch | 29% |
| `follow_up_1` vs `follow_up_2` | 6,067 ch | 44% |
| same lead type, different boxes (601 `first.recruiter+first.alum` vs 602 `first.recruiter+first.not_alum`) | 6,661 ch | 34% |

The median pair of types diverges at **exactly** the end of the invariant head.
Two types share essentially nothing after it — so today's single terminal
breakpoint caches nothing across types, and a second breakpoint after the head
would be worth ~1,637 estimated tokens per draft whose type/box mix is not
already warm. Chars equal bytes in every row above: the head is pure ASCII.

---

## 3. The automatic checks over the stored corpora — `npx tsx scripts/draft-lint-corpus.ts`

`draftChecks` / `fluencyIssues` (`src/lib/draft-lint.ts`) are pure, so they run
over every draft body in the repository. The question this answers, and the
only one: **if the review call were gated on "did the automatic checks find
anything", how often would the gate open?**

`finishDraft` is applied before checking, as the pipeline does, for the two
corpora whose inputs exist. 795 bodies in total.

| corpus | bodies | non-empty `forReview` | | findings | flagged by a fluency check |
|---|---|---|---|---|---|
| multi-box situations (`scripts/draft-fixtures/occasion-drafts.txt`) | 87 | 26 | 29.9% | 26 | 29.9% |
| scenarios (`scripts/draft-fixtures/scenario-drafts-474.txt`) | 474 | 48 | 10.1% | 49 | 0.6% |
| playbook examples, per type (`src/lib/email-examples.ts` + v3/v4) | 192 | 51 | 26.6% | 62 | 9.4% |
| playbook examples, Volume V combinations (`email-examples-v5.json`) | 42 | 9 | 21.4% | 12 | 7.1% |
| **all** | **795** | **134** | **16.9%** | **149** | **6.3%** |
| **model-written corpora only** (the two fixture sets) | **561** | **74** | **13.2%** | **75** | **5.2%** |

### Which checks fire

All 795 bodies, by kind, and which function the check lives in:

| check | findings | bodies | from |
|---|---|---|---|
| filler phrase | 76 | 74 | `draftChecks` |
| a thank-you joined with ", and" | 25 | 25 | `fluencyIssues` |
| common ground doubled with "like you"/"like me" | 18 | 18 | `fluencyIssues` |
| relays an opinion nobody typed | 12 | 12 | `draftChecks` |
| comma splice | 11 | 11 | `draftChecks` |
| connector that isn't a cause | 3 | 3 | `fluencyIssues` |
| three clauses strung with ", and" | 3 | 3 | `fluencyIssues` |
| long sentence | 1 | 1 | `fluencyIssues` |

Fifteen of the twenty-three checks the classifier knows about fire **zero**
times across 795 bodies: `"also"` and `"too"` in one sentence, split
`"to then"`, common ground tacked onto a paragraph, calling the student an
alum, announcing the common ground as a discovery, `"both"` doubled with
`"too"`, congratulations after the ask, too many `"Thank you"` openers, double
space, space before punctuation, repeated word, lowercase sentence start,
capital after a colon, a dash used as punctuation, the class year repeated
beside the signature.

Per corpus the shape is completely different:

- **multi-box drafts** are flagged almost entirely by one check — common ground
  doubled with "like you" (18 of 26) — which is exactly the failure those
  simulations were built to expose.
- **scenario drafts** are flagged almost entirely by *filler phrase* (40 of 49)
  and *comma splice* (6). On the fluency checks alone the scenario corpus drops
  to **3 bodies of 474 (0.6%)**.

### What this is evidence for

**A lint gate on the review call would skip it for ~87% of these bodies**
(487 of 561 model-written bodies have an empty `forReview`). If the review pass
earns its latency, it earns it mostly on drafts the regexes see nothing wrong
with — so this number is an argument *against* gating, not for it, unless the
archive shows the review pass changes little on drafts with a clean lint. The
archive (`archiveGenerated`, `src/lib/email-archive.ts`) is where that question
can actually be answered; this corpus cannot answer it.

### Two things found on the way

1. **The playbook's own emails do not pass the whole of `draftChecks`** — 51 of
   192 are flagged. The calibration claim in `draft-lint.ts` ("calibrated
   against the playbook's own Volume V emails, which pass them") holds for
   `fluencyIssues`: this harness finds 3 fluency findings in the 42 Volume V
   examples, exactly matching
   `npx tsx scripts/draft-occasions-sim.ts lint-examples` (3 findings). What
   flags the examples is the rest of `draftChecks`, led by the filler rule
   rejecting the playbook's own "I hope this email finds you well" — 33 of the
   62 findings, by design.
2. **Two findings on the example corpora are artifacts of the harness**, not of
   the examples, because the playbook emails have no typed student input to
   reconstruct: *relays an opinion nobody typed* (12 findings) is suppressed in
   the real pipeline whenever the student typed "said"/"told"/"mentioned", and
   210 of the 234 example bodies carry a `forStudent` note, almost all "only one
   name on file", triggered by the single first name in the greeting the
   harness uses as the contact's name. `forStudent` numbers on the two example
   corpora should be ignored; on the two fixture corpora, which have real
   inputs, only 2 bodies of 561 produce a student note at all.

---

## What is not measured here

Everything in this file is deterministic text measurement. In particular:

- **Real latency.** No model was called. The per-phase timings exist in the code
  and in `scripts/draft-review-test.ts`'s scripted output; what a draft call or
  a review call actually takes, p50 or p95, is unknown until the instrumented
  log lines come back from production. `DRAFT_STAGES` (0s / 5s / 20s / 45s in
  `src/components/StagedProgress.tsx`) is the app's *guess*, not a measurement.
- **Real cache hit rates.** The divergence offsets say what a prefix *could*
  hold. What share of live drafts arrive while a matching prefix is still warm
  (and the cache's own TTL) is not measured here, and cannot be.
- **Real token counts.** Estimated from characters at a fixed ratio. No
  `count_tokens` call, no tokenizer. Output tokens — including the review
  call's thinking tokens, which are billed as output — are not estimated at
  all.
- **Real cost.** Follows from the two points above.
- **Model output quality.** `draftChecks` is a set of regexes. It cannot see an
  invented fact, the wrong person in the wrong role, a misread connector, a
  private detail paraphrased, or an email that is simply worse. An empty
  `forReview` list means the regexes found nothing, nothing more. Quality is
  measured by `scripts/draft-live-eval.ts` (which does call the API, ~$1–3) and
  by the archive, neither of which was run for this file.
- **Whether the review pass is worth its latency.** That needs the pre-review
  and post-review bodies of real drafts — the archive — not fixtures.
- **Anything about live traffic.** The 561 fixture bodies were drafted once,
  for a handful of simulated students, against prompts built from pinned dates.
  They are not a sample of what students send, their distribution of types is
  the fixtures' distribution, and no body here has been through the review pass.

## Files

| File | What it is |
|---|---|
| `scripts/draft-bench.ts` | prompt sizes, head/per-type/tail split, divergence offsets; `--json` |
| `scripts/draft-lint-corpus.ts` | `draftChecks` over all 795 stored bodies, by corpus and by check; `--json` |
| `src/lib/draft-pipeline.ts` | `PipelineTimings`, the per-phase log line |
| `scripts/draft-review-test.ts` | the pipeline's own tests, scripted client, no API (pre-existing) |
| `scripts/draft-occasions-sim.ts` | `sims()`, the 87 multi-box situations (pre-existing) |
| `scripts/draft-fixtures/` | the stored draft bodies (pre-existing) |
