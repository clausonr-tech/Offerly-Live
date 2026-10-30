# BUILD-1 — the guard's confirmed false positives, fixed

BUILDER-1. Scope: `src/lib/draft-review.ts`, `src/lib/draft-lint.ts`,
`scripts/draft-review-test.ts`. `draft-prompt.ts` and `draft-pipeline.ts` were
not touched (their diff in this worktree is BUILDER-2's cache tiering).

Six items landed, each with the full red → green → revert → red → restore
cycle. One item was **not** done and one is **incomplete** without a line in a
file I do not own; both are called out below rather than buried.

| Item | State |
|---|---|
| Bug 1 — private-detail removal vs the shrink floor (M12) | **fixed** |
| Bug 2 — school-name expansion (M9) | **fixed** |
| Bug 3 — `coverage()` stemming (M5/M6) | **fixed**; M7 deliberately unchanged |
| Bug 4 — `ASK` inert on most shapes (M4) | **fixed**, 23.3% → 90% recall |
| Bug 5 — resume-PDF proper noun (M10) | **guard fixed; the student note does not reach the student yet** |
| Extra 1 — count comparison → category veto (M11) | **fixed** |
| Extra 2 — contradictory length limits in `REVIEW_SYSTEM` | **fixed** |
| Coordinator's "raise the floor 0.6 → 0.55" | **NOT DONE — see below** |
| Coordinator's "per-op growth cap" | **NOT DONE — not implementable in this scope** |

Gates, all run after the last change:

```
npx tsx scripts/draft-review-test.ts          104/104 passed   (was 71/71)
npx tsx scripts/draft-lint-corpus.ts          149 findings — byte-identical to baseline
npx tsx scripts/draft-lint-corpus.ts --json   identical to pristine HEAD
npx tsx scripts/draft-occasions-sim.ts lint-examples   3 findings (unchanged)
npx tsc --noEmit                              only src/app/layout.tsx(20,56) LayoutProps
npx tsx scripts/content-limits-test.ts        64/64 passed
npx tsx scripts/content-limits-coverage-test.ts   103 actions: 45 checked, 58 exempt, 0 missing
```

---

## Two instructions I did not carry out

### "Also raise the floor 0.6 → 0.55"

Not done, deliberately, and it needs a decision rather than a default.

1. **0.6 → 0.55 is a loosening, not a raise.** It would let an edit cut 45% of
   an email instead of 40%. The message describes it as raising the floor, so
   the intent and the number disagree and I did not guess which was meant.
2. **Nothing needs it.** The measured failure (M12) passes at 0.6 once the
   deletion credit exists — that is what the regression test proves. There is no
   case in evidence that 0.6 still rejects wrongly.
3. **The original brief forbids exactly this**: "Do not simply raise or delete
   the floor — the floor exists to catch a reviewer that guts an email, and that
   protection must survive." Loosening a safety floor on no evidence is the one
   thing I was told not to do.
4. It is not in the committed `PLAN-B-accuracy-v2.md`; it appears only in the
   message.

The value is now a named constant, `SHRINK_FLOOR` in `draft-review.ts`, which
the reviewer's prompt quotes rather than restates, so changing it is one edit
and the prompt follows automatically. **If you still want 0.55, change that
constant** — the prompt text and the `60%` assertion in the test will need the
same number.

### "Add a per-op growth cap"

Not implementable here. `guardRevision` has no ops: it sees a whole before body
and a whole after body. Ops/spans are R1b, which v2 ranks **#7 behind an
explicit kill criterion** (≥2 rejections in 30 drafts) and whose row for this
work says **"the three confirmed guard false positives, no alignment"**.
Building a per-op anything means building `draft-align.ts` and
`applyReviewEdit`, i.e. the thing the plan says not to build until the rate is
measured. The whole-edit growth ceiling (`GROWTH_CEILING = 1.2`) is unchanged
and still applies; the test now proves 20% is the real boundary.

---

## Bug 1 — the shrink floor punished a safety-motivated removal (M12)

**Reproduction** (coordinator's, reproduced exactly):

```
guardRevision(
  { body: 'Hi Rachel,\n\nThank you for the call. You mentioned your divorce and the move, which I appreciated hearing about.\n\nBest,\nMaya Patel' },
  { body: 'Hi Rachel,\n\nThank you for the call.\n\nBest,\nMaya Patel' },
  { brief: { conversationDetails: "she mentioned her divorce and the move" } },
  [{ kind: "private", quote: "your divorce and the move", ... }],
)
→ { ok: false, reason: "cut from 19 to 7 words" }
```

Rule 3 tells the reviewer to remove a private detail. Removing it means dropping
the sentence that carried it, which on a short email is most of the body — so
the floor fired, the edit was thrown away, and **the private detail shipped**.

**Fix.** `wordsRemovedOnInstruction()` computes the words the reviewer removed
*because it was told to*, and the floor measures against `before` minus those
words. The floor is neither raised nor removed; what changed is the denominator.

Credit is earned, not claimed:

- only for `private`/`hateful` problems;
- only when the `quote` was really in the original and is really gone from what
  the reviewer returned (so reporting a removal it did not make earns nothing);
- only for the **sentences carrying that quote** (so deleting three paragraphs
  around one private detail earns the one sentence, not the paragraphs);
- a quote straddling a sentence boundary credits only its own words.

Quote matching is case-, whitespace- and curly-quote-insensitive, because the
reviewer's "verbatim" quote often is not byte-exact.

I kept my own formulation rather than the message's "exclude those words from
both sides of the window": the removed words are in `before` and absent from
`after` by construction, so subtracting them from `before` *is* excluding them
from both sides. Same arithmetic, one subtraction.

**Red-green.** Test `guard: removing a private detail may shrink a short email
past the floor`.

```
red     73/74  FAIL ... -> {"ok":false,"reason":"cut from 19 to 7 words"}
green   74/74
revert  73/74  FAIL ... -> {"ok":false,"reason":"cut from 19 to 7 words"}
restore 74/74
```

Two tests pin the protection that had to survive, and both were written to fail
if the credit were ever made unconditional:

- `the shrink floor still catches a gutted email` — a 41-word body cut to 4,
  with a private problem reported, is still rejected `cut from 41 to 4 words`.
- `no shrink credit for a private detail the edit kept` — the quote is still in
  the returned body, so no credit.

---

## Bug 2 — the guard rejected a correct school-name expansion (M9)

**Reproduction:** facts `studentSchool: "Penn"`, edit writes "the University of
Pennsylvania" → `{ ok: false, reason: 'added "University"' }`.

**Fix.** `schoolRenderings()` adds, for each school FACTS actually names
(`studentSchool`, `alumniSchool`, `contactSchool`), two strings from
`src/lib/school-name.ts`: `schoolCanonical(raw)` and `schoolKey(raw)`.

**Why only the canonical name, and not `schoolSpellings` or the whole nickname
group.** The new-capitalised-word rule blocked 17 of 18 plausible invented
proper nouns (M17) and it is the main defence against an invented firm, person
or place. Writing a school FACTS names under the table's own full name for it is
a strictly more correct rendering of a fact the student gave. The group's other
members are not: **"Wharton" for "Penn"**, "Ross" for "Michigan", "Haas" for
"Berkeley" name a school *inside* the university — a narrower claim than the
student made — and nothing needs them. So each school contributes two strings
and no more.

PLAN-B R9's literal recipe (full string, string minus `University|College|…`,
bare first word) does **not** fix this direction: all three reduce "Penn" to
"penn", so "University" and "Pennsylvania" stay unknown. The canonical lookup is
what makes M9's stated direction pass.

`LOOKALIKE_SCHOOLS` turned out to be unnecessary and I did not use it: it exists
for blanking lookalikes before *prose* is searched, and the narrow approach
avoids the trap for free — `schoolCanonical("Penn")` is "university of
pennsylvania" and never yields "state", while `schoolCanonical("Penn State")` is
"penn state university" and never yields "pennsylvania".

**Red-green.** Tests `the school's own full name may replace its nickname` and
`the recipient's school may be written out in full too`.

```
red     78/80  FAIL both -> {"ok":false,"reason":"added \"University\""}
green   80/80
revert  78/80  FAIL both -> {"ok":false,"reason":"added \"University\""}
restore 80/80
```

Four tests pin the hole shut, all passing before and after:
`still rejects a school FACTS never named` (Princeton), `still rejects a
lookalike school` (Penn State), `still rejects a school inside the school FACTS
named` (Wharton), `the nickname may replace the full name`.

**Residual, honestly:** `known` is still a substring blob, so M17's narrow hole
is unchanged — a capitalised token that happens to be a substring of a known
string passes. Adding "university of pennsylvania" adds substrings such as
"ania". Token-exact matching is PLAN-B L3's job under R1b; I did not widen the
hole but I did not close it either.

---

## Bug 3 — `coverage()`'s stemming, replaced (M5/M6)

**Reproduction, measured against today's function via the R5 fixture table:**
**9 of 14 rows wrong**, and a six-word window cut out of a body was noticed only
**168 times in 192**. At guard level, M6 returned `{ok: true}` — "nothing was
dropped" when half the detail was.

**Fix.** `coverage()` is gone, replaced by `detailScore()` / `detailSurvived()`
(both exported, with `contentWords`), per PLAN-B R5:

1. tokens keep their capitalisation, so an anchor can be recognised;
2. compared by a **suffix-stripping stem**, not the first five letters;
3. **weighted**: an anchor (capitalised in the typed detail, carrying a digit, or
   absent from `DETAIL_COMMON`) counts 1, anything else 0.4;
4. survived = weighted share ≥ 0.4 **and** `anchorsLost.length === 0`.

`DETAIL_COMMON` is in `draft-lint.ts`, **generated not hand-written**: tokens of
≥4 letters, no digits, outside the stop list, appearing **lowercase** in ≥10% of
the 192 playbook bodies (74 tokens). Lowercase-only is my addition and it
matters: counting all occurrences pulled in the playbook's invented names
(`Marchbank`, `Nadia`, `Ridgemont`, `Calloway`) and its months and weekdays, and
putting those in "words that mean nothing in particular" would have down-weighted
exactly the tokens the anchor rule exists to protect. The test regenerates the
set from the corpus and fails if it has drifted.

**Where I departed from R5, and why.** R5's suffix list includes `al` and claims
the stemmer "separates `intern`/`internal`/`interest`". It does not: stripping
`al` turns `internal` into `intern`, merging two unrelated words. I dropped `al`,
which costs nothing — R5 also wants `financial` ≈ `finance`, and `financial`
reduces to `financi`, not `financ`, with or without the rule. Documented in the
code. Consequence: `financial` and `finance` do not match; `financial` is a
common word (weight 0.4) so the effect is small.

I also added a trailing-`e` normalisation after suffix removal, without which
R5's own requirement that `manage`/`management`/`manager` stay together fails
(`manager` → `manag` ≠ `manage`). Minimum stem length 4 throughout, as specified.

**One R5 threshold was mis-specified, and I corrected my test rather than the
code.** R5 asks that a six-word window removed from a body be detected ≥95% of
the time. My first harness read 69%. The cause was my harness, not the function:
the window is rebuilt with single spaces, so `body.replace(window, "")` silently
does nothing whenever the span crosses a line break, leaving the body intact.
Building both the window and the body-without-it from the same flattened word
list gives **192/192** found in their own body and **184/192 = 95.8%** detected
when removed — R5's bar, met. Of the 8 remaining, every content word of the
window still appears elsewhere in the body, so "survived" is the correct answer.

**Red-green.** To get an honest red rather than a missing-export crash, R5's
signature was first exposed over today's algorithm, the fixture table run
against it, then the internals replaced.

```
red     91/100  9/14 fixture rows; windows 168/192; guard M6 -> {"ok":true}
                FAIL M6, intern/internal, interest/intern, distressed/distribution, "the word is gone"
green   95/95   14/14 rows; windows 184/192; guard M6 rejected
revert  91/100  same five rows fail again
restore 95/95
```

Note the fourth red row: detail `"we talked about his cars"` against
`"We talked about the markets."` scored **0.5 ≥ 0.4** today — the old function
said a detail survived when its only distinctive word was gone. That is M6's
class, on a five-word detail.

**M7 is NOT fixed, on purpose.** Detail `"we ended up talking about his
Mustang"` vs body `"We spent most of the conversation on his car."` still
returns `false`. The task asked me to say plainly whether it is fixable by
string matching: **it is not, and more than that, rejecting it is the correct
verdict.** "Mustang" is the student's own word and it is gone; no string
comparison can know "car" was licensed by the student while "Porsche" would not
be. What makes M7 stop costing a good edit is R1b reverting only the
paraphrasing span, not the whole edit. This agrees with PLAN-B R5 ("M7 stays
rejected, correctly") and I did not weaken the anchor rule to paper over it. The
fixture row records the verdict and the reason, so it is visible rather than
forgotten.

---

## Bug 4 — `ASK` was inert on most email shapes (M4)

**Reproduction:** `EMAIL_EXAMPLES.filter(ex => ASK.test(ex.body))` → **35/192 =
18.2%**. So "dropped the ask" and the congratulations-ordering check did nothing
on ~82% of shapes.

**Hand-labelled sample, committed in the test.** The first example of each of
the 40 types, read in full, labelled for whether the email asks the recipient to
do or answer something: **30 ask, 10 do not**. The line I drew, stated in the
test: an *offer* is not an ask ("I am glad to send anything else", "please do not
hesitate to reach out"), and neither is a *sentiment* ("I would love to stay in
touch"); a softened request is ("if you have 10 minutes, I would love to hear…").

**Fix.** Twelve families read off the corpus, grouped as asked-outright,
softened-into-a-conditional, and asking-them-to-reply. The softened families all
require a **request object** (call, chat, time, update, feedback, minutes) rather
than keying on "I would love" or "hear" alone — that is what keeps the offers
and sentiments out.

Measured on the 40-body sample:

| | recall | precision | corpus-wide |
|---|---|---|---|
| before | 7/30 = **23.3%** | 7/7 = 100% | 35/192 = 18.2% |
| after | 27/30 = **90.0%** | 27/27 = **100%** | 131/192 = 68.2% |

Required bar was ≥70% recall at 100% precision. The three still missed are
`call_scheduling`, `coffee_in_person_reply`, `recruiter_follow_up` — all of which
ask by offering times rather than by requesting anything ("please just name a
time", "if it is easier to point me to a page").

I did **not** add the coordinator's "a question containing `minutes`" family:
measured, it adds zero recall (27/30 either way) because every such body is
already matched, and the only version that added anything was a bare `\?`
catch-all, which is too broad to justify. Everything else on the list is in.

**Precision stress beyond the sample.** Over every example of the five types the
templates give no ask (`congratulations`, `close_loop_referrer`,
`withdraw_process`, `thank_helper_offer`, `decline_offer`): **1 match in 19
bodies** — `decline_offer#5`, "if the policy ever changes, I would welcome the
chance to talk again", which is a soft forward-looking request and a borderline
label rather than a clean false positive.

**The side effect you asked me to check: there is none.**
`scripts/draft-lint-corpus.ts` is **byte-identical** before and after, 149
findings either way, and the `--json` form is identical to pristine HEAD.
`draft-occasions-sim.ts lint-examples` stays at exactly 3 findings. Widening
`ASK` created **zero** new `fluencyIssues` findings: the ask-ordering check only
fires when congratulations follow the ask, which no corpus body does.

**Red-green.** Tests `at least 70% of real asks are matched`, `the rule is live
on most playbook shapes`, `deleting a softened ask is caught as the ask`.

```
red     97/100  recall 23.3% (7/30); 35/192; guard -> {"ok":true,"subject":"s"}
green   100/100
revert  97/100  same three fail
restore 100/100
```

The guard test needed fixing mid-flight: my first version deleted so much of the
body that the **shrink floor** rejected it, so it passed while testing nothing
about the ask. It is now padded so losing the ask cannot trip the floor, and it
asserts the *reason* mentions the ask.

**The risk, stated.** Making the rule live makes the guard stricter on 50% more
shapes. `let me know` is the weakest family: a reviewer deleting "Please let me
know if there is anything else you need from me" — close to filler in a
thank-you email — now loses the whole edit. I judged that the right side to err
on (the unedited draft ships, which is the conservative outcome, and that
sentence is the email's only forward motion), but it is the one place where this
change can cost a good edit, and `R3`'s rejection-reason logging is what would
show it.

---

## Bug 5 — resume-PDF proper noun (M10) — INCOMPLETE, needs one line I do not own

**Reproduction:** facts `hasResumePdf: true`, no `studentResumeSummary`, edit
adds "the Pinecrest investment club" → `{ ok: false, reason: 'added
"Pinecrest"' }`.

Structural, as you said: `runDraftPipeline` does `const { resumePdf, ...rest } =
input`, so the **reviewer** is shown the PDF and the **guard** gets a boolean. A
proper noun read off the resume and one invented are identical to the guard,
because the guard is not given the text that would tell them apart.

**Fix.** The capitalised-word loop now collects unknown words instead of
returning on the first. When `hasResumePdf && !studentResumeSummary`, **exactly
one** unknown capitalised word becomes accept-with-note, carrying
`note` on the success value. Two is still a rejection. A resume summary turns the
allowance off entirely, because then the guard *can* check. The first unknown
word in document order is still what a rejection reports, so no existing
rejection message changed.

**Red-green.** Test `one proper noun from an unread resume PDF is accepted with
a note`.

```
red     84/85  FAIL -> {"ok":false,"reason":"added \"Pinecrest\""}
green   85/85
revert  84/85  FAIL -> {"ok":false,"reason":"added \"Pinecrest\""}
restore 85/85
```

Four tests bound the allowance: `two unknown proper nouns are still rejected`,
`the allowance is off once the resume text is available`, `no resume, no
allowance`, `an ordinary accepted edit carries no note`. As you noted, the rig
forces `hasResumePdf` false, so these fixtures are the only evidence available.

### What is NOT done, and why it matters

**The note never reaches the student.** `draft-pipeline.ts:286` builds the
student notes from `studentNotesFromReview(out.problems, guard.ok)` and does not
read `guard.note`. That file is BUILDER-2's and I did not touch it.

This is not a cosmetic gap. The bargain you approved was "admitting one
unverified proper noun **while telling the student** — the second is honest and
visible". Without that line, the behaviour is *admitting one unverified proper
noun silently*, which is a different and worse trade than the one argued for.

The change is one line, at `draft-pipeline.ts:286`:

```ts
draft = { ...draft, notesForStudent: dedupe([...draft.notesForStudent,
  ...studentNotesFromReview(out.problems, guard.ok),
  ...(guard.ok && guard.note ? [guard.note] : [])]) };
```

I verified the note text clears the `APP_HANDLES` filter at line 324, so it
survives to the student once passed in. **Either land that line, or hold the
Bug 5 change** — shipping the guard half alone trades a visible wrong answer for
an invisible one.

---

## Extra 1 — the count comparison, deleted (M11)

**Reproduction:** original with one `filler phrase` finding, revised with one
`comma splice` and no filler → `after_.length > before_.length` is `1 > 1`,
false → **accepted**. Measured: `{"ok":true,"subject":"s"}`.

**Fix.** Deleted outright, not generalised. `findingCategory()` in
`draft-lint.ts` recovers the kind of problem from the finding text (26 patterns,
mirroring the order `draft-lint.ts` produces them in), and the guard rejects only
when the revised lint contains a **category absent from the original's**. Never
rewards fewer findings; never rejects because the lint found nothing.

**Behaviour change in the permissive direction, pinned by a test:** more
findings of a category the draft already had is now **accepted** (1 filler → 2
fillers). That is v2 §2.4 as specified, and it is a real loosening, so
`more of a finding the draft already had is not a rejection` records it
deliberately rather than leaving it as a side effect.

A test asserts **every** finding the 192-body playbook corpus produces
classifies to a named category — without that, the veto would silently lump
unrelated defects together and stop noticing a swap.

**Red-green.** `findingCategory` was added first (inert, no guard change) so the
red is about the comparison and not a missing import.

```
red     86/89  swap -> {"ok":true}; same-category increase -> rejected
green   89/89
revert  86/89  same three fail
restore 89/89
```

---

## Extra 2 — the contradictory length limits

`REVIEW_SYSTEM` said both "grows past 20% or shrinks past 40%" (which the code
enforces) and "never more than 15% longer" (which nothing enforced).

**Fix.** `GROWTH_CEILING = 1.2` and `SHRINK_FLOOR = 0.6` are now named constants
that **both** the prompt and the guard read, so they cannot drift again. The
prompt states the numbers once, interpolated from the constants, and the 15% line
is gone. It also now tells the reviewer that words it removes because it reported
them private or hateful do not count against the shrink limit — otherwise rule 3
and the stated floor still contradict each other from the reviewer's point of
view.

The guard-description bullet also stopped claiming the edit is thrown away for
growing/shrinking in one breath with the fabrication rules, and now says it is
thrown away for introducing a kind of writing problem the draft did not have,
which is what Extra 1 made true.

**Red-green.**

```
red     101/104  FAIL "15% longer" present; 20%/60% absent; private-exemption line absent
green   104/104
revert  101/104  same three fail
restore 104/104
```

A boundary test proves the numbers are the real ones: an edit grown 19% is
accepted and one grown 21% is rejected with `grew from…`. It grows the body by
repeating two words the body already uses, so growth is the only variable — the
first version appended `"word word word…"` and was rejected for `repeated word`
rather than for growth.

---

## Things a reviewer should push on

1. **`SHRINK_FLOOR` is still 0.6** against an instruction to make it 0.55. My
   reasons are above; it is one constant if you disagree.
2. **Bug 5 is half-landed** and the missing half is the honest half. See above.
3. **`let me know` is the loosest `ASK` family** and the most likely source of a
   newly-rejected good edit. `R3` logging is what would catch it.
4. **The same-category loosening in Extra 1** is specified behaviour, but it does
   mean an edit may double a filler phrase and pass.
5. **`moved` and `move` do not share a stem** under the minimum-length-4 rule, as
   do not `living` and `live`. Short words are mostly in `DETAIL_COMMON`
   (weight 0.4) so the effect is small, but it is a false negative on matching,
   which makes the guard slightly stricter about dropped details.
6. **`commaSplices` is an unused import** in `draft-review.ts`. Pre-existing at
   HEAD, left alone to keep this diff scoped to the bugs.
