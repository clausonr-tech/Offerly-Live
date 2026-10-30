# CORPUS-EDIT-PLAN — the gold example corpus, line by line

CORPUS-PLAN, 12 October 2026. Worktree `.claude/worktrees/draft-pipeline-perf`,
branch `perf/draft-pipeline`.

**Nothing under `src/` was edited.** `shasum` was taken on
`email-examples.ts`, `email-examples-v3.json`, `email-examples-v4.json`,
`email-examples-v5.json`, `draft-prompt.ts`, `draft-review.ts` and
`draft-lint.ts` before and after this work; all seven lines are byte-identical.
No Anthropic API call, no `scripts/draft-cli-eval.ts` run, no database, no
commit, no `npm install`.

| | |
|---|---|
| `git rev-parse --short HEAD` at measurement | **`5db0379`** |
| `git rev-parse --short HEAD` at writing | **`163eb31`** (a concurrent session committed mid-run) |
| `src/lib/draft-prompt.ts` hash, start and end | `5d57a9f2ffb2fc8c9311981255317372ece2a5f1` — **unchanged** |
| `src/lib/email-examples{.ts,-v3,-v4,-v5}` hashes | unchanged |
| `npx tsx scripts/draft-occasions-sim.ts lint-examples` | **3 findings**, before and after |

**HEAD moved but none of the seven files moved.** The FIX-FORM §3.5 patch to
`combinedExamplesFor` had **not** landed at either commit, so every figure below
was computed against the pre-patch prompt.

### Robustness to the `combinedExamplesFor` patch

**This plan edits zero Volume V bodies, so the patch cannot invalidate any of
it.** `combinedExamplesFor` selects only from `email-examples-v5.json`; every
one of the 138 edits below targets a *gold per-type* body in
`email-examples.ts`, `-v3.json` or `-v4.json`, which reach the drafter through
`EMAIL_EXAMPLES[typeId]` on the single-type path (`draft-prompt.ts:459`), a path
the patch does not touch.

Consequently:

- **No edit's justification depends on reachability.** The priority order is
  ranked on (a) the pattern's raw frequency in the 192 gold bodies and (b)
  type-level draft volume. Both survive the patch.
- **Not editing Volume V is a deliberate decision, not an oversight.** Volume V
  is the corpus `fluencyIssues` is *calibrated against*, and
  `lint-examples`' `EXPECTED_FINDINGS = 3` is now a build-breaking assertion on
  exactly those 42 bodies. Editing them would move the gate and the thing the
  gate measures in one change. **Leaving Volume V alone keeps `lint-examples` at
  exactly 3 by construction** — verified above, not argued. Volume V has its own
  defects (25 of 42 carry a canned resume line, 7 of 42 open on a pleasantry);
  they belong in a separate change that re-calibrates `EXPECTED_FINDINGS`
  explicitly.

---

# 1. Re-measurement — my figures beside the brief's

Probe: `scripts/audit-probe/corpus/measure.ts`. It reads the 192 gold bodies and
the 42 Volume V bodies and reports, per body and in aggregate, contraction
count, opening type, canned-line hits verbatim, longest run of `"I"`-opening
sentences, em/en dashes and the closing sentence. `CONTRACTION`, `CANNED_LINES`,
`PLEASANTRY`, `sentencesOf` and `bodyParts` are **copied verbatim from
`scripts/draft-cli-eval.ts`**, so these numbers sit on the same footing as the
rig's own `cannedResume*` / `pleasantryOpen*` / `zeroContraction*` /
`threeIStarts*` aggregates. They are copied rather than imported because
`draft-cli-eval.ts` runs a `main()` on import and would spawn model calls.

Corpus shape, confirmed: `EMAIL_EXAMPLES` = Volume II (in `email-examples.ts`) +
Volume III (`-v3.json`) + Volume IV (`-v4.json`) = **40 types, 192 bodies**.

| pattern | brief | **measured** | verdict |
|---|---|---|---|
| zero contractions in the whole email | 144/192 (75.0%) | **192/192 (100.0%)** | **brief understates it** |
| opens on a pleasantry | 64/192 (33.3%) | **62/192 (32.3%)** | definitional, both right |
| exact `I hope this email finds you well` | 20/192 (10.4%) | **20 bodies** | confirmed |
| 3+ consecutive "I" openings | 54/192 (28.1%) | **30/192 (15.6%)** | **brief overstates ~1.8×** |
| `for your reference` | 32 occurrences | **32 occurrences, 32 bodies** | confirmed |
| `do not hesitate to` | 8 | **8** | confirmed |
| `I look forward to hearing from you` | 5 | **5** | confirmed |
| em or en dash present | 11/192 (5.7%) | **11 bodies, 12 occurrences — all en, zero em** | **confirmed but mis-framed** |

## The four divergences, with the cause

**1. Contractions: it is 192/192, not 144/192 — the corpus is worse than
reported.** There is not one contraction in any of the 192 gold bodies, nor in
any of the 42 Volume V bodies. 174 of 192 bodies contain an apostrophe and
**every single one is a possessive** (`University’s`, `company’s`, `team’s`,
`Thursday’s`). Checked with a deliberately loose regex that would catch any
`X’m/re/ve/ll/d/s` or `Xn’t`: 55 matches, all possessives. There is no
sub-population of contraction-bearing examples to point the drafter at.

**2. Three-or-more "I" openings: 30/192, not 54/192.** Robust across three
sentence splitters (harness `(?<=[.!?])\s+(?=[A-Z“"])` → 30; any-whitespace →
30; per-paragraph → 31). The brief's 54 is reproducible under a *different*
definition: counting runs of sentences opening with any first-person token
(`I`/`My`/`We`) gives **61/192**. The rig's `threeIStartsPre` uses
`/^I\b|^I['’]/` exactly, so **30/192 (15.6%) is the figure comparable to the
rig**, and this pattern is a third as bad as the brief suggests.

**3. Pleasantries: 62 vs 64 is a definition gap, not an error.** 62 bodies
*open* on one (harness `PLEASANTRY` on the first sentence; also 62 if you look
anywhere in the first paragraph). **64** bodies contain a pleasantry *anywhere in
the body*. Both numbers are correct; the rig's `pleasantryOpenPre` measures the
62.

**4. The dashes are not what the brief says, and I recommend leaving all 12
alone.** There are **zero em dashes in the corpus**. All 12 occurrences are en
dashes and **every one is a numeric range**: eight are `10–15 minutes`, three are
time windows in `call_scheduling` (`9:00 a.m. – 12:00 p.m.`), one is a `10–15
minute call`. HOUSE_RULES bans em dashes in prose; it does not reach a number
range, and `10 to 15 minutes` already appears in four other bodies, so the
corpus demonstrates both forms. **Leave them.** If the worry is the drafter
emitting `–` in prose at all, the zero-risk subset is the eight
`10–15 minutes` → `10 to 15 minutes` in the priority types; it is listed as
optional Tier 5 below and is deliberately *not* in the edit table.

## Two findings the brief did not have

### A. 85.4% of gold bodies close on a thank-you. This is the closing defect.

| closing family (last sentence of the body) | bodies | share |
|---|---:|---:|
| **opens with "Thank you" / "Thanks" (any)** | **164/192** | **85.4%** |
| of which: thanks + for your/the time | 72/192 | 37.5% |
| of which: thanks + some other object | 47/192 | 24.5% |
| of which: bare thanks, no object | 25/192 | 13.0% |
| of which: thanks + for the opportunity | 10/192 | 5.2% |
| contains the literal `for your time` | 68/192 | 35.4% |
| **does not thank at all, anywhere in the closing** | **16/192** | **8.3%** |

113 distinct closing strings over 192 bodies. The most repeated: `Thank you so
much for your time!` ×19, `Thank you again!` ×12, `Thank you so much!` ×9,
`Thank you very much for your time!` ×7.

**This explains the product symptom and corrects the natural reading of it.**
`"Thank you for your time!"` ends 16 of 28 generated emails (57%), yet that exact
string appears only 3 times in the corpus. So the model is **not** copying a
string — it is copying the *family*, and amplifying the mode: 37.5% of
demonstrations close on thanks-for-time, and the other 62.5% are scattered over
113 distinct strings with no shape carrying enough mass to be learnable. Given a
distribution like that, converging on the one dense formula is the correct
inference from the data it was shown.

