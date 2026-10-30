# BUILD-2 — tiered cache breakpoints on the drafting prompt

BUILDER-2, 11 October 2026. Branch `perf/draft-pipeline`, worktree
`.claude/worktrees/draft-pipeline-perf`. Implements D14 (unbundle the free
two-thirds of the cache win) and respects D15 (no reorder) and D18 (`custom`
must not emit an empty block).

Files changed: `src/lib/draft-prompt.ts`, `src/lib/draft-pipeline.ts`, new
`scripts/draft-tiers-test.ts` and `scripts/draft-fixtures/system-tiers-baseline.json`.
`src/lib/draft-review.ts` and `src/lib/draft-lint.ts` were not touched
(BUILDER-1 owns them). No API call was made; the Phase 2 evaluation ran on the
`claude` CLI on Kai's subscription.

Every number below is **MEASURED** by a named command, **ESTIMATED** (tokens, at
BASELINE's 3.7 ch/tok — never counted by a model), or **REASONED** from the
documented cache semantics, which is stated where it applies.

---

## 1. What shipped

`buildDraftPrompt` returns the system prompt as three ordered slices as well as
the single string it always returned:

```ts
export type SystemTiers = { invariant: string; perType: string; perRequest: string };
export function buildDraftPrompt(input: DraftPromptInput):
  { system: string; systemTiers: SystemTiers; userText: string };
```

`system` is now literally `invariant + perType + perRequest`, so the eight
scripts that destructure `{ system, userText }` — `draft-bench`,
`draft-cli-eval`, `draft-scenarios`, `draft-occasions-test`, `draft-bug-hunt`,
`draft-review-test`, `content-limits-test` and the `scripts/probe/*` probes — are
untouched and all still pass (§5). The draft call sends the three as separate
text blocks, one `cache_control` each; the review call's `cachedSystem` is
unchanged.

### The slices, and why they fall where they do

| slice | content | keys | size |
|---|---|---:|---|
| `invariant` | role line, `HOUSE_RULES`, `STUDENT_DETAILS_RULES`, `PLAN_RULES` | **1** | 6,044 ch / ~1,634 est tok |
| `perType` | `formatBlock` — the `EMAIL TYPE` line, timing, format steps, `HARD CEILING` | **53** | median 809 ch / ~219 est tok (min 554, max 23,775) |
| `perRequest` | blend rules, examples, combination block, `CONNECTION_RULES`, `GAP_RULES`, `INPUT_IS_DATA`, the closing line | **102** | median 8,270 ch (min 3,155, max 18,742) |

MEASURED: `npx tsx scripts/draft-tiers-test.ts` over all 148 prompts (107 valid
`resolveSituation` box combinations + 41 one-box type rows).

**Nothing moved.** The slices are cut at two boundaries in the existing order:
after `PLAN_RULES`, and after `formatBlock`. The invariant tail
(`CONNECTION_RULES` … `"Never state anything…"`) stays at the end of the prompt,
where the model has always read it last — D15 rejects moving it, and this change
does not need it moved.

**Why `perType` stops at the format and not after the examples.** The examples
are a pure function of the lead type and would be the valuable thing to put in a
per-type tier (up to 10,660 ch). They cannot go there without a reorder:
`blendRules` is written for one specific mix of boxes and sits *between*
`formatBlock` and `examplesBlock`, and a cache prefix has to be contiguous, so
with a second box checked a per-type slice has to stop at the format anyway.

I built the other variant first — `perType` swallowing the examples when no
blend rules intervene — and **rejected it on measurement**: it gives a type two
different per-type values (one for single-box, one for mixes) and so **61 keys
instead of 53**, and because a cache read can only land where an earlier request
wrote a breakpoint, a mix would then stop finding the single-box entry's
format-level prefix. It bought single-box drafts examples they already get from
the terminal breakpoint on an exact repeat, and charged the mixes for it.

### Three breakpoints, not two — a deliberate deviation from the brief

The brief said to mark `invariant` and `perType` and leave `perRequest` unmarked
because "it is the cache key's tail and marking it is pointless". I kept the
mark on all three, and this is the one place I did not follow the brief.

Marking the final block is exactly what today's code does — `cachedSystem` puts
one breakpoint at the end of the whole system prompt. Dropping it would delete
the only cache entry the system has today, so a **repeat of the same box mix**
would fall from a whole-prompt hit (median 15,208 ch) to a 6,853-ch prefix hit.
That is a regression on the one traffic pattern today's code already serves, in
exchange for nothing. REASONED from the documented semantics, with the quoted
rule that makes it free: *"Writes bill only the bytes past the highest cache
hit"* — so the two extra breakpoints add no write cost on a cold request, and the
API allows 4 (3 used; the review call is a separate request).

### What the breakpoints are actually worth

Today's single terminal breakpoint spreads over **102 distinct keys** (MEASURED),
one per box mix. REASONED from *"reads can only land on positions where a
previous request wrote a breakpoint"*: today a draft whose mix has not been seen
inside the cache window reads **nothing** — not the 6,056-ch common prefix, which
no breakpoint sits behind. After this change the same draft reads the invariant
tier, and the per-type tier when that type has been seen.

| traffic pattern | readable prefix today | with tiers |
|---|---|---|
| repeat of the same mix | whole prompt (median 15,208 ch) | unchanged |
| different mix, same lead type | 0 | 6,598–29,819 ch (median 6,874 over the multi-box rows) |
| different lead type | 0 | 6,044 ch / ~1,634 est tok |

Medians here are over this 148-prompt matrix, which includes the 41 single-box
type rows; TEST-A's p50 of 15,925 ch is over the 107 combinations alone. Neither
contradicts the other — they are medians of different sets.

**Honest limit: the per-type breakpoint is nearly worthless at the median, and
enormous on one type.** Beyond the invariant tier it adds only the format block
— ~219 est tok at the median. The exception is `custom`, whose `formatBlock` is
the 40-format dump: **23,775 ch / ~6,425 est tok**, now cached across every
`custom` draft from every student. So the honest summary is that the invariant
breakpoint is the win D14 described (~1,634 est tok, free, every draft), the
per-type breakpoint is a rounding error except on `custom`, and the examples —
the big per-type prize — stay stranded behind `blendRules` until someone does
the reorder D15 deferred.

**Cacheable-minimum check.** The invariant prefix is ~1,634 est tok, above the
1,024-token floor for Sonnet 5 (free tier) and the 512-token floor for Opus 5
(paid). It clears the Sonnet floor by ~60% on a *token estimate*; real
tokenization of English prose runs leaner than 3.7 ch/tok, so the margin is
thinner than it looks. It is not close enough to fail, and it is worth
re-checking against `usage.cache_read_input_tokens` on the first real traffic.

---

## 2. The safety property, and the evidence for it

**Claim: the concatenation of the three slices is byte-identical to the single
string the pre-change code built, for every one of the 148 prompts a student can
produce.** If that holds, the model is sent exactly the bytes it was sent
before, cache markers are not prompt text, and no quality A/B is owed — which is
why this change could ship without one.

The evidence is a committed fixture plus a test:

1. `scripts/draft-tiers-test.ts --capture` was run **before** `draft-prompt.ts`
   was edited. It records, for each of the 148 prompts, the sha256, char count
   and byte count of `buildDraftPrompt(...).system`, into
   `scripts/draft-fixtures/system-tiers-baseline.json`. 148 rows, **102 distinct
   sha256** — which independently reproduces TESTER-1's 102-distinct-keys count.
2. `npx tsx scripts/draft-tiers-test.ts` rebuilds all 148 and asserts, per row,
   `sha256(invariant + perType + perRequest) === the fixture's sha256`.

Result: **148/148 byte-identical, 33 assertions passing, 0 failing.**

Checked a second way: re-running `--capture` against the **post**-change code and
diffing the hashes against the committed fixture reproduces **all 148 sha256
values** (the committed fixture, with its pre-change capture timestamp, was then
restored). So the byte-identity does not depend on the test's own comparison
logic being right.

The system prompt is a pure function of `(type, alsoTypes, boxIds)` — no clock,
no student facts reach it — so the fixture is deterministic and a re-run cannot
drift for an unrelated reason.

Byte-identity is also structural, not just tested: the three slices are built
from one list per slice and joined, rather than cut back out of a finished
string with regexes, and a second assertion checks that the `system` the
function returns is the same bytes as the slices it hands the pipeline — so no
caller can be given one thing while the model is sent another.

### The other assertions (all MEASURED, all in that one script)

- `invariant` has **exactly 1** distinct value across 148.
- `perType` has **exactly 53**, and is a **pure function of (lead type, word
  ceiling)** — no box mix leaks into it. 41 lead types are reachable; the 12
  extra keys are types a mix gives a second or third word ceiling, and a further
  assertion proves those variants differ **only** in the `HARD CEILING` line.
- `perType` is the format block alone — no blend rules, no examples, no
  combination block — and always opens on `EMAIL TYPE: `.
- **No slice is ever the empty string** on any of the 148.

**Correction to the brief.** The brief asked me to assert that `perType` has
exactly 41 distinct values and is a pure function of the lead type. That is
**false for any tiering that moves no text**, and I did not engineer the number
to match. `HARD CEILING: N words` is a `Math.max` over the whole box mix and
sits *inside* `formatBlock`, so the tier is a function of (lead type, ceiling)
and has 53 values. 41 is what it becomes once the ceiling line moves out, which
is Phase 2 — and the measured 53 → 41 confirms the brief's own arithmetic for
that change (a 23% cut) exactly.

### The `custom` empty-block hazard (D18, TEST-A T6b)

`custom` produces no examples (`examplesBlock` returns `""`) and no combination
block (one box). Under PLAN-A's tiering, which moved the invariant tail up into
`invariant`, that left `custom` with a per-request block of **0 chars** — not a
valid API content block, and a new production bug.

It cannot arise here, for a structural reason: the invariant tail stays at the
end of the prompt, so `perRequest` always contains at least
`CONNECTION_RULES + GAP_RULES + INPUT_IS_DATA +` the closing line — 3,155 ch
minimum, measured as the floor across all 148. `custom` specifically is asserted
on: its `perRequest` is 3,155 ch and starts with `FINDING COMMON GROUND`, its
`perType` is the 23,775-ch format dump, and the three slices account for the
whole 32,974-ch prompt.

Belt and braces, `cachedTiers` in `draft-pipeline.ts` also
`.filter((text) => text.length > 0)` before building the block array, so a
future prompt change that empties a slice drops a block instead of sending an
invalid one.

---

## 3. Phase 2 — the `HARD CEILING` line

MEASURED (`draft-tiers-test`): the ceiling line is the only mix-dependent text
in the per-type tier, and the sole reason that tier has 53 keys rather than 41.
Moving it to the per-request tier cuts per-type keys by 23%.

Implemented behind a flag, **default OFF**:
`ceilingInPerRequestTier()` in `draft-prompt.ts`, on only when
`OFFERLY_DRAFT_CEILING_TIER=per-request`. With it on, `formatBlock` omits the
line and it becomes the first segment of `perRequest`.

**My placement differs from PLAN-A §2.2 and from TESTER-1's warning, and the
difference is the point.** The plan put the line after the examples, where
TESTER-1 correctly objected that it "would float after ~2,900 tokens of examples
with nothing introducing it" and so needs its own heading. The per-request tier
*begins* where `formatBlock` ends, so putting the line **first** in that tier
leaves it in the position it already occupies — immediately after the format
steps, before the blend rules and the examples. It is not moved across the
examples, nothing dangles, and it needs no heading. MEASURED consequence: the
entire text change is **one newline becoming two, once per prompt**. The test
asserts exactly that — every prompt grows by exactly 1 char (`custom` by 0, it
has never had a ceiling line), and substituting the single newline back
reproduces the pre-change sha256 on all 148.

With the flag on, MEASURED: per-type keys **53 → 41**, one per lead type, no
`HARD CEILING` anywhere in the per-type tier, no empty slices.

### The A/B

**Verdict: INCONCLUSIVE. The flag stays OFF.** The brief's pass condition is met
on its face, and I do not believe the measurement can carry that conclusion.

Three runs on the free CLI rig, 12 scenarios each, same seed, review pass on
(`scripts/draft-cli-eval.ts`, subscription, no API):

```
A  --scenarios=12 --seed=ceiling --json=ceil-off.json                       (flag OFF)
B  --scenarios=12 --seed=ceiling --json=ceil-off2.json  --compare=ceil-off.json   (flag OFF again — the control)
C  OFFERLY_DRAFT_CEILING_TIER=per-request … --json=ceil-after.json --compare=ceil-off.json   (flag ON)
```

B is the arm the brief's recipe does not include and the one that decides the
question: **two identical runs of the same code.** Everything it moves is noise
by construction.

| | A off | B off (control) | C flag ON |
|---|---:|---:|---:|
| metrics moved vs A (of 58) | — | **28** | **31** |
| `overCeilingPre` | 1 | **0** | **0** |
| `overCeilingPost` | 0 | 0 | 0 |
| `overCeilingWordsPost` | 0 | 0 | 0 |
| `issuesPost` | 8 | **9** | **6** |
| `issuesPostMean` | 0.667 | 0.75 | 0.5 |
| `lintCleanPost` | 11 | 11 | 12 |
| `guardAcceptRate` | 0.833 | 0.833 | 0.917 |
| `blockedLanguage` | 0 | 0 | 0 |

Why this is inconclusive and not a pass:

- **31 moved metrics versus 28 for doing nothing at all.** The experiment is
  inside its own control. On **17** of the 58 metrics the control moved *further*
  from A than the experiment did — including `problems` (−8 on noise, −2 on the
  flag) and every latency and token metric.
- **The control reproduced the win.** `overCeilingPre` fell 1 → 0 under the flag
  — and fell 1 → 0 in the control too, with the code untouched. That specific
  improvement is demonstrably noise.
- **`issuesPost` moved in both directions.** −2 under the flag, **+1** in the
  control. A 2-count move at n = 12 is not resolvable against a ±1 noise band.
- **The headline pass condition is unfalsifiable on this corpus.**
  "No draft exceeds its type's `maxWords` more often than before" cannot fail
  here: `overCeilingPost` is **0 across all 36 drafts** in all three runs. There
  is no baseline rate for a regression to show up against, so passing it is
  evidence of nothing. This is a defect in the pass condition, not a result —
  testing a word-ceiling instruction needs a corpus that actually produces
  over-ceiling drafts.

So: no harm was detected, nothing was established, and per the brief's own
instruction — *"If the A/B is inconclusive, leave the flag OFF and say so; do
not ship it on argument"* — `ceilingInPerRequestTier()` ships **off**. The 53 →
41 key reduction is real and measured; what it costs in output quality is not
known, and the argument that moving one newline cannot matter is exactly the
kind of argument the brief told me not to ship on.

What would settle it: a corpus selected for drafts that run long (so
`overCeilingPost` has a non-zero baseline), several runs per arm to establish
per-metric noise bands rather than one, and a pass condition stated as a
difference that exceeds those bands.

The flag, the measurement and this verdict are all cheap to revisit; the
implementation is done and tested on both settings, so turning it on later is a
one-line change plus a better experiment.

---

## 3a. The guard's admitted proper noun now reaches the student

Added on the coordinator's instruction, in `draft-pipeline.ts`, unrelated to
caching. It closes a silent-fabrication path, and it is the one change in this
build that alters what a student sees.

BUILDER-1's guard fix accepts **one** capitalised word it cannot verify — and
only when the resume is a PDF with no extracted summary, the one case where the
guard genuinely cannot check — rather than destroying a review edit that put a
real resume fact back (measured there as `added "Pinecrest"`). `guardRevision`
returns `{ ok: true, subject, note? }`, where `note` names the admitted word.

`draft-pipeline.ts` built the student's notes from `studentNotesFromReview(...)`
alone and **never read `guard.note`**, so the word entered the student's email
with nothing said about it. Being told is the entire basis on which admitting it
is acceptable, so this was a half-landed fix, not a missing nicety. The merge
site now appends `guard.note` when the edit was applied and a note exists.

Verified rather than assumed, in a new `scripts/draft-guard-note-test.ts`
(**13/13 passed**), which drives the real pipeline against a stub client — no
API call. It covers the fix and the three ways it could be wrong:

- the guard does accept the restored fact and does return a note naming it;
- the note reaches `draft.notesForStudent` on the finished draft, and
  **survives the `APP_HANDLES` filter** that strips resume boilerplate on the
  way out — the note mentions a resume, so a filter that ate it would be the
  same bug as never adding it. (It clears the filter; checked, not trusted.)
- exactly one copy, not duplicated by the dedupe/merge path;
- a plain rewording adds no such note, a **rejected** edit adds none (the word
  never reached the email), and a student **with** a resume summary gets the
  edit rejected outright, because then the guard can check and the allowance is
  off.

It is a separate file rather than an addition to `draft-review-test.ts` because
BUILDER-1 was editing that file in the same session; the pipeline half is what
is under test here.

## 4. What I chose not to do, and why

- **The reorder** (moving `CONNECTION_RULES`, `GAP_RULES`, `INPUT_IS_DATA` and
  the closing line up after `PLAN_RULES`, worth the remaining 853 est tok of the
  invariant tier, and the only way to get the examples into the per-type tier).
  D15 rejects it as specified: two of the three sentences it moves invert rather
  than dangle — the prompt-injection defence would widen its scope over the
  playbook's own text, and "not given to you below" would come to point at
  examples `HOUSE_RULES` declares fictional. Out of scope here by instruction
  and by judgement.
- **`ttl: "1h"`** on the invariant tier, which PLAN-A §2.2 proposes. Left at the
  5-minute default. The 1-hour TTL doubles the write price (2× vs 1.25×) and
  pays off only for start-to-start gaps between 5 and 60 minutes; PLAN-A §6 lists
  the production traffic distribution as UNKNOWN, and TEST-A T4c already
  faulted the plan for asserting a 5-minute window "often misses" on no traffic
  data. Deciding it needs the traffic numbers, not another argument. It is a
  one-line change when they exist.
- **The review call's breakpoint.** Left exactly as it was. Its system prompt is
  one constant value and one cache key (TEST-A T6e), so there is nothing to tier.
- **Any change to the user message.** PLAN-A's recency mitigation for the
  reorder is only needed if the reorder happens.

---

## 5. Verification, verbatim

```
$ npx tsx scripts/draft-tiers-test.ts
matrix                     148 prompts (107 box combinations + 41 type rows)
byte-identical             148/148
invariant tier             1 value, 6044 ch / ~1634 tok
per-type tier              53 values, 554-23775 ch (median 809)
per-request tier           102 values, never empty
cache keys today           102 (one per distinct whole system string)
cached prefix, cold mix    6056 ch today -> 6598-29819 ch, median 6853

33 passing, 0 failing
```

```
$ npx tsx scripts/draft-guard-note-test.ts → 13/13 passed
$ npx tsx scripts/draft-review-test.ts     → 104/104 passed
$ npx tsx scripts/draft-occasions-sim.ts lint-examples
                                           → 42 Volume V examples linted, 3 findings
$ npx tsx scripts/content-limits-test.ts   → 64/64 passed
$ npx tsx scripts/content-limits-coverage-test.ts
                      → 103 actions take input: 45 checked, 58 exempt, 0 missing
$ npx tsx scripts/draft-occasions-test.ts  → 0 failures
$ npx tsx scripts/draft-bug-hunt.ts        → 147/147 passed, 0 failed
$ npx tsc --noEmit
src/app/layout.tsx(20,56): error TS2304: Cannot find name 'LayoutProps'.
                      → the one pre-existing error, nothing new
```

`draft-review-test.ts` is at **104/104**, not the 71 the brief expected:
BUILDER-1 added tests to it during this session. 0 failures either way.

### The prompt sizes did not move — which is the whole point of Phase 1

`npx tsx scripts/draft-bench.ts --json` before and after, compared field by
field (3,937 leaf fields):

```
total leaf fields: 3937; differing: 387
differing paths (normalized):
   .invariant.reviewSystem.bytes
   .invariant.reviewSystem.chars
   .invariant.reviewSystem.tokens
   .rows[].reviewSystem.bytes
   .rows[].reviewSystem.chars
   .rows[].reviewSystem.tokens
differing paths NOT under a review field: NONE
draft-side size fields compared: 1942; all identical: True
```

**All 1,942 draft-side size fields are identical.** The 387 that differ are all
`reviewSystem` (11,682 → 11,952 ch), which is BUILDER-1's `draft-review.ts`
landing between my two captures — `draft-review.ts` mtime 18:07:10, my baseline
18:04:28, my after-run 18:07:50 — and nothing in this change can affect the
review prompt. Both harnesses that import the changed function (`draft-bench.ts`
and `draft-cli-eval.ts`) were re-run and work.

---

## 6. What this does not establish

- **No latency or cost number here is measured.** Every claim about what gets
  cached is reasoned from the documented cache semantics; nothing in this
  session made an API call, so no `cache_read_input_tokens` has been observed.
  The first real traffic should confirm `cache_read_input_tokens > 0` on a
  second draft of a *different* mix — that is the specific thing today's code
  cannot do and this change is supposed to fix. Until then the win is an
  argument from the API's documented behaviour, not a measurement.
- **The 102 → {1, 53, 102} key counts are over the 148-prompt matrix, not over
  production traffic.** Which keys are actually hot is a traffic question, and
  PLAN-A §6 lists that distribution as UNKNOWN.
- **Token figures are estimates at 3.7 ch/tok**, never counted by a model. The
  cacheable-minimum margin on Sonnet 5 rests on that estimate (§1).
