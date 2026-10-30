# LOGIC-3 — the pipeline's control flow and the prompt assembly

Audited at `0053b1a` on branch `perf/draft-pipeline`, in the worktree
`.claude/worktrees/draft-pipeline-perf`.

**Concurrent-session note.** Three commits landed in this worktree from other
sessions while the audit ran (`5738bad`, `8afe9bf`, `ac8a0d6`). Two in-scope files
moved: `draft-prompt.ts` gained `keepInSection` (prompt-section hardening on
`userText`, `+27/-6`) and `draft-templates.ts` reworded one `recruiter_outreach`
promptNote. **Every number in this report was re-run against `ac8a0d6` and is
unchanged**, except where the reworded promptNote changes a quoted line's text.
No finding depends on either change.

**In scope:** `src/lib/draft-pipeline.ts`, `src/lib/draft-prompt.ts`,
`src/lib/draft-occasions.ts`, and `src/lib/ai-runner.ts` (read only for how the
review sits outside the fallback ladder).
**Not read (in flight):** `src/lib/draft-stream.ts`, `scripts/draft-stream-test.ts`,
`src/app/api/drafts/`, `useDraftStream.ts`, `draft-request.ts`. Where a conclusion
would depend on one of those, it is marked as such.

Every claim below is labelled **MEASURED** (with the command that produced it) or
**REASONED** (an argument over code I read). No number here was estimated.
Probes live in `scripts/audit-probe/logic3/`; they make no API call and touch no
database.

Run them all with:

```bash
cd "/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf"
for p in enumerate strength sections boxdetail setsask alsotrue combined deadmix \
         tiers ceiling purpose coldgap asked questions finish finish2 finish3 \
         stalenote retrythrow greeting; do npx tsx scripts/audit-probe/logic3/$p.ts; done
```

---

## 0. The shape of the thing (MEASURED)

`npx tsx scripts/audit-probe/logic3/enumerate.ts`

| | |
|---|---|
| combinations `resolveSituation` accepts | **107** |
| by box count | 1 box: 46 · 2: 29 · 3: 24 · 4: 8 |
| multi-box | **61** |
| by occasion | first_contact 54 · stay 17 · thanks 11 · follow_up 7 · reply 6 · offers 6 · ask 5 · custom 1 |
| lead types that ever lead a multi-box situation | 9 (`cold_referral` 17, `cold_after_meeting` 11, `conference_follow_up` 11, `redirect_sequence` 8, `second_conversation` 5, `thank_you_offered_help` 3, `close_loop_referrer` 3, `recruiter_outreach` 2, `keep_in_touch` 1) |
| combinations `cold_email` leads | **1** (the single box `first.alum`), **0 of them multi-box** |

The stated 107 is exact, and the known fact about `cold_email` holds: within
`first_contact` every other box outranks `first.alum` in `STRENGTH`, and
`first.not_alum` — the only box it could outrank — excludes it.

---

## Findings, ranked

### F1 — `conference_follow_up` falls through `briefLines`' cold switch; three typed answers are discarded

**The flaw.** `briefLines`' first `case` group is keyed on four literal ids —
`cold_email`, `cold_after_meeting`, `cold_not_alum`, `cold_referral`
(`draft-prompt.ts:539-542`) — not on `type.isCold`. There are **five** types with
`isCold: true`. `conference_follow_up` is the fifth, and it gets none of that
block: not the purpose line, not `financeInterest`, not `wantToLearn`, not
`specificReason`, not the resume-source line, not the ask line.

Meanwhile `briefQuestions` *is* keyed on `isCold`
(`draft-occasions.ts:789`), so the form asks all three `COLD_BRIEF` questions
for a conference situation.

**Reproduction (MEASURED).**

```bash
npx tsx scripts/audit-probe/logic3/coldgap.ts
npx tsx scripts/audit-probe/logic3/asked.ts
```

```
types with isCold === true: 5 -> cold_email, cold_after_meeting, cold_not_alum, cold_referral, conference_follow_up
NOT covered: conference_follow_up

conference_follow_up   purpose=NO   financeInterest=NO   wantToLearn=NO   commonGround=NO   askLine=NO
cold_email             purpose=yes  financeInterest=yes  wantToLearn=yes  commonGround=yes  askLine=yes
```

and the form, for `[first.conference]`:

```
   financeInterest      "What part of finance draws you?"
   wantToLearn          "What do you want to learn from this person?"
   specificReason       "What you and this person have in common"
```

The three `COLD_BRIEF` questions carry `prompt: ""`, so they never reach the
prompt through `fieldAnswers` either — only through `brief.financeInterest` /
`wantToLearn` / `specificReason`, which only the cold `case` reads. The
committed harness wires them exactly that way
(`scripts/draft-occasions-sim.ts:234-238`), so the probe reproduces the product's
own mapping. (The server-side wiring is in `draft-request.ts`, which I did not
read; the field names are identical, so the conclusion is the same unless that
file re-routes them.)

**Consequence.** `conference_follow_up` leads **12 of 107** combinations
(MEASURED, `enumerate.ts`). On every one, the student is asked what part of
finance draws them, what they want to learn, and what they have in common with
the recipient — and all three answers are thrown away. The model is left to
invent the "why you specifically" line from the conference detail alone, which is
precisely the invention `CONNECTION_RULES` exists to prevent. The ask is also
unstated by the brief; only the type's own promptNote "Ask for 10 minutes."
supplies it.

**Fix.** Replace the four-id `case` list with `if (type?.isCold)` (or add
`case "conference_follow_up":` to the group) and let the existing
`typeId === "cold_email"` sub-conditions keep the alum-database line specific to
that type. One line; it also makes the next cold type added correct by default.

---

### F2 — the retry window and the skip gate are cut from different budgets: a 30-second dead band where the retry can never fire

**The flaw.** Production calls `runDraftPipeline` with `reviewSkipAfterMs: 80_000`
and no `reviewRetryBeforeMs`, so the retry window is the 60 s default
(`generate-draft.ts:38`, `draft-pipeline.ts:315`). The two gates read different
clocks:

- the skip gate tests `draftedMs > 80_000` — time from `started` to the end of
  `finishDraft`, i.e. *drafting only*;
- the retry gate tests `Date.now() - started < 60_000` — time from `started` to
  *after the first review call returned*, i.e. drafting **plus** lint **plus**
  one whole review.

