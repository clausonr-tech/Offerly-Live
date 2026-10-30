# FIX-FORM — the draft form's question routing

Fixes for the defects INPUT-1 (#1–#7) and LOGIC-3 (F5, F11, F13, F15, F16)
found in the FORM → SITUATION → BRIEF path. Branch `perf/draft-pipeline`, in
the worktree `.claude/worktrees/draft-pipeline-perf`.

**Files changed: two.** `src/lib/draft-occasions.ts` and
`scripts/draft-occasions-test.ts`. Four other fixers were live in the same tree
on `draft-review.ts`/`draft-lint.ts`, `draft-prompt.ts`/`draft-templates.ts`,
`draft-pipeline.ts`/`draft-request.ts`/`actions.ts` and
`content-limits.ts`/validation; nothing of theirs was touched. Everything that
needs one of their files is in §3, with the patch spelled out.

`draft-occasions.ts` is pure, so every number below comes from enumerating all
**107** valid combinations rather than sampling. Each fix was taken red → green
→ red → green: the assertion added first and seen to fail, the fix applied and
seen to pass, the fix reverted and the same failure seen again, the fix
restored.

---

## 0. The gate was not a gate

`scripts/draft-occasions-test.ts` printed `0 failures` or `N failures:` and
**exited 0 either way** — the only one of the draft test scripts without an
exit-code line. Every "occasions: 0 failures" ever cited for it was a string on
screen, not a passing gate.

Fixed first, with the pattern `draft-review-test.ts` uses:

```ts
if (failures.length) {
  console.log(`\n${failures.length} failures:`);
  for (const f of failures.slice(0, 60)) console.log(`  ${f}`);
  // Printing the count is not a gate: without this the script exited 0 with
  // failures on screen, so every caller read it as green.
  process.exitCode = 1;
}
```

Proof it can now fail (fix 1 reverted, nothing else changed):

```
--- proof it can now fail: revert fix 1 only ---
exit: 1
exit restored: 0
```

**What was concealed: nothing.** At the moment the exit code was added the tree
was green — `exit with current tree: 0`. The `5 failures` and `2 failures`
prints the overseer saw were the deliberate RED halves of the red-green cycles
below; each is quoted in §1 beside the GREEN that followed it. Every count in
this document was re-measured after the exit code existed.

**Same hole, not mine to fix:** `scripts/draft-bug-hunt.ts` prints
`147/147 passed, 0 failed` and also sets no exit code (`grep -c process.exit` →
`0`). Reported, not changed.

---

## 1. Fixed here

### #1 — `QUESTION_MERGES` defeated by a third box (INPUT-1 #1 HIGH, LOGIC-3 F16)

**Reproduction.** The merge loop ran *after* alias de-duplication, so when its
`drop` question had already been removed as an alias of something else,
`dropAt < 0` and the whole merge was skipped — the merged wording lost with it.

```
first_contact {first.not_alum, first.recruiter, first.referred}: merge whereMet<-howFound fired but "whereMet" is still worded "Where you met this recruiter, and what you talked about"
first_contact {first.not_alum, first.recruiter, first.pointed}:  merge whereMet<-howFound fired but "whereMet" is still worded "Where you met this recruiter, and what you talked about"
stay {stay.update, stay.congrats, stay.referrer}: merge nextForYou<-ownNews fired but "nextForYou" is still worded "What happens next for you"
stay {stay.update, stay.congrats, stay.referrer}: merge nextForYou<-ownNews fired but "updateSince" is still asked beside it
```

The two reports' figures reconcile to **9 of 13 eligible firings doing
nothing** (INPUT-1's number; LOGIC-3's "6 of 13" counted only the subset where
`keep` was not asked at all), measured on the pre-fix code:

```
=== PRE-FIX ===
eligible firings: 13; merged wording applied: 4; no-op: 9
=== POST-FIX ===
eligible firings: 13; merged wording applied: 7; no-op: 6
```

**Fix.** `situationQuestions`' merge loop now resolves `drop` through its alias
group as well as by its own name, and a merge whose `drop` was never asked
still rewords its `keep`:

```ts
const keepAt = out.findIndex((q) => q.name === m.keep);
if (keepAt < 0) continue;
const dropNames = [m.drop, ...aliasesOf(m.drop)];
const dropAt = out.findIndex((q, i) => i !== keepAt && dropNames.includes(q.name));
if (dropAt >= 0) out[keepAt].required = out[keepAt].required || out[dropAt].required;
Object.assign(out[keepAt], m.text);
if (dropAt >= 0) out.splice(dropAt, 1);
```

`keep` is deliberately **not** alias-resolved. The 6 remaining no-ops are all
`whereMet<-howFound` in combinations where a connection box asks its own alias
(`metAt`, `conferenceName`) instead: the student did meet in person or at a
conference, so "or how you found them" would be the dishonest wording there.
Those are now classified and asserted as substitutes rather than left silent —
a merge that does neither fails the test.

The worst case is gone. `stay[stay.update+stay.congrats+stay.referrer]` no
longer asks both "What happens next for you" and "Your own news since you last
spoke": it asks the merged "Your own news, or what happens next for you" once,
and the questions-per-combination distribution moves `10:1 → 9:1`.
`first_contact[first.not_alum+first.recruiter+first.referred]` no longer tells a
student who was *referred* that the question is "Where you met this recruiter".

**Red-green.** RED the four lines above (exit 1) → GREEN `0 failures` → the
merge loop reverted, the same four lines again (exit 1) → restored, `0
failures`. The new assertion also forced a second, correct change: the
test's required-coverage skip now recognises a merge drop matched through an
alias, or `required "keep_in_touch.updateSince" never asked` fires 5×.

**Both reports agree after the fix**, from the test's own output:

```
merge whyNow<-nextForYou:  2 eligible firings, 2 apply the merged wording, 0 superseded by a connection box's own alias of "keep"
merge nextForYou<-ownNews: 2 eligible firings, 2 apply the merged wording, 0 superseded by a connection box's own alias of "keep"
merge whereMet<-howFound:  9 eligible firings, 3 apply the merged wording, 6 superseded by a connection box's own alias of "keep"
```

### #2 — one alias group, required under three names and optional under a fourth (INPUT-1 #2)

**Reproduction.**

```
thanks {thanks.chat}:      no required question at all: the student can submit every field blank
thanks {thanks.interview}: no required question at all: the student can submit every field blank
```

**Fix, and which way.** `conversationDetails` (CHAT_BRIEF and INTERVIEW_BRIEF)
is now `required: true`, matching `conversationDetail` / `remarkPoint` /
`recruiterExplained`. The other direction — dropping `required` from those
three — would mean a thank-you after a talk, a session or an offer of help need
not name the one specific detail the playbook builds the email on, and those
three fields live in `draft-templates.ts`, which is not mine. Tightening the
shared question is the direction that makes the requirement depend on the email
instead of on how many boxes were ticked.

Required-per-combination moves `{0:4, 1:20, …}` → `{0:2, 1:22, …}`. The two
combinations still asking nothing are allowlisted with reasons: a plain alum
cold email (every fact optional by design) and `custom` (whose single `purpose`
box the server checks on its own).

**Caveat, and it is #3's:** the flag is enforced in the browser today but *not*
on the server, because `runGenerateDraft` skips promptless questions before it
looks at `required`. See §3.1 — one line in `draft-request.ts` closes it.

**Red-green.** RED the two lines above → GREEN → `required: true` removed, the
same two lines → restored, green.

### #3 — the required check sits below the prompt check (INPUT-1 #6)

**The fix is in `draft-request.ts`, not mine.** §3.1 has the patch. What
belongs here is the latent-bug prevention the item asks for, so the invariant
stops being undocumented: the set of required-but-promptless questions is now
pinned with a reason each, and a new one fails the test instead of being
silently unenforced.

```ts
const REQUIRED_NO_PROMPT: Record<string, string> = {
  originalSubject: 'bespoke check in draft-request.ts: "Add the subject line of the email this replies to."',
  conversationDetails: "NOT ENFORCED on the server yet - needs the required check moved above `if (!q.prompt) continue`",
};
```

**Red-green** (entry removed, i.e. simulating a new required brief question):

```
1 failures:
  required: "conversationDetails" is required but has no prompt, so the server cannot enforce it - add a reason to REQUIRED_NO_PROMPT or give it a prompt
```

### #4 — `questionText` rewording the label but not the prompt (INPUT-1 #3)

**Reproduction**, from the new data lint over every box:

```
2 failures:
  stay.referrer.questionText.updateSince: rewords the label for the student but not the prompt for the model
  stay.second.questionText.updateSince:   rewords the label for the student but not the prompt for the model
```

**Fix.** Both now carry the matching `prompt`:

- `stay.referrer` → `"The student's own news since they last spoke to the referrer - separate from how the introduction went and from the advice they acted on"`
- `stay.second` → `"The student's own news since they last spoke - separate from what they did with the recipient's advice"`

The lint is the general rule, not the two cases: any future `questionText`
entry that sets `label` without `prompt` fails.

**Red-green.** RED the two lines → GREEN → prompts removed, the same two lines
→ restored, green.

### #5 — one answer reaching the model twice (INPUT-1 #4) — my half

**Reproduction**, all 107 combinations plus the real `buildDraftPrompt`:

```
7 failures:
  thanks {thanks.helped}:                  brief "conversationDetails" re-sends "conversationDetail" (ANSWER_conversationDetail), which the model already gets as "A specific thing from the conversation"
  thanks {thanks.chat, thanks.helped}:     brief "conversationDetails" re-sends "conversationDetail" …
  thanks {thanks.event}:                   brief "conversationDetails" re-sends "remarkPoint" …
  thanks {thanks.helped, thanks.event}:    brief "conversationDetails" re-sends "conversationDetail" …
  thanks {thanks.session}:                 brief "conversationDetails" re-sends "recruiterExplained" …
  thanks {thanks.helped, thanks.session}:  brief "conversationDetails" re-sends "conversationDetail" …
  thanks.chat+thanks.helped: one typed answer reaches the model 2x:
    A specific thing from the conversation: ANSWER_conversationDetail
    What was discussed or learned: ANSWER_conversationDetail
```

6 brief slots, and the one combination where both framings reach the prompt as
real lines — exactly INPUT-1's measurement.

**Fix here.** A new `briefAnswerFor(name, questions, valueOf)` in
`draft-occasions.ts`: like `answerFor`, except it ignores the alias names that
are themselves prompted questions on this situation, because their answer
already reaches the model under its own prompt through `fieldAnswers`.
`answerFor` is unchanged — walking the whole group is correct where it reads a
*type field*.

**The assignment is in `draft-request.ts` and is not mine.** §3.2 has the
two-line change that wires it up. Until then the duplication is live in the
product; the enumeration and the double-prompt-line assertion are in place and
will hold it closed the moment that line lands.

**Red-green.** The assertions above are the RED taken with `answerFor` in place
of `briefAnswerFor`; with `briefAnswerFor` they pass, and the test prints
`6 brief slots where answerFor would re-send a prompted answer, 0 left by
briefAnswerFor`.

### #7 — foreign box ids silently discarded (INPUT-1 #5)

**Decision: error, not a silent drop.** The form cannot produce a mixed set —
`GenerateForm.tsx`'s occasion `onChange` does `setChosenBoxes(null)`, so the
boxes are refilled from `autoFill` for the new occasion — and every in-app
caller passes ids from the occasion it resolved. So the only sender is a stale
or tampered post, and that is precisely the case where quietly building an email
from fewer boxes than were ticked is worse than refusing. `resolveSituation`'s
own contract is "the browser's choice is never trusted as-is"; trusting part of
it and dropping the rest without a word was the one thing it should not do.

```ts
const ids = [...new Set(boxIds)];
if (ids.some((id) => !inOccasion.has(id))) {
  return { error: `Those boxes don't go with "${occasion.label}". Check the boxes again.` };
}
```

It still fails safe — no other occasion's type can be smuggled in — and the
message is student-readable. **Valid combinations are unchanged at 107**: every
valid set is in-occasion by construction. What changes is the message for
garbage input: ids from another occasion, unknown ids, whitespace-padded ids and
`__proto__` now produce `Those boxes don't go with "…"` instead of
`Check at least one box that describes the situation.` A duplicate of a real box
is still de-duplicated, not refused.