**The design consequence is sharp: writing 32 unique new closings will not fix
this.** 113 distinct strings already exist and the model still converged. What
fixes it is lowering the dominant family's mass *and giving the alternatives
enough instances each to be learnable*. The closing target in §2 is therefore a
**family distribution**, not a uniqueness count.

### B. `cannedResumePre`/`cannedResumePost` cannot carry a pass condition here

`CANNED_LINES.resumeLine` is a presence detector for "I/my + resume +
attached", not a cannedness detector. Measured:

| line | flagged? |
|---|---|
| `I also attached a copy of my resume for your reference.` | CANNED |
| `My resume is attached.` | **CANNED** |
| `I attached my resume in case the background is useful.` | **CANNED** |
| `I attached my resume, though it is still a work in progress.` | **CANNED** |
| `A resume is attached.` | clean |
| `Resume attached.` | clean |
| `I included my resume.` | clean |

So the metric fires on the terse, specific lines VOICE_RULES actually wants, and
clears on near-identical rewordings. Two consequences:

1. **`cannedResumePre`/`cannedResumePost` must not be a pass metric for this
   plan.** It would read nearly flat on a correct edit, and it can be driven to
   zero by writing `A resume is attached` into every body — which is
   metric-gaming, not improvement. The honest metric is the literal
   **`for your reference` occurrence count (32 → 0)**, which is unambiguous.
2. **It weakens the brief's own decisive evidence.** `cannedResumePre 8 →
   cannedResumePost 8` is read as "the reviewer could not fix the resume line".
   It is equally consistent with the reviewer having rewritten the line into
   something the detector still flags. The conclusion survives on other
   grounds — the corpus demonstrates `for your reference` 32 times, which is
   measured directly — but **"8 → 8" should not be quoted as proof that a prompt
   rule cannot move a courtesy line.**

### C. One more correction worth stating: the drafter, not the reviewer, is the thing the corpus controls

From MEASURE-1's own table: `contractionsPreMean` and `contractionRatePreMean`
are **0 in all three noise arms**, and `zeroContractionPre` is **12/12** — with
VOICE_RULES already in the drafting prompt. The brief's "contractions went 0 →
2.25/draft" is a *pre-review → post-review* move inside one run: it is the
**reviewer** supplying every contraction in the product, on every draft, while
the drafter reproduces the corpus's 192/192 exactly.

That matters for what this plan is for. A contraction in the shipped email
currently costs a whole review call and survives only if the guard accepts the
edit — and `reviewRetried` is the noisiest count on the board (0/2/3, 180%).
Fixing it in the corpus moves it to the draft stage, where it is free.

---

# 2. The target distribution, and why it is this

The disease is **a demonstration beating an instruction**. A plan that replaces
one uniform corpus with a differently uniform corpus has the disease, which is
why the measured reviewer behaviour is the cautionary case: it pasted
VOICE_RULES' own printed example (`Any time that suits you works for me`) into 2
of 3 edits, and `CANNED_LINES.flexibilityLine` now has to list that phrase to
catch it. **Deliberate variety is the deliverable.** Every target below is stated
as a *distribution*, and the probe reports the most-repeated string so that
flatness is checkable rather than asserted.

## 2.1 Contractions — create the split, do not raise the rate

VOICE_RULES already names a split: contractions in cold emails, thank-yous,
follow-ups, scheduling and notes to people the student has met; **full forms in
emails to a recruiting team or inbox, offer decisions, and letters to
professors.** About 38 of the 192 bodies are on the full-form side
(`recruiting_inbox` 9, `recruiting_inbox_follow_up` 4, `offer_extension` 6,
`accept_offer` 6, `decline_offer` 5, `withdraw_process` 2,
`professor_recommendation` 3, `reference_request` 3).

So **the corpus's 192/192 is correct for ~38 bodies and wrong for ~154.** The
edit must *create the split*, not lift the overall rate. A naive sweep would
destroy the one thing the corpus currently gets right by accident.

| | now | target |
|---|---:|---|
| bodies with ≥1 contraction, full-form types | 0 | **0 — unchanged, deliberately** |
| bodies with ≥1 contraction, contraction-eligible types | 0 | a real minority, mode 1 |

**Target for the 32 cold-outreach bodies this plan covers: 18 with ≥1, 14 with
0.** Within the 18: eleven have exactly 1, five have 2, two have 3. Mean across
all 32 = 0.84.

Why deliberately low, when the reviewer currently produces 2.25: the corpus
should **stop teaching zero**, not teach a new number. The measured reviewer mean
is an upper anchor, and a corpus that sat at it would be teaching the ceiling as
the norm. 14 of 32 cold emails with no contraction at all keeps the formal
register visibly available. If `contractionsPreMean` after this lands below
~0.5 in the rig, **raise the dose in a second pass against the measurement**
rather than guessing a bigger number now.

Every contraction edit is a full-form → contracted swap inside a sentence
(`I am`→`I'm`, `do not`→`don't`, `it is`→`it's`, `I have`→`I've`,
`cannot`→`can't`). Zero word delta, zero fact risk.

## 2.2 Pleasantry openings — 62 → 25, and no string over 5

Two dimensions, and **the second matters more**:

- **Rate.** The four cold types (32 bodies) carry 26 pleasantries even though
  each type's own premise supplies a hook — `cold_referral` has the referrer,
  `cold_after_meeting` has the meeting, `cold_not_alum` has the deal or the
  article. All 26 of those sit *in front of* the hook, so they delete. The
  remaining 36 are in `follow_up_1`, `interview_check_in`, `keep_in_touch`,
  `referral_ask` and `second_conversation`, where "it has been three months" is
  genuinely the most specific thing available and **VOICE_RULES positively
  permits a pleasantry**. Target **25/192 (13.0%)**, concentrated there.
- **Form.** `I hope you are doing well!` opens 21 bodies *verbatim* and `I hope
  this email finds you well!` opens 20 — **41 of 192 bodies open with one of two
  literal strings.** That is the learnable signal, and it is the cheaper half of
  the fix: a one-sentence swap with zero fact risk. Target **no opener repeated
  more than 5 times.**

