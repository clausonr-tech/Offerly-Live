# FORMAT-AUDIT: the 41 `format` bodies

All 41 `format` arrays in `src/lib/draft-templates.ts` read in full, cross-checked
against `DraftPromptInput` (`src/lib/draft-prompt.ts:49`), the `users` columns in
`src/db/schema.ts`, each type's own `fields`, `HOUSE_RULES` / `VOICE_RULES` /
`STUDENT_DETAILS_RULES` / `GAP_RULES` (`draft-prompt.ts`) and `REVIEW_SYSTEM`
(`draft-review.ts:47`).

Every claim is labelled **MEASURED** (with the command) or **READ** (judgement
from the text). No Anthropic API, no DB, no model call was used.

Probes, all read-only:

```
npx tsx scripts/audit-probe/formats/probe.ts [bracket|facts|quotes|ceiling|fieldrefs|reach]
npx tsx scripts/audit-probe/formats/siblings.ts          # same situation, two types
npx tsx scripts/audit-probe/formats/custom-dump.ts       # what a custom draft's prompt holds
npx tsx scripts/audit-probe/formats/timezone.ts          # F2
npx tsx scripts/audit-probe/formats/cold-alum.ts         # F1
npx tsx scripts/audit-probe/formats/professor.ts         # F9b
npx tsx scripts/audit-probe/formats/branches.ts          # F5
npx tsx scripts/audit-probe/formats/hidden-fields.ts     # F4, F5
npx tsx scripts/audit-probe/formats/no-ask.ts            # F6
npx tsx scripts/audit-probe/formats/rules-vs-format.ts   # F7, F8
npx tsx scripts/audit-probe/formats/optional-demanded.ts # F10
npx tsx scripts/audit-probe/formats/format-facts-test.ts # the gate (green, 11 known)
```

## The structural fact behind most of this

`formatBlock` (`draft-prompt.ts:433`) renders the lead type's `format` as a
numbered list under the heading *"Format (the order can flex, but the examples
show the best structure)"*. It renders **every step, unconditionally**. A type's
`promptNotes` are the only thing that branches, and they arrive later, in the
user message, as prose among 20-40 other lines.

So wherever a type's situation has branches — a select asking *which* email this
is — the numbered format demands all branches at once and one buried note has to
argue it back. **MEASURED** (`branches.ts`): 12 of the 41 types have such a
select; across them 36 format steps are unconditional.

And `draft-prompt.ts:718-726` already filters `redirect_sequence`'s *notes* to
the chosen step. The format was never given the same treatment.

---

## F1 — `cold_email` claims the alumni database whether or not the recipient is an alum

**Type:** `cold_email` (the primary cold box; 9 examples, more than any other type;
**0 fields and 0 promptNotes**, so the format *is* the whole type).

**Exact text**, step 3 of 9:

> `Say you found them through your school's alumni database`

**Why it is wrong.** The fact behind that sentence is supplied by `briefLines`
(`draft-prompt.ts:630-636`) and only when `alumniSchool` is set. `alumniSchool`
comes from `overlaps.includes("Same school")`
(`src/app/(app)/drafts/draft-request.ts:463`), which needs
`contact.school` to be non-empty and to match `sameSchool()`
(`src/lib/relevance.ts:40`). The picker box "An alum of my school" is
independent of that detection — a contact entered without a school, or with
"Penn" against a profile's "University of Pennsylvania", checks the box and
fails the match.

**MEASURED** (`npx tsx scripts/audit-probe/formats/cold-alum.ts`) — with
`alumniSchool` null the drafter is handed both of these in the same prompt:

```
step 3:  Say you found them through your school's alumni database
brief:   The recipient's school isn't confirmed as the student's. Don't claim
         they're an alum or say how the student found them.
```

One numbered format step against one brief line, with nothing in the type to
break the tie.

**What a student would see.** An email to a stranger asserting *"I came across
your name in the Ridgemont alumni database"* about someone who may not be an
alum. Worse than a bracket: the student cannot tell it is false, and it reads as
presumptuous to a recipient who is not one.