**Reproduction (REASONED arithmetic over MEASURED latencies).** Recorded review
latency on the CLI rig is `reviewMsMean` 10,144 / 9,576 / 10,158 ms across three
identical arms (`docs/concepts/MEASURE-1.md:437`) and 13.8 s on another rig
(`MEASURE-1.md:353`). Taking 10 s:

| drafting time | review runs? | retry available? |
|---|---|---|
| ≤ ~50 s | yes | yes |
| **~50 s – 80 s** | **yes** | **never** |
| > 80 s | no (skipped) | n/a |

The dead band is **30 s wide, 37.5 % of the 80 s range in which the review is
allowed to run at all** (42.3 % at the 13.8 s review figure). Its width is
computable; **how often a request lands in it is not measurable from anything in
the repo** — see F17.

The behaviour inside the band is reproducible directly:

```bash
npx tsx scripts/audit-probe/logic3/retrythrow.ts   # case E
```

```
E retry window exhausted  : calls=2 applied=false rejected="added \"Goldman\"" reviewRetryMs=null
```

**Consequence.** `MEASURE-1.md:204` records **12 of 30** full-profile drafts
hitting a first-turn guard rejection, and `MEASURE-1.md:335-344` records the
retry **rescuing 15 of 19** rejections across five runs. REASONED from those two
numbers: outside the dead band, ~40 % × (4/19) ≈ **8 %** of drafts finally lose
their review edit; inside it, **40 %** do — a **4.7×** increase. In the band the
student gets the unreviewed draft plus `studentNotesFromReview(problems, false)`,
i.e. told about problems that nothing fixed.