Three pleasantries are **kept on purpose** and one is kept as the model of the
good case: `cold_after_meeting#3`'s `I hope you made it home safely on
Thursday!` is tied to a real fact in the body. That is the shape VOICE_RULES
wants and the corpus's only example of it. Keeping zero pleasantries anywhere
would teach that the opener is forbidden, contradicting the rule — a second
template.

## 2.3 Courtesy lines — the one place a prompt rule provably cannot win

| | now | target | why |
|---|---:|---|---|
| `for your reference` | 32 | **0** | banned by name in VOICE_RULES; the measured 8-of-12 recurrence |
| flexibility line (`CANNED_LINES.flexibilityLine`) | 42 | **≤16** | **32 of 32 cold bodies have one — 100% uniformity in the most-drafted class of email** |
| `do not hesitate to` | 8 | **0** | banned by name |
| `I look forward to hearing from you` | 5 | **0** | banned by name |

The flexibility line is the headline and the brief did not name it: **every one
of the 32 cold-outreach bodies carries a "happy to work around your
schedule" / "I am very flexible" sentence.** 40 bodies corpus-wide use that exact
construction. Most of those sentences carry no information — the ask already says
"would you have 15 minutes", and flexibility is implied — so **24 of them simply
delete**, which is the edit VOICE_RULES itself models ("what to copy there is the
deletion, not the sentence"). Eight keep a timing sentence, in eight different
constructions, so the corpus still demonstrates *that* you can say it.

Resume mentions: all 32 cold bodies keep a resume mention or drop it entirely
(the app attaches the file, and `APP_HANDLES` already suppresses notes telling
the student to attach it) — spread across **11 variety slots**: terse fragment,
impersonal, plain, purpose clause, honest caveat, folded into the ask, and
no-sentence-at-all. The rule is not "never mention the resume".

## 2.4 Closings — a family distribution, not 32 unique strings

Per §1.A, uniqueness is not the lever; **family mass** is.

| family | now | target |
|---|---:|---|
| thanks + for your/the time | 72 (37.5%) | **≈47 and falling — no family over ~25%** |
| thanks for a *specific, non-time* thing | 47 | **up — this is where mass should go** |
| closes on the ask / next step | ~4 | **up** |
| appreciation without the word "thank" | 8 | **up** |
| bare short thanks | 25 | hold — short and already varied |
| most-repeated single closing string | 19 | **≤5** |

This plan takes the dominant family from **72 → 47** and the most-repeated single
closing from **19 → 5**, and lifts distinct closings 113 → 131. It does **not**
finish the job; `Thank you again!` ×12 and `Thank you so much!` ×9 remain, in
thank-you types where closing on a thanks is correct. Tier 4 below states the
remaining work and why it is deliberately not enumerated here.

---

# 3. The edit table

**138 edits across 69 bodies.** The table is generated from
`scripts/audit-probe/corpus/edits.ts` by
`scripts/audit-probe/corpus/table.ts` — it is not retyped, so a row cannot drift
from the thing that was checked.

`scripts/audit-probe/corpus/apply-check.ts` applies all 138 **in memory** and
asserts the four things that decide whether they are safe to apply verbatim:

```
npx tsx scripts/audit-probe/corpus/measure.ts          # the re-measurement in §1
npx tsx scripts/audit-probe/corpus/measure.ts --phrase --where
npx tsx scripts/audit-probe/corpus/apply-check.ts      # the gate below
npx tsx scripts/audit-probe/corpus/tiers.ts            # the prefix property in §4
```

**Current result, all 138 edits:**

```
FACT FIDELITY (69 bodies touched) : no fact token lost in any touched body
LENGTH                            : net -771 words; no body over its type ceiling
FLUENCY (gold 192)                : before 18 findings, after 18 findings (+0)
FIND UNIQUENESS                   : 138/138 `find` strings occur exactly once
THE ASK (draft-lint ASK)          : 115/192 before, 115/192 after; no body lost its ask
lint-examples (Volume V)          : 3 findings (untouched by construction)
```

Fact fidelity is checked by extracting every proper noun, number, requisition
number, class year and date from the original body and asserting each is still
present afterwards — deliberately over-inclusive, because a false alarm costs a
glance and a missed fact change costs the corpus its whole purpose.

## Headline effect over all 192 gold bodies

| metric | before | after |
|---|---:|---:|
| `for your reference` bodies | 32 | **0** |
| `I look forward to hearing from you` | 5 | **0** |
| `do not hesitate to` | 8 | **0** |
| canned `flexibilityLine` | 42 | **14** |
| opens on a pleasantry | 62 | **25** |
| bodies with ≥1 contraction | 0 | **18** |
| total contractions | 0 | **27** |
| 3+ consecutive "I" openings | 30 | **25** |
| closes on thanks-for-your-time | 72 | **47** |
| distinct opening strings | 137 | **173** |
| distinct closing strings | 113 | **131** |
| most-repeated opener | 21× | **5×** |
| most-repeated closer | 19× | **12×** |
| `fluencyIssues` findings | 18 | **18** |
| total body words | 21,113 | **20,342** |

The plan is **deletion-dominant**: −771 words. That is deliberate. It fixes the
voice and the length ceiling in the same edit, and it is the only direction that
is safe in the four bodies with under 10 words of headroom (`cold_email#3` has
**4**, `cold_referral#6` has 6, `cold_after_meeting#1` has 7, `cold_referral#1`
has 8).

## Variety, shown rather than claimed

138 edits across **56 distinct variety slots**. The two largest are the two
zero-risk mechanical ones — `delete-pleasantry` ×29 and `contraction-swap` ×18 —
and no *written* replacement slot is used more than 10 times. The resume
mention alone is spread over 11 slots; the flexibility sentence over 9; the
closing over 6 families. The probe prints this tally on every run, so "the 32
fixes read alike" is a checkable failure rather than a matter of opinion.


## The 138 rows

File column: `.ts` II = `src/lib/email-examples.ts` (Volume II template literals);
`v3` = `src/lib/email-examples-v3.json`; `v4` = `src/lib/email-examples-v4.json`.
`find` occurs exactly once in its body; apply it as a literal string replace.
No key, id, `section` or `boxes` list is touched anywhere — subject and body
text only, and in fact **no subject line is edited either**.