**Fix.** Make the step carry its own condition, as the neighbouring cold types'
steps do:

> `Say how you found them - through your school's alumni database when THIS EMAIL confirms they are an alum, otherwise leave it out`

Rank: **highest volume**. Every `cold_email` draft whose contact has no recorded
school.

---

## F2 — `recruiter_scheduling_reply` spells out a time zone, and the only zone it is given is the student's own

**Type:** `recruiter_scheduling_reply`.

**Exact text**, step 2 of 6:

> `Confirm the slot with the date, time and time zone spelled out, or ask for a different one`

reinforced twice more: promptNote *"Repeat the date, time and time zone back in
writing"*, and the `offeredSlot` field prompt *"The slot the recruiter offered -
repeat it back with the time zone"*.

**Why it is wrong.** The slot is the **recruiter's**, in the recruiter's zone.
The type's `timeZone` field is `TIME_ZONE_FIELD`, whose prompt is *"The student's
time zone - write it out with every time"*. Its sibling `call_scheduling` asks
the student for the recipient's zone — `proposedTime.hint` is *"Include their
time zone if they gave one."* — and `recruiter_scheduling_reply`'s `offeredSlot`
has **no hint at all**. Same situation, two types, one of them missing the piece:
the graduation-month shape exactly.

**MEASURED** (`npx tsx scripts/audit-probe/formats/timezone.ts`) — every
time-zone fact a Pacific student confirming an 11:00 slot is handed:

```
The slot the recruiter offered - repeat it back with the time zone: Tuesday, October 20 at 11:00 a.m.
The student's time zone - write it out with every time: Pacific
Formal: this is a process, not a favor. Repeat the date, time and time zone back in writing.
Use only the days and times the student gave, tidied up ... Never add calendar dates, "next week" or a time zone that wasn't given.
```

Three instructions demand a zone; one zone is available; it is the wrong one;
and `GIVEN_TIMES_NOTE` forbids adding one that wasn't given. All three outcomes
are bad: the wrong zone, no zone (against three instructions), or a bracket.

**What a student would see.** *"Tuesday, October 20 at 11:00 a.m. Pacific works
— thank you."* sent to a recruiter who meant 11:00 Eastern. A missed first-round
interview, written in the student's own hand.

**Fix.** Two lines. Give `offeredSlot` `call_scheduling`'s hint ("Include their
time zone if they gave one"), and change the step to:

> `Confirm the slot, repeating the date and time exactly as they gave it, and the time zone only if they gave one`

Rank: **lowest volume of the top findings, highest cost per occurrence.** Only
cross-zone students, but the failure is a missed interview.

---

## F3 — both surviving "graduation date" demands are in `format` bodies, and the `custom` path strips their escape clauses

**Types:** `recruiting_inbox` step 3, `recruiter_outreach` step 2.

**Exact text:**

> `State your name, school, major and graduation date in the first two lines` (`recruiting_inbox`)
> `Introduce yourself: name, school, class year and graduation date` (`recruiter_outreach`)

**Why it is wrong.** Nothing in the app holds a graduation **month**:
`DraftPromptInput` has `studentGradYear?: number` and `users` has `gradYear`.
`scripts/audit-probe/gradmonth-test.ts` scans `promptNotes` only, so it passes
while both `format` bodies still ask for a date.

In the *normal* path both types carry an escape clause in their notes, so this is
contained:

- `recruiter_outreach`: *"The profile holds only a year, never a month, so never ask for a graduation month and never leave a placeholder for one."* — explicit, sound.
- `recruiting_inbox`: *"If the graduation month isn't given, give just the year."* — works, but phrased as a condition that is **always** true, which invites the model to look for a month first.

The live exposure is the **`custom` path**. `formatBlock` (`draft-prompt.ts:437-451`)
dumps all 40 non-custom formats into a custom draft's prompt, and carries **none
of their promptNotes** — `custom` has none of its own, and `briefLines` only
pushes the lead type's.

**MEASURED** (`npx tsx scripts/audit-probe/formats/custom-dump.ts`):

