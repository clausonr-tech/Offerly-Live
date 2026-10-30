# PROMPT-COHERENCE: the prompt stack stops instructing what it forbids

The drafting prompt told the drafter to write lines `VOICE_RULES` bans, printed
a sentence `HOUSE_RULES` names as a forbidden invented specific, and demanded
facts the student's own answer had hidden. `REVIEW_SYSTEM` embeds `VOICE_RULES`
verbatim, so every one of those was a model call paid to undo what the format
asked for.

This change removes the contradictions in the two files that cause them:
`src/lib/draft-templates.ts` (the 41 `format` bodies) and `src/lib/draft-prompt.ts`
(`VOICE_RULES`). Nothing in `draft-review.ts`, `draft-lint.ts`, `email-examples*`
or `src/app/` was touched.

Findings are numbered as in `FORMAT-AUDIT.md`. Every claim below is **MEASURED**
with the command shown, or labelled **READ**.

## The governing principle, applied

A demonstration beats an instruction (`DECISIONS.md` D11, measured twice). So:

- a step may **describe** a job; it may not **print** the sentence that does it;
- a rule may **quote** a phrasing shown as wrong - that is the discriminator;
- a rule may **quote** a shape, labelled as a shape;
- nothing else in the stack gets to print a reusable sentence.

## MEASURED: before and after

```
$ npx tsx scripts/audit-probe/formats/rules-vs-format.ts
  A. Format STEPS that instruct a banned courtesy line
     before: 7 steps across 7 types      after: 0            <- F7
$ npx tsx scripts/audit-probe/formats/hidden-fields.ts
  "format steps still demanding them"
     offer_extension        before: 3    after: 0            <- F4
     coffee_in_person_reply before: 1    after: 0            <- F5
     thank_you_offered_help before: 2    after: 0            <- F5
$ npx tsx scripts/audit-probe/formats/no-ask.ts
  thank_you_event: a no-ask clause now in the STEP and in a note (the
  thank_you_recruiter_session shape)                         <- F6
$ npx tsx scripts/audit-probe/formats/format-facts-test.ts
  before: 11 KNOWN open findings    after: 4                 <- 5 fixed, 2 stale
$ npx tsx scripts/draft-specimen-test.ts
  before: 43 assertions             after: 54
```

The whole text change, over all 148 prompts a student can produce: **26 distinct
new lines replacing 27**, plus the renumbering of two unchanged `offer_extension`
steps (its format went 6 steps to 5). Dumped both versions in full and diffed
them line by line before re-capturing the tier fixture; nothing else moved.

---

## F7 - six format steps instructed a line `VOICE_RULES` bans outright

Seven steps, not six: five types shared one string, and two more said it in
their own words.

**Before** (`cold_email`, `cold_after_meeting`, `cold_not_alum`, `cold_referral`,
`follow_up_1`):

> `Say you're flexible and will work around their schedule`

**After:**

> `Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)`

**Before** (`conference_follow_up`):

> `Note your flexibility, mention your attached resume (you attach it when you send), and thank them`

**After:**

> `Leave the timing to them and mention your attached resume (you attach it when you send), both in wording built from this email rather than a stock courtesy line, then thank them`

**Before** (`second_conversation`): `Note your flexibility and thank them`
**After:** `Leave the timing to them, in wording built from this email rather than a stock courtesy line, and thank them`

Three things the replacement is doing deliberately:

- it asks for the **intent** (the timing is theirs to choose) and never a sentence;
- it carries its own **testable constraint** - wording built from this email -
  so the step cannot be satisfied by a line that would fit any email;
- it names `VOICE_RULES` by its **heading**, not by position. `SOUND LIKE A
  PERSON, NOT A TEMPLATE` is in the invariant tier, so the reference travels
  into the `custom` dump too, which carries no `promptNotes`. A positional
  "above" would be the D15 mistake.

**The replacement wording is itself a risk, stated plainly.** "Leave the timing
to them" is five words a model could turn into "I'll leave the timing to you" in
all five types - a new stock line, differently worded. Two things work against
it and neither is a proof: the phrase is an instruction to the drafter rather
than email prose (it is not a sentence the email could contain unchanged), and
the constraint clause plus `VOICE_RULES`' "a courtesy line that would read the
same in any email gets rewritten or cut" both bear on it. `repeatedSentencesPost`
on the rig is the measurement that would catch it; if it shows up there, the
answer is to vary the five steps rather than to restore the ban-and-undo loop.