Note also that every retry measurement in the repo was taken with
`--retry-before=600000`, ten times the production window — `HARNESS.md:41` says so
outright ("Raise it to exercise the retry path, which real CLI durations often
push past"), and `reviewRetrySkippedForTime` is recorded as **DEGENERATE**
(`MEASURE-1.md:474`). **The production window has never been exercised by a
measurement.**

**Fix.** Derive both gates from one budget constant. With `maxDuration = 120`
(`src/app/(app)/outreach/email/page.tsx:20`), a coherent pair is
`reviewSkipAfterMs = 80_000` and `reviewRetryBeforeMs ≈ 95_000` — a retry started
at 95 s with a 10 s review still lands at ~105 s. Better still, gate the retry on
*remaining* budget (`deadline - Date.now() > expectedReviewMs`) rather than on
elapsed time, and pass the deadline in from the caller that owns `maxDuration`.

---

### F3 — a throwing retry discards everything the first review turn found

**The flaw.** The retry's `await callReview()` (`draft-pipeline.ts:326`) sits
inside the same `try` as the first call. If it throws — a capacity error being the
expected case — control jumps to the `catch` at line 357, which overwrites
`review` with `{ problems: [], applied: false, error }`. The first turn's
`problems`, its `rejected` reason and its `revisedBody` are gone.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/retrythrow.ts`

```
A retry fails the guard   : calls=3 applied=false rejected="added \"Goldman\"" problems=2
   notes=["Check this before sending: \"sales and trading\". Your interest is sales and trading, but this is a credit team."]

B retry throws            : calls=3 applied=false rejected=undefined problems=0 error="overloaded" notes=[]
   timings={"reviewMs":0,"reviewRetryMs":null,...}
```

Same first review turn, same two problems found. In A the student is warned that
the email claims an interest in sales and trading to a credit team. In B — where
only the *second* call failed — that warning is silently dropped.

**Consequence.** A transient 529 on the retry is strictly worse than not retrying
at all: it converts "review rejected, here is what it found" into "review didn't
run". The failure also makes the timings ambiguous — `reviewMs` is populated and
`reviewRetryMs` is `null`, the same shape as "the guard accepted first time".

**Fix.** Wrap only the retry:

```ts
const retry = await callReview().catch((err) => {
  console.error("[draft] review retry failed; keeping the first turn", err);
  return { out: null, stop: null };
});
```

Then the existing `if (retry.out)` branch already does the right thing, and the
first turn's outcome survives.

---

### F4 — the review call is unbounded, and `started` resets on a fallback re-run, so both gates can be wrong about the request's real age

**The flaw, three parts.**

1. **No timeout on the review.** `getAnthropicClient()` constructs
   `new Anthropic()` with no `timeout` and no `maxRetries`
   (`src/lib/anthropic-client.ts`). The SDK defaults are **`timeout` = 10 minutes
   and `maxRetries` = 2** (MEASURED: `node_modules/@anthropic-ai/sdk/client.d.ts:202,205`;
   SDK 0.117.1). The skip gate bounds the *draft*; nothing bounds the review. A
   review that takes 50 s after a 79 s draft puts the request at 129 s against
   `maxDuration = 120`, the host kills it, and the student gets nothing — the exact
   outcome the gate's own comment ("A draft that arrives unreviewed beats one that
   never arrives") exists to prevent.
2. **The SDK retries inside each gate.** Because `maxRetries` is 2, one
   `client.messages.parse` can be three HTTP attempts with backoff before
   `isCapacityError` is ever consulted. Both the 80 s and the 60 s thresholds are
   therefore measuring up to three attempts, not one.
3. **`started` is per-invocation.** `const started = Date.now()` is the first
   line of `runDraftPipeline` (`:197`), and `callWithFallback` wraps the *whole*
   callback (`ai-runner.ts:283`), which in `generate-draft.ts:38` is the whole
   pipeline. So a capacity error on the draft re-runs the entire pipeline on the
   next model **with the clock reset to zero**. After an Opus attempt that burned
   45 s, the Sonnet attempt's skip gate believes it has the full 80 s.

**Reproduction.** Parts 1–2 are MEASURED from the SDK's own documented defaults
plus the absence of any override (`grep -n "timeout\|maxRetries" src/lib/anthropic-client.ts`
returns nothing). Part 3 is REASONED from `draft-pipeline.ts:197` and
`ai-runner.ts:278-289`; it is structural, not probabilistic.

**Consequence.** The two time gates protect the request only when nothing retries.
With a draft fallback, total wall time can exceed `maxDuration` while both gates
read "fine" — and the student loses the draft entirely. A secondary consequence
belongs to the streaming path: `runDraftPipeline` is re-invoked whole, so
`onEvent` replays `draft-finished` for a second draft (`draft-stream.ts` is in
flight and was not read; the pipeline side of it is plain from `:226-254`).

**Fix.** (a) Give the review call an explicit per-request timeout —
`client.messages.parse(req, { timeout: remainingBudgetMs, maxRetries: 0 })` — so a
slow review degrades to an unreviewed draft instead of a dead request. (b) Thread
an absolute deadline (`startedAt` from the route) into `PipelineConfigs` instead
of recomputing `started` per invocation, so a fallback re-run inherits the clock.

---

### F5 — a checked box that contributes nothing: `redirect_sequence` as a secondary box, in 14 of 61 multi-box combinations

**The flaw.** All three of `redirect_sequence`'s `promptNotes` begin with a
`STEP_NOTE` prefix (`Thanking the first person:`, `Emailing the new person:`,
`Closing the loop:`) and all three are alternatives in `SETS_THE_ASK`. When the
box is secondary, `briefLines` is called with `fieldAnswers: []`
(`draft-prompt.ts:830`), so `step` resolves to `undefined`, the per-step filter at
`:656` is skipped, all three notes are pushed — and then all three are removed by
the `SETS_THE_ASK` filter at `:831`. `redirect_sequence` matches no `case` in the
switch, so there is nothing left. `extra.length === 0` and the whole
`ALSO TRUE` block is dropped.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/alsotrue.ts`

```
ALSO TRUE blocks built: 87; lines inside them: 322
=== checked boxes contributing NO ALSO TRUE block: 14 occurrences ===
  635 [first.met,first.pointed]            lead=cold_after_meeting   SILENT secondary=redirect_sequence
  641 [first.conference,first.pointed]     lead=conference_follow_up SILENT secondary=redirect_sequence
  660 [stay.redirected,stay.second]        lead=second_conversation  SILENT secondary=redirect_sequence
  ... 14 in all, every one of them redirect_sequence
```

**Consequence.** `blendRules` promises the model "Every checked box shows up.
Each fact given for it appears once" (`draft-prompt.ts:964`). In these 14
combinations the student ticked "Someone I emailed sent me to them" (or "Thank the
person who sent me elsewhere"), the form asked about it, and the prompt says
nothing about it at all. On 12 of the 14 the box is the student's entire account of
how they came to the recipient.

**Fix.** Two steps. (a) Pass the resolved step through to the secondary call
instead of blanking `fieldAnswers` wholesale — the per-step filter then selects one
note. (b) Guard the silence: when `extra.length === 0` for a checked box, log it
(or fail `scripts/draft-occasions-test.ts`) rather than `continue`. A box that
contributes nothing is always a bug, never a valid outcome.

---

### F6 — `finishDraft`'s sign-off detection: two sign-offs on 14 of 23 plausible closings, and one case where it deletes the rest of the email

**The flaw.** Three separate narrownesses in the same five lines
(`draft-prompt.ts:1077-1087`):

1. the window is `i >= lines.length - 8`, counted in **lines including blanks**;
2. `CLOSING` requires a comma immediately after a fixed 20-word list;
3. the optional trailing name allows at most **two** capitalised words.

**Reproduction A — the 8-line window (MEASURED).**
`npx tsx scripts/audit-probe/logic3/finish.ts` (case G): a body of 11 lines whose
`Best,` sits at index 2 with a six-line signature and two P.S. lines after it.
`Best,` is at `length - 9`, one line outside the window, so `signOff` stays `-1`:

```
   | Best,
   | Maya Okafor
   | Duke University '29
   | maya.okafor@duke.edu
   | (919) 555-0142
   | linkedin.com/in/mayaokafor
   |
   | P.S. I have attached my resume.
   | P.P.S. I am free any afternoon.
   |
   | Best,
   | Maya Okafor
   | Duke University ’29
   ...
```

Two sign-offs and two signatures, one of them the model's own invention — the
exact thing the rebuild exists to prevent. A six-line signature (name, school,
program, email, phone, LinkedIn) plus one blank already occupies 7 of the 8 lines.

**Reproduction B — the regex (MEASURED).**
`npx tsx scripts/audit-probe/logic3/finish3.ts`

```
"Best, Maya Okafor"                      no  (cut correctly)
"Best, Maya A. Okafor"                   YES - TWO SIGN-OFFS
"Sincerely"                              YES - TWO SIGN-OFFS
"Thank you so much,"                     YES - TWO SIGN-OFFS
"Thanks so much,"                        YES - TWO SIGN-OFFS
"Looking forward to hearing from you,"   YES - TWO SIGN-OFFS
"Gratefully,"                            YES - TWO SIGN-OFFS
"Warm wishes,"                           YES - TWO SIGN-OFFS
"All my best,"                           YES - TWO SIGN-OFFS
"Best,Maya"                              YES - TWO SIGN-OFFS
"Best , Maya"                            YES - TWO SIGN-OFFS
"With gratitude,"                        YES - TWO SIGN-OFFS
"Appreciatively,"                        YES - TWO SIGN-OFFS
"Respectfully yours,"                    YES - TWO SIGN-OFFS
"Yours sincerely,"                       YES - TWO SIGN-OFFS
```

**14 of 23** tested closings leave the model's closing in place and append a
second one. A middle initial (`Best, Maya A. Okafor`) and a comma-less
`Sincerely` are both ordinary model output.

**Reproduction C — the ordering actually destroys content (MEASURED).**
`npx tsx scripts/audit-probe/logic3/finish2.ts` (case L). The em-dash rewrite runs
*before* sign-off detection, so it can manufacture a `CLOSING` match in the middle
of the body. A line `Thanks again — Maya` becomes `Thanks again, Maya`, matches
`CLOSING`, and **everything after it is cut**: the student's two recruiter
questions disappear from the email, and the output is flagged as having two
sign-offs. This is the one place where step 2 corrupts step 3's work rather than
merely confusing it.

**Consequence.** A visibly broken email (two sign-offs, two signatures, one
invented) or a silently truncated one. The pre-existing simulation check
(`draftIssues`, `scripts/draft-occasions-sim.ts:291`) compares the lines after the
**last** `Best,` and so cannot see a duplicate above it.

**Fix.** Detect the sign-off *before* the em-dash rewrite, or run the rewrite only
on the body lines after the cut. Replace the 8-line window with "the last
non-blank block" (scan up from the end past lines that look like signature lines:
no sentence-ending punctuation, under ~60 chars). Widen `CLOSING` to
`^<word phrase>[,.!]?\s*(\p{Lu}[\w'’.-]*(\s+\p{Lu}[\w'’.-]*){0,3})?$` with the
comma optional and the name allowance raised to 4 words. A false positive here is
cheap (the closing is rebuilt anyway); a false negative ships a broken email.

---

### F7 — `SETS_THE_ASK` is a prefix list, so it drops prohibitions and keeps real second asks

**The flaw.** The filter is a regex over 15 literal line openings
(`draft-prompt.ts:514`). It has no category for "sets the opening" or "sets the
subject", and it matches by prefix, so a line that sets an ask in different words
survives.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/setsask.ts` scores
every `promptNote` of every type that can appear as a secondary box (12 types,
31 notes): **9 dropped, 22 kept**. `npx tsx scripts/audit-probe/logic3/alsotrue.ts`
then counts what survives into real prompts:

```
=== ALSO TRUE lines that set an ask: 30 occurrences, 2 distinct ===
    x24  Ask at most three questions, each answerable, in prose ("First, ... Second, ..."). ...
    x6   Ask for 10 minutes.
=== ALSO TRUE lines that set the subject line: 6 occurrences ===
    x6   Name the event in the subject line.
=== ALSO TRUE lines that set the opening: 12 occurrences ===
    x6   Open with the exact moment they met - the event, the day and the specific thing they talked about. Never vague.
    x6   Name the conference and the city in the first line.
```

The recruiter line (x24) is deliberate — `blendRules` forces the recruiter ask.
The other three are not. `npx tsx scripts/audit-probe/logic3/dump.ts 624` shows the
contradiction verbatim in one prompt: the lead block says

```
Ask for a 10-15 minute call, as the examples do.
...
Put the referrer's name in the subject line.
Lead with the referral in the very first sentence...
```

and nine lines later the `ALSO TRUE` block says

```
Name the conference and the city in the first line.
Ask for 10 minutes.
```

`^Ask for a ` does not match `Ask for 10 minutes.` — `a ` versus `10`.

**Over-dropping**, from the same probe. Three dropped lines are *prohibitions*,
not asks, and nothing in the lead replaces them:

- `keep_in_touch`: "Never ask for a referral: the goal is simply to stay on their
  radar." — dropped on `{stay.second, stay.update}` etc., where the lead's ask is a
  second conversation, so no rule against a referral ask remains;
- `close_loop_referrer`: "…Never ask for anything, including another
  introduction.";
- `congratulations`: "No ask of any kind, including 'let me know if you have
  time'."

**A fourth leak the filter never sees at all.** `fieldAnswers` are passed only on
the *lead's* call and are never filtered, yet several field `prompt`s embed format
directives. `dump.ts 613` shows the conference box's own field prompt landing
inside the lead block:

```
The specific thing they talked about - open the email with it: the grocery chain turnaround she worked on
```

That is a third, unfiltered opening instruction, in the most authoritative part of
the brief.

**Consequence.** On 6 prompts the model is told two different call lengths and two
different subject-line rules; on 12 it is told two different openings.
`blendRules` papers over it with "where they disagree with it about the opening,
the order or the ask, the structure above wins", which only works if the model
notices the disagreement.

**Fix.** Stop filtering by line prefix. Tag the lines structurally — give each
brief line a `sets: "ask" | "opening" | "subject" | "length" | null` and drop
secondary lines by tag — and tag `promptNotes` in `draft-templates.ts` the same
way. In the interim, add `opening`/`subject` alternatives to the regex, change
`^Ask for a ` to `^Ask for\b`, and move the three prohibitions out of
`promptNotes` into a `neverAsk` list that is never dropped. Strip format
directives out of field `prompt` strings so a field answer carries only the fact.

---

### F8 — the em-dash rewrite: a manufactured comma splice, an untouched en dash, and a subject that can become `","`

**The flaw.** `draft.body.replace(/\s*—+\s*/g, ", ")` (`:1072`) and the same
rewrite on the subject (`:1066`).

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/finish.ts`

| case | input | output |
|---|---|---|
| A | `…at Pinecrest this summer — it taught me…` | `…this summer, it taught me…` — a comma splice, the exact pattern `commaSplices` in `draft-lint.ts` flags and `guardRevision` rejects a *reviewer* for creating |
| B | `I worked there 2023–2025 and loved it – the team was great.` | `2023-2025` fixed; **`it – the team` left alone** |
| C | subject `—` | subject **`","`** |
| D | subject `— Duke student reaching out` | subject `", Duke student reaching out"` |

Case B is the sharp one: `(\d)\s*[—–]\s*(\d)` handles **both** dash characters, so
the author knew en dashes occur, yet the prose rewrite and the bullet rewrite
handle only `—`. An en dash reads identically to a reader and is the same AI tell
the house rules ban. `draftIssues` only tests `/—/`, so the simulation cannot see
it either.

**Consequence.** The product manufactures the grammatical error its own guard
rejects in the reviewer, and leaves half of the dash problem in place. Cases C/D
are cosmetic but ship a subject line beginning with a comma.

**Fix.** (a) Rewrite a dash between two sentence-like clauses to `". "` with the
following word capitalised, or to `" - "`, rather than to `", "` unconditionally;
at minimum run `commaSplices` over the rewritten body and, where the rewrite
created one, fall back to `" - "`. (b) Extend the prose and bullet rewrites to
`[—–]`. (c) `.replace(/^[\s,]+/, "")` on the subject after the rewrite, and treat
a subject of punctuation only as empty so the fallback fires.

---

### F9 — a date warning survives the review that deleted the date

**The flaw.** On an applied review edit the pipeline calls
`finishDraft(promptInput, { ...first, subject, body })` (`:337`). Spreading
`first` carries `first.notesForStudent` in as `out.notesForStudent`, which
`finishDraft` copies into the new draft before appending its own flags
(`:1049`). Line 338 then unions the two lists. A "Double-check …" note from the
pre-review body therefore survives even when the reviewed body no longer contains
that date.

The comment at `:364` — "Checked on the email that actually goes out, so a detail
the review already removed doesn't still produce a warning" — is true of
`draftChecks` and false of `finishDraft`'s date notes.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/stalenote.ts`

```
pre-review notes : ["Double-check \"October 17\" - that date wasn't in what you entered."]
post-review body : "Would a short call work in the next week or two?"
notes shipped    : ["Double-check \"October 17\" - that date wasn't in what you entered."]
STALE: the warning names a date that is no longer in the email.
```

**Consequence.** The student is told to check a date that is not in their email.
Low severity on its own; corrosive to the notes list, which is the only channel
the pipeline has for things the student must act on.

**Secondary (MEASURED, same probe family).** The date gate is asymmetric:
`given` is built from both `writtenDates` and `numericDateKeys` over the input,
but the draft is scanned with `writtenDates` only. `finish.ts` case K:

```
body : Would Thursday 10/16 work, or October 17?
notes: ["Double-check \"October 17\" - that date wasn't in what you entered."]
```

An invented `10/16` is never flagged. Students type dates that way (the comment at
`:1011` says so), so models write them that way too.

**Fix.** Pass the pre-review notes explicitly rather than through the spread —
`finishDraft(promptInput, { ...first, notesForStudent: [], subject, body })` — and
let line 338's union carry forward only the notes that are not date flags, or
recompute the date flags once on the final body. Add `numericDateKeys` to the
draft-side scan.

---

### F10 — the review sits outside every mechanism that watches a model call

Four consequences of the same structural choice, in the order they bite.

**(a) No fallback ladder (REASONED, code-traced).** `callWithFallback` wraps the
callback, and the callback is the whole pipeline (`generate-draft.ts:38`). The
review's own `try` (`draft-pipeline.ts:269-361`) swallows the error before it can
reach `isCapacityError`, so a Sonnet capacity spike never degrades the review to
Haiku — it cancels it. Confirmed MEASURED by `retrythrow.ts` case C
(`calls=2 error="overloaded" reviewMs=null`).

**(b) The catch does not discriminate retryable from permanent (MEASURED).**
`retrythrow.ts` case D feeds the review a 400:

```
D review 400 (our bug) : error="400 invalid_request_error: output_config.format is not valid"
                         -> draft still ships, same code path as a capacity blip
```

A permanently broken review request degrades *every* draft to unreviewed, forever,
and the only signal is a `console.error`.

**(c) `getModelConfig` is bypassed, so the capability guards never apply
(MEASURED + REASONED).** `DRAFT_REVIEW_CONFIG` is a literal
(`draft-pipeline.ts:26`) and `grep -rn "DRAFT_REVIEW_CONFIG" src` shows it is never
passed through `getModelConfig`, which is the only place `supportsEffort` and
`supportsAdaptiveThinking` are applied outside `ai-runner`. Today this is
harmless: the config names `claude-sonnet-5`, and the two
`MODELS_WITHOUT_*` sets contain only `claude-haiku-4-5`
(`model-registry.ts:229,240`). But Haiku is the obvious cost reduction for a
review pass, and it rejects **both** `effort` and `{ thinking: { type: "adaptive" } }`
with a 400 — which (b) swallows. The result would be a **silent, permanent review
outage with no test failing**: every pipeline test uses a fake client
(`scripts/draft-review-test.ts:132`) that accepts any request shape.

**(d) The review's tokens are billed under the draft model's name (REASONED,
code-traced).** `runDraftPipeline` adds the review's usage into the same `usage`
object (`:301-302`); `generate-draft.ts:39` returns that sum; `recordUsage` writes
it against `model`, the model from the **draft's** fallback walk
(`ai-runner.ts:291-297`). So one `ai_usage` row carries Opus-or-Sonnet draft tokens
plus Sonnet review tokens under a single model name, and `usedFallback` can never
reflect a review fallback. Any cost figure computed from that table is wrong by the
review's share at the wrong rate.

**On the `speed` claim.** `client.messages.parse` is called directly for the review
rather than through `parseWith`, so a `speed` on the review config would be
dropped — but `DRAFT_REVIEW_CONFIG` sets no `speed`, and `parseWith` is a no-op
unless `speed === "fast"` (`fast-mode.ts:33`). **The defect is latent, not live.**
It is still worth closing, because `supportsFastMode` contains only Opus
(`model-registry.ts:249`), so nothing would strip a `speed` wrongly set here either.

**Fix.** Route the review through the same machinery as everything else: give it
its own `AiFeature` entry in the registry (`draftReview`) resolved by
`getModelConfig`, call it with `parseWith`, and run it inside its own
`callWithFallback` so it degrades instead of vanishing. Split the catch on
`isCapacityError(err)` — degrade on capacity, re-throw or at minimum emit a
distinct `review_request_invalid` log on anything else. Meter it as its own
`ai_usage` row, or add a `reviewInputTokens`/`reviewOutputTokens` pair, so cost is
attributable.

---

### F11 — `combinedExamplesFor`: one combination loses examples that exist, and three stored examples are unreachable

**The flaw.** `fits` requires `e.boxes.includes(boxIds[0])` — the stored mix must
contain the *lead* box (`draft-prompt.ts:457`). A fully-checked stored mix that
does not contain the lead is discarded, and because `sections` is derived from the
examples that win, its playbook format goes with it.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/combined.ts`

```
Volume V: 18 sections, 42 examples; stored examples by mix size: 2:40  4:2; distinct stored mixes: 21
multi-box combinations: 61
  with >=1 combination example: 42        flagged "exactly this mix": 19        with NO example: 19

--- NO example although a fully-checked stored mix exists: 1
  [first.conference,first.pointed,first.alum] lead=first.conference  stored-but-unused mixes: first.alum+first.pointed

sections NEVER shown to any student:
  #15 Referral + Someone I Emailed Sent Me to Them
```

So the "silently gets no combination examples although one exists" set is
**exactly one** of 61 — the `{conference, pointed, alum}` student, who gets neither
section 14's format nor its two examples. The other 18 example-less combinations
have no stored mix at all; that is a corpus gap, not a logic bug.

**And dead corpus (MEASURED).** `npx tsx scripts/audit-probe/logic3/deadmix.ts`

```
DEAD s15 first.pointed+first.referred  err="…can't both be checked."
DEAD s16 first.alum+first.met+first.pointed+first.referred  err="…can't both be checked."
```

`first.referred` excludes `first.pointed`, so **3 of 42 stored examples (7 %) and
1 of 18 sections can never be shown to anyone**. Someone wrote a playbook section
for a combination the picker forbids.

**Consequence.** Small. One student in 61 combinations loses examples that exist;
7 % of the corpus is maintained for nothing, and nothing warns about either.

**Fix.** Relax the lead rule to "the largest fully-checked stored mix, preferring
one that contains the lead", so the `{conference, pointed, alum}` case picks up
section 14 instead of nothing. Separately, add a corpus test that every
`VOLUME_V.examples[].boxes` is a set `resolveSituation` accepts — it would have
caught section 15 the day it was written.

---

### F12 — the word ceiling only ever loosens, never tightens: up to +50 words over the lead's own

**The flaw.** `const ceiling = Math.max(...[input.type, ...alsoTypes].map(maxWords))`
(`:857`). By construction the ceiling is ≥ the lead's own, never below it.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/ceiling.ts`

```
multi-box combinations: 61
ceiling > the lead type's own maxWords in 40 of them
ceiling < the lead's own in 0
largest loosenings:
  +50  lead=recruiter_outreach (150) -> ceiling 200  [first.recruiter,first.alum]
  +50  lead=redirect_sequence (150) -> ceiling 200  [first.pointed,first.alum]
  +40  lead=close_loop_referrer (110) -> ceiling 150  [stay.referrer,stay.update]
```

**Consequence.** On **40 of 61** multi-box combinations the ceiling is looser than
the leading format's, by up to a third. `recruiter_outreach`'s whole character is
"shorter and more formal, skip the small talk"; checking "also an alum" buys it 50
extra words. The comment "A ceiling, not a target" is the mitigation, and
`draftIssues` grades against the same loosened number, so the slack is invisible to
the simulation.

**Fix.** Keep the stretch — facts from every box do need room — but bound it:
`min(max(maxWords), leadMaxWords + 25)`, or add one sentence to `blendRules`
naming the lead's own ceiling as the target and the mix ceiling as the hard stop.
Either way, grade the simulation against the lead's number so the slack shows up.

---

### F13 — `boxIds` is trusted as the checked set with no cross-check against `type`/`alsoTypes`

**The flaw.** `combinedExamplesFor`'s whole safety argument is the comment at
`:445`: "A stored mix with a box the student didn't check never counts — its
examples would carry a fact they never gave." The checked set is `boxIds`, and
`buildDraftPrompt` never checks `boxIds` against `type`/`alsoTypes`, nor that the
ids are real boxes.

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/tiers.ts`

```
3 unknown boxIds, single type -> COMBINATION FORMAT block present: true
boxIds that disagree with the type -> referral combination examples present: true
  ... inside a thank_you_chat prompt (lead type in the format block): EMAIL TYPE: THANK-YOU AFTER A COFFEE CHAT
```

Three nonsense ids inject the "Three or More Boxes at Once" playbook format into a
single-box prompt (`:481` tests only `boxIds.length >= 3`). And
`boxIds: ["first.alum", "first.referred"]` with `type: "thank_you_chat"` puts
referral combination examples into a coffee-chat prompt.

**Consequence.** Reachability depends on whether the route validates `boxIds` —
that is `draft-request.ts` / `src/app/api/drafts/`, both in flight and not read, so
I make no claim about live exploitability. What I can say is that
`buildDraftPrompt` provides no defence of its own, while `resolveSituation` exists
precisely because "the browser's choice is never trusted as-is"
(`draft-occasions.ts:549`).

**Fix.** Derive `boxIds` from the resolved `Situation` at the one place that
resolves it, or re-validate in `buildDraftPrompt`: drop ids `boxById` does not
know, and drop the whole combination block when the box set's `situationTypes` do
not match `[type, ...alsoTypes]`.

---

### F14 — `greetingInstruction` tells the model to write "Hi Team," and "Dear Dr. Amy,"

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/greeting.ts`

```
"team lead Rachel Stein"   Greeting: write "Hi Team," - the first name only, ...
"VP Rachel Stein"          Greeting: write "Hi Vp," - the first name only, ...
"Dr. Amy"                  Greeting: write "Dear Dr. Amy," - never their first name alone.
"Professor Amy"            Greeting: write "Dear Professor Amy," - never their first name alone.
```

**The flaw, two causes.**

1. `greetingName` takes `parts[0]` as the first name, so any leading job title
   becomes the greeting. It surfaces specifically when the title is all-caps or
   all-lowercase, because `fix()` then rewrites it and the
   `first !== name.split(/\s+/)[0]` test at `:333` fires. `TEAM_RECIPIENT`'s
   `team(?!\s+lead)` lookahead correctly declines to call "team lead Rachel Stein"
   an inbox — and then the fallback hands back "Hi Team," anyway.
2. The `restWords >= 2` guard at `:328` is applied only to `Dean`. For
   `Dr.`/`Professor`/`Prof` with a one-word remainder, `rest.last` is that single
   word, which is a first name as often as a surname — producing exactly the
   "their first name alone" the instruction forbids.

**Consequence.** An email that opens "Hi Team," to a person named Rachel Stein, or
"Dear Dr. Amy," to Dr. Amy Adams. This is the first line the recipient reads.

**Fix.** Apply the `restWords >= 2` guard to every title, not just `Dean`: with one
remaining word, fall through to the house default. Strip a known leading job title
(`VP|SVP|MD|Managing Director|Associate|Analyst|Director|Team Lead|Head of …`)
before `greetingName`, and when the remaining words are fewer than two, emit no
instruction rather than a guess.

---

### F15 — `STRENGTH` ranks 21 of 46 boxes; the other 25 tie, and the lead would fall to client-supplied order

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/strength.ts`

```
boxes total 46; in STRENGTH 21
boxes NOT in STRENGTH: follow.first, follow.final, follow.recruiter, follow.inbox, follow.quiet,
  follow.later, follow.interview, reply.*, ask.*, offers.*, custom.describe   (25 ids)
STRENGTH ids that are not boxes: (none)

multi-box combos whose LEAD changes when the id order is reversed: 0
combos (3+ boxes) whose ALSO order changes on reversal: 0
```

**Why it is safe today, and only today.** `rank()` returns `STRENGTH.length` for
any unranked id, so all 25 tie, and `Array.prototype.sort` is stable — ties resolve
to the order of `boxIds`, which came from the browser. It is harmless because every
unranked box lives in a `mode: "one"` section (MEASURED,
`npx tsx scripts/audit-probe/logic3/sections.ts`: only `first_contact`, `thanks`
and `stay` have `any` sections, and all of their boxes are ranked), so no two of
them can be checked together.

**Consequence.** Zero today. The day someone adds a second `any` section to
`follow_up`, `reply`, `ask` or `offers`, the lead type — which chooses the format,
the examples and the ask — becomes a function of the order the client posted the
checkboxes, with no error and no test failure.

**Fix.** Make the omission loud: a module-level assertion (or a line in
`scripts/draft-occasions-test.ts`) that every box id in an `any` section appears in
`STRENGTH`. One line, and it turns a future silent bug into a failing test.

---

### F16 — a `QUESTION_MERGES` entry no-ops in 6 of its 13 firings, silently

**Reproduction (MEASURED).** `npx tsx scripts/audit-probe/logic3/questions.ts`

```
combinations: 107
duplicate question names: 0        alias pairs both asked: 0
combinations where a QUESTION_MERGE applies: 13        where TWO merges apply: 0

merge whereMet<-howFound fired but whereMet is NOT asked in [first.met,first.recruiter,first.not_alum]
  ... 6 such combinations
```

**The flaw.** In those 6, `whereMet` was already suppressed as an alias of
`metAt`/`conferenceName` (the connection box's own question is asked first) and
`howFound` was suppressed by `connected && FOUND_QUESTIONS`. So `!keep` holds, the
loop `continue`s, and the merge's carefully written wording — "Where you met this
recruiter, or how you found them … say it honestly", the only place the not-alum
honesty requirement is phrased for a recruiter — never appears. The student is
asked "Where and when they met" instead, which is a reasonable substitute; the
severity is in the silence, not the outcome.

**Consequence.** 46 % of merge firings do nothing, and `continue` makes that
indistinguishable from "did not apply". The two other merges
(`whyNow<-nextForYou`, `nextForYou<-ownNews`) would collide if ever reachable
together — merge 1 removes `nextForYou`, which is merge 2's `keep`, so merge 2
would silently no-op too. Today unreachable: `stay.congrats` excludes
`stay.second`, so `{second, referrer, congrats}` is invalid (MEASURED, the
`TWO MERGES` count is 0).

**Fix.** Log or throw when a merge's boxes are both checked but `keep`/`drop` are
not both present, so the dead entry is visible. Order-independence would also help:
resolve all merges against the pre-merge name set before splicing.

---

### F17 — what is not observable, and the one line that fixes most of it

**Observable from the existing log line** (`draft-pipeline.ts:387`), by outcome
string: `review off`, `review applied`, `review rejected (<reason>)`,
`review not applied (<error>)`; and `review -` versus `review Nms` distinguishes
"never reached a request" from "ran". Credit where due: *whether* the review ran is
loggable today.

**Not observable:**

1. **Retry skipped for the clock, as a field.** Nothing on `PipelineTimings` or
   `PipelineResult.review` records it. `reviewRetryMs: null` means both "the guard
   accepted first time" and "the window had closed" — its own doc comment says
   "Null when there wasn't one", which conflates the two. The eval harness has a
   `reviewRetrySkippedForTime` counter (`HARNESS.md:118`); the product has nothing.
   It is *inferable* from the log by the absence of a `retry Nms` token next to a
   `review rejected` outcome, which means it can only be recovered by parsing for a
   token that is not there — no archive row, no metric. MEASURED:
   `retrythrow.ts` case E prints `reviewRetryMs=null` with a `review rejected`
   outcome.
2. **How often the review silently does not run, as a rate.** Each occurrence logs,
   but `review.error` is free text — the SDK's message for a capacity error, our
   own message for a 400, `skipped: drafting took Nms` for the time gate. Nothing
   classifies them, so "what fraction of drafts shipped unreviewed last week, and
   why" is not answerable without regexing over free-text log lines.
3. **Problems the review found but a throwing retry discarded.** MEASURED, F3: the
   log prints `0 problems` for a turn that found 2.
4. **The review's cost.** F10(d): its tokens are summed into the draft row under
   the draft model's name.
5. **Time spent in a draft fallback attempt.** F4(3): `started` resets, so the
   pipeline's own `totalMs` understates the request's real age.

**The one line.** Add a classified reason to the outcome the pipeline already
returns, and log it:

```ts
// in ReviewOutcome
/** Why the review produced nothing, as a fixed value: skipped_for_time | retry_skipped_for_time | capacity | request_invalid | stopped. */
reviewGap?: "skipped_for_time" | "retry_skipped_for_time" | "capacity" | "request_invalid" | "stopped";
```

set it at the four sites that currently write `error`/`rejected` (the skip gate at
`:262`, the retry gate at `:315`, the `!out || !guard` branch at `:332`, and the
catch at `:357`, splitting that one on `isCapacityError`), and append
`· gap=${review.reviewGap ?? "-"}` to the `console.info`. That single enumerated
field makes items 1–3 countable from the log and recordable in the archive, which
is what every remaining question in this section needs.

---

## Cleared

Checked, and sound.

- **The tier split keeps its invariants (MEASURED,
  `npx tsx scripts/audit-probe/logic3/tiers.ts`).** Across **135** prompts — every
  one of the 41 types as a single box, all 87 `sims()` situations, and 7 hostile
  shapes — `invariant` has **1 distinct value**, `perType` **53** (matching the
  documented count), `perRequest` **105**; byte-identity
  `invariant + perType + perRequest === system` holds **135/135**; and **no tier is
  ever empty or whitespace-only**, so `cachedTiers`' `filter(length > 0)` never has
  work to do. The hostile shapes — `custom` with no boxes, with `boxIds: []`, with
  unknown ids, `alsoTypes` containing the lead itself, and all 40 other types as
  `alsoTypes` at once — all build without throwing. I could not break it.
- **`cold_email` never leads a multi-box situation (MEASURED):** 1 of 107
  combinations, 0 multi-box. Structural, not accidental — `first.not_alum` is the
  only lower-ranked box and it excludes `first.alum`.
- **`resolveSituation`'s validation is complete for its contract (MEASURED,
  `enumerate.ts`):** unknown ids filtered, empty set rejected, `mode: "one"`
  enforced, exclusions checked symmetrically in both directions, `presets` merged
  weakest-first so the strongest box wins, and the result is deterministic under
  input reordering (0 lead flips, 0 `also` reorderings across all 61 multi-box
  combinations). The ranking *mechanism* is right; F15 is about its coverage.
- **Question de-duplication works (MEASURED, `questions.ts`):** across all 107
  combinations, **0** duplicate question names and **0** alias pairs both asked.
  `ASK_QUESTIONS` correctly restricts the ask question to the lead box, and
  `FOUND_QUESTIONS` is correctly suppressed when a connection box is checked.
- **`finishDraft`'s `//n` unescape is correctly scoped (MEASURED, `finish.ts` case
  J plus the committed assertion at `draft-review-test.ts:277`):** it becomes a
  paragraph break, and the `(?<!:)` guard keeps `https://nyu.edu/news` intact.
