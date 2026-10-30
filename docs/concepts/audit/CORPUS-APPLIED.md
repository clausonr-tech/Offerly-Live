# CORPUS-APPLIED — the 138 gold-corpus edits, applied

CORPUS-APPLY, 12 October 2026. Worktree `.claude/worktrees/draft-pipeline-perf`,
branch `perf/draft-pipeline`, applied against HEAD **`67169d3`**.

**138 of 138 edits applied. 0 skipped.** One replacement was rewritten before it
was written to disk, for a reason the plan's own gate could not see (§4).

Three files changed, and only these three:

```
 src/lib/email-examples-v3.json | 48 ++++++++++++-----------
 src/lib/email-examples-v4.json | 46 ++++++++++++---------
 src/lib/email-examples.ts      | 86 ++++++++++++++++++++---------------
 3 files changed, 90 insertions(+), 90 deletions(-)
```

90 insertions against 90 deletions: every edit replaced a line in place, so the
diff is readable line by line. Nothing else under `src/` moved — `shasum` after
the write:

| file | sha1 | state |
|---|---|---|
| `src/lib/email-examples-v5.json` | `cec2b6d19a3dbf0570bd4693a3061b1dd35f2fb8` | **unchanged** (the calibration corpus) |
| `src/lib/draft-prompt.ts` | `5d57a9f2ffb2fc8c9311981255317372ece2a5f1` | **unchanged** |
| `src/lib/draft-review.ts` | `ace539d84def8300277035dd4c34c9879afe68b5` | **unchanged** |
| `src/lib/draft-lint.ts` | `5777d7dc5c9359b0269451ebdf3cd380cdbe128a` | **unchanged** |
| `src/lib/draft-templates.ts` | `300dad4c29f30ad761485926eb16db24a6d21bff` | **unchanged** |

No Anthropic API call, no `scripts/draft-cli-eval.ts`, no database, no commit,
no `npm install`.

---

## 1. Why 73 became 138: the key, not the `file` column

The earlier applier reached 73 of 138. The cause was resolution, not the edits.

`EMAIL_EXAMPLES` concatenates **Volume II** (template literals in
`email-examples.ts`), then **Volume III** (`-v3.json`), then **Volume IV**
(`-v4.json`), and the edit table's `key` is `typeId#n` **1-based over that merged
list**. Indexing a per-file array by `n - 1` therefore reads a different example
than the one that was reviewed: `cold_referral#5` is `v3["cold_referral"][0]`,
not `[4]`, because Volume II supplied the first four. That is the "key resolves
to the wrong body" failure. The other failure was uniqueness measured
**file-wide** for the `.ts`: a `find` that is unique inside its own body but
repeated elsewhere in Volume II was rejected as ambiguous.

`scripts/audit-probe/corpus/corpus-map.ts` now owns that arithmetic for both
`apply.ts` and `apply-check.ts --post`. It parses Volume II's `body:` literals
out of the raw `.ts` with their byte offsets, expands `${…_SIGNATURE}`, lays the
three volumes out in merge order, and — the load-bearing step —
**asserts every reconstructed slot is byte-identical to the corresponding
`EMAIL_EXAMPLES` body before anything is written**:

```
slot map verified: 192/192 bodies byte-identical to EMAIL_EXAMPLES
138/138 applied and WRITTEN · 0 skipped
```

So `key → file location` is checked, not inferred. With that in place **all 138
`find` strings occur exactly once inside their resolved body**; the caller's
reading was right that apostrophes were never the problem (this corpus is
U+2019 throughout and every `find` matched on an exact-string basis).

Volume II is edited by byte span, so one body's edit cannot reach another's.
Both JSON files round-trip byte-identical through
`JSON.stringify(data, null, 2) + "\n"` — re-verified before the write, and v3
re-verified after the §4 correction.

## 2. Skips

**None.** Every edit the plan specifies is on disk. No edit needed its intent
recovered from an ambiguous or absent `find`.

## 3. Before and after

Counted over all 192 gold bodies, signature stripped, with the committed corpus
at `67169d3` as "before".