```
custom prompt: 36770 chars, 441 lines
  /graduation date/gi  x2
  ...graduation-year escape clause present in the custom prompt? false
```

**What a student would see.** A `custom` draft that lands on the recruiting-inbox
or recruiter format: `[graduation month]` in the body — the exact string that made
12 of 28 emails unsendable in OUTPUT-1.

**Fix.** Write the constraint into the two `format` steps themselves, where it
travels with them into the custom dump:

> `State your name, school, major and graduation year in the first two lines (the year only - no month)`

Then extend `gradmonth-test.ts` over `format` bodies, which
`scripts/audit-probe/formats/format-facts-test.ts` now does.

---

## F4 — `offer_extension` replying to a "no" demands the three facts that branch hides

**Type:** `offer_extension`, `extensionStage = "said_no"`.

**MEASURED** (`npx tsx scripts/audit-probe/formats/hidden-fields.ts`):

```
fields hidden (never reach the prompt): requestedDate, extensionReason, otherFirm
format steps still demanding them:
  ! Ask clearly for a specific new date, not "a little more time"
  ! Give a short, honest reason, without naming the other firm unless you choose to
  ! Reassure them it's not a negotiating tactic and you aren't shopping the offer
promptNotes that contradict those steps:
  + Replying to a no: thank them, accept it with no second attempt, and confirm
    the original deadline in writing. Short.
```

`activeFields()` hides all three fields behind `showWhen: { field: "extensionStage", is: ["asking"] }`,
so the facts never reach the prompt — while three numbered steps ask for them and
one note, buried in the user message, says to do the opposite.

**What a student would see.** Either `[the new date you need]` in the body of an
email whose entire purpose is to accept that no new date is coming, or — worse —
a second ask, which the note exists to prevent and which the format outvotes 3-1.

**Fix.** Branch the steps:

> `1. Thank them and restate your excitement about the offer`
> `2. If you are asking: ask clearly for a specific new date, not "a little more time", give a short honest reason, and say plainly it is not a negotiating tactic`
> `3. If they have said no: accept it with no second attempt and confirm the original deadline in writing`

---

## F5 — the same bug in four more types, and in `redirect_sequence` it is three emails at once

**MEASURED** (`branches.ts`, `hidden-fields.ts`):

| Type | branch | the step that should not be there | the note that fights it |
|---|---|---|---|
| `redirect_sequence` | `thank` | `In the email to the new person, lead with the first person's name in the first sentence` **and** `Close the loop with the first person once the conversation has happened` | notes are correctly filtered to the chosen step by `draft-prompt.ts:718-726` — the format is not |
| `referral_ask` | `followup` | `Make it easy: attach the resume and include a two-line summary they can forward` | *"No new pitch, no summary, and don't mention the resume."* |
| `coffee_in_person_reply` | `yes` | `Suggest a specific spot near their office, and offer to go wherever is easiest for them` (`coffeeSpot` is hidden) | *"If they named a place and time, confirm it exactly and stop."* |
| `thank_you_offered_help` | `none` | `Thank them for the specific offer they made, in their own terms` / `Make the offer easy to act on: attach the resume, or include a short blurb` | *"If they offered nothing, say plainly the student isn't asking for anything else, and don't attach or mention the resume."* |

`referral_ask` and `thank_you_offered_help` are the costly two: both set
`attachResumeIfMentioned: true`, so a format step that makes the drafter write
"my resume is attached" **actually attaches the resume**
(`mentionsAttachedResume`, `draft-templates.ts`) on an email the note says must
not mention it.

`coffee_in_person_reply` is the bracket risk: `coffeeSpot` is hidden, the step
demands a spot, the note says *"Never invent a cafe, street or date"*, so
`GAP_RULES` leaves `[a spot near their office]` in a reply whose only job was to
say yes to a time they already named.

**Fix.** The pattern `redirect_sequence`'s notes already use: prefix each
branch-specific step with its condition. `redirect_sequence` additionally wants
the `STEP_NOTE` filter at `draft-prompt.ts:718` extended to the format, so a
student thanking the redirector never sees the other two emails' steps.