| # | body | file | current text (exact) | replacement (exact) | fixes | variety slot |
|---:|---|---|---|---|---|---|
| 1 | `cold_referral#1` | `.ts` II | I hope this email finds you well! Sarah Chen suggested | Sarah Chen suggested | pleasantry, repeat | delete-pleasantry |
| 2 | `cold_referral#1` | `.ts` II | I am more than happy to work around your schedule, so please let me know if a specific time works best for you. I also attached a copy of my resume for your reference. | Resume attached. | canned-flex, canned-fyr | flex-delete + R1-fragment |
| 3 | `cold_referral#1` | `.ts` II | Thank you so much for your time, and I look forward to hearing from you! | Thank you for considering it, and for whatever you can tell me about the credit team. | closing, canned-lfth | C1-thanks-for-the-specific-thing |
| 4 | `cold_referral#2` | `.ts` II | I hope you are doing well! Professor Ellis Vance | Professor Ellis Vance | pleasantry, repeat | delete-pleasantry |
| 5 | `cold_referral#2` | `.ts` II |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  I attached my resume in case the background is useful. | canned-flex, canned-fyr | flex-delete + R2-purpose-clause |
| 6 | `cold_referral#3` | `.ts` II | I hope all is well with you! Dan Pruitt | Dan Pruitt | pleasantry, repeat | delete-pleasantry |
| 7 | `cold_referral#3` | `.ts` II | I have developed an immense passion for the finance world over the past two years | I've developed an immense passion for the finance world over the past two years | contraction | contraction-swap |
| 8 | `cold_referral#3` | `.ts` II |  I am more than happy to work around your schedule. I also attached a copy of my resume for your reference. | *(delete)* | canned-flex, canned-fyr | flex-delete + R0-no-resume-sentence |
| 9 | `cold_referral#3` | `.ts` II | Thank you so much for your time, and I look forward to hopefully speaking with you! | Thank you either way, and please pass my regards to Dan. | closing | C3-close-on-the-person |
| 10 | `cold_referral#4` | `.ts` II | I hope you are having a great week! I spoke with Jake Abbott | I spoke with Jake Abbott | pleasantry | delete-pleasantry |
| 11 | `cold_referral#4` | `.ts` II |  I am very flexible and more than happy to work around your schedule, and I attached a copy of my resume for your reference. |  A resume is attached. | canned-flex, canned-fyr | flex-delete + R2-impersonal |
| 12 | `cold_referral#5` | `v3` | I hope you are having a good week! Harriet Loewen | Harriet Loewen | pleasantry | delete-pleasantry |
| 13 | `cold_referral#5` | `v3` | I do not have an internship yet, but I help run | I don't have an internship yet, but I help run | contraction | contraction-swap |
| 14 | `cold_referral#5` | `v3` |  I am very flexible and more than happy to work around your schedule, and I attached my resume for your reference. |  I have no constraints on my end, and I attached a resume. | canned-flex, canned-fyr | F-c-no-constraints + R1-bare |
| 15 | `cold_referral#5` | `v3` | Thank you so much for your time! | Thank you for even reading a freshman's email! | closing | C1-thanks-for-the-specific-thing |
| 16 | `cold_referral#6` | `v3` | I hope this email finds you well! Professor Imogen Halliwell | Professor Imogen Halliwell | pleasantry, repeat | delete-pleasantry |
| 17 | `cold_referral#6` | `v3` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  I attached my resume, though the engineering half of it will be more legible than the finance half. | canned-flex, canned-fyr | flex-delete + R3-honest-caveat |
| 18 | `cold_referral#7` | `v4` | I hope this email finds you well! Devin Oyelaran | Devin Oyelaran | pleasantry, repeat | delete-pleasantry |
| 19 | `cold_referral#7` | `v4` | My name is Grant Feldstrom, and I am a sophomore at Halverson | My name is Grant Feldstrom, and I'm a sophomore at Halverson | contraction | contraction-swap |
| 20 | `cold_referral#7` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. | *(delete)* | canned-flex, canned-fyr | flex-delete + R0-no-resume-sentence |
| 21 | `cold_referral#7` | `v4` | Thank you so much for your time! | Thank you, and I hope the speaker night was worth the trip. | closing | C3-close-on-the-specific-thing |
| 22 | `cold_referral#8` | `v4` | I hope this email finds you well! My uncle, Rob Osgood, suggested | My uncle, Rob Osgood, suggested | pleasantry, repeat | delete-pleasantry |
| 23 | `cold_referral#8` | `v4` | My name is Dani Osgood, and I am a senior at Marchbank | My name is Dani Osgood, and I'm a senior at Marchbank | contraction | contraction-swap |
| 24 | `cold_referral#8` | `v4` | If you have 15 minutes for a call, I would be grateful, and I am very flexible. | If you have 15 minutes for a call, I would be grateful. I can move anything on my end. | canned-flex | F-h-move-anything + short-sentence |
| 25 | `cold_referral#8` | `v4` | I attached my resume for your reference. Thank you so much for your time! | I attached my resume. Thank you for treating it as a normal student email. | canned-fyr, closing | R4-plain + C1-thanks-for-the-specific-thing |
| 26 | `cold_after_meeting#1` | `.ts` II |  I am more than happy to work around your schedule, so please let me know if a specific time works better for you. I also attached a copy of my resume for your reference. | *(delete)* | canned-flex, canned-fyr | flex-delete + R0-no-resume-sentence |
| 27 | `cold_after_meeting#1` | `.ts` II | Thank you again for coming to campus, and I look forward to hearing from you! | Thank you again for coming to campus! | canned-lfth | C5-keep-the-specific-close |
| 28 | `cold_after_meeting#2` | `.ts` II | I attached one here as well so that it does not get lost. | I attached one here as well so it doesn't get lost. | contraction | contraction-swap |
| 29 | `cold_after_meeting#2` | `.ts` II |  I am very flexible and more than happy to work around your schedule! | *(delete)* | canned-flex | flex-delete |
| 30 | `cold_after_meeting#2` | `.ts` II | Thank you so much for your time! | Thank you for standing in that line with me! | closing | C1-thanks-for-the-specific-thing |
| 31 | `cold_after_meeting#3` | `.ts` II |  I am more than happy to work around your schedule, and I attached a copy of my resume for your reference. |  I attached my resume, in case the advisory question is easier to answer with it in front of you. | canned-flex, canned-fyr | flex-delete + R2-purpose-clause |
| 32 | `cold_after_meeting#4` | `.ts` II | which I have not stopped thinking about since | which I haven't stopped thinking about since | contraction | contraction-swap |
| 33 | `cold_after_meeting#4` | `.ts` II |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  Whatever is least disruptive for you is fine. I attached a resume. | canned-flex, canned-fyr | F-d-least-disruptive + R1-bare |
| 34 | `cold_after_meeting#4` | `.ts` II | Thank you so much for your time! | Thank you for judging, and for the exit question in particular! | closing | C1-thanks-for-the-specific-thing |
| 35 | `cold_after_meeting#5` | `v3` |  I am very flexible and more than happy to work around your schedule. I attached my resume, though it is still a work in progress. |  I attached my resume, though it is still a work in progress. | canned-flex | flex-delete + R3-honest-caveat-kept |
| 36 | `cold_after_meeting#6` | `v3` | who asked whether your team ever hires people who cannot yet build a model | who asked whether your team ever hires people who can't yet build a model | contraction | contraction-swap |
| 37 | `cold_after_meeting#6` | `v3` | and I am working through the financial half now | and I'm working through the financial half now | contraction | contraction-swap |
| 38 | `cold_after_meeting#6` | `v3` |  I am very flexible and happy to work around your schedule, and I attached a copy of my resume for your reference. |  I included my resume. | canned-flex, canned-fyr | flex-delete + R3-included |
| 39 | `cold_after_meeting#6` | `v3` | Thank you so much for your time! | Thank you for staying to talk to the engineers! | closing | C1-thanks-for-the-specific-thing |
| 40 | `cold_after_meeting#7` | `v4` |  I am very flexible and glad to work around your schedule, and I attached my resume for your reference. |  I'm easy on timing. The resume is attached. | canned-flex, canned-fyr, contraction | F-g-short-sentence + R1-bare |
| 41 | `cold_email#1` | `v3` | I hope this email finds you well! | I hope your week is going well! | repeat | vary-the-kept-pleasantry |
| 42 | `cold_email#1` | `v3` |  I am more than happy to work around your schedule, so please let me know if a specific time works better for you. In addition, I attached a copy of my resume for your reference. |  Please pick whatever time is easiest; I attached a resume. | canned-flex, canned-fyr | F-i-please-pick + R5-semicolon |
| 43 | `cold_email#1` | `v3` | Thank you for your time, and I look forward to hearing back from you! | Thank you for reading this far! | closing | C1-thanks-for-the-specific-thing |
| 44 | `cold_email#2` | `v3` | I hope this email finds you well! My name is Nadia | My name is Nadia | pleasantry, repeat | delete-pleasantry |
| 45 | `cold_email#2` | `v3` |  I am more than happy to work around your schedule, so please let me know if a certain time works for you. Additionally, I have attached a copy of my resume for your reference. |  Additionally, I have attached a copy of my resume. | canned-flex, canned-fyr | flex-delete + R6-drop-fyr-only |
| 46 | `cold_email#2` | `v3` | Thank you for your time, and I look forward to hearing from you! | I appreciate you reading this. | closing, canned-lfth | C4-appreciation-not-thanks |
| 47 | `cold_email#3` | `v3` | I hope all is well with you! My name is Owen | My name is Owen | pleasantry, repeat | delete-pleasantry |
| 48 | `cold_email#3` | `v3` | I do not have a professional internship yet | I don't have a professional internship yet | contraction | contraction-swap |
| 49 | `cold_email#3` | `v3` |  I am very flexible and more than happy to work around your schedule. I attached a copy of my resume for your reference, though it is still fairly light. |  I can work around you entirely. I attached a resume, though it is still fairly light. | canned-flex, canned-fyr | F-a-work-around-you + R7-honest-caveat |
| 50 | `cold_email#3` | `v3` | Thank you so much for your time! | Thank you for whatever you can spare! | closing, repeat | C3-close-on-the-ask |
| 51 | `cold_email#4` | `v3` | alumni network and wanted to reach out regarding a startup that I am building | alumni network, and I am writing about a startup I am building | throat | cut-throat-clearing |
| 52 | `cold_email#4` | `v3` |  I am more than happy to work around your schedule. | *(delete)* | canned-flex | flex-delete |
| 53 | `cold_email#5` | `v3` | I hope this email finds you well! My name is Owen | My name is Owen | pleasantry, repeat | delete-pleasantry |
| 54 | `cold_email#5` | `v3` | I am early enough that I do not have an internship to point to yet. | I'm early enough that I don't have an internship to point to yet. | contraction | contraction-swap |
| 55 | `cold_email#5` | `v3` |  I am very flexible and more than happy to work around your schedule. I attached a copy of my resume for your reference. |  I attached a copy of my resume. | canned-flex, canned-fyr | flex-delete + R6-drop-fyr-only |
| 56 | `cold_email#5` | `v3` | Thank you so much for your time! | Thank you, and I hope the fall is treating you well. | closing, repeat | C6-thanks-plus-a-wish |
| 57 | `cold_email#6` | `v3` | I hope you are doing well! My name is Priya | My name is Priya | pleasantry, repeat | delete-pleasantry |
| 58 | `cold_email#6` | `v3` | and it is what I have been reading about ever since | and it's what I've been reading about ever since | contraction | contraction-swap |
| 59 | `cold_email#6` | `v3` |  I am happy to work entirely around your schedule, and I attached a copy of my resume for your reference. |  I attached a copy of my resume. | canned-flex, canned-fyr | flex-delete + R6-drop-fyr-only |
| 60 | `cold_email#6` | `v3` | Thank you so much for your time! | I appreciate the time either way. | closing, repeat | C4-appreciation-not-thanks |
| 61 | `cold_email#7` | `v4` | I hope this email finds you well! My name is Elliot | My name is Elliot | pleasantry, repeat | delete-pleasantry |
| 62 | `cold_email#7` | `v4` |  I am happy to work entirely around your schedule, and I attached my resume for your reference. |  I attached my resume. | canned-flex, canned-fyr | flex-delete + R4-plain |
| 63 | `cold_email#7` | `v4` | Thank you for your time! | Thank you for considering it. | closing | C2-short-thanks |
| 64 | `cold_email#8` | `v4` | I hope this email finds you well! My name is Jocelyn | My name is Jocelyn | pleasantry, repeat | delete-pleasantry |
| 65 | `cold_email#8` | `v4` | My name is Jocelyn Ampofo, and I am a junior at Halverson | My name is Jocelyn Ampofo, and I'm a junior at Halverson | contraction | contraction-swap |
| 66 | `cold_email#8` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  A resume is attached. | canned-flex, canned-fyr | flex-delete + R2-impersonal |
| 67 | `cold_email#8` | `v4` | Thank you so much for your time! | Thank you for reading this. | closing, repeat | C2-short-thanks |
| 68 | `cold_email#9` | `v4` | I hope this email finds you well! My name is Dani | My name is Dani | pleasantry, repeat | delete-pleasantry |
| 69 | `cold_email#9` | `v4` | I know that is not the same as two years of clubs. | I know that's not the same as two years of clubs. | contraction | contraction-swap |
| 70 | `cold_email#9` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume. |  I'll take whatever slot is easiest to give, and I attached my resume. | canned-flex, contraction | F-e-whatever-slot |
| 71 | `cold_not_alum#1` | `.ts` II | I hope this email finds you well! My name is Kai | My name is Kai | pleasantry, repeat | delete-pleasantry |
| 72 | `cold_not_alum#1` | `.ts` II |  I am more than happy to work around your schedule, and I attached a copy of my resume for your reference. |  I attached a copy of my resume. | canned-flex, canned-fyr | flex-delete + R6-drop-fyr-only |
| 73 | `cold_not_alum#1` | `.ts` II | Thank you so much for your time! | Thank you for reading an email from a stranger! | closing, repeat | C1-thanks-for-the-specific-thing |
| 74 | `cold_not_alum#2` | `.ts` II | I hope you are doing well! My name is Kai | My name is Kai | pleasantry, repeat | delete-pleasantry |
| 75 | `cold_not_alum#2` | `.ts` II | I do not think I have ever met another person from home working in this industry. | I don't think I've ever met another person from home working in this industry. | contraction | contraction-swap |
| 76 | `cold_not_alum#2` | `.ts` II |  I am very flexible and more than happy to work around your schedule, and I attached my resume for your reference. |  You pick the time and I'll make it work. I attached my resume. | canned-flex, canned-fyr, contraction | F-b-you-pick + R4-plain |
| 77 | `cold_not_alum#3` | `.ts` II | I hope this email finds you well! My name is Kai | My name is Kai | pleasantry, repeat | delete-pleasantry |
| 78 | `cold_not_alum#3` | `.ts` II |  I am happy to work entirely around your schedule, and I attached a copy of my resume for your reference. |  I included a copy of my resume. | canned-flex, canned-fyr | flex-delete + R3-included |
| 79 | `cold_not_alum#3` | `.ts` II | Thank you very much for your time! | Thank you for whatever you can say about that deal! | closing, repeat | C1-thanks-for-the-specific-thing |
| 80 | `cold_not_alum#4` | `.ts` II | I hope all is well with you! My name is Kai | My name is Kai | pleasantry, repeat | delete-pleasantry |
| 81 | `cold_not_alum#4` | `.ts` II |  I am very flexible and more than happy to work around your schedule.<br><br>I attached a copy of my resume for your reference. | <br><br>I attached a copy of my resume. | canned-flex, canned-fyr | flex-delete + R6-drop-fyr-only |
| 82 | `cold_not_alum#4` | `.ts` II | Thank you so much for your time! | Thank you for the episode, and for whatever time you can spare! | closing, repeat | C1-thanks-for-the-specific-thing |
| 83 | `cold_not_alum#5` | `v3` | I hope this email finds you well! My name is Owen | My name is Owen | pleasantry, repeat | delete-pleasantry |
| 84 | `cold_not_alum#5` | `v3` | and I have not been able to stop thinking about it | and I haven't been able to stop thinking about it | contraction | contraction-swap |
| 85 | `cold_not_alum#5` | `v3` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  I attached my resume. | canned-flex, canned-fyr | flex-delete + R4-plain |
| 86 | `cold_not_alum#5` | `v3` | Thank you so much for your time! | Thank you for writing the piece, and for reading this! | closing, repeat | C1-thanks-for-the-specific-thing |
| 87 | `cold_not_alum#6` | `v3` | I hope you are doing well! My name is Priya | My name is Priya | pleasantry, repeat | delete-pleasantry |
| 88 | `cold_not_alum#6` | `v3` | My interest in this area is not abstract. | My interest in this area isn't abstract. | contraction | contraction-swap |
| 89 | `cold_not_alum#6` | `v3` |  I am happy to work entirely around your schedule, and I attached my resume for your reference. |  Pick whatever is least inconvenient and I'll be there. A resume is attached. | canned-flex, canned-fyr, contraction | F-f-least-inconvenient + R2-impersonal |
| 90 | `cold_not_alum#6` | `v3` | Thank you very much for your time! | Thank you for reading it either way. | closing, repeat | C2-short-thanks |
| 91 | `cold_not_alum#7` | `v4` | I hope this email finds you well! My name is Kofi | My name is Kofi | pleasantry, repeat | delete-pleasantry |
| 92 | `cold_not_alum#7` | `v4` | That is the exact sequence I have been trying to understand, and nobody I have spoken with has done both. | That's the exact sequence I've been trying to understand, and nobody I've spoken with has done both. | contraction | contraction-swap |
| 93 | `cold_not_alum#7` | `v4` |  I am glad to work entirely around your schedule, and I attached my resume for your reference. Thank you very much for your time! |  I attached my resume. Thank you for being the first person I have found who has done both! | canned-flex, canned-fyr, closing | R4-plain + C1-thanks-for-the-specific-thing |
| 94 | `cold_not_alum#8` | `v4` | I hope you are doing well! My name is Grant | My name is Grant | pleasantry, repeat | delete-pleasantry |
| 95 | `cold_not_alum#8` | `v4` | My name is Grant Feldstrom, and I am a sophomore at Halverson | My name is Grant Feldstrom, and I'm a sophomore at Halverson | contraction | contraction-swap |
| 96 | `cold_not_alum#8` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume. Thank you so much for your time! |  I attached my resume. Thank you for whatever you can tell me about the move! | canned-flex, closing | R4-plain + C1-thanks-for-the-specific-thing |
| 97 | `recruiting_inbox#1` | `.ts` II | I wanted to confirm that my application was received in full, as I did not receive a confirmation email after submitting. | Could you confirm that my application was received in full? No confirmation email arrived after I submitted. | throat | throat-to-direct-question |
| 98 | `recruiting_inbox#2` | `.ts` II | and I wanted to confirm whether students graduating in 2029 are eligible this cycle | and please confirm whether students graduating in 2029 are eligible this cycle | throat | throat-to-please-confirm |
| 99 | `recruiting_inbox#2` | `.ts` II |  I attached my resume for your reference. |  My resume is attached. | canned-fyr | R1-bare |
| 100 | `recruiting_inbox#2` | `.ts` II | Thank you for your time, and I look forward to hearing back. | Thank you for clarifying either way. | closing | C3-close-on-the-ask |
| 101 | `recruiting_inbox#3` | `.ts` II | Please let me know if there is anything else the team needs from me, or any other step I should take in the process. | If there is another step I should take in the process, I would be glad to know it. | canned-anyelse | anything-else-to-one-real-question |
| 102 | `recruiting_inbox#4` | `.ts` II | I wanted to ask when candidates can expect to hear about first-round interviews, so that I can plan around my exam schedule if needed. | Could you tell me when candidates can expect to hear about first-round interviews? I ask so that I can plan around my exam schedule. | throat | throat-to-could-you-tell-me |
| 103 | `recruiting_inbox#5` | `v4` | I wanted to ask whether eligibility for the Sophomore Insight Program is based on class year, on years completed at the current institution, or on expected graduation date. | Would you mind confirming whether eligibility for the Sophomore Insight Program is based on class year, on years completed at the current institution, or on expected graduation date? | throat | throat-to-would-you-mind |
| 104 | `recruiting_inbox#5` | `v4` | Thank you very much for your time and consideration. | Thank you for sorting out which of those it is. | closing, repeat | C3-close-on-the-ask |
| 105 | `recruiting_inbox#6` | `v4` | Before I apply, I wanted to ask whether the 2027 Summer Analyst Program in the markets division considers candidates who will need sponsorship for the subsequent full-time role. | Before I apply, please confirm whether the 2027 Summer Analyst Program in the markets division considers candidates who will need sponsorship for the subsequent full-time role. | throat | throat-to-please-confirm |
| 106 | `recruiting_inbox#7` | `v4` | I wanted to ask whether the firm considers candidates for off-cycle analyst positions, January start dates, or full-time roles that open outside the campus cycle, and if so, how those postings are advertised. | Would you be willing to say whether the firm considers candidates for off-cycle analyst positions, January start dates, or full-time roles that open outside the campus cycle, and if so, how those postings are advertised? | throat | throat-to-would-you-be-willing |
| 107 | `recruiting_inbox#8` | `v4` | I wanted to confirm that my application was received in full, as I did not receive a confirmation from the portal. | Could you check that the application was received in full? The portal sent no confirmation. | throat | throat-to-could-you-check |
| 108 | `recruiting_inbox#9` | `v4` | I wanted to ask whether one would be read, so that I can submit it if it is useful. | Let me know whether a cover letter would be read and I will include one if it is useful. | throat | throat-to-let-me-know |
| 109 | `conference_follow_up#1` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  I attached my resume. | canned-flex, canned-fyr | flex-delete + R4-plain |
| 110 | `conference_follow_up#2` | `v4` |  I am glad to work entirely around your schedule, and I attached my resume for your reference. |  A resume is attached. | canned-flex, canned-fyr | flex-delete + R2-impersonal |
| 111 | `conference_follow_up#3` | `v4` | I attached a copy of my resume for your reference. | I included a copy of my resume. | canned-fyr | R3-included |
| 112 | `redirect_sequence#2` | `v4` |  I am very flexible and happy to work around your schedule, and I attached my resume for your reference. |  I attached my resume. | canned-flex, canned-fyr | flex-delete + R4-plain |
| 113 | `follow_up_1#2` | `v3` | I hope you are doing well! I reached out | I reached out | pleasantry, repeat | delete-pleasantry |
| 114 | `follow_up_1#5` | `v3` | I hope you are doing well! I emailed | I emailed | pleasantry, repeat | delete-pleasantry |
| 115 | `interview_check_in#1` | `.ts` II | I hope you are doing well! I interviewed | I interviewed | pleasantry, repeat | delete-pleasantry |
| 116 | `interview_check_in#6` | `v4` | I hope you are doing well! I interviewed | I interviewed | pleasantry, repeat | delete-pleasantry |
| 117 | `second_conversation#1` | `v4` | I hope you are doing well! We spoke | We spoke | pleasantry, repeat | delete-pleasantry |
| 118 | `second_conversation#3` | `v4` | I hope you are doing well! Since our call | Since our call | pleasantry, repeat | delete-pleasantry |
| 119 | `keep_in_touch#1` | `.ts` II | I hope you are doing well! | I hope the semester has been a good one! | repeat | vary-pleasantry-season |
| 120 | `keep_in_touch#4` | `.ts` II | I hope you are doing well! | I hope the year has been kind to you! | repeat | vary-pleasantry-stretch-of-time |
| 121 | `keep_in_touch#5` | `v4` | I hope you are doing well! | I hope things have been steady on your end! | repeat | vary-pleasantry-neutral |
| 122 | `referral_ask#1` | `v3` | I hope you are doing well! | I hope the fall has been good to you! | repeat | vary-pleasantry-season |
| 123 | `referral_ask#2` | `v3` | I hope you are doing well! | I hope the months since September have gone well! | repeat | vary-pleasantry-grounded-in-the-body |
| 124 | `referral_ask#4` | `v4` | I hope you are doing well! | I hope the week has been a reasonable one! | repeat | vary-pleasantry-neutral |
| 125 | `referral_ask#5` | `v3` | I hope you are doing well! | I hope you are keeping well! | repeat | vary-pleasantry-short |
| 126 | `follow_up_2#2` | `v3` | I hope you are doing well! I just wanted to reach out one last time about setting up a call. | I am writing one last time about setting up a call. | pleasantry, repeat, throat | delete-pleasantry + cut-throat-clearing |
| 127 | `interview_check_in#3` | `.ts` II | I hope you are doing well! I wanted to follow up on my interview | Following up on my interview | pleasantry, repeat, throat | delete-pleasantry + cut-throat-clearing |
| 128 | `interview_check_in#4` | `v4` | I hope this email finds you well! I wanted to reach out one final time regarding | I am writing one final time about | pleasantry, repeat, throat | delete-pleasantry + cut-throat-clearing |
| 129 | `interview_check_in#1` | `.ts` II | If there is any additional information you need from me, please do not hesitate to reach out. | If anything else would help, I can send it over. | canned-hesitate | offer-in-this-email's-words |
| 130 | `call_scheduling#2` | `.ts` II | If anything comes up between now and then, please do not hesitate to move it, as I am very flexible. | If anything comes up between now and then, move it and I will adjust. | canned-hesitate, canned-flex | offer-as-an-imperative |
| 131 | `call_scheduling#6` | `v4` | If anything comes up between now and then, please do not hesitate to move it. | If the time stops working, I can take a different one. | canned-hesitate | offer-stated-as-a-fact |
| 132 | `referral_ask#1` | `v3` | I know that a referral carries your name with it, so please do not hesitate to say no. | A referral carries your name with it, so no is a complete answer. | canned-hesitate | easy-out-rewritten |
| 133 | `thank_you_interview#1` | `v3` | If there is any additional information that you need from me, please do not hesitate to reach out. | Anything else the team needs, I can get to you quickly. | canned-hesitate | offer-fronted |
| 134 | `thank_you_interview#2` | `v3` | If so, please do not hesitate to reach out. | If so, I will send it the same day. | canned-hesitate | offer-with-a-commitment |
| 135 | `thank_you_interview#4` | `v3` | If you need any additional information from me, please do not hesitate to ask. | If you need anything further from me, just ask. | canned-hesitate | offer-shortened |
| 136 | `thank_you_superday#1` | `v3` | If there is any additional information you need from me, please do not hesitate to reach out, and I look forward to hearing about the next steps! | If anything further is needed from me, I can send it along. I would be glad to hear what the next step is. | canned-hesitate, canned-lfth | offer-split-from-the-ask |
| 137 | `follow_up_1#4` | `v3` | Thank you so much for your time, and I look forward to hearing from you! | Thank you so much, and I will leave it here either way! | canned-lfth, closing | C3-close-on-the-ask |
| 138 | `follow_up_2#1` | `v3` | Thank you, and I look forward to hearing from you! | Thank you either way! | canned-lfth, closing | C2-short-thanks |