**Red-green.**

```
3 failures:
  foreign ids: another occasion's boxes beside a real one: accepted as lead=first.alum also=[]
  foreign ids: an id that is no box at all: accepted as lead=first.alum also=[]
  foreign ids: a prototype key: accepted as lead=first.alum also=[]
```

→ GREEN with `107 valid situations checked` → filter restored, the same three
lines → fix restored, green.

### #9 — 25 of 46 boxes unranked in `STRENGTH` (LOGIC-3 F15)

**Decision: assert, do not rank.** Ranking the other 25 would invent an order
with no basis in the playbook and no observable effect (they all sit in
`mode: "one"` sections and can never be weighed against a sibling), which hides
the decision rather than making it. The assertion forces whoever adds a second
`mode: "any"` section to rank the box then and there:

```ts
for (const section of occasion.sections) {
  if (section.mode !== "any") continue;
  for (const box of section.boxes) {
    if (!STRENGTH.includes(box.id)) fail(…, `"${box.id}" can be checked beside another box but isn't in STRENGTH, so which one leads would come from the browser's post order`);
  }
}
for (const id of STRENGTH) if (!boxById(id)) fail("STRENGTH", `"${id}" is not a box`);
```

`STRENGTH` is now exported (it was module-private) with a comment saying why
only `mode: "any"` boxes need a rank.