---

## F6 — `thank_you_event` is the one thank-you sibling with no "no ask" clause

**Type:** `thank_you_event`, `eventAsk = "none"` ("Nothing, just thanks").

**MEASURED** (`npx tsx scripts/audit-probe/formats/no-ask.ts`):

```
### thank_you_event with "no ask" chosen
  format steps that demand an ask:
    ! Ask one small follow-up question, or ask for a short call
    ! ... One short paragraph plus the ask. Genuine and kind, never aggressive or demanding
  lines that say an ask is optional / absent:
    + What to ask for at the end: Nothing, just thanks          <- the raw field answer, no instruction
```

Its three siblings all carry one:

- `thank_you_recruiter_session` — in the **step itself**: `Ask at most one follow-up question, or none at all`, plus *"With no question, say plainly the student just wanted to say thank you."*
- `thank_you_offered_help` — *"If they offered nothing, say plainly the student isn't asking for anything else."*
- `thank_you_chat` — brief line *"No ask - just thank them."* (`draft-prompt.ts:693`)

**What a student would see.** A thank-you they asked to end on thanks, ending on
*"Would you have time for a short call in the next few weeks?"* — because two
numbered steps say so and nothing says otherwise.

**Fix.** Copy the sibling's wording into the step:
`Ask one small follow-up question, ask for a short call, or none at all`, and add
the note *"With nothing to ask, say plainly the student just wanted to say thank
you."*

`thank_you_chat` has the clause but the worst ratio — 2 unconditional ask steps
(`Say your interest has grown and ask about next steps`, `Ask whether you should
talk to anyone else, or for a specific introduction`) against 1 brief line. Worth
the same conditioning.

---

## F7 — six format steps instruct a courtesy line `VOICE_RULES` bans outright

`VOICE_RULES` (`draft-prompt.ts:160`):

> *"the stock versions are banned outright: "I attached my resume for your reference", "happy to work around your schedule", ... never in a wording printed in these rules."*

**MEASURED** (`npx tsx scripts/audit-probe/formats/rules-vs-format.ts`):

```
A. Format STEPS that instruct a banned courtesy line
  cold_email, cold_after_meeting, cold_not_alum, cold_referral, follow_up_1:
      Say you're flexible and will work around their schedule
  conference_follow_up:  Note your flexibility, mention your attached resume ...
  second_conversation:   Note your flexibility and thank them

B. The same lines in the EXAMPLES each type is shown
   14 examples  "work around your schedule"   follow_up_1:6  thank_you_event:4  second_conversation:2  conference_follow_up:1  not_now_reply:1
   23 examples  the pleasantry opener          follow_up_1:4  keep_in_touch:3  referral_ask:3  cold_email:2 ...
    5 examples  "I wanted to follow up"        follow_up_2:3  follow_up_1:1  recruiter_follow_up:1
  (out of 192 example emails in total)
```

**Why it is waste.** The drafter is instructed toward the line, shown it 14 times,
writes it; `REVIEW_SYSTEM` then embeds `VOICE_RULES` verbatim and is told to
rewrite it — and was MEASURED pasting the rules' own printed example into 2 of 3
edits. The pipeline pays a model call to undo what the format asked for.
`follow_up_1` is the worst case: the step, 6 of 7 examples, and 4 of 7 pleasantry
openers all point at what the reviewer must strip.

**Fix.** Say the job, not the line, in all six steps:

> `Offer to work around their timing, in words built from this email`

**READ, flagged for the owner of `email-examples*`:** the examples half of this
is not mine to touch. Counts above were read 2026-10-12 and will move.

---

## F8 — `follow_up_1` step 2 quotes a sentence `HOUSE_RULES` names as a banned invented specific

**Type:** `follow_up_1`.

**Exact text**, step 2 of 7:

> `Open with one short sentence that follows up on the first email ("Following up on my note from last week in case it got buried.")`

**Why it is wrong.** `HOUSE_RULES`:

> *"NO INVENTED SPECIFICS. Never add a detail nobody gave you, including: when something happened ("this fall", "last week")"*

**"last week" is HOUSE_RULES' own example of a forbidden invented specific**, and
the format step prints it inside a 13-word sentence offered as the opener. The
brief question that would make it true — `originalDate`, "When did you send it?"
— is **optional** (`draft-occasions.ts`, `THREAD_BRIEF`). And the same sentence is
the subject of three further rules: `VOICE_RULES` (*"what to copy there is the
deletion, not the sentence"*), `REVIEW_SYSTEM` (*"in case it got buried" explains
why the student is writing AGAIN…*), and `OTHER_FIRST_EMAIL_NOTE` in
`draft-templates.ts`, which quotes a near-identical sentence as **wrong**.

**MEASURED** (`probe.ts quotes`): 7 format steps across all 41 types quote a
phrasing. This is the only one that quotes a whole sentence, and it is 13 words.

**What a student would see.** *"Following up on my note from last week in case it
got buried."* — with no date given, "last week" invented, in the one email type
whose own examples demonstrate the same sentence 6 of 7 times.

**Fix.** Keep the shape, drop the sentence and the date:

> `Open with one short sentence that follows up on the first email, using the date only if THIS EMAIL gives one`

The remaining 6 quoted phrasings are short and safe: `cold_not_alum`'s *"why you
specifically"* and `offer_extension`'s *"a little more time"* are both naming a
concept, not a line.

---

## F9 — the two brackets that reach lines the reviewer may not rewrite

`REVIEW_SYSTEM` (`draft-review.ts`, "HOW TO EDIT"):

> *"thrown away whole if it changes the greeting or a [placeholder]"*
> *"Keep the greeting line exactly as written … and every [bracketed placeholder] exactly as written."*
> *"Leave the subject exactly as it is unless it has a misspelling or a wrong name"*

**MEASURED** (`probe.ts bracket`): 9 literal brackets across formats, notes and
field prompts. Two of them sit in a greeting or subject step.

**9a. `interview_check_in` step 1** — `Keep the thread: reply to your thank-you note, or use "Following Up on the [Role] Interview"`, repeated in the note as `[role]`. When `threadSubject` is blank (it is optional), `finishDraft` keeps the model's own subject (`draft-prompt.ts:1370`). `interviewRole` is required, so the drafter has the role — but this project's measured lesson is that a demonstration beats an instruction, and this is the only bracket in all 41 formats that can reach a subject line.
**Fix:** `or write a subject naming the role and that this follows up on the interview`.

**9b. `professor_recommendation` step 1** — `Greet them as "Professor [Last name]," never by first name`, and the note `Use the greeting given under RECIPIENT - "Dear Professor [Last name]," for a professor`.

**MEASURED** (`npx tsx scripts/audit-probe/formats/professor.ts`) — only one of
four contact shapes agrees with the step:

```
"Professor Amy Adams"       -> Greeting: write "Dear Professor Adams,"           agrees
"Amy Adams"                 -> NO GREETING LINE (house default: Hi {first name},) contradicts "never by first name"
"Dr. Reyes"                 -> Greeting: write "Dear Dr. Reyes,"                  contradicts "Professor"
"amy.adams@ridgemont.edu"   -> Greeting: write "Hello,"                           contradicts both
```

A contact entered as plain "Amy Adams" — the ordinary case, since the directory
stores names, not honorifics — gets **no greeting line**, so the note points at
something that is not in the prompt and the only instruction left is a bracket.
A hedged `Dear Professor [Last name],` ships in the one line the reviewer is
forbidden to touch.

**Fix.** Make the step defer and the note stop assuming:

> `Greet them formally with their title and surname, using the greeting under RECIPIENT where one is given; never by first name`

---

## F10 — optional fields an unconditional step demands, with no clause for a blank

**MEASURED** (`npx tsx scripts/audit-probe/formats/optional-demanded.ts`, then
read by hand — the probe is deliberately loose and most of its 17 hits are
word-overlap noise). Three are real, and one is a sibling disagreement:

| Type | field | step | the sibling that has the clause |
|---|---|---|---|
| `decline_offer` | `thankPeople` (optional) | `Say something genuine about the people you met` | `accept_offer` has it **twice** — in the step (`Thank anyone who helped you along the way, by name, if there is someone`, plus `If nobody helped you in, skip thanking rather than inventing a name`) and in a note |
| `not_now_reply` | `followUpWhen` (optional) | `Name when you'll follow up, so the later email is expected rather than intrusive`, and the note repeats it | — |
| `professor_recommendation` | `recSubmission` (optional) | `Name the program, the deadline, and exactly how the letter is submitted` | — |
| `recorded_round_note` | `roundContent` (optional) | `Reference the content lightly, since there was no conversation to draw on` | — |

`decline_offer` is the one that matters: the offer family was meant to be
symmetric, and declining is the more delicate of the two. With no names given,
the drafter must invent one (`HOUSE_RULES`: never) or bracket it — in an email
turning down an offer.

**Fix.** `decline_offer`: `Say something genuine about the people you met, if the
student named any — never invent a name`. The other three: `if THIS EMAIL gives
one`.

---

## F11 — dead, and correct-but-noted

- **`follow_up_1` / `follow_up_2` step 1, `Subject is "Re: [original subject line]"` — dead, not harmful.** **MEASURED** (`probe.ts bracket`, plus code): `finishDraft` overwrites the subject from `brief.originalSubject` (`draft-prompt.ts:1359-1372`) and `draft-request.ts:361` refuses the submission without one (*"Add the subject line of the email this replies to."*). The model's subject is discarded, so the bracket cannot ship. It still teaches the drafter that a bracketed subject is a normal thing to write, and it is in the `custom` dump (**MEASURED**, `custom-dump.ts`: `x2`) where no such override applies. Worth deleting the quote from the step.
- **`briefLines` disagrees with itself about an unknown thread subject.** `draft-prompt.ts:671` for `follow_up_1`/`follow_up_2`/`call_scheduling`: *'Original subject line unknown - use "Re: [original subject line]" and list it as a gap.'* `draft-prompt.ts:709` for every other `repliesInThread` type: *"The thread's subject line is unknown - write a short, plain subject, never one starting with \"Re:\"."* Opposite instructions for the same situation, in the same function. Both branches are unreachable behind the `draft-request.ts:361` gate — but `recruiter_follow_up`, `not_now_reply` and `coffee_in_person_reply` are `repliesInThread` with **no `threadSubject` field**, so they rely entirely on that gate.
- **`coffee_in_person_reply` step 5, `Give your phone number in case of a change on the day` — sound.** `studentPhone` exists (`DraftPromptInput:53`, `users.phone` at `schema.ts:428`), is supplied to the body separately (`draft-prompt.ts:958`: *"Contact details, for the body only when the email calls for them"*), and the note carries the clause (*"If there's no phone number, leave that sentence out - never a placeholder"*). One note: `signatureLines` also prints the phone (`draft-prompt.ts:776`), so a student with a phone gets it twice, and `REVIEW_SYSTEM` only names the class year as a don't-repeat-the-signature case.
- **188 of 192 example emails end on a literal `[phone number]` line** (**MEASURED**, `rules-vs-format.ts` section C), while `HOUSE_RULES` says *"Never write \"[phone number]\" or any other placeholder in the signature."* Harmless in output — `finishDraft` rebuilds the signature from the profile — but it is the single most repeated thing the drafter sees, and what it demonstrates is that a bracketed placeholder is acceptable output. That raises the base rate under every finding above. **Owned by the `email-examples*` agent, not changed here.**

---

## Cleared: `maxWords`

**MEASURED** (`npx tsx scripts/audit-probe/formats/probe.ts ceiling`). **No
ceiling is below its own longest example**, for any of the 40 types that have
examples. The tightest margins:

```
after_rejection       ceiling 125, longest example 124 (+1)
follow_up_1           ceiling  80, longest example  78 (+2)
thank_you_event       ceiling 130, longest example 128 (+2)
thank_helper_offer    ceiling 110, longest example 107 (+3)
```