- **The digit-range rule is right (MEASURED, `finish.ts` case B):** `2023–2025`
  becomes `2023-2025` and not a comma, and it handles both dash characters. F8 is
  that the *prose* rule does not.
- **Running `finishDraft` twice is idempotent in its mechanics:** the thread-subject
  override, the em-dash rewrite and the signature rebuild all converge on a second
  application. (REASONED; F9 is about the notes carried between the two calls, not
  the body.)
- **The em-dash rewrite's position before the sign-off scan sometimes helps:** a
  model that writes `Best — Maya` becomes `Best, Maya` and is correctly cut, where
  the unrewritten line would not have matched (MEASURED, `finish3.ts`). F6-C is the
  same mechanism going the other way.
- **The retry's correction message is well-formed and the happy paths are right
  (MEASURED, `retrythrow.ts` case A and `draft-review-test.ts:172-183`):** the
  rejected edit is pushed back as an assistant turn with the guard's reason, exactly
  one retry is attempted, a passing retry replaces the draft, and a failing one
  keeps the unedited draft **with the first turn's problems intact**. F3 is only the
  throwing case.
- **Usage accumulation across both calls is correct (MEASURED,
  `retrythrow.ts`):** 3,000/600 for draft + review + retry, 2,000/400 when the
  retry throws before its usage is added — a failed call is not billed. F10(d) is
  about attribution, not arithmetic.
