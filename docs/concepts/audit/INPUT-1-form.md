# INPUT-1 — the FORM → SITUATION → BRIEF input path

Audited at commit `0053b1a` on branch `perf/draft-pipeline`, in the worktree
`.claude/worktrees/draft-pipeline-perf`. Read-only audit: nothing under `src/`
or `scripts/` (other than the probes named below) was changed.

**What was audited.** `src/lib/draft-occasions.ts` (pure, committed, stable):
`OCCASIONS`, `resolveSituation`, `boxesConflict`, `toggleBox`, `STRENGTH`,
`situationTypes`, `situationQuestions`, `QUESTION_ALIASES`/`aliasesOf`,
`QUESTION_MERGES`, `answerFor`, `visibleSections`, `autoFill`, `suggestions`,
box `presets`. Plus the field definitions in `src/lib/draft-templates.ts`, the
form's reading of them in `src/app/(app)/drafts/GenerateForm.tsx`, and the
committed server path read out of git — `git show 0053b1a:'src/app/(app)/drafts/actions.ts'`
and `git show 0053b1a:'src/app/(app)/drafts/draft-request.ts'` — because the
working copies of `draft-request.ts` and the streaming route are in flight.

While this audit ran, concurrent sessions on the same branch moved `HEAD` to
`8afe9bf`. The only change to any audited file is one `promptNotes` string on
`recruiter_outreach` (`git diff 0053b1a HEAD -- src/lib/draft-templates.ts`):
no box, preset, field, alias or merge changed, so every measurement below still
holds at `HEAD`. Those sessions also swept the probe files below into
`8afe9bf`; this audit made no commits.

**Probes** (the only files written, besides this report):

```
scripts/audit-probe/input1/enumerate.ts    # exhaustive subset enumeration, validation, questions
scripts/audit-probe/input1/divergence.ts   # form's vs server's view of situationQuestions
scripts/audit-probe/input1/handoff.ts      # brief handoff, preset merge order, real buildDraftPrompt
scripts/audit-probe/input1/thread.ts       # thread-subject / near-duplicate label analysis
scripts/audit-probe/input1/burden.ts       # question and required-question distributions
```

Run them with `npx tsx scripts/audit-probe/input1/<file>.ts`. No API, no
database, no dev server: `draft-occasions.ts`, `draft-templates.ts` and
`draft-prompt.ts` are pure modules and are called directly.

Every claim below is tagged **MEASURED** (with the probe that produced it) or
**REASONED** (read from the code, not executed).

---

## 1. The enumeration

MEASURED — `enumerate.ts`:

| | |
|---|---|
| occasions | 8 |
| sections | 9 (2 in `first_contact`, 1 in each of the others) |
| boxes | 46, no duplicate ids |
| email types | 41 |
| box subsets tried (every subset of every occasion, including empty) | **834** |
| **valid combinations** | **107** |
| rejected | 727 |

Valid per occasion: `first_contact=54  follow_up=7  reply=6  thanks=11
stay=17  ask=5  offers=6  custom=1`. The brief's 107 matches exactly.

Reachability: only **59** of the 107 are reachable for a saved/matched contact,
because `visibleSections(occasion, false)` hides "How are you connected?" for
anyone the student did not type in by hand. The other 48 need an outside
recipient. MEASURED — `enumerate.ts` §3.

Rejection reasons, all of them student-readable: 260 "Pick just one under
`<section>`", 467 named-box conflicts (`"An alum of my school" and "Not an
alum" can't both be checked.`), plus the empty case. No subset produced a
malformed `Situation`.

Question load, MEASURED — `burden.ts`:

```
questions per combination: {0:1, 2:6, 3:12, 4:16, 5:14, 6:25, 7:5, 8:27, 10:1}
required per combination:  {0:4, 1:20, 2:35, 3:20, 4:19, 5:8, 6:1}
email types per situation: {1:46, 2:29, 3:24, 4:8}
```

Worst case is `stay[stay.update+stay.congrats+stay.referrer]`: 10 questions, 6
of them required, drawing on 3 email types.

---

## 2. Findings, ranked

### F1 — `QUESTION_MERGES` is defeated by a third box, and then asks the near-duplicate pair it exists to prevent (HIGH)