and the tightest words-per-content-step:

```
follow_up_1            80w / 6 steps = 13.3 w/step   longest example 78w
follow_up_2           100w / 6 steps = 16.7 w/step   longest example 89w
recruiter_follow_up    90w / 5 steps = 18.0 w/step   longest example 76w
congratulations        90w / 5 steps = 18.0 w/step   longest example 78w
```

`follow_up_1` is the only one worth a second look: 80 words must hold the
follow-up sentence, `OTHER_FIRST_EMAIL_NOTE`'s mandatory separate reminder
sentence, the re-ask, the flexibility line and the thanks, while
`STUDENT_DETAILS_RULES` says every typed detail must appear and `blendRules`
says never drop a checked box. Its own 78-word example proves it fits — **READ:**
tight but not impossible, and no fix proposed. The comment on `maxWords`
("Roughly the longest example") is accurate across all 40.

## Cleared: field references and reachability

**MEASURED** (`probe.ts fieldrefs reach`):

- No format step or promptNote references a field name the type does not have.
- All 41 types are reachable from a picker box in `draft-occasions.ts`.
- Every non-custom type has at least one example.

---

## Coverage: all 41 read

| Type | verdict |
|---|---|
| `cold_email` | **F1** (alumni database asserted unconditionally); F7 |
| `cold_after_meeting` | F7 only. Steps 1-4 all backed by required fields (`metAt`, `talkedAbout`); the missing-day case has its clause. Sound |
| `cold_not_alum` | F7 only. `howFound` + `whyThem` both required and both named by their steps. Sound |
| `cold_referral` | F7 only. `referrerName` + `referrerContext` required; subject-line step backed. Sound |
| `recruiting_inbox` | **F3** ("graduation date"). Otherwise sound: `program`, `inboxContext`, `inboxQuestion` all required, team greeting handled, `TRANSCRIPT_NOTE` present |
| `conference_follow_up` | F7 only. `conferenceName` + `whereTalked` required; the ask is stated once (and `briefLines` deliberately stays silent to avoid a second call length). Sound |
| `recruiter_outreach` | **F3** ("graduation date"), though its own note is the strongest escape clause in the file. Sound otherwise |
| `follow_up_1` | **F8** (quoted sentence with "last week"); F7; F11 (dead subject bracket). Ceiling cleared |
| `follow_up_2` | F11 (dead subject bracket). Sound otherwise |
| `recruiting_inbox_follow_up` | Sound. Four required fields, one per step; the only type that names its own one-follow-up ceiling in both format and note |
| `interview_check_in` | **F9a** (`[Role]` can reach the subject). `lastCheckIn`, `otherDeadline`, `threadSubject` all have clauses. Sound otherwise |
| `recruiter_follow_up` | Sound, with F11's caveat: `repliesInThread` and no `threadSubject` field, so it depends entirely on the `draft-request.ts:361` gate |
| `stalled_thread_nudge` | Sound. `threadSubject` and `openQuestion` required; the one-question rule is in both format and note |
| `call_scheduling` | F5-adjacent: 4 unconditional steps across 3 branches, but every branch has a note and `availability`'s blank case has the documented `[your available times]` marker. Sound |
| `reschedule_call` | Sound. 4 branches, 4 branch-labelled notes — the best-covered branchy type. Minor: `callTime` carries no zone, same shape as F2 but no step demands one |
| `recruiter_scheduling_reply` | **F2** (wrong time zone) |
| `not_now_reply` | **F10** (`followUpWhen` optional, demanded by step and note). Both stage notes are self-labelled, so the branches are clear |
| `redirect_sequence` | **F5** (3 of 5 steps belong to emails not being written; the notes are filtered in code, the format is not) |
| `coffee_in_person_reply` | **F5** (`coffeeSpot` hidden, step demands it); F11 (phone duplicated in the signature). Step 5 itself is sound |
| `thank_you_chat` | **F6**-adjacent: 2 unconditional ask steps against 1 brief line. No fields, so everything rides on `CHAT_BRIEF` |
| `thank_you_offered_help` | **F5** (`offerType = none` fights two steps; `attachResumeIfMentioned` makes it attach). The blurb note (third person, student's name, never a guessed pronoun) is sound |
| `thank_you_event` | **F6** (the one sibling with no no-ask clause); F7 (4 of 6 examples) |
| `keep_in_touch` | Sound. `lastSpoke` + `updateSince` required; the no-referral prohibition survives `SETS_THE_ASK` by design |
| `close_loop_referrer` | Sound. The split-note comment (LOGIC-3 F7) is correct: the prohibition survives, the length gives way |
| `referral_ask` | **F5** (`followup` branch: resume + summary demanded against the note) |
| `thank_you_recruiter_session` | Sound, and the model for F6's fix: the no-question case is handled in the step *and* the note |
| `second_conversation` | F7 only. `firstTalk` + `whatYouDid` required. Sound |
| `congratulations` | Sound. The split-note comment is correct, and step 4 ("Don't ask for anything") agrees with the note |
| `thank_you_interview` | Sound. `clarification` optional and conditioned in the note; the superday cross-reference is in the format |
| `thank_you_superday` | Sound. `onlyDetail` required, `otherNotes` and `secondInterviewer` both conditioned in notes, the brief-meeting case handled |
| `thank_you_phone_screen` | Sound. `nextStep` optional **and** conditioned both ways (given / not given / date-only) — the cleanest optional-field handling in the file |
| `recorded_round_note` | **F10** (`roundContent`). All three round kinds covered by the note |
| `withdraw_process` | Sound. `processStage` required; both situations note-labelled; the "ask for another slot before withdrawing" rule is in format and note |
| `after_rejection` | Sound. `roleName` + `takeaway` required; `peopleMet` conditioned ("Only after a superday or final round … thank the people named. Never mention a superday otherwise") |
| `offer_extension` | **F4** (3 hidden fields, 3 steps) |
| `accept_offer` | Sound, and the model for F10's fix: the skip-thanking clause is in the step and the note, plus a resume cross-check for the return-offer answer |
| `decline_offer` | **F10** (`thankPeople` has no clause where `accept_offer`'s does) |
| `thank_helper_offer` | Sound. Both required fields named by their steps; `helperRole` covered by the note |
| `professor_recommendation` | **F9b** (`[Last name]` in the greeting); **F10** (`recSubmission`). The tight-timeline rule is in format and note |
| `reference_request` | Sound. `referenceKind` covered by the note, `referenceBullets` explicitly "never invent accomplishments", `roleWithThem` + `sharedProject` required |
| `custom` | **F3** carrier. Its own format is two lines and sound; the harm is `formatBlock`'s dump of the other 40 formats with none of their notes |

**24 of 41 sound as written.** 17 carry at least one finding; `cold_email`,
`recruiter_scheduling_reply`, `offer_extension` and `professor_recommendation` are
the four worth fixing first.

---

## The gate

`scripts/audit-probe/formats/format-facts-test.ts` generalises
`gradmonth-test.ts` from one fact in one string to every fact in all three
strings a type sends the model, plus the branch selects:

1. a `format` step demanding a fact no field and no profile column holds, with no escape clause anywhere in the type;
2. a literal `[placeholder]` printed in a greeting or subject step — the lines `REVIEW_SYSTEM` may not rewrite;
3. a step demanding a fact the student's own select answer hides, or a no-ask option with no step or note saying what to write instead.

`KNOWN` holds the 11 instances this audit reports as open, so the test is green
today and goes red the moment a **new** one appears. Delete a `KNOWN` line when
its finding is fixed.

**MEASURED:**

```
$ npx tsx scripts/audit-probe/formats/format-facts-test.ts
41/41 types: no new unsupplied-fact demand, no new bracket in a greeting or
subject step, no new step asking for a hidden field (11 known open findings allowed)
$ echo $?
0
$ npx tsx scripts/audit-probe/gradmonth-test.ts
41/41 types: no unfillable graduation-month request
```