---

# 4. Priority order — every prefix is shippable

Ranked by **(a) the pattern's frequency in the 192 gold bodies and (b)
type-level draft volume**. Neither depends on which box mix currently reaches
which stored example, so the order survives the `combinedExamplesFor` patch.

The five most-drafted types are `cold_email`, `cold_not_alum`, `cold_referral`,
`cold_after_meeting` and `recruiting_inbox` — **41 bodies, 21% of the corpus**,
and they carry the defects out of all proportion to their share:

| pattern | in the 41 priority bodies | corpus total | share |
|---|---:|---:|---:|
| `for your reference` | **28** | 32 | **88%** |
| flexibility line | **32** (and 32 of 32 cold bodies = 100%) | 52 | 62% |
| opens on a pleasantry | 26 | 62 | 42% |
| `My name is` | 40 | 50 | 80% |
| en dash | 8 | 11 | 73% |

`recruiting_inbox` has a **different** defect profile and is handled separately:
0 pleasantries, 0 flexibility lines, but **8 of 9 open the ask with `I wanted
to ...`** and 6 of 9 close on a thanks-for-time formula. Its fix is deleting
throat-clearing and varying the close — and *not* adding contractions, because
VOICE_RULES names a recruiting inbox as the place full forms belong.

## The prefix property, measured