`QUESTION_MERGES` runs *after* the alias de-duplication. If the merge's `drop`
question was already removed as an alias of something else, `dropAt < 0`, the
merge is skipped entirely — and with it the merged wording that was written to
cover both questions at once.

MEASURED — `enumerate.ts` §10:

```
merge stay.referrer+stay.congrats keep=nextForYou drop=ownNews:
  2 combinations contain both boxes, merged in 1
  NOT MERGED: stay.update+stay.congrats+stay.referrer (keep=true drop=false)

merge first.recruiter+first.not_alum keep=whereMet drop=howFound:
  9 combinations contain both boxes, merged in 1
  NOT MERGED in 8
```

Reproduction of the worst one, MEASURED — `divergence.ts`:

```
stay[stay.update+stay.congrats+stay.referrer]  lead=stay.referrer
  types=close_loop_referrer/keep_in_touch/congratulations   10 questions
  * introducedTo     "Who they introduced you to"
    loopStage        "How did the introduction go?"
  * learnedOrUpdate  "What came of the introduction"
    nextForYou       "What happens next for you"        <-- merge keep, unmerged
  * lastSpoke        "When you last spoke, and about what"
  * updateSince      "Your own news since you last spoke"  <-- stay.referrer's rewording
    adviceFollowed   "Advice of theirs you acted on"
  * theirNews        "Their news"
  * whereSaw         "Where you saw their news"
    whyFits          "Why their news makes sense to you"
```

`ownNews` (congratulations) was dropped as an alias of `updateSince`
(keep_in_touch), so the merge could not find its `drop` and never ran. The
student is asked both "What happens next for you" and "Your own news since you
last spoke" — which is precisely the pair the merge text
`"Your own news, or what happens next for you"` was written to collapse. Two
of the six required answers in this combination are about the same thing.

The recruiter case is milder but hits 8 combinations: `howFound` is suppressed
by the `FOUND_QUESTIONS` filter whenever a connection box is checked, so
`whereMet` keeps its own label. In `first_contact[first.not_alum+first.recruiter+first.referred]`
the student is asked `whereMet` — **"Where you met this recruiter, and what you
talked about"** — when the boxes say they were *referred* to the recruiter and
never met them. MEASURED — `divergence.ts`.

**Consequence.** The merge mechanism is only reliable for exactly two boxes.
Adding a third defeats it silently, and the combination that defeats it is the
same combination that needs it most.

### F2 — the same alias group is required under three names and optional under a fourth (MEDIUM)

The one specific detail a thank-you is built on lives in the alias group
`conversationDetails / conversationDetail / remarkPoint / recruiterExplained`.
Three of the four are `required: true` type fields; the fourth,
`conversationDetails`, is a shared-brief question with no `required` flag.

MEASURED — `enumerate.ts` §11 and `burden.ts`: the required list contains
`conversationDetail`, `remarkPoint` and `recruiterExplained` but **not**
`conversationDetails`. And:

```
combinations with NO required question at all:
  first_contact[first.alum], thanks[thanks.chat], thanks[thanks.interview], custom[custom.describe]
```

So `thanks[thanks.chat]` and `thanks[thanks.interview]` — the two most common
thank-yous — can be submitted with every field blank, and the model is asked to
write a thank-you with no specific detail in it. Check *any* second box
(`thanks.chat+thanks.helped`) and the detail becomes required, because the
alias-drop path copies `required` onto the question that is shown. MEASURED —
`divergence.ts` shows `* conversationDetail "Something specific from the
conversation"` for that pair.

**Consequence.** Whether the student must supply the one thing the playbook
insists on depends on how many boxes they ticked, not on what the email is.

### F3 — `questionText` can reword the label without rewording the prompt (MEDIUM)

Eight box-level `questionText` entries exist. Six set `prompt`; two do not:

- `stay.referrer.questionText.updateSince` — sets `label`, `hint` only
- `stay.second.questionText.updateSince` — sets `label`, `hint` only

REASONED (read from `draft-occasions.ts`) and MEASURED for the effect — in
`stay[stay.update+stay.referrer]` the student answers a box labelled **"Your
own news since you last spoke"** with the hint *"Separate from how the
introduction went and from their advice"*, and the model is handed that answer
under `keep_in_touch`'s own prompt, **"The student's update since then"**
(`draft-templates.ts:1307`). Beside it sits `nextForYou` → *"What happens next
for the student"*. The question was narrowed for the student and widened again
for the model.