- **The review sees the same resume PDF as the drafter**, and both system prompts
  carry `cache_control` (committed assertions, `draft-review-test.ts:286-289`).
- **`classYearLabel` is correct at the August rollover (MEASURED, `greeting.ts`):**
  at 2026-09-20 the academic year ends 2027, so 2027→senior … 2030→freshman, and
  `null` outside a four-year track and after June of the graduation year; at
  2026-05-20 the window shifts correctly to 2026→senior … 2029→freshman.
- **`isGraduateStudent` reads only the resume's EDUCATION block (MEASURED,
  `greeting.ts`):** `"EDUCATION\n- Ravensworth · MBA 2027"` → `true`, while
  `"WORK EXPERIENCE\n- Advisor · MBA program office"` → `false`. The `(?<!pre-)`
  guard works (`"Pre-MBA track"` → `false`). One oddity worth a look rather than a
  finding: the `(?<!\/)` guard makes `"Economics/MBA"` → `false`, so a student who
  types their dual degree that way is signed as an undergraduate.
- **`signatureLines` (MEASURED, `greeting.ts`):** undergraduate
  `["Maya Okafor","Duke University ’29"]`; MBA
  `["Maya Okafor","Ravensworth","MBA Class of 2027"]`; the school line is omitted
  with no school and the name with no name. The one soft edge is that `programLine`
  names the programme only when `/\bMBA\b/` matches, so an MSF student signs a bare
  `Class of 2027`.