**Red-green** (`thanks.chat` removed from `STRENGTH`):

```
1 failures:
  thanks / What are you thanking them for?: "thanks.chat" can be checked beside another box but isn't in STRENGTH, so which one leads would come from the browser's post order
exit: 1
```

---

## 2. Held closed here, fixed elsewhere

Both of these have their cause in `draft-prompt.ts`, and both were re-measured
at `d7a30a7`, after that fixer's own changes landed: unchanged. Each is pinned
**one-directionally** — growth fails, shrinking passes — so the prompt fixer's
change drives the count to zero without breaking this test. When it lands, the
ceilings here should be lowered to match.

### #6 — a checked box that contributes nothing (LOGIC-3 F5)

Confirmed unchanged at **14 of 61** multi-box prompts, every one of them
`redirect_sequence` as a secondary box. The test now builds the real prompt for
every multi-box combination (reusing `sims()`, the product's own simulation
inputs) and fails if any *other* type goes silent, or if the count grows:

```
14 checked boxes contribute no ALSO TRUE block (all redirect_sequence; draft-prompt.ts owns the fix, ceiling 14)
```

**Red-green** (the allowlisted type changed, so `redirect_sequence` is no longer
excused): 14 failures, one per occurrence, exit 1 —

```
14 failures:
  635 [first.met,first.pointed]: checked box's type "redirect_sequence" puts nothing in the prompt at all
  636 [first.alum,first.met,first.pointed]: checked box's type "redirect_sequence" puts nothing in the prompt at all
  …
```