### F4 — one typed answer reaches the model twice in 12 combinations; in one of them it appears as two prompt lines (MEDIUM)

MEASURED — `handoff.ts` §D replays `runGenerateDraft`'s field reading verbatim
with every visible question answered:

```
combinations where one typed answer lands in both the brief and fieldAnswers: 12
  follow_up[follow.inbox] / follow.quiet / follow.interview,
  reply[reply.scheduling] / reply.move, ask[ask.referral_check]
      -> threadSubject is in brief.threadSubject AND in fieldAnswers
  thanks[thanks.helped], thanks[thanks.event], thanks[thanks.session],
  thanks[thanks.chat+thanks.helped], thanks[thanks.helped+thanks.event],
  thanks[thanks.helped+thanks.session]
      -> conversationDetail / remarkPoint / recruiterExplained is in
         brief.conversationDetails AND in fieldAnswers
```

The cause is `brief.conversationDetails = answerFor("conversationDetails", field)`
(`draft-request.ts:226`): `answerFor` walks the alias group, so a type field's
answer is copied into the brief slot as well as being carried in
`fieldAnswers`.

Most of those are harmless — `brief.threadSubject` is only consumed by
`finishDraft` to build the `Re: …` subject line (`draft-prompt.ts:1054`), and
`b.conversationDetails` is only read in the `thank_you_chat` and
`thank_you_interview` branches of `briefLines`. Exactly one combination lands in
both places at once. MEASURED — `handoff.ts` §E, with the real
`buildDraftPrompt`:

```
thanks[thanks.chat+thanks.helped]  types=thank_you_offered_help/thank_you_chat
  "conversationDetail" appears 2x:
      A specific thing from the conversation: MARKER_conversationDetail
      What was discussed or learned: MARKER_conversationDetail
```

**Consequence.** The model is told the same fact twice under two framings in 1
of 107 combinations. Cheap to fix, low harm.

### F5 — `resolveSituation` silently discards foreign box ids instead of rejecting them (LOW)

MEASURED — `enumerate.ts` §4:

```
boxes from another occasion only        -> ERROR "Check at least one box …"
mixed: one valid + two foreign          -> SITUATION lead=first.alum also=[] presets={}
```

`resolveSituation("first_contact", ["first.alum", "thanks.chat", "offers.accept"])`
returns a clean single-box situation. The filter is deliberate (`ids` is
filtered to `inOccasion`) and it fails safe — a tampered or stale POST can never
smuggle another occasion's type into the email — but it is silent. If the form
ever drifts out of step with the occasion (a stale `checked` array after an
occasion switch), the student gets an email built from fewer boxes than they
ticked, with no error.

### F6 — the only required question with no `prompt` is enforced by a bespoke branch, not the generic path (LOW)

MEASURED — `enumerate.ts` §5/§11:

```
REQUIRED-NO-PROMPT: 7 occurrences, 1 distinct
  originalSubject ("Subject line of your email") is required but has no prompt
combinations where the generic 'Add "<label>"' error can fire: 98
combinations whose only required question has no prompt: 5
```

`runGenerateDraft`'s required check reads
`if (!q.prompt) continue;` *before* `if (q.required) return { error: … }`
(`draft-request.ts:253-257`), so a required shared-brief question can never
produce the generic error. Today that is only `originalSubject`, and it is
covered by a separate branch 90 lines later:
`if (isFollowUp && !brief.originalSubject) return { error: "Add the subject
line of the email this replies to." }` (`draft-request.ts:344`).

Two consequences. First, the wording the student gets differs from the label
they saw ("Subject line of your email"), where every other required field
produces `Add "<the exact label>" to draft this email.` Second, the invariant
is undocumented: any *new* required brief question is silently unenforced.

REASONED (needs the database to reproduce): when the form is replying to a
cold email drafted inside Offerly it hides the four `THREAD_QUESTIONS`
(`GenerateForm.tsx:269-271`) and posts `useOfferlyOriginal=1`. If the prior
cold draft has disappeared between page load and submit, `brief.originalSubject`
stays empty and the student gets "Add the subject line of the email this replies
to." for a field that is not on screen — they have to click "I sent a different
email myself →" to reveal it.

### F7 — the blocked-language gate names only 23 of the 128 answerable questions (LOW, content-limits)