## F8 - `follow_up_1` step 2 quoted a 13-word sentence containing "last week"

The only whole-sentence quote in all 41 formats, and `HOUSE_RULES` names "last
week" **by name** as a forbidden invented specific. `originalDate` is optional,
so the drafter may have no date at all.

**Before:**

> `Open with one short sentence that follows up on the first email ("Following up on my note from last week in case it got buried.")`

**After:**

> `Open with one short sentence that follows up on the first email: the follow-up itself, not wanting to follow up. Say when the first email went out only if THIS EMAIL gives the date, and never how long ago it was`

The shape survives (one short sentence, the follow-up itself, not a preamble
about following up); the sentence and the invented week are gone, and the date
is now conditioned on the section that would hold it.

## D11 item 3 - the last positive specimen in `VOICE_RULES`

The resume line, the flexibility line, the easy-out and the common-ground
sentence had already been rewritten (they are pinned as Class P in
`scripts/draft-specimen-test.ts`). **The follow-up opener had not**, and it
carried F8's own fault - a weekday nobody gave:

**Before:**

> `- Say things directly. Cut throat-clearing: "I wanted to reach out", "I wanted to follow up", "I just wanted to say". "Following up on my note from Tuesday" beats "I wanted to follow up on my note from Tuesday": what to copy there is the deletion, not the sentence.`

**After:**

> `- Say things directly. Cut throat-clearing: "I wanted to reach out", "I wanted to follow up", "I just wanted to say". The shape to copy is the deletion: open on the follow-up itself rather than on wanting to follow up, and name when the first email went out only if this email gives the date.`

The three throat-clearing phrases stay quoted - Class N, and the test pins them.

**This rule is genuinely vaguer than it was, and it is the one trade-off in this
change worth arguing about.** The "X beats Y" contrast taught the deletion in
one glance: two sentences differing by four words, with the difference being the
whole lesson. The replacement describes the deletion instead. Removing it also
removes the one place the stack showed what a *good* follow-up opener looks
like, at the same time as F8 removed the format's version of the same sentence -
so the drafter now gets the instruction twice and the demonstration never. If
openers get worse rather than more varied, this is the line to put back, as a
contrast with **no date in either half** (`"Following up on my note" beats "I
wanted to follow up on my note"`), which keeps the lesson and drops the invented
specific. I did not do that here because a four-word quoted fragment is still a
printed opener, and D11's measured result is that printed openers get pasted.

Not changed, deliberately: `"a fellow Duke alum"` (Class S, and
`guardRevision`'s shared-school regex keys on that rendering - rewriting it
would make the reviewer phrase a shared school in words the guard reads as
"dropped the shared school" and throw the edit out), `"My name is ..."`, and
every Class-N phrasing.

## D11 item 4 - the global rule

Already present at the top of `VOICE_RULES`, and asserted by the specimen test
in both prompts:

> `- READ THE QUOTED PHRASINGS AS SHAPES. Every phrasing quoted in these rules is an illustration of a shape, never a phrase to use. ... If a sentence you write matches any wording quoted in these rules word for word, rewrite it in words built from this email.`

The test now also asserts it survives into the **assembled drafting prompt**,
not only into the constant.

## F4 - `offer_extension` replying to a "no" demanded three hidden fields

`activeFields()` hides `requestedDate`, `extensionReason` and `otherFirm` behind
`showWhen: extensionStage is ["asking"]`, while three unconditional steps asked
for all three and one buried note said to do the opposite.

**Before** (steps 2-4 of 6):

> `Ask clearly for a specific new date, not "a little more time"`
> `Give a short, honest reason, without naming the other firm unless you choose to`
> `Reassure them it's not a negotiating tactic and you aren't shopping the offer`

**After** (steps 2-3 of 5):

> `If this email is the ask: ask clearly for the specific new date THIS EMAIL gives, not "a little more time", give the short honest reason it gives, name the other firm only if it names one, and say plainly this is not a negotiating tactic and you aren't shopping the offer`
> `If this email replies to a no: accept it with no second attempt, confirm the original deadline in writing, and keep it short`