The fix needs §3.3 **and** §3.4 together: passing the step through is not
enough on its own, because the note it selects is then dropped by the
`SETS_THE_ASK` filter.

### #8 — combination examples unreachable (LOGIC-3 F11)

```
playbook sections no student can ever be shown: #15
1 combinations lose combination examples the corpus holds (draft-prompt.ts owns the fix, ceiling 1): [first.conference,first.pointed,first.alum] lead=first.conference unused mix: first.alum+first.pointed
42 combination examples checked (3 for boxes that can't be checked together)
```

Both of LOGIC-3's figures reproduce exactly: 3 of 42 stored examples dead, and
one combination of 61 losing examples the corpus holds.

**Why the dead examples are dead, and why they stay.** `first.referred`
("Someone I know suggested them") excludes `first.pointed` ("Someone I emailed
sent me to them") on purpose — the box comment says two people who each
connected the student is one too many for the form to ask about clearly — so
sections 15 and 16's four-box mixes can never be checked. **Nothing was deleted
from the example files**; the corpus is another fixer's territory, and relaxing
the exclusion is a product decision that would move the 107 (see §4). What is
held here is the count and the unreachable-section list, so a *new* example
written for an impossible mix fails instead of being maintained for nothing.

Section 16's own examples are dead too, but its *format* still reaches every
three-box student through `combinedExamplesBlock`'s "Three or More" rule, so #15
is the only section no student ever sees — computed, not assumed.

**Red-green**, each pin loosened by one:

```
UNREACHABLE_SECTIONS = []  -> section #15 ("Referral + Someone I Emailed Sent Me to Them") can never be shown to anyone
EXAMPLES_LOST_MAX = 0      -> 1 combinations lose examples the corpus holds, up from 0: [first.conference,first.pointed,first.alum] …
DEAD_EXAMPLES = 2          -> 3 examples are written for boxes that can't be checked together, up from 2
```

---

## 3. Hand-offs — patches for files I do not own

Every claim below was re-verified at `d7a30a7`, after the other fixers'
commits landed; line numbers are from that commit.

### 3.1 `draft-request.ts` — move the required check above the prompt check (INPUT-1 #6)

At `draft-request.ts:318` (as of `d7a30a7`), `if (!q.prompt) continue;` precedes
the required check, so a required question with no prompt can never raise the generic error.

```ts
// before
for (const q of situationQuestions(...)) {
  if (!q.prompt) continue;
  const raw = answerFor(q.name, field);
  if (!raw) {
    if (q.required) return { error: `Add "${q.label}" to draft this email.` };
    continue;
  }

// after
for (const q of situationQuestions(...)) {
  const raw = answerFor(q.name, field);
  if (!raw && q.required) return { error: `Add "${q.label}" to draft this email.` };
  if (!q.prompt || !raw) continue;
```

**This is now load-bearing, not hypothetical.** `conversationDetails` is
`required: true` as of #2 and has no prompt, so until this lands a thank-you
after a coffee chat or an interview is enforced only in the browser. With it,
`thanks[thanks.chat]` and `thanks[thanks.interview]` get
`Add "What did you learn or enjoy?" to draft this email.` /
`Add "Something specific they said" to draft this email.` — the student's own
label, which is what every other required field does.

The bespoke branch at `:383` (`if (isFollowUp && !brief.originalSubject)`) then
becomes redundant for the on-screen case and can be narrowed to the
`useOfferlyOriginal` path, where the field is hidden and the generic error would
name something the student cannot see.

### 3.2 `draft-request.ts` — stop the brief slot re-sending a prompted answer (INPUT-1 #4)

`briefAnswerFor` is exported from `draft-occasions.ts` and tested over all 107
combinations; it needs two lines here. The questions are already computed in
this function — keep them in a variable and move the `brief` literal (or just
that one field) below the `if ("error" in situation)` guard:

```ts
const questions = situationQuestions(situation, (name) => situation.presets[name] ?? field(name));
// …
conversationDetails: briefAnswerFor("conversationDetails", questions, field),
```

Measured effect: 6 brief slots stop duplicating, and
`thanks[thanks.chat+thanks.helped]` stops sending one typed answer as two prompt
lines ("A specific thing from the conversation" and "What was discussed or
learned").

### 3.3 `draft-prompt.ts:1006` — pass the step through to the secondary call (LOGIC-3 F5)

`fieldAnswers` is blanked wholesale, so `redirect_sequence`'s `redirectStep`
cannot be resolved and the per-step filter at `:736` is skipped. Blanking is
unnecessary: `b.fieldAnswers` is read in the non-shared path **only** for the
step lookup; the fact lines are behind `if (mode.shared)`.

```ts
// before
const extra = briefLines(t, { ...(input.brief ?? {}), fieldAnswers: [] }, ctx, { shared: false, attach })
// after
const extra = briefLines(t, input.brief ?? {}, ctx, { shared: false, attach })
```

### 3.4 `draft-prompt.ts:591` — drop the three step prefixes from `SETS_THE_ASK` (LOGIC-3 F5)

§3.3 alone does not fix it. `SETS_THE_ASK_RULES`' last entry,
`"^(Thanking the first person|Emailing the new person|Closing the loop):"`,
matches all three step notes, so the one the per-step filter selects is removed
by the filter on the next line immediately afterwards. Once the step resolves, exactly one of
the three survives the per-step filter and it is that box's own rule, not a
second ask — so those three prefixes should come out of `SETS_THE_ASK`. With
both changes the count in §2 goes to 0; the test's `SILENT_SECONDARY_MAX` can
then be dropped to 0.

### 3.5 `draft-prompt.ts:494` — relax `combinedExamplesFor`'s lead rule (LOGIC-3 F11)

`fits` requires `e.boxes.includes(boxIds[0])`, so a fully-checked stored mix
that does not contain the lead is discarded along with its playbook format.
LOGIC-3's suggestion stands: "the largest fully-checked stored mix, preferring
one that contains the lead". That gives
`first_contact[first.conference+first.pointed+first.alum]` section 14's format
and its two examples instead of nothing. The test's `EXAMPLES_LOST_MAX` can then
be dropped to 0.

### 3.6 `draft-bug-hunt.ts` — no exit code

Prints `147/147 passed, 0 failed` and exits 0 whatever the result, the same hole
§0 fixed in this file. One line, same pattern.

### 3.7 LOGIC-3 F13 — `boxIds` is trusted with no cross-check

Out of scope for these two files and left to whoever owns `buildDraftPrompt`,
but worth recording that **the picker's half of the defence is now stronger**:
after #7, `resolveSituation` refuses an id that is not a box of the occasion, so
a `boxIds` array *derived from the resolved `Situation`* can no longer contain a
foreign or nonsense id. F13's recommended fix — derive `boxIds` from the
`Situation` at the one place that resolves it — is now sufficient on its own,
without a second validation pass inside `buildDraftPrompt`.

---

## 4. Declined, with reasons

- **Making sections 15 and 16 reachable by dropping the
  `first.referred` ⇄ `first.pointed` exclusion.** It would change validation and
  move the 107, and the exclusion is deliberate and documented at the box ("Two
  people who each connected the student is one too many for the form to ask
  about clearly"). Whether to retire those playbook sections or to let both
  boxes be checked is a product decision, and the example files belong to
  another fixer. Documented and pinned instead (§2 #8). **Nothing was deleted
  from any example file.**
- **Ranking the 25 unranked boxes in `STRENGTH`** — §1 #9.
- **Alias-resolving a merge's `keep`** as well as its `drop`. It would apply
  "or how you found them" to a student who *did* meet the recruiter in person.
  The 6 affected firings are asserted as honest substitutes instead (§1 #1).
- **Giving `conversationDetails` a real `prompt`** to make it server-enforced
  without §3.1. That would push it into `fieldAnswers` and recreate exactly the
  double-send of INPUT-1 #4.
- **Re-capturing `draft-tiers-test.ts`'s fixture** — §5.

---

## 5. The runs

All from the worktree, after every fix. Verbatim.

`npx tsx scripts/draft-occasions-test.ts` — **exit 0, 0 failures**

```
merge whyNow<-nextForYou: 2 eligible firings, 2 apply the merged wording, 0 superseded by a connection box's own alias of "keep"
merge nextForYou<-ownNews: 2 eligible firings, 2 apply the merged wording, 0 superseded by a connection box's own alias of "keep"
merge whereMet<-howFound: 9 eligible firings, 3 apply the merged wording, 6 superseded by a connection box's own alias of "keep"
playbook sections no student can ever be shown: #15
1 combinations lose combination examples the corpus holds (draft-prompt.ts owns the fix, ceiling 1): [first.conference,first.pointed,first.alum] lead=first.conference unused mix: first.alum+first.pointed
14 checked boxes contribute no ALSO TRUE block (all redirect_sequence; draft-prompt.ts owns the fix, ceiling 14)
6 brief slots where answerFor would re-send a prompted answer, 0 left by briefAnswerFor
107 valid situations checked, 719 invalid combinations correctly rejected, 480 random click sequences
42 combination examples checked (3 for boxes that can't be checked together); 19 multi-box situations have none:
  …
0 failures
```

`npx tsx scripts/draft-bug-hunt.ts` — `147/147 passed, 0 failed`

`npx tsx scripts/draft-occasions-sim.ts lint-examples` —
`42 Volume V examples linted, 3 findings` (**exactly 3**, unchanged: sections 12
and 17, the `", and thank you"` splices)

`npx tsc --noEmit` — **clean, no output.** The pre-existing
`layout.tsx LayoutProps` error is no longer reported in this tree.

`npx tsx scripts/draft-review-test.ts` — **139/139 passed** (baseline before
this work: `104/104`; the extra 35 are the review/lint fixer's)

`npx tsx scripts/draft-tiers-test.ts` — **33 passing, 0 failing**,
`byte-identical 148/148`

### Both of those were red mid-run, and neither was from this work

Recorded because the numbers were reported while red. At `ac8a0d6`, with four
fixers live in the tree:

- `draft-review-test.ts` **crashed** — `ReferenceError:
  wordsRemovedOnInstruction is not defined` at `src/lib/draft-review.ts:689`,
  that fixer's file caught mid-edit, called before it was defined. Nothing in
  `draft-occasions.ts` is involved. Green at `d7a30a7`.
- `draft-tiers-test.ts` was **30 passing, 64 failing**, byte-identity broken on
  64 of 148 rows with every prompt grown by the same +226 characters — a shared
  prompt string, which `draft-occasions.ts` does not contribute to (the fixture
  hashes the *system* prompt; questions reach only `userText`). Attributed by
  reverting my file alone, with the other fixers' edits left in the tree, and
  byte-comparing the failure lists:

  ```
  --- tiers with MY file reverted (others' edits still in tree) ---
  30 passing, 64 failing
  --- tiers with my file restored ---
  30 passing, 64 failing

  IDENTICAL: my draft-occasions.ts changes contribute 0 of the 64 tiers failures
  ```

  **The fixture was not re-captured here.** Its owner re-captured it, and it is
  byte-identical again.

### Also run, for the modules that import this one

- `npx tsx scripts/test/quick-draft.test.ts` — `pass 6, fail 0`
- `npx tsx scripts/test/outreach-features-stress.test.ts` — fails at import
  (`server-only` via `src/lib/discovery-matches.ts`), identically with my file
  reverted. Pre-existing, unrelated, needs the Next runtime.

---

## 6. The enumeration, before and after

**Valid combinations: 107, unchanged.** No validation rule was loosened or
tightened in a way that admits or rejects a different set of boxes: #7 only
changes what happens to ids that were never valid.

| | INPUT-1 | after |
|---|---|---|
| valid combinations | 107 | **107** |
| questions per combination | `{0:1, 2:6, 3:12, 4:16, 5:14, 6:25, 7:5, 8:27, 10:1}` | `{0:1, 2:6, 3:12, 4:16, 5:14, 6:25, 7:5, 8:27, 9:1}` |
| required per combination | `{0:4, 1:20, 2:35, 3:20, 4:19, 5:8, 6:1}` | `{0:2, 1:22, 2:35, 3:20, 4:19, 5:8, 6:1}` |
| merge firings that do nothing | 9 of 13 | **0 of 13** (7 apply the wording, 6 asserted substitutes) |
| combinations with no required question | 4 | **2**, both allowlisted with a reason |
| brief slots re-sending a prompted answer | 6 | **0** once §3.2 lands; enumerated and asserted now |
| checked boxes contributing no `ALSO TRUE` | 14 | 14, pinned — §3.3 + §3.4 |
| combinations losing examples that exist | 1 | 1, pinned — §3.5 |
| dead Volume V examples / unreachable sections | 3 / #15 | 3 / #15, pinned and documented |

The two moved distribution cells are the fixes, not drift: `10:1 → 9:1` is the
duplicate question the merge now collapses in
`stay[stay.update+stay.congrats+stay.referrer]`, and `0:4 → 0:2` is
`thanks[thanks.chat]` and `thanks[thanks.interview]` gaining the required detail.