MEASURED — `enumerate.ts` §7: 128 distinct question names can be asked across
the 107 combinations (134 once conditional selects are answered). `DRAFT_INPUT_FIELDS`
carries 23 labels. **116** of the reachable question names are not in it:

```
acceptedOnCall, adviceFollowed, answeredPart, applicationRef, availability,
callFormat, callTime, canMakeIt, … , withdrawSituation, yourQuestion
```

`blockedInForm` iterates *every* string entry in the `FormData`
(`content-limits.ts:89-92`), so coverage is complete — nothing reaches the model
unchecked, and the project rule holds. But the label falls back to
`"One of your answers"`, so a student with eight answers on screen is told one
of them is blocked without being told which. `purpose` — the only input the
`custom` occasion has — is in neither `DRAFT_INPUT_FIELDS` nor
`DRAFT_SKIP_FIELDS`, so a custom email's single text box gets the nameless
error too.

### F8 — eight `questionText` overrides and one `collectInputs` branch are dead (INFO)

MEASURED — `enumerate.ts` §5, `DEAD-QUESTIONTEXT: 8` across 4 distinct entries
(`thanks.event.conversationDetail`, `thanks.session.conversationDetail`,
`stay.referrer.updateSince`, `stay.second.updateSince`). These target a question
name that only exists when a *second* specific box is checked, so in the
single-box combinations they rewrite nothing. That is by design — the override
is keyed to the alias that wins — but it means the data cannot be validated by
"every `questionText` key must be a field of this box's type".

REASONED: `collectInputs`'s `purposeLabel: "Anything else to mention"` branch
(for a non-`custom` type with a `purpose`) is unreachable from this form —
`GenerateForm.tsx` renders the `purpose` textarea only when `lead.id === "custom"`.
It is still reachable from other callers of `runGenerateDraft` (Quick Draft).

---

## 3. Cleared

Everything below was probed and found correct.

**Validation completeness (MEASURED — `enumerate.ts` §4).** Every malformed
input returns a student-readable error and never a half-built `Situation`:

| input | result |
|---|---|
| occasion that does not exist / `""` / `"null"` / `"__proto__"` | `Choose what you want to do.` |
| box ids from another occasion only | `Check at least one box…` |
| unknown box ids, whitespace-padded ids, `__proto__`, `constructor` | `Check at least one box…` |
| two or three boxes from a `mode:"one"` section | `Pick just one under "<section title>".` |
| mutually `excludes` boxes, **either order** | identical message, same box order |
| duplicate ids (×3) | valid single-box situation (de-duplicated) |
| duplicates that would trip `mode:"one"` | valid — `new Set` runs before the count |
| empty box list | `Check at least one box…` |
| 50 box ids spanning every occasion | first real conflict reported |
| every box of one occasion at once | first real conflict reported |
| `custom` occasion + a foreign box | `Check at least one box…` |

**`boxesConflict` is symmetric for all 46×46 pairs** (MEASURED), and all 37
one-directional `excludes` entries therefore behave bidirectionally. No
`excludes` entry points at an unknown box or across occasions.

**Order independence (MEASURED).** All 107 valid combinations were re-resolved
with the box ids reversed: `lead`, `also`, `presets` and `summary` were
identical in every case — **0 order-dependent results**. `STRENGTH` covers every
box in a `mode:"any"` section, so no tie ever falls through to submission order.

**`toggleBox` cannot build an invalid set (MEASURED).** Every ordered walk of up
to 3 clicks from empty, in every occasion: **0** sets that `resolveSituation`
rejects; 99 distinct valid sets reached within 3 clicks.

**`autoFill` / `suggestions` (MEASURED — `enumerate.ts` §9).** 5,184
hint/`outside`/`occasionId` states: **0** results that `resolveSituation`
rejects, **0** results that check a box inside a section
`visibleSections(occasion, false)` hides, **0** ids emitted by `suggestions()`
that are not a real box or occasion id, and never an empty occasion.

**Box → type mapping (MEASURED — `enumerate.ts` §1).** All 46 boxes map to a
type that exists in `draft-templates.ts`. All **41** email types are reachable
from at least one box — including `custom`, via `custom.describe`. Nothing is
orphaned in either direction. Three types are served by several boxes, each
disambiguated by a preset: `redirect_sequence`
(`first.pointed`/`reply.pointed`/`stay.redirected`), `not_now_reply`
(`follow.later`/`reply.not_now`), `referral_ask`
(`ask.referral`/`ask.referral_check`/`ask.other_firm`).