The said-no branch now has a step of its own instead of one note against three
steps, and the asking branch's facts are tied to the section that holds them.

## F5 - the same bug in four more types

**`coffee_in_person_reply`** - `coffeeSpot` is hidden on the confirming branch,
and `GAP_RULES` was leaving `[a spot near their office]` in a reply whose only
job was to say yes to a time they already named.

Before: `Offer two or three days, or accept the place and time they named` /
`Suggest a specific spot near their office, and offer to go wherever is easiest for them`

After:

> `If they named a place and time: confirm both exactly as THIS EMAIL gives them, and stop there`
> `If they did not: offer the days and times THIS EMAIL gives, suggest the spot it gives near their office, and offer to go wherever is easiest for them - never invent a cafe, a street or a day`

**`referral_ask`** - the costly one: `attachResumeIfMentioned: true` means a step
that makes the drafter write "my resume is attached" **actually attaches it**, on
the follow-up whose note says not to mention it.

Before: `Make it easy: attach the resume and include a two-line summary they can forward`
After: `For a first ask, make it easy: say the resume is attached and include a two-line summary they can forward. On the one follow-up after they said yes, no summary and no mention of the resume`

**`thank_you_offered_help`** - same attachment mechanism, `offerType = none`.

Before: `Thank them for the specific offer they made, in their own terms` /
`Make the offer easy to act on: attach the resume, or include a short blurb they can forward`

After:

> `If they offered something: thank them for that specific offer, in their own terms, and make it easy to act on - say the resume is attached, or include a short blurb they can forward`
> `If they offered nothing: say plainly you aren't asking for anything else, and don't attach or mention the resume`

**`redirect_sequence`** - three emails' steps rendered for whichever one is being
written. The notes are already filtered in code (`draft-prompt.ts:718-726`); the
format was not.

Before:

> `Thank the first person for the redirect specifically, not generically`
> `Ask whether they'd prefer to introduce you or whether you should write directly`
> `In the email to the new person, lead with the first person's name in the first sentence`
> `Close the loop with the first person once the conversation has happened`

After:

> `Only the email THIS EMAIL names gets written. The three steps below are one per email; follow the one that matches and ignore the other two`
> `Thanking the first person: thank them for the redirect specifically, not generically, and ask whether they'd prefer to introduce you or whether you should write directly`
> `Emailing the new person: lead with the first person's name in the first sentence`
> `Closing the loop: tell the first person how the conversation went, now it has happened`

Each step now opens with the **same label the surviving note opens with**
(`STEP_NOTE` in `draft-prompt.ts`), so the one note that reaches the prompt and
the one step that applies to it read as a pair.

### Why `formatBlock` was NOT made to branch

The audit's preferred fix is to extend the `STEP_NOTE` filter to the format.
**READ - rejected here, with the reason.** `formatBlock`'s output is the whole
per-type cache tier, and `scripts/draft-tiers-test.ts` asserts that tier is a
pure function of `(lead type, word ceiling)`: 53 distinct values, 41 reachable
lead types, 12 extra keys and every one of them a ceiling a box mix stretched.
Filtering the format by a select answer makes it a function of the student's
answers instead - the tier stops being cacheable across requests for the one
type, three of those assertions fail, and `--capture` cannot fix them because
they are structural, not fixture-based. That is the caching this branch exists
to buy, spent on one type.

Labelling the steps costs nothing and keeps the tier intact. What it does not
buy: the drafter still **sees** two emails' steps it must ignore, where a filter
would not show them at all. Step 1 and the matching note are what stand between
that and a drafted paragraph belonging to the wrong email. If output shows the
other branches leaking in, the filter is the fix, and it should be taken
together with the tier assertions and the 41-key flag, not slipped in under them.

## F6 - `thank_you_event` was the one thank-you sibling with no "no ask" clause

`thank_you_recruiter_session` carries it in the step itself; that shape is copied.

Before: `Ask one small follow-up question, or ask for a short call`
After: `Ask one small follow-up question, ask for a short call, or none at all - whichever THIS EMAIL names`

Before: `... One short paragraph plus the ask. ` + `TONE_NOTE`
After: `... One short paragraph, plus the ask when there is one. ` + `TONE_NOTE`

New note: `With nothing to ask, say plainly the student just wanted to say thank you, and end there.`