---

## Prioritised improvements

| # | Change | Finding | Cost | Why it is this high |
|---|---|---|---|---|
| 1 | Key `briefLines`' cold `case` on `type.isCold` | F1 | 1 line | 12 of 107 combinations currently discard three answers the student typed and the email's stated purpose |
| 2 | Isolate the retry in its own `catch` | F3 | 3 lines | A transient error on call two is currently worse than never retrying |
| 3 | One budget for both time gates; gate the retry on *remaining* time | F2 | ~10 lines | Closes a 30 s band (37.5 % of the admissible range) where the rescue that MEASURE-1 shows works 15/19 times can never fire |
| 4 | Add the enumerated `reviewGap` field and log it | F17 | ~8 lines | Without it, items 3 and 5 below cannot be prioritised with evidence instead of argument |
| 5 | Explicit `timeout`/`maxRetries` on the review call; thread an absolute deadline instead of per-invocation `started` | F4 | ~10 lines | The only remaining way the student gets *nothing*, and the one the skip gate was built to prevent |
| 6 | Fix the sign-off scan: detect before the em-dash rewrite, replace the 8-line window, widen `CLOSING` | F6 | ~15 lines | 14 of 23 plausible closings ship two sign-offs; one case deletes the body |
| 7 | Pass the resolved redirect step to secondary `briefLines`; make an empty `extra` loud | F5 | ~5 lines | 14 of 61 multi-box prompts silently ignore a checked box |
| 8 | `^Ask for\b`, add opening/subject alternatives, move prohibitions out of `promptNotes` | F7 | ~10 lines | Removes the 6 double-ask and 12 double-opening prompts cheaply, before the structural fix |
| 9 | Clear pre-review notes on the second `finishDraft`; scan the draft for numeric dates too | F9 | 2 lines | Stops warning the student about a date the review already removed |
| 10 | Assert every `any`-section box is in `STRENGTH`; assert every Volume V mix resolves | F15, F11 | 2 lines each | Converts two future silent bugs into failing tests; the second would have caught the 3 dead examples |
| 11 | Register the review as its own `AiFeature`, call it via `parseWith` inside its own `callWithFallback`, split the catch on `isCapacityError`, meter it separately | F10 | ~40 lines | Fixes the missing ladder, the swallowed 400, the `getModelConfig` bypass and the cost mis-attribution in one move |
| 12 | Apply the `restWords >= 2` guard to every title; strip leading job titles | F14 | ~5 lines | The greeting is the first line the recipient reads |
| 13 | Tag brief lines structurally (`sets: "ask" \| "opening" \| …`) and drop by tag; strip format directives out of field `prompt`s | F7 | ~1 day | The real fix for the filter, and for the unfiltered `fieldAnswers` leak |
| 14 | Bound the mix ceiling (`leadMax + 25`); grade the simulation against the lead's number | F12 | ~5 lines | 40 of 61 combinations currently loosen the lead's ceiling, by up to a third |
| 15 | Derive `boxIds` from the resolved `Situation`, or re-validate it in `buildDraftPrompt` | F13 | ~5 lines | `combinedExamplesFor`'s safety argument currently rests on an unchecked input |
| 16 | Relax `combinedExamplesFor`'s lead rule to "prefer, not require" | F11 | ~3 lines | One combination recovers examples that already exist |
| 17 | Log a no-op `QUESTION_MERGE` instead of `continue` | F16 | 2 lines | 46 % of merge firings do nothing and say nothing |