`npx tsx scripts/audit-probe/corpus/tiers.ts` applies the table one tier at a
time. **Every metric moves monotonically in the right direction at every tier,
`fluencyIssues` never leaves 18, and word count only falls** — so stopping after
any tier leaves a coherent, strictly better corpus.

| after tier | edits | fyr | flex | hes | pleas | contr | cTime | opens | closes | flu | words |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| (baseline) | 0 | 32 | 42 | 8 | 62 | 0 | 72 | 137 | 113 | 18 | 21113 |
| **1a** `cold_referral` | 25 | 24 | 35 | 8 | 54 | 4 | 67 | 145 | 117 | 18 | 20945 |
| **1b** `cold_after_meeting` | 40 | 19 | 28 | 8 | 54 | 8 | 64 | 145 | 119 | 18 | 20843 |
| **1c** `cold_email` | 70 | 12 | 21 | 8 | 47 | 13 | 57 | 152 | 124 | 18 | 20638 |
| **1d** `cold_not_alum` | 96 | 5 | 16 | 8 | 39 | 18 | 50 | 157 | 131 | 18 | 20506 |
| **2** `recruiting_inbox` | 108 | 4 | 16 | 8 | 39 | 18 | 48 | 157 | 132 | 18 | 20480 |
| **3a** remaining `for your reference` | 112 | **0** | 14 | 8 | 39 | 18 | 48 | 157 | 132 | 18 | 20434 |
| **3b** repeated pleasantry openers | 132 | 0 | 14 | 6 | **25** | 18 | 47 | **173** | 131 | 18 | 20368 |
| **3c/3d** `do not hesitate` + last `lfth` | 138 | 0 | 14 | **0** | 25 | 18 | 47 | 173 | 131 | 18 | 20342 |

