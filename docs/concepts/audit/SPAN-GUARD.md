# SPAN-GUARD — the per-span guard, and the shared-school rule

Built by SPAN-GUARD-2 in `.claude/worktrees/draft-pipeline-perf`. Two changes:

1. **The per-span guard** (`src/lib/draft-align.ts`, `src/lib/draft-span-guard.ts`),
   OFF by default behind `SPAN_GUARD_DEFAULT` / `OFFERLY_SPAN_GUARD`.
2. **The shared-school rule now protects the fact, not the token `alum`**
   (`src/lib/draft-review.ts`, `saysSharedSchool`). Always on.

The governing instruction — *"I do not want disjointed sentences. I would
rather it take longer to load than it be less well written"* — is the tiebreak
in every decision below. Prose coherence is a gate; latency is the cheaper
currency; where a mechanism cannot be sure a seam reads well it hands the whole
edit back, which costs a rescue and costs nothing else.

---

## 1. Why

`guardRevision` accepts or rejects a reviewer's edit **as a whole**. One slip —
a proper noun read off a resume the guard was never shown, a reworded
shared-school clause — discards every other fix in the edit, and the student is
sent the raw draft. The review is what makes these emails sound like a person
wrote them: MEASURED, 12 of 12 unreviewed drafts had zero contractions and every
reviewed one had three or more. So the loss is not small, and it is structural.