| pattern | before | after | plan's target |
|---|---:|---:|---|
| `for your reference` | 32 | **0** | 0 ✓ |
| flexibility construction (bodies) | 52 | **16** | ≤16 ✓ |
| canned `flexibilityLine` (bodies) | 42 | **14** | ≤16 ✓ |
| `flexible` (occurrences) | 31 | **9** | — |
| opens on a pleasantry | 62 | **25** | 25 ✓ |
| `I hope this email finds you well` | 20 | **5** | no opener over 5 ✓ |
| `I hope you are doing well` | 23 | **3** | no opener over 5 ✓ |
| bodies with ≥1 contraction | 0 | **18** | 18 ✓ |
| total contractions | 0 | **27** | 27 ✓ |
| `do not hesitate to` | 8 | **0** | 0 ✓ |
| `I look forward to hearing from you` | 5 | **0** | 0 ✓ |
| closes on thanks-for-your-time | 72 | **47** | ≈47 ✓ |
| closes on a thanks (any) | 164 | 162 | — |
| canned `resumeLine` (bodies) | 52 | 36 | not a pass metric (§1.B of the plan) |
| 3+ consecutive "I" openings | 30 | **25** | down ✓ |
| distinct opening strings | 137 | **173** | up ✓ |
| distinct closing strings | 113 | **131** | up ✓ |
| most-repeated opener | 21× | **5×** | ≤5 ✓ |
| most-repeated closer | 19× | **12×** | ≤12 ✓ |
| `I wanted to` | 53 | **43** | down ✓ |
| **total body words** | **21,113** | **20,342** | −771 ✓ |

Every figure the plan predicted landed exactly, including the −771 words.

Most-repeated after the edits:

```
OPENER  5x "I hope you are having a good week!"   5x "I hope this email finds you well!"
        3x "Thank you so much for the offer."     2x "My name is Owen Dulaney, and I am a freshman…"
CLOSER 12x "Thank you again!"   9x "Thank you so much!"   7x "Thank you again for everything!"
        6x "Thank you again for your time!"       5x "Thank you very much for your time and consideration."
```

The residue is Tier 4, which the plan deliberately does not enumerate: 34 bodies
in thank-you types where closing on a thanks is correct.

## 4. The one deviation, and the one correction

**Correction — a comma splice the plan's gate could not see.** Edit 133
(`thank_you_interview#1`, slot `offer-fronted`) replaced
`"…please do not hesitate to reach out."` with
`"Anything else the team needs, I can get to you quickly."` That construction is
flagged by `draft-lint`'s own `commaSplices`, so the corpus would have
demonstrated a sentence the app rejects. `apply-check.ts` gates on
`fluencyIssues`; comma splice lives in `draftChecks`, which is why 138/138 came
back clean. Caught by diffing `draftChecks` per body against HEAD.