**Tier 1a is first on purpose.** `cold_referral` is the one tier whose
justification needs no judgement at all: Volume V's own section-1 format block
says *"Put the referrer's name in the subject line and open the first sentence
with it"*, and **all 8 gold `cold_referral` bodies put a pleasantry in front of
it.** Deleting that pleasantry makes the gold corpus agree with the playbook's
own documented rule, costs no words and changes no fact. If only one tier ever
lands, it should be this one.

## Tier 4 — stated, deliberately not enumerated

What remains after 138 edits: `Thank you again!` ×12, `Thank you so much!` ×9,
`Thank you again for everything!` ×7, `Thank you again for your time!` ×6 — 34
bodies, nearly all in thank-you types (`thank_you_interview`, `thank_you_event`,
`accept_offer`, `after_rejection`, `close_loop_referrer`) where closing on a
thanks **is correct** and VOICE_RULES explicitly allows a thank-you email to
thank again at the close.

They are not enumerated here because the honest fix for each is a sentence built
from **that body's own content** — the conversation, the offer, the deal, the
favour — and writing 34 of those from a template is precisely the 32-identical-
replacements failure. The correct sequence is: land Tiers 1–3, **measure** (§5),
then write Tier 4 against the measurement with the same per-body discipline the
table above demonstrates. Target: no closing string over 5, dominant family
under 25%.

## Tier 5 — optional, zero-risk, not in the table

The eight `10–15 minutes` → `10 to 15 minutes` in the priority types. Removes
the en-dash character from every prose-adjacent position in the corpus without
touching the three `call_scheduling` time tables. **Recommended only if someone
decides the dash character itself is the concern** — on the measurement (§1.4)
it is not a defect, and `10 to 15 minutes` already appears in four bodies.

## Explicitly left alone, with reasons

| pattern | count | why it stays |
|---|---:|---|
| all 12 en dashes | 12 | every one a numeric range; zero em dashes exist; HOUSE_RULES bans em dashes in prose |
| `Thank you again` anywhere in the body | 96 | VOICE_RULES permits a thank-you email to thank again at the close; not a defect |
| `My name is` | 50 | VOICE_RULES sanctions it in a first email to someone who doesn't know the student, which is exactly these types |
| zero contractions in ~38 full-form bodies | 38 | VOICE_RULES requires full forms to a recruiting inbox, in offer decisions and in letters to professors |
| all 42 Volume V bodies | 42 | the `fluencyIssues` calibration corpus and the `EXPECTED_FINDINGS = 3` gate; needs its own change |
| the 3 `lint-examples` findings | 3 | in Volume V sections 12, 12 and 17 — untouched, so the gate holds by construction |
| the 18 gold `fluencyIssues` findings | 18 | pre-existing and unrelated; measured flat before and after |

---

# 5. The test, with a same-code control arm

The standing requirement: an earlier A/B was invalidated because the experiment
moved 31 of 58 metrics while a control moved 28. MEASURE-1 §3 reproduced that
exactly — **28 of 55 metrics moved between two identical arms.** No arm here is
interpretable without the control.

## 5.1 Rig

```bash
# node_modules must exist in the worktree
ln -s "$(git rev-parse --path-format=absolute --git-common-dir)/../node_modules" node_modules

# --- BEFORE: two arms on UNCHANGED code. Arm 2 is the control. ---
shasum src/lib/email-examples*.{ts,json} src/lib/draft-{prompt,review,lint}.ts  # record
npx tsx scripts/draft-cli-eval.ts --scenarios=24 --seed=offerly --json=before.json  --quiet
npx tsx scripts/draft-cli-eval.ts --scenarios=24 --seed=offerly --json=control.json --quiet
shasum src/lib/email-examples*.{ts,json} src/lib/draft-{prompt,review,lint}.ts  # must match

# --- apply the 138 edits; nothing else in the same change ---
npx tsx scripts/audit-probe/corpus/apply-check.ts     # must report the §3 gate clean
npx tsx scripts/draft-occasions-sim.ts lint-examples  # must print exactly 3
npx tsx scripts/draft-lint-corpus.ts
npx tsx scripts/draft-bug-hunt.ts                     # ceiling + leak checks on the examples
npx tsx scripts/content-limits-coverage-test.ts
npm run help:learn                                    # if any page text changed (it should not)

# --- AFTER: same seed, same count ---
shasum src/lib/email-examples*.{ts,json} src/lib/draft-{prompt,review,lint}.ts
npx tsx scripts/draft-cli-eval.ts --scenarios=24 --seed=offerly --json=after.json \
  --compare=before.json --quiet
shasum src/lib/email-examples*.{ts,json} src/lib/draft-{prompt,review,lint}.ts
```

**Reading rule.** For every metric, compute `|after − before|` **and**
`|control − before|`. A metric counts as moved only where
`|after − before| > |control − before|` **and** the delta clears the metric's
MEASURE-1 §3 band. Anything else is noise, whatever its sign. Four runs of 24
scenarios ≈ **$2.50 notional and ~6 minutes** on the subscription rig. There is
no excuse for skipping the control.

Prompt-only arms (`--no-review`) answer the question this plan is actually
about — what the **drafter** does — at half the calls. Run those first.

## 5.2 Pass conditions, with each metric's MEASURE-1 class named before the run

### Primary, and the only arm that needs no statistics

| metric | class (MEASURE-1 §3) | before | pass |
|---|---|---:|---|
| `contractionsPreMean` | **DEGENERATE (0, 0, 0)** | 0 | **> 0.5** |
| `contractionRatePreMean` | **DEGENERATE (0, 0, 0)** | 0 | **> 0.4** |
| `zeroContractionPre` | **LOW-NOISE (range 0)** | 12/12 | **≤ 8 of 12 / ≤ 16 of 24** |