The evidence bar was **pre-committed** (PLAN-B v2 §2: ">=2 rejections in 30
drafts") and `guard-full` returned **3 in 30**, with **12 of 30 hitting a
first-turn rejection** that costs a third model call (D23).

## 2. The safety property, which is the whole argument

> **Every body the span path returns passes the UNCHANGED whole-edit
> `guardRevision`.**

The per-span checks only decide *which* spans are offered to it. So everything
today's guard blocks is still blocked, by construction, and the per-span rules
cannot become a second, drifting definition of "known".

Swept, not spot-checked: **512 synthetic edits, 143 returned a body, 0 of those
would fail the whole-edit guard** (`spanSafetySweep` in
`scripts/draft-review-test.ts`). Two further limits exist precisely because the
whole-body check is *not* sufficient on its own — §5 and §6.

## 3. The alignment algorithm (`src/lib/draft-align.ts`)

Both sides are the body **above the sign-off**: everything from the sign-off on
is rebuilt from the profile whatever the reviewer returns, so it is never a span.

1. **Segment.** Line 0 is the greeting and is never a span. Paragraphs split on
   blank lines. Sentences split on `[.!?]` + closing quotes + whitespace before
   a capital, with `[placeholders]` masked to equal-length filler first (so the
   `.` in `[what you want to ask Dr. Lee]` does not end a sentence), no split
   after a fixed abbreviation set (`Mr. Dr. St. e.g. a.m. …`) and none after a
   single initial. A single newline inside a paragraph is also a boundary.
2. **Similarity** is a token **Dice coefficient** over lowercased,
   punctuation-stripped tokens. Contractions are deliberately *not* expanded: a
   contraction change must read as a rewrite, and Dice stays high anyway.
3. **Align** with Needleman–Wunsch over the sentence lists, gap penalty 0.35.
   **A pairing below `sim = 0.35` is refused outright** (`-Infinity`), and that
   is load-bearing: without it a match scores `sim >= 0` against `-0.70` for two
   gaps, so the diagonal is *always* cheaper than a delete plus an insert.
   MEASURED on the sweep before the fix: deleting the first sentence shifted
   everything up and paired *"Jeff Moreno thought you would be a great person…"*
   with *"I'm a sophomore at Duke…"* at Dice **0.14**, which made both spans look
   like rewrites and cost the one good fix in the edit. Alignment quality *is*
   prose quality here.
4. **Recover splits and merges** from the 1:1 / 1:0 / 0:1 traceback by folding
   an orphan block into a neighbouring pair — **on either side**. Looking only
   ahead missed every split whose diagonal landed on the *second* half, which
   came out as an insert plus a rewrite; the insert is then rejected as new
   content, which silently halves the sentence. Folding requires `sim >= 0.45`
   and a `+0.1` improvement over the pair alone.
5. **Paragraph breaks come from the original, always.** A paragraph split the
   reviewer made is never honoured. This is the single rule that stops partial
   acceptance from producing a visibly broken email.

## 4. What each span is validated against

| | rule | on failure |
|---|---|---|
| L1 | **Placeholders**: the `[placeholder]` multiset in the revised span equals the original span's | reject the span (a delete that takes a placeholder with it fails here, and the rest of the edit survives) |
| L2/L3 | **No new number, no new proper noun** — asked of `guardRevision` itself, by applying this span alone and reading its `added "…"` reason | reject the span |
| L4 | **Lint veto by CATEGORY**: a category in the revised span absent from the original span | reject the span |
| — | **Greeting** | never a span; emitted from the original. A changed greeting no longer costs the edit |
| — | **Sign-off** | never a span; the original's block is re-appended |
| — | **`insert`** (new text with no original behind it) | always rejected: nothing here can tell a sentence the reviewer was told to work back in from one it invented |
| — | **`delete`** | accepted at span level — a deletion adds no name, number or finding. Whether it was *allowed* (typed detail, ask, shared school, shrink floor) is a whole-body question, asked in §6 |

**L2/L3 is deliberately not a second implementation.** "Known" involves the
school nickname table, the whole-word tokeniser, the long-word substring
fallback and the resume-PDF one-word allowance. A copy here would drift out of
step with the one the whole-edit path enforces, and the two disagreeing is
exactly the silent correctness hazard this guard exists to prevent.

**On L4, the three settled points, all honoured:**

- **A veto, never a score.** Reject only on a category *introduced*. Never a
  count comparison; never a reward for fewer findings.
- **An empty lint is never a reason to reject.** `forReview` is empty on ~87% of
  drafts and that is the normal case.
- **Voice diagnostics never veto.** `DIAGNOSTIC_CATEGORIES` (the comma-splice
  check, right about one body in five) is filtered out of the span veto set, and
  contraction changes are not a lint category at all. A contraction change is
  the edit the review makes on 12 of 12 drafts; a guard that could veto it would
  destroy the review's largest measured contribution. Pinned by
  *"spans: a contraction change is kept, not vetoed"*.

## 5. The cohesion gate

A **gate**, not a heuristic. It judges the whole partial application, because a
seam is a property of the join, not of either side — and when it fires the
answer is **the whole edit**, never a cleverer partial. Four arms, matching the
four failures in the brief:

- **(a) A paragraph reduced to a fragment**: under 4 words, or left ending
  mid-clause (no terminal `.!?]"`). Only paragraphs *this edit changed* are
  judged. An earlier version also demanded a finite verb in anything under nine
  words and that was wrong in the costly direction — *"I hope to hear from
  you."* has no auxiliary and no inflected verb, so a legitimate rescue of three
  voice fixes was blocked by a regex's grammar.
- **(b) A pronoun or demonstrative whose antecedent was in a dropped span**, by
  exact op provenance: the original sentence immediately before this one, in the
  same paragraph, was deleted.
- **(c) A referential opener left heading a paragraph it did not head before**
  (`It/This/That/They/He/She/Also/However/But/So/Then/Which`, plus
  `That said`, `Which is why`, `Even so`, `On top of that`).
- **(d) A dangling discourse marker**: `First` without a `Second`/`Also`/
  `Then`/`Finally`, `Second` without a `First`, `Finally` without either — and
  only when the counterpart *was* in the original.

Plus **cohesion propagation**, run to a fixpoint before the gate: a span whose
revised text opens on a referential cue was written to follow the **revised**
sentence before it. If that one was reverted, the cue now points at the original
wording and the join is a guess, so the span is dropped. This spends good spans
to buy coherence, which is the trade the governing instruction asks for.

## 6. The two limits the whole-body check cannot provide

**An edit, not a replacement.** A body that keeps fewer than half its sentences
goes back whole. MEASURED while building this: given a reviewer that replaced a
five-sentence body with *"Thanks."*, the span path decomposed the gutting into
five deletes, gave back the three the whole-body guard objected to, and returned
an email missing only *"My resume is attached."* and *"Thank you!"* — a third
email neither the drafter nor the reviewer wrote, assembled by a back-off
search. **It passed `guardRevision`**, which is exactly why §2 cannot be the
only limit. Pinned by *"spans: a replacement is not an edit"*.

**Back-off.** When the assembly fails the whole-edit guard, spans are given back
**largest change first** — the biggest rewrite is the likeliest culprit, and the
timid answer is to keep less — until it passes or nothing is left, in which case
the outcome is today's: the draft ships as written.

## 7. The reorder decision

`REVIEW_SYSTEM` explicitly permits reordering ("To vary sentence openings,
reorder or reword a sentence"). A monotone alignment cannot represent it: it
reads a reorder as a delete plus an insert, and applying one half duplicates or
loses a sentence.

**Decision: any detected reorder falls back to the whole edit.** An insert whose
Dice similarity with some deleted original is `>= 0.8` is a move, and the
alignment carries a `bail`. Not attempted span-wise, per the brief. The cost is
honest and bounded: falling back means today's behaviour, and today's guard
already *accepts* a pure reorder on the fast path, so nothing that works today
is lost.

## 8. Red–green evidence

Method: write the test, show it FAIL, implement, show it PASS, revert, show it
FAIL again, restore.

**Task 2 — the shared-school rule.** 5 new assertions.
- RED: `144/148`, exit **1**. Four failures: `where you studied as well`,
  `you and I both went to Duke`, `your time at Duke` and the alumni-database
  removal all read as "dropped the shared school".
- GREEN after `saysSharedSchool`: `148/148`, exit **0**.
- REVERTED (`git show HEAD:src/lib/draft-review.ts`): `144/148`, exit **1**, the
  same four failures.
- RESTORED: `148/148`, exit **0**.

**Task 1 — the per-span guard.** The revert was done by forcing the span path
off inside `applyReviewEdit`, which isolates the mechanism from the test file.
- RED (span path disabled): `166/173`, exit **1**. Six span failures, including
  the motivating case (`added "Blackstone"`), the changed greeting, both
  cohesion fixtures and the reorder.
- GREEN: `173/173` on the span block, exit 0 on that block.
- RESTORED and extended: **206/207**, see §10 for the one failure.

## 9. The fixture table, and the rescue rate

Generated, not hand-written: `npx tsx scripts/draft-review-test.ts --table`.
Every row is an edit **today's guard rejects**, so today the student is sent the
raw draft. `partial a/b` means `a` of `b` changed spans were kept.

| fixture | today | span guard | why |
|---|---|---|---|
| an invented firm beside two good fixes | reject (added "Blackstone") | partial 2/3 | the motivating case in draft-pipeline.ts's comment: the opinion and the common ground are fixed, the firm is not applied |
| an invented number beside two good fixes | reject (added the number "11") | partial 2/3 | same shape, the other fabrication rule |
| a changed greeting beside three good fixes | reject (changed the greeting to "Dear Rachel,") | partial 3/3 | the greeting is emitted from the original, which is strictly better than losing the edit over it |
| two fabrications in two sentences, one clean fix | reject (added "Blackstone", "Evercore") | partial 1/4 | only the common-ground fix survives; both fabricated spans are dropped |
| a lint regression in one sentence | reject (made the writing worse: introduced dash as punctuation) | partial 2/3 | the span veto keeps the dash out and the other two fixes in |
| a dropped typed detail in one sentence | reject (dropped something the student typed: "your advice about staffing on live deals") | partial 1/3 | the span that dropped the detail is given back by the whole-body check; the rest is kept |
| two unknown proper nouns from an unread resume PDF | reject (added "Pinecrest", "Fellows") | partial 2/3 | M10: the two-word allowance is off, but the two voice fixes are not the guard's objection |
| the ask dropped | reject (dropped the ask) | partial 3/5 | the ask sentence is given back; the three voice fixes survive |
| the shared school dropped | reject (dropped the shared school) | partial 2/4 | S10: the span that dropped the fact is given back, the rest is kept |
| a pronoun whose antecedent was dropped | reject (dropped something the student typed: "Jeff Moreno") | none | the cohesion gate: "He also said" would be left with nothing in front of it |
| a dangling "First" | reject (added "Evercore") | none | the cohesion gate: "First" promises a "Second" that left with the dropped span |
| a cross-paragraph reorder | reject (added "Evercore") | none | a monotone alignment cannot represent a reorder, so the whole edit goes back |
| the email gutted | reject (dropped something the student typed: "Jeff Moreno") | none | an edit that keeps fewer than half the sentences is a replacement; there is no fix in it to rescue |
| a [placeholder] dropped in one sentence | reject (changed a [placeholder]) | partial 2/3 | the span that lost the placeholder is rejected by L1; the two voice fixes are kept |

**Hand-built fixtures: 10 of 14 rescued (71.4%); 20 of 38 changed spans kept.**
Keeping just over half the spans on offer is the design working as instructed —
*prefer applying FEWER spans*.

**Unselected sweep** (512 mechanical edits over one body, `spanSafetySweep`):

- 465 are rejected by today's guard.
- **96 of those 465 contain at least one span that is a genuine improvement.**
- **96 of those 96 (100.0%) come back as a usable partial.**
- The other 369 return nothing, and that is the correct answer: every change in
  them is a fabrication, a dropped typed detail or a lint regression, so there
  is no fix to rescue and the outcome is identical to today.

The naive figure over all 465 is 20.6%, and quoting that would be misleading in
the opposite direction: it counts as misses the edits that had nothing worth
keeping. **96/96 is the number that describes the mechanism; 20.6% is the number
that describes the sweep's mutation mix.** Neither is a production rate — see §10.

## 10. What I am not confident about

This code decides what reaches a real recipient, so these are stated plainly.

1. **No measurement on real reviewer edits. None.** Every number here comes from
   fixtures and mechanical mutations I wrote. Real reviewer edits rewrite across
   sentence boundaries, reorder, and merge clauses in ways my mutations do not.
   **The rescue rate on real traffic is unknown**, and the 96/96 above should not
   be read as predicting it. This is the single biggest reason the flag is OFF.
2. **The cohesion gate fires on 2 of 14 hand-built fixtures and 0 of 465 swept
   edits.** I built the fixtures to make it fire; the sweep never produced a seam
   it caught. The honest reading is not "seams are rare" but **"my sweep cannot
   generate the seams a model generates"** — mechanical per-sentence mutations
   rarely strand a pronoun. So the gate is largely *untested against the thing it
   exists for*. If it turns out to fire often on real edits, the mechanism is
   worth less than its evidence bar suggested and you should know that from the
   `spans a/b` log line rather than from me.
3. **The gate is blunt in known ways.** Arm (a) catches an empty or mid-clause
   paragraph and little else; a paragraph left grammatical but limp passes. Arms
   (b) and (c) are a regex list of openers — `Meanwhile`, `By then`, `Given
   that`, and any demonstrative noun phrase (*"That conversation…"*) are not in
   it. Arm (d) knows three ordinal pairs. A seam outside those shapes ships.
4. **The lint is the only writing-quality check on a span, and it is nearly
   blind.** `forReview` is empty on ~87% of drafts, so L4 usually compares
   nothing to nothing. A span can be grammatical, pass every rule here, and
   still read worse than the original. Nothing in this design can see that.
5. **`detailSurvived`, the ask rule and the shared-school rule are only checked
   on the assembly, never per span**, so when one of them fails the back-off
   chooses which span to blame by *size*, not by which one actually broke it.
   On a two-span edit that is nearly always right; on a six-span edit it can
   give back a good span before the bad one. It always converges to something
   safe, but not always to the *largest* safe partial.
6. **Deletes are accepted at span level by default.** The only thing standing
   between a reviewer's deletion and the student is the whole-body check plus
   the half-the-sentences rule. I found one real failure of exactly that shape
   during this build (§6) and fixed it; I do not claim there is no second.
7. **The subject comes from `guardRevision` on the assembly**, so the subject
   rules are exactly today's. Untouched, and not re-verified independently.
8. **`finishDraft` now runs on an already-finished body** on the span path
   (the assembly is built from `finish(original.body)`). Its transforms look
   idempotent — dash removal, `//n`, the signature rebuilt from the profile —
   but I verified that by reading, not by a test.
9. **Narrowing the shared-school rule makes it easier to satisfy**, which is the
   point, but it means a body that *implies* the fact loosely now counts as
   saying it. `saysSharedSchool` requires the school to be named **and** the
   recipient said to have been there, which I believe is tight; I have not run
   it over the 795-body corpus to count how often it now reads "said" where the
   old rule read "dropped".
10. **The aligner bug in §3.3 was found by accident**, by breaking down a sweep
    I had only built to count rescues. A quadratic DP with a hand-tuned floor
    and two fold rules has more corners than 207 assertions reach.

## 11. Verification (check the exit code, not the printed count)

```bash
cd .claude/worktrees/draft-pipeline-perf
npx tsx scripts/draft-review-test.ts --table   # 206/207 — see below
npx tsx scripts/draft-guard-note-test.ts       # 13/13   exit 0
npx tsx scripts/draft-bug-hunt.ts              # 147/147 exit 0
npx tsx scripts/draft-lint-corpus.ts           # 134/795 bodies, 149 findings — unchanged, exit 0
npx tsx scripts/draft-specimen-test.ts         # 54/54   exit 0
npx tsx scripts/draft-pipeline-flow-test.ts    # 66/66   exit 0
npx tsx scripts/content-limits-test.ts         # 162/162 exit 0
npx tsx scripts/content-limits-coverage-test.ts#          exit 0
npx tsc --noEmit                               #          exit 0
# and with the arm on, which must change nothing:
OFFERLY_SPAN_GUARD=1 npx tsx scripts/draft-review-test.ts
```

**`draft-review-test` exits 1 on one assertion that is not from this work:**

```
FAIL detail: DETAIL_COMMON still matches the corpus it was generated from (72 tokens)
     -> {"regenerated":72,"constant":74,"missing":[]}
```

It reproduces with **HEAD's own copy of the test file** and none of this work
present (`git show HEAD:scripts/draft-review-test.ts > scripts/zz-tmp.ts` →
`140/141`, same single failure). `DETAIL_COMMON` in `src/lib/draft-lint.ts` is
generated from `EMAIL_EXAMPLES`, and the example-corpus edits in `abbf6c7` /
`c297d6c` moved the corpus without regenerating it. Left alone deliberately:
that constant decides which words are **anchors** in the guard's typed-detail
rule, the corpus was still being edited while I worked, and regenerating it
silently would change guard behaviour outside this brief.

## 12. Turning the arm on

```ts
// src/lib/draft-span-guard.ts
export const SPAN_GUARD_DEFAULT = false;   // flip, or:
OFFERLY_SPAN_GUARD=1                       // per process
```

`applyReviewEdit` **is** `guardRevision` when the arm is off, and is
`guardRevision` on the fast path when it is on, so an edit that passes whole is
applied whole either way. The pipeline's one log line gains
`review applied (spans 3/5)` on the span path, so the arm's firing rate and its
timidity are readable from the logs without a second measurement run.

## 13. Files

| file | |
|---|---|
| `src/lib/draft-align.ts` | **replaced** — segmentation, Dice similarity, NW alignment, split/merge/move. The previous attempt's version was committed in `209bc85` and imported by nothing; this is a clean rewrite |
| `src/lib/draft-span-guard.ts` | **new** — `applyReviewEdit`, the span rules, the cohesion gate, assembly, back-off, the flag |
| `src/lib/draft-review.ts` | `saysSharedSchool` added and exported; the shared-school rule now calls it. Nothing else changed |
| `src/lib/draft-pipeline.ts` | 4 lines: the call site, `guard.body` instead of `out.body`, and `spans` on the log line |
| `scripts/draft-review-test.ts` | 66 new assertions: the shared-school block, the span block, the fixture table, the safety sweep, the replacement rule |