**The form and the server ask the same questions (MEASURED — `divergence.ts`).**
They call `situationQuestions` with different `valueOf` functions —
`GenerateForm.tsx:269` passes `(name) => selectValues[name] ?? values[name]`,
`draft-request.ts:252` passes `(name) => situation.presets[name] ?? field(name)` —
which looked like a divergence: the form would resolve a preset-controlled
`showWhen` against the select's *default* option while the server resolved it
against the preset. It is not one: `situationQuestions` consults the presets
itself (`const answer = (name) => situation.presets[name] ?? valueOf(name)`),
so the server's wrapper is redundant and the two views agree. Diff over all 107
combinations: **0**. The preset→conditional chains behave correctly in both:
`follow.later` presets `notNowStage="later"` and `followUpWhen` is hidden;
`reply.not_now` presets `"reply"` and it is shown; `ask.referral_check` presets
`askStage="followup"` and `threadSubject` is shown while `ask.referral` hides it.
(MEASURED — `thread.ts` question dumps.)

**Preset merge order (MEASURED — `handoff.ts` §B).** No shipped combination has
two checked boxes presetting the same question (**0 of 107**), so the
`Object.assign({}, ...ordered.map(b => b.presets ?? {}).reverse())` merge is
currently unexercised. Its rule was measured directly by giving `stay.update`
and `stay.congrats` a colliding preset in memory: the **lead (strongest) box
wins**, and the result is the same whichever order the ids are submitted in.
That is the right winner — the lead's type writes the email — and it is
deterministic.

**`"{recipient}"` substitution (MEASURED — `handoff.ts` §C).** Three presets
carry the token — `first.pointed.newPerson`, `reply.pointed.firstPerson`,
`stay.redirected.firstPerson` — and all three name a field that exists on
`redirect_sequence`, the type their own box maps to, so the substitution at
`draft-request.ts:284` always finds them. **No** conditional question is
controlled by a `"{recipient}"` preset, so the literal token is never compared
as a `showWhen` value. There are **0** `PRESET-ORPHAN` cases: every preset key,
in every combination, is a field of one of that situation's types, so no preset
is silently dropped before the model.

**No question is asked twice (MEASURED — `enumerate.ts` §5).** Over all 107
combinations: **0** duplicate question names, **0** cases of two members of one
alias group both being asked, **0** cases of two different questions sharing a
visible label, **0** questions whose own name is a preset key, **0** questions
whose *alias* is a preset key. The 13 names that carry more than one visible
label all do so because a box's `questionText` or a merge deliberately reworded
them.

The alias machinery also carries `required` and the per-box `prompt` across the
drop correctly: in `thanks[thanks.helped+thanks.event]`, `remarkPoint`
(`required: true`) is dropped in favour of `conversationDetail`, which is made
required, and `thanks.event.questionText.conversationDetail` supplies the
talk-specific label *and* prompt — so the model is told about the talk, not
about a conversation. MEASURED — `divergence.ts`.

**The subject line is never asked for twice (MEASURED — `thread.ts`).** The six
types with a `threadSubject` field (`recruiting_inbox_follow_up`,
`interview_check_in`, `stalled_thread_nudge`, `reschedule_call`,
`recruiter_scheduling_reply`, `referral_ask`) are disjoint from the six
`repliesInThread` types that pull in `THREAD_BRIEF`'s `originalSubject`
(`follow_up_1`, `follow_up_2`, `recruiter_follow_up`, `call_scheduling`,
`not_now_reply`, `coffee_in_person_reply`). Combinations asking for a subject
under two labels: **0**. All 7 `repliesInThread` combinations ask
`originalSubject` and are therefore consistent with the `isFollowUp` guard.

**No required question is unreachable (MEASURED — `enumerate.ts` §6).** 60 type
fields are `required: true`; **0** of them are unreachable. Exploring the select
option space (depth 3) raises the reachable question set from 128 to 134 names;
the 6 that need a select answer first are `coffeePlaceTime`, `conflictReason`,
`introName`, `introReason`, `introTarget`, `proposedTime` — all optional, all
behind a select the student can change. Only three fields can never be asked —
`notNowStage`, `redirectStep`, `askStage` — and all three are always supplied by
a box preset by design, and all three still reach the model through the preset
loop.