**`thank_you_chat`**, F6-adjacent (2 unconditional ask steps against 1 brief
line), gets the same conditioning:

Before: `Say your interest has grown and ask about next steps` /
`Ask whether you should talk to anyone else, or for a specific introduction`

After:

> `Say your interest has grown, and ask about next steps only if THIS EMAIL names an ask`
> `If THIS EMAIL asks for one: ask whether you should talk to anyone else, or for a specific introduction. With no ask, end on the thanks and ask for nothing`

## F10 - optional fields an unconditional step demanded

`accept_offer`'s own clause is the model: condition the step, never invent.

| Type | before | after |
|---|---|---|
| `decline_offer` | `Say something genuine about the people you met` | `Say something genuine about the people you met, if THIS EMAIL names any - never invent a name` |
| `not_now_reply` | `Name when you'll follow up, so the later email is expected rather than intrusive` | `Name when you'll follow up if THIS EMAIL gives a time, so the later email is expected rather than intrusive; with no time given, say you'll check back without naming a date` |
| `professor_recommendation` | `Name the program, the deadline, and exactly how the letter is submitted` | `Name the program, the deadline, and exactly how the letter is submitted - each one only if THIS EMAIL gives it` |
| `recorded_round_note` | `Reference the content lightly, since there was no conversation to draw on` | `If THIS EMAIL describes the content, reference it lightly, since there was no conversation to draw on` |

`decline_offer` was the one that mattered: with no names given the drafter had to
invent one (`HOUSE_RULES`: never) or bracket it, in an email turning down an offer.

---

## `KNOWN` entries cleared

`scripts/audit-probe/formats/format-facts-test.ts`, 11 to 4.

**Five fixed here**, all under check 3 (a step demanding a fact the student's own
answer hides). Every replacement step opens with its condition, which is what
the check reads:

```
hidden/offer_extension/requestedDate        F4
hidden/offer_extension/extensionReason      F4
hidden/offer_extension/otherFirm            F4
hidden/coffee_in_person_reply/coffeeSpot    F5
hidden/thank_you_event/eventAsk             F6
```

Check 3 now has **no** exemptions at all, so the next type that does this fails
the build.

**Two removed as stale, not fixed by me:**

```
unsupplied/recruiting_inbox/graduation date
unsupplied/recruiter_outreach/graduation date
```

Both format steps already ask for a graduation **year** and carry the no-month
clause in the step itself (`draft-templates.ts:334`, `:439`) - fixed upstream of
this change. **MEASURED:** deleting the two entries leaves the test green, so
they were exempting a pattern that no longer occurs, and an exemption that
matches nothing hides the next real instance. Removed.

**Four left, none of them mine:**

```
bracket/interview_check_in/[Role]                  F9a - still open
bracket/professor_recommendation/[Last name]       F9b - still open
bracket/follow_up_1/[original subject line]        F11 - dead, kept on purpose
bracket/follow_up_2/[original subject line]        F11 - dead, kept on purpose
```

F9a/F9b are bracket-in-a-greeting-or-subject findings, not prompt-coherence
contradictions, and F11's two are documented in the test as dead (`finishDraft`
overwrites a follow-up's subject from `brief.originalSubject`, which
`draft-request.ts:361` refuses to submit without). **READ:** the F11 quotes still
demonstrate that writing a bracketed subject is normal output, and they do reach
the `custom` dump where no override applies - a one-line deletion in each, worth
doing, left alone here because it is outside this change's scope.

## The ratchet, extended

`scripts/draft-specimen-test.ts`, 43 assertions to 54. New:

1. **The de-quoted specimen is pinned**, as `'"Following up on my note from
   Tuesday" beats'` rather than as the bare phrase. Deliberate: `REVIEW_SYSTEM`
   still quotes the bare phrase as a Class-N example of a glued-together opener,
   where it belongs, and a Class-P entry for the bare phrase would fail on a
   prompt this change is not allowed to edit. Pinning the frame pins the thing
   that was wrong - a positive specimen - and leaves the negative alone.