**This is the subtle point and it is worth being exact about.** MEASURE-1 calls
a DEGENERATE metric "the D21 trap: nothing can regress against it, so a pass
condition written on it is unfalsifiable". That is right for a **regression
guard** and exactly backwards for an **improvement target**. These three are
0 across three identical arms, so the control band is *exactly zero*: **any
non-zero pre-review contraction after the edit is signal and cannot be noise.**
This is the cheapest clean measurement available on the whole board — valid at
n=12 — and it is the one metric where the corpus is the sole cause, since
`zeroContractionPre` is 12/12 *with VOICE_RULES already in the drafting prompt*.

### Secondary, usable at n=12 (LOW-NOISE, range 0, band 2.6%)

| metric | before | pass |
|---|---:|---|
| `cannedFlexibilityPre` | 3/12 | **≤ 1** |
| `cannedFlexibilityPost` | 3/12 | **≤ 1** |
| `pleasantryOpenPre` | 2/12 | **≤ 1** |
| `lintCleanPre` | 8/12 | **≥ 8** (must not regress) |
| `wordsPreMean` | 118.25 | **within ±8** (a corpus 771 words shorter should not blow the ask apart) |

### Needs n ≥ 24 (MEDIUM: bands 5.7%–24%)

`cannedLinesPre` (8.8%), `longestIRunPreMean` (16.4%), `repeatedSentencesPre`
(18.2%), `problems`/`problemsMean` (12.2%), `guardAcceptRate` (8.5%),
`reviewApplied` (8.6%), `issuesPost` (15.0%). Report these at n=24 **with the
control delta beside each**, as directional evidence only. MEASURE-1 is explicit
that n≥24 is a floor, not a guarantee: the bands were measured at n=12 and this
plan does not claim to know how they shrink.

### Must NOT carry a pass condition

| metric | why |
|---|---|
| `cannedResumePre` / `cannedResumePost` | §1.B — detects presence, not cannedness; flags `My resume is attached.` and clears `A resume is attached.` Use the literal `for your reference` count instead. |
| `contractionsPostMean` | UNUSABLE-AT-THIS-N (27.6%) |
| `zeroContractionPost` | UNUSABLE-AT-THIS-N (60.0%) |
| `pleasantryOpenPost`, `threeIStartsPost`, `cannedEasyOutPre` | UNUSABLE-AT-THIS-N (300%) |
| `reviewRetried`, `reviewRejected` | UNUSABLE-AT-THIS-N (180% / 300%) |
| `overCeilingPre`/`Post`, `lintForReviewPost`, `lintForStudentPost` | DEGENERATE **as guards** — 0 in all three arms with no baseline rate; this is the D21 trap proper |

### Static gates, no model call, must all hold

| gate | required |
|---|---|
| `scripts/draft-occasions-sim.ts lint-examples` | **exactly 3** findings (build-breaking assertion) |
| `apply-check.ts` fact fidelity | **0** bodies lose a fact token |
| `apply-check.ts` fluency | gold findings **≤ 18**, no NEW finding |
| `apply-check.ts` ceiling | **0** bodies over `maxWords` |
| `apply-check.ts` find uniqueness | **138 / 138** |
| `apply-check.ts` the ask | `ASK` reaches **≥ 115 / 192**; **0** bodies lose their ask |
| most-repeated opener / closer | **≤ 5 / ≤ 12** |

## 5.3 The specific risk to watch: fact fidelity

**The drafter copies these bodies, so a fact edited into an example becomes a
fact hallucinated into a student's email.** This is the one failure mode that
would make the change net-negative however good the voice numbers look, and the
corpus's facts are deliberately fictional precisely so that HOUSE_RULES can say
"never carry any of it into this email".

Three layers of defence, in order:

1. **Static, every run.** `apply-check.ts` asserts every proper noun, number,
   requisition number, class year and date in the original body survives the
   edit. Currently **0 of 69 touched bodies lose a token.**
2. **By construction.** The table adds no new proper noun, no number, no date,
   no claim about anyone. Every replacement is a deletion, a contraction swap,
   a reordering, or a courtesy/closing sentence built only from words already in
   that body. The two shapes that would be dangerous — stating specific
   availability windows (`"Tuesday mornings are open"`) and inventing a
   relationship detail — were **considered and rejected** for exactly this
   reason, which is why every flexibility replacement is time-free
   (`"I have no constraints on my end."`, `"Whatever is least disruptive for you
   is fine."`).
3. **On the rig.** Read `problemsNeedsStudent` and the `forStudent` notes in
   `after.json` against `before.json` and `control.json`, and hand-read the
   **12 sparse-profile drafts** — thin input is where a model reaches into an
   example for filler, so it is where a leaked fact would surface first. Any
   example-sourced proper noun in a generated draft (`Marston Pike`,
   `Ridgemont`, `Halcombe`, `Gaffney`, `Hollis Grove`) is an immediate stop:
   `scripts/draft-bug-hunt.ts:383` already has a leak check over the example
   bodies and must stay clean.

A secondary risk worth naming: **−771 words.** The deletions are concentrated in
the courtesy block, which is also where the ask lives. `draft-lint.ts`'s `ASK`
regex reaches **115 of 192** bodies (measured; the comment at
`draft-lint.ts:30` says 131, which no longer reproduces and should be
re-checked separately). `apply-check.ts` now asserts this count does not fall
and names any body that loses its ask — see §5.4, which is how a real
regression in this plan was caught.

## 5.4 A regression this plan already caught, and why the gate now exists

Worth recording, because it is the shape of mistake this kind of edit invites.

Tier 2's whole point is deleting `I wanted to ...` throat-clearing from
`recruiting_inbox`. The obvious rewrite turns the hedge into a plain question:

> `I wanted to ask whether eligibility for the Sophomore Insight Program is
> based on class year, ...`
> → `Is eligibility for the Sophomore Insight Program based on class year, ...?`

That is better prose and it **broke seven of the nine bodies.** `draft-lint.ts`'s
`ASK` regex matched those sentences on its `\bwanted to (?:ask|confirm)\b`
family; a bare interrogative matches none of its families, so `ASK` fell from
115/192 to 108/192. The emails still asked — `draft-lint` could no longer tell,
which silently switches off everything downstream that reads the ask, **including
the guard's check that a reviewer edit has not deleted the email's only
request.** That is the exact failure the `ASK` comment
(`draft-lint.ts:19-38`) says the regex was widened to prevent.

Fixed inside the plan, with no change to `src/`: all seven replacements were
rewritten onto families `ASK` does recognise, and deliberately onto **eight
different ones** — `could you confirm` (#1), `please confirm` (#2, #6),
`could you tell me` (#4), `would you mind confirming` (#5),
`would you be willing to say` (#7), `could you check` (#8), `let me know
whether` (#9). `ASK` is back to 115/192 with no body losing its ask.

One of those took two attempts, which is the argument for the gate rather than
for care: `My question is whether ...` looks like it should match the
`\bmy (?:two |three )?questions? (?:were|are|was)\b` family and does not — that
family requires a plural verb (`my questions are`), not `my question is`.
**`apply-check.ts` now asserts the ask count and names any body that loses it,
and exits non-zero.** No reviewer should have to spot this by reading.

---

# 6. Files

| path | what |
|---|---|
| `docs/concepts/CORPUS-EDIT-PLAN.md` | this document |
| `scripts/audit-probe/corpus/measure.ts` | probe 1 — the §1 re-measurement; `--json`, `--phrase --where`, `--list=<re>` |
| `scripts/audit-probe/corpus/dump.ts` | probe 2 — bodies with file provenance and sentence indices |
| `scripts/audit-probe/corpus/edits.ts` | **the 138 edits as data** — the artefact to apply |
| `scripts/audit-probe/corpus/apply-check.ts` | probe 3 — applies them in memory; fact / length / fluency / uniqueness gate |
| `scripts/audit-probe/corpus/tiers.ts` | probe 4 — the §4 prefix table |
| `scripts/audit-probe/corpus/table.ts` | probe 5 — renders §3's table from `edits.ts` |

None of the probes writes to `src/`, calls a model, or touches the database.