**Every conditional question's controller is resolvable (MEASURED).** Two
`ORPHAN-SHOWWHEN` hits (`followUpWhen`→`notNowStage`, `threadSubject`→`askStage`)
are the preset-hidden controllers above, and `situationQuestions` resolves them
from `situation.presets`, not from the form.

**Nothing the student types is dropped, and nothing the brief needs is
unfillable (MEASURED — `enumerate.ts` §7, `handoff.ts` §D).** The 12 questions
with `prompt: ""` (`financeInterest`, `wantToLearn`, `specificReason`,
`originalSubject`, `originalDate`, `originalAsk`, `followUp1Date`,
`meetingWhen`, `conversationDetails`, `nextStepAsk`, `interviewTeam`,
`personalConnection`) are *all* read into `DraftBrief` by name — **0** collected
and never sent. Every question with a `prompt` reaches the model through
`typeFields` → `brief.fieldAnswers`. The 6 `DraftBrief` keys with no question of
that name are either server-filled (`fieldAnswers`, `originalBody`,
`originalTypeLabel`, `followUp1Body`) or reachable once a select is answered
(`introName`, `introReason`, behind `nextStepAsk="intro"`). No brief slot is
unpopulatable.

**`INPUT_FIELDS` / `collectInputs` match what is sent (REASONED + MEASURED).**
`collectInputs` records `situation.summary`, the recipient, every `typeFields`
entry (label + value, the labels the student saw), then every non-empty
`DRAFT_INPUT_FIELDS` value, then `purpose` and the signature choice. No type
field shares a name with a `DRAFT_INPUT_FIELDS` entry — the only name-level
overlap anywhere is `threadSubject`, which is not in `DRAFT_INPUT_FIELDS` — so
**no answer is listed twice** in the saved `inputs` record. The only questions
the record cannot show are ones the student never saw.

**Required-error labels match the form (REASONED).** The error is
`Add "${q.label}" to draft this email.` built from the same `Question` object
`GenerateForm.tsx` rendered, after `QUESTION_MERGES` and every box's
`questionText` have been applied. The form renders `q.required ? q.label :
`${q.label} (optional)``, so for a required field the two strings are identical
by construction. The single exception is F6.

**Unanswered-form sanity (MEASURED — `handoff.ts` §D).** For all 107
combinations, filling in every question the form shows (first option for each
select) makes the server accept: **0** combinations error with every visible
question answered. There is no combination where a student can see a complete
form and still be refused.

---

## 4. Prioritised fix list

1. **Run `QUESTION_MERGES` before the alias de-duplication, or let a merge
   match an alias of its `drop`.** Fixes F1 — the 8 recruiter combinations and
   `stay[stay.update+stay.congrats+stay.referrer]`, which today asks two
   required questions for one fact. Add a test that for every merge, every
   combination containing both boxes ends with `keep` reworded and `drop` gone
   (the assertion `enumerate.ts` §10 already makes).
2. **Give the shared `conversationDetails` question `required: true`**, or drop
   `required` from the three type fields in its alias group. Fixes F2, and with
   it the two combinations (`thanks.chat`, `thanks.interview`) that can be
   submitted entirely blank.
3. **Move the required check above the `if (!q.prompt) continue;` line** in
   `runGenerateDraft`, and delete the bespoke `originalSubject` branch (or keep
   it only for the `useOfferlyOriginal` path). Fixes F6 and closes the hole for
   future required brief questions.
4. **Add `prompt` to `stay.referrer.questionText.updateSince` and
   `stay.second.questionText.updateSince`.** Fixes F3. Consider a lint that any
   `questionText` entry setting `label` must also set `prompt`.
5. **Skip the brief slot when the answer is already in `fieldAnswers`** — i.e.
   `brief.conversationDetails` should not use `answerFor` across alias names
   that are themselves prompted type fields. Fixes F4's one real double-send.
6. **Extend `DRAFT_INPUT_FIELDS` (or derive labels from
   `situationQuestions`) so the blocked-language error names the field**, and
   add `purpose` to it. Fixes F7. Coverage is already complete; this is only
   about the message.
7. **Decide whether a foreign box id should be an error rather than a silent
   drop** (F5). Low risk either way; if it stays silent, say so in the doc
   comment on `resolveSituation`.