2. **Seven banned lines may not appear in any type's `format`**: the four stock
   courtesy lines `VOICE_RULES` bans by name, the `work around their schedule`
   paraphrase the steps actually used, and F8's `in case it got buried` and
   `from last week`. Checked over `format` only, not `promptNotes`: the numbered
   format tells the drafter what to write, so a line printed there is an
   instruction, while a note may quote one as wrong - `OTHER_FIRST_EMAIL_NOTE`
   deliberately does, and that is Class N.
3. **No format step may quote a run longer than six words.** Six is the longest
   quoted run left in all 41 formats (`interview_check_in`'s subject), so this is
   a ratchet at today's value, not a round number. F8's quote was 13.
4. **The global specimen rule must survive into the assembled drafting prompt**,
   not just into the `VOICE_RULES` constant.

## The tier fixture was re-captured, on purpose

`scripts/draft-tiers-test.ts` compares every one of the 148 system prompts
against a byte fixture, and format text is inside the per-type tier, so all 148
rows failed by design.

Before capturing, both versions of the prompt stack were dumped in full - all
148 prompts, from this tree and from a `git archive HEAD` copy - and diffed:
**26 distinct new lines replacing 27**, every one of them an edit listed above,
plus the renumbering of `offer_extension`'s last two steps where its format went
from 6 steps to 5. No other line in any prompt moved. Then:

```
$ npx tsx scripts/draft-tiers-test.ts --capture
captured 148 system prompts; distinct sha256: 102
$ npx tsx scripts/draft-tiers-test.ts     # 33 passing, 0 failing; exit 0
```

The structural assertions, which `--capture` cannot touch, all still hold:
**invariant tier 1 distinct value**, per-type **53** values (41 lead types + 12
ceilings a mix stretched), per-request **102**, **no tier empty** on any of the
148. The invariant tier grew 9,199 to 9,226 chars (`VOICE_RULES`, 3,153 to 3,180);
the cached prefix for a cold mix moved 9,753-33,367 to 9,780-35,458 chars.

## Verified by exit code

```
scripts/draft-review-test.ts                      exit 0   148/148
scripts/draft-specimen-test.ts                    exit 0   54/54
scripts/draft-tiers-test.ts                       exit 0   33 passing, 0 failing
scripts/draft-bug-hunt.ts                         exit 0   147/147
scripts/draft-occasions-test.ts                   exit 0   0 failures
scripts/audit-probe/gradmonth-test.ts             exit 0   41/41
scripts/audit-probe/formats/format-facts-test.ts  exit 0   41/41, 4 known
scripts/draft-occasions-sim.ts lint-examples      exit 0   3 findings (exactly 3)
npx tsc --noEmit                                  exit 0
```

## Left undone, with reasons

- **F1, F2, F3** (`cold_email`'s alumni database, `recruiter_scheduling_reply`'s
  time zone, the graduation-date demands) - **already fixed in `HEAD`**, read and
  confirmed in the current format bodies. Nothing to do.
- **F9a, F9b, F11** - bracket findings, not coherence contradictions, and not in
  this change's scope. F11's two dead subject quotes are a cheap deletion worth
  taking next; see above.
- **The examples.** `follow_up_1` is shown the flexibility line in 6 of its 7
  examples and 42 examples carry it overall - the instruction is gone, the
  demonstration is not, and the demonstration is the stronger of the two.
  `email-examples*` was reverted this session and belongs to another agent.
  Until it is fixed, F7's instruction-side fix removes the contradiction but
  should not be expected to remove the line from output on its own: the
  reviewer will still be stripping it, just no longer on the format's orders.
- **The standalone `Mention your attached resume (you attach it when you send)`
  steps** (five cold types). Not a contradiction - the step asks for the
  mention, not for the banned sentence - so they were left as they are. If
  `I attached my resume for your reference` keeps appearing (65 of 300 drafts
  once did), the same constraint clause belongs there too.
- **`referral_ask` step 2** (`Say you've applied, or are about to, naming the
  role and requisition number`) still renders on the follow-up branch.
  `roleAndReq` is **required** in both branches, so there is no hidden field and
  no gap; the note's prohibitions are about a new pitch, a summary and the
  resume, none of which that step asks for. Left alone as a judgement call, not
  an oversight.
- **The audit probes** (`rules-vs-format.ts`, `hidden-fields.ts`, `siblings.ts`)
  still carry regexes written for the old strings. Left as they are on purpose:
  a probe that now reports zero is the evidence the fix landed.