Rewritten to `"Whatever else the team needs, I can get it over quickly."` —
still fronted, so the variety slot is unchanged; `Whatever` is in
`draft-lint`'s own `INTRODUCTORY` exemption list, so it is not a splice; and it
also repairs a semantic slip in the original replacement ("I can get **to** you
quickly" says *reach* you, not *send* it). `comma splice` is back to its
baseline 3 and **no check of any kind gains a finding anywhere in the 192
bodies**. `edits.ts` carries the corrected text, so `table.ts` and the plan's
table regenerate to what is actually on disk.

**Deviation — apostrophe typography.** The 26 contractions in `edits.ts` were
written with the ASCII `'`. The corpus uses U+2019 exclusively (174 bodies, every
one a possessive, plus the signature's `University ’29`), so applying them
verbatim would have left **11 of the 18 contraction bodies carrying both forms in
one email** — e.g. `That's the exact sequence` beside `University’s` in
`cold_not_alum#7`. All 26, plus one possessive (`a freshman’s email`), were
normalised to U+2019 in `edits.ts` before applying. Mixed forms afterwards: **0**.
Nothing else about the replacements changed; `draft-lint`'s `CONTRACTION` regex
accepts both forms, and total contractions is still 27.

## 5. Variety

**138 edits across 56 distinct variety slots.** The two largest are the
zero-risk mechanical ones; **no written replacement slot exceeds 10.**

```
  29  delete-pleasantry                     2  flex-delete + R2-purpose-clause
  18  contraction-swap                      2  flex-delete
  10  C1-thanks-for-the-specific-thing      2  flex-delete + R3-included
   5  flex-delete + R6-drop-fyr-only        2  C4-appreciation-not-thanks
   4  C3-close-on-the-ask                   2  throat-to-please-confirm
   4  flex-delete + R4-plain                2  vary-pleasantry-season
   4  C2-short-thanks                       2  vary-pleasantry-neutral
   3  flex-delete + R0-no-resume-sentence
   3  flex-delete + R2-impersonal          …and 38 slots used once each
   3  R4-plain + C1-thanks-for-the-specific-thing
   3  delete-pleasantry + cut-throat-clearing
```

The resume mention is spread over 11 slots, the flexibility sentence over 9, the
closing over 6 families, the `recruiting_inbox` ask over 8 `ASK`-recognised
families, and the `do not hesitate` offer over 7 constructions. 32 identical
replacements would have installed a new cliché; this did not.

Read independently of the tally, all 138 were checked against their own body
before the write — every new sentence is built from words already in that body
(`the credit team`, `that long line`, `the exit question`, `the speaker night`,
`a freshman’s email`, `nobody I have spoken with has done both`). Three are worth
naming as the weakest, all kept deliberately:

- `cold_referral#8` closes `"Thank you for treating it as a normal student
  email."` while the body already asks `"please treat this like any other
  student email."` The idea is said twice, and the thanks pre-dates the favour.
- `cold_after_meeting#4` opens `"Thank you for judging…"` and now closes
  `"Thank you for judging, and for the exit question in particular!"` The
  specificity earns the callback, but it is a callback.
- `cold_email#5` closes `"…I hope the fall is treating you well."` Nothing in
  that body establishes the season. It is a generic wish, not a fact, and it
  carries no proper noun, number or date — but it is the only replacement in the
  table that asserts anything the body does not supply.

## 6. Gates

```
npx tsx scripts/audit-probe/corpus/apply-check.ts --post      exit 0
  POST-APPLY       69 bodies differ from HEAD; the table names 69 — exactly that set
                   no edit's original text survives on disk
                   every non-empty replacement is present on disk
  FACT FIDELITY    no fact token lost in any touched body          (0 of 69)
  LENGTH           net −771 words; no body over its type ceiling
  THE ASK          115/192 before, 115/192 after; no body lost its ask
  FLUENCY          18 findings before, 18 after (+0); no NEW finding, none gone

npx tsx scripts/draft-occasions-sim.ts lint-examples          exit 0 — 3 findings
npx tsx scripts/draft-bug-hunt.ts                             147/147 passed
npx tsx scripts/content-limits-coverage-test.ts               104 actions, 0 missing
npx tsc --noEmit                                              clean
```

`apply-check.ts` gained a `--post` mode, because its `find` strings are consumed
by a successful apply and the default mode can then only report 138 missing
finds. `--post` reads the pre-edit corpus out of `git show HEAD:…` and runs the
identical gate on what is actually on disk — so fact fidelity, length, the ask
and fluency are asserted against the written files, not against an in-memory
simulation. Its one pre-existing type error (`ceiling.get(b.typeId)` with a
`string` against an `EmailTypeId`-keyed map) is fixed.

`lint-examples` is **3 findings, exit 0** — unchanged by construction, since
`email-examples-v5.json` is byte-identical.

`scripts/draft-lint-corpus.ts`, before → after, on the gold 192:

| | before | after |
|---|---|---|
| playbook examples flagged | 51 / 192 (26.6%) | **41 / 192 (21.4%)** |
| findings | 62 | **44** |
| filler phrase | 33 | **15** |
| comma splice | 3 | **3** |
| thank-you joined with ", and" | 14 | 14 |
| relays an opinion nobody typed | 8 | 8 |
| clauses strung with ", and" | 3 | 3 |
| connector that isn't a cause | 1 | 1 |
| ALL corpora | 134 / 795, 149 findings | **125 / 795, 132 findings** |

The filler-phrase drop is the deleted pleasantries: the rule rejects the
playbook's own `I hope this email finds you well` by design. No check gains a
finding. Volume V is untouched at 9 / 42, 12 findings.

## 7. Two failing gates this change causes, both outside the files I own

Reported, not worked around. Neither is in the three edited files, and neither
can be fixed from them.

### 7a. `scripts/draft-review-test.ts` — 139/141 (was 141/141)

```
FAIL detail: DETAIL_COMMON still matches the corpus it was generated from (69 tokens)
     {regenerated: 69, constant: 74, missing: ["fall","writing"]}
FAIL detail: a window removed from a body is noticed (180/192)
```

**`DETAIL_COMMON` is a generated constant in `src/lib/draft-lint.ts`** — the
tokens appearing lowercase in ≥10% of the gold bodies — and the test asserts it
still equals what the corpus regenerates. It no longer does, and the delta is a
clean fingerprint of this change:

```
dropped (7): doing  finds  flexible  great  please  reach  reference
added   (2): fall  writing
```

`doing`/`finds` are the deleted pleasantries, `flexible` the deleted flexibility
line, `reach`/`please` the `do not hesitate to reach out` rewrites, `reference`
the 32 `for your reference`; `writing` arrives with `I am writing one last
time`. The fix is a one-line regeneration of that constant, in a file this task
is not allowed to touch. The regenerated set, for whoever does it:

```
again answer anything appreciate appreciated around attached back call conversation
else email fall finance firm first forward glad happy hear hope interest junior know
last look love minutes morning move name next number offer phone point process rather
really resume schedule send since sophomore spent spoke still studying summer taking
team thank through time understand useful want wanted week weeks well were whether
will work worked writing year years
```

Left stale, the effect is small and conservative: `detailSurvived`
(`draft-review.ts:472`) treats a word as an *anchor* when it is capitalised,
numeric, or **not** in `DETAIL_COMMON`, so seven words that are no longer common
are still exempted from anchoring. It makes the detail check slightly less
sensitive, in seven words, and the failing test is the signal that says so.

**The window assertion is a re-rolled sample, not a sensitivity loss.** The test
takes a deterministic 6-word window per body at offset
`(body.length * 7) % (words.length - 6)`, removes it, and requires the removal to
be noticed in ≥95% of bodies. Measured both ways through the same
`detailSurvived`:

```
HEAD    184/192 (95.8%)   — 8 misses
working 180/192 (93.8%)   — 12 misses
```

Five misses are the same unchanged bodies in both runs
(`recruiting_inbox_follow_up#1`, `#2`, `thank_you_phone_screen#1`,
`decline_offer#3`, `reference_request#2`). Changing a body changes its length,
which moves the offset, and in 7 edited bodies the new window lands on
boilerplate whose every anchor recurs elsewhere in the same body — `"My name is
Alex Rivera, and"`, `"Clauson, and I am a junior"`, `"Calloway School of Business
studying finance"`. Removing those spans genuinely is not noticeable, because the
tokens are still there. The assertion was riding at 95.8% against a 95% floor, so
any corpus edit re-rolls it. I checked the obvious hypothesis that regenerating
`DETAIL_COMMON` would lift it back and it **does not** — the misses turn on
anchors recurring, not on which words count as anchors. This is a judgement for
the owner of that test: either the window selection should be made independent
of body length, or the floor should sit where the measurement actually is.

### 7b. `scripts/draft-tiers-test.ts` — 30 passing, 92 failing (was 33/0)

Every one of the 92 is the same fact: the composed drafting prompt is no longer
byte-identical to `scripts/draft-fixtures/system-tiers-baseline.json`, because
the gold corpus is embedded in the per-type tier and the corpus got shorter.

```
FAIL first_contact:first.alum: chars 22867 vs 23857 … tiers===system true
FAIL byte-identical on all 148 prompts (59/148)
```

**`tiers===system true` on all 89 per-row failures** — the property the test
exists to protect (`invariant + perType + perRequest` reassembles the single
string exactly) holds on every row. 59 of 148 prompts are still byte-identical:
the types with no edited examples. Per-prompt deltas run −989 to +43; a few
prompts grow, because the `recruiting_inbox` throat rewrites and the specific
closings are longer than what they replace, while the corpus is −771 words
overall.

The documented path forward is `npx tsx scripts/draft-tiers-test.ts --capture`,
and **I deliberately did not run it.** The committed fixture was captured against
the code *before* the tiering landed; re-capturing now would replace it with
output from the tiered code and delete the only evidence that the tiering changed
no bytes. That trade is the fixture owner's call, not this change's, and
`scripts/draft-fixtures/` is outside what this task owns.

### Not caused by this change

`scripts/test/help-knowledge-coverage.test.ts` reports stale entries for
`/applications`, `/contacts`, `/discovery`, `/drafts`, `/help` and others. No
page's source list in `src/lib/help-knowledge-sources.ts` includes
`email-examples*`, and the staleness predates this work (it tracks the dead-symbol
and shared-hook commits). `npm run help:learn` is therefore **not** required by
this change and was not run.

## 8. Files

| path | what |
|---|---|
| `src/lib/email-examples.ts` | 86 lines changed — Volume II bodies, by byte span |
| `src/lib/email-examples-v3.json` | 48 lines changed |
| `src/lib/email-examples-v4.json` | 46 lines changed |
| `scripts/audit-probe/corpus/apply.ts` | rewritten: resolves by key through the merge, verifies 192/192, writes |
| `scripts/audit-probe/corpus/corpus-map.ts` | new — the `typeId#n` → file arithmetic, shared by apply and apply-check |
| `scripts/audit-probe/corpus/apply-check.ts` | `--post` mode, and the `ceiling.get` type error fixed |
| `scripts/audit-probe/corpus/edits.ts` | apostrophes normalised to U+2019; edit 133's replacement corrected |
| `docs/concepts/audit/CORPUS-APPLIED.md` | this document |

## 9. What is now measurable

The primary arm in the plan's §5.2 is unblocked and is the cheapest clean
measurement on the board: `contractionsPreMean`, `contractionRatePreMean` and
`zeroContractionPre` were 0/0/0 and 12/12 across three identical arms, so the
control band is exactly zero and **any non-zero pre-review contraction after this
lands is signal**. The corpus now demonstrates 27 contractions in 18 of 192
bodies, 0 of them in the ~38 full-form bodies VOICE_RULES reserves for full
forms. Run `before` / `control` / `after` as §5.1 specifies; the reading rule
(`|after − before| > |control − before|`) still applies to everything else.
