# FIX-PROMPT — the prompt construction and the type definitions

Fixes for the nine defects LOGIC-3 and OUTPUT-2 found in `src/lib/draft-prompt.ts`
and `src/lib/draft-templates.ts`, plus one open security hole in the same file
(the section-forgery gap recorded as closed in `ac8a0d6` and reopened by the
overseer). Written 11 October 2026 in the worktree
`.claude/worktrees/draft-pipeline-perf`, branch `perf/draft-pipeline`.

**Files changed:** `src/lib/draft-prompt.ts`, `src/lib/draft-templates.ts`,
`scripts/draft-fixtures/system-tiers-baseline.json` (re-captured, see the end),
and two new tests: `scripts/audit-probe/fix-prompt-test.ts` and
`scripts/audit-probe/input3/forge-test.ts`. Nothing outside those was touched.

**Red-green method.** One test holds all ten items, each assertion naming its
audit item. The cycle, verbatim:

| state | `fix-prompt-test.ts` | `input3/forge-test.ts` |
|---|---|---|
| first run, at `ac8a0d6`, before any fix (150 assertions then) | **92/150 passed, 58 failing** | — |
| with the fixes | **154/154 passed, 0 failing** | **1045/1045 passed, 0 failing** |
| both source files reverted to `HEAD`, the final tests kept | **95/154 passed, 59 failing** | **803/1045 passed, 242 failing** |
| restored | **154/154 passed, 0 failing** | **1045/1045 passed, 0 failing** |

(150 → 154 is four assertions added during the work, for the two false positives
the audit's own probes caught in a first draft of the fix — see items 2 and 6.
`forge-test.ts`'s red was produced by putting the two shipped layers of
`keepInSection` back while keeping `PROMPT_SECTIONS` exported, since a full
revert of the file leaves the new test unable to import it.)

---

## 1. `conference_follow_up` fell through the cold switch (LOGIC-3 F1)

**Reproduction.** `briefLines`' first `case` group was keyed on four literal type
ids; five types carry `isCold`. `npx tsx scripts/audit-probe/logic3/coldgap.ts`
before:

```
conference_follow_up   purpose=NO   financeInterest=NO   wantToLearn=NO   commonGround=NO
```

**The fix.** The group is now `if (type?.isCold)`, lifted out of the `switch` and
placed before it, so the next cold type added is correct by default. The one
sub-condition that is genuinely `cold_email`-only (the alumni-database line)
still tests the id.

One thing the fix had to avoid: `conference_follow_up`'s own promptNote already
says `Ask for 10 minutes.`, so the cold block's `Ask for a 10-15 minute call`
would have been a second, different call length in the same prompt — the exact
contradiction item 7 is about. The brief's ask line is therefore `null` for this
one type, with a comment saying why.

**Evidence.** After:

```
conference_follow_up   purpose=yes  financeInterest=yes  wantToLearn=yes  commonGround=yes
```

and in the test: all four facts reach the prompt for all five cold types, the
`Ask for a 10-15 minute call` line is absent, and `Ask for 10 minutes.` is
present exactly once.

## 2. `finishDraft` shipped two sign-offs, and one ordering deleted the body (LOGIC-3 F6, OUTPUT-2 #4)

**Reproduction.** `npx tsx scripts/audit-probe/logic3/finish3.ts` before: 14 of
23 plausible closings left the model's closing in place and appended a second
one, printing the student's name twice. `finish.ts` case G: a six-line signature
plus two P.S. lines pushed `Best,` outside the 8-line window. `finish2.ts` case
L: the em-dash rewrite ran first, turned a mid-body `Thanks again — Maya` into a
`CLOSING` match, and deleted the student's two questions.

**The fix**, three parts:

- **Order.** `//n` → paragraph break, *then* the sign-off cut, *then* the
  em-dash rewrite over the kept body only. Step 3 can no longer manufacture step
  2's match. The function's doc comment now states the order and why.
- **`CLOSING` → `isClosingLine`.** 39 closing phrases, the comma optional, the
  trailing name up to four capitalised words. Two deliberate exclusions, both
  found by the audit's own probes while testing the fix: a **dash** is not a
  closing separator (`Thanks again - Maya mentioned you` is a sentence), and
  neither is a **full stop** — reading a body paragraph of `Thanks.` as a
  sign-off deleted the whole body of a two-line email
  (`output2/dates2.ts` caught it; both cases are now pinned in the test).
- **Window → trailing block.** The 8-line count is replaced by a scan up from
  the end past the lines that can sit under a sign-off (blank, another closing,
  a `P.S.`, or a short non-sentence), and the **first** closing in that block
  wins, not the last — which is what let an earlier closing survive above the
  model's own signature.

**Evidence.** `finish3.ts` after: 23 of 23 `cut correctly`. The test asserts, for
each of 23 closings, that the name is printed exactly once and the body ends on
the rebuilt signature; that the six-line-signature-plus-P.S. body keeps exactly
one `Best,`; that the mid-body dash case keeps `What should I read first?` while
still rewriting the dash; and that `Thanks for your time and advice.` is not read
as a closing.

## 3. The subject fallback (OUTPUT-2 #5)

**Reproduction.** `output2/subject.ts` before: a model subject of `—` shipped as
`,`, and `Summer 2023—2025 recruiting` as `Summer 2023, 2025 recruiting`.

**The fix.** The subject is built in the order the fallback expects: strip the
reply prefix, apply the **body's** whole dash chain (digit-range protection and
bracket protection included, now a named `noDashes` used by both), strip
whatever punctuation the rewrite leaves at the front, and only then fall back —
treating a result with no letter or digit as empty.

**Evidence.** `subject.ts` after: `—` → `University of Pennsylvania Student
Reaching Out`; `Summer 2023—2025 recruiting` → `Summer 2023-2025 recruiting`;
`— Penn student reaching out` → `Penn student reaching out`; and all 24 rows the
audit marked CORRECT are unchanged, including every `Re:` collapse.

## 4. Graduate detection (OUTPUT-2 #1, #2)

**Reproduction.** `isGraduateStudent` said `true` for `"BS/MS Finance"` and
`"Economics (MBA pipeline)"`; the prompt then told the model to lead with a
20-year-old's "prior career" and that they recruit at associate level. Separately,
MBA + grad year 2024 printed `Graduate student (graduates 2024)`.

**The fix.** `GRADUATE_MAJOR` is rebuilt so both guards (`(?<!pre-)` and a
widened `(?<![/\w])`) sit in front of **every** alternative rather than only the
first — the `M.S. Finance` alternative had none — and a trailing lookahead rules
out an aspiration (`MBA pipeline`, `pre-MBA track`, `MBA-bound`) while leaving
`Finance (MBA)` a graduate degree. In `buildDraftPrompt`, `hasGraduated` is now
checked **before** the graduate branch, so a graduate with a past year gets the
same "Not a current student" line an undergraduate gets.

**Evidence.** `classyear2.ts` after: `BS/MS Finance` and `Economics (MBA
pipeline)` both `grad=false`, signature back to `University of Pennsylvania ’28`.
`classyear.ts` after: `Graduated in 2024. Not a current student: …`. The test
pins 7 negatives and 10 positives, plus the resume-education-line path.

## 5. `finishDraft` damaged placeholders (OUTPUT-2 #9)

**Reproduction.** `[date — time]` became `[date, time]`, so the body no longer
equalled the `gaps[].placeholder` the model reported; `[their//nGroup]` was split
across two lines and `Composer.tsx`'s `/\[[^\]\n]{2,}\]/g` stopped seeing it.

**The fix.** One helper, `outsideBrackets(text, rewrite)`, splits on
`(\[[^\]]*\])` and rewrites only the odd-indexed-out parts. Both the `//n` chain
and the dash chain go through it, in the body and in the subject.

**Evidence.** `output2/placeholders.ts` after: `brackets in` equals `brackets
out` for every bracket the rebuild keeps, including `[date — time]`,
`[2023—2025]` and `[their//nGroup]`; the test also asserts the send gate's own
regex still matches, and that text *outside* the brackets is still rewritten.

## 6. Date flagging gaps (OUTPUT-2 #7)

**Reproduction.** `11/20` and `2026-11-20` in the draft got no note; `1/2 hour`
typed by the student whitelisted both January 2 and February 1.

**The fix.** One reader, `datesIn`, returns each date with *every* month-day
reading it could carry, and it now runs over the draft as well as the input:
`\d{1,2}/\d{1,2}(/\d{2,4})?` and ISO `\d{4}-\d{1,2}-\d{1,2}` alongside the month
names. A note fires only when **no** reading was given, so one date never
produces two notes. Three deliberate boundaries, each commented:

- a literal common fraction (`1/2`, `3/4`, …) **with a word after it** is a
  quantity, not a date. The first draft of this used "denominator ≤ 16", and
  `logic3/finish.ts` case K caught it swallowing `Would Thursday 10/16 work` —
  now pinned in the test;
- links are stripped on the draft side and not on the input side, so
  `cal.com/maya/10/5` in a draft is never flagged while a booking link in the
  input still whitelists the date it carries;
- `input.now` is excluded from what counts as "entered" — today's date is not
  something the student typed;
- **natural-language dates are left alone on purpose** (`next Tuesday`, `the week
  of the 20th`). The student's phrasing and the model's almost never agree, so a
  reader for them would flag dates the student *did* give; `GAP_RULES` asks the
  model for a bracket instead. Said in the comment on `datesIn`.

**Evidence.** `output2/dates.ts` and `dates2.ts` after: `11/20`, `2026-11-20` and
`10/16` each get one note; `1/2 hour` no longer whitelists anything; and all 24
rows the audit marked CORRECT are unchanged (URLs, the signature, text the
rebuild deletes, month-without-day, one-note-per-date).

## 7. `SETS_THE_ASK` leaked and over-dropped (LOGIC-3 F7)

**Reproduction.** `npx tsx scripts/audit-probe/logic3/alsotrue.ts` before:
`Ask for 10 minutes.` survived into 6 prompts whose lead asks for 10–15
(`^Ask for a ` versus `Ask for 10`), `Name the event in the subject line.` into
6, two different openings into 12. Three *prohibitions* were dropped instead.

**The fix**, both directions:

- the filter is a documented list of 15 phrase rules joined into one regex, with
  categories the old list had none of — the opening (`^(Open|Lead) with`,
  `in the (first|opening) (line|sentence)`), the subject line
  (`in the subject line`) — and `^Ask for a ` widened to `^Ask for\b`;
- the two prohibition alternatives (`No ask of any kind`, `Never ask for a
  referral`) are **gone** from the list, so a prohibition always survives: it
  takes nothing away from the lead's ask and nothing in the lead replaces it.
  Two stored notes mixed a prohibition with a directive and could only be kept
  or dropped as a unit, so they are split in `draft-templates.ts` —
  `close_loop_referrer` into the purpose sentence and `Never ask for anything,
  including another introduction.`, and `congratulations` into `No ask of any
  kind, including "let me know if you have time".` and `Three or four
  sentences.` (`^(Three or four|Four or five) sentences` is in the list).

`recruiter_outreach`'s `Ask at most three questions…` is deliberately still
kept: `blendRules` forces the recruiter ask, as the audit notes.

**Evidence.** `alsotrue.ts` after:

```
=== ALSO TRUE lines that set the subject line: 0 occurrences ===
=== ALSO TRUE lines that set the opening: 0 occurrences ===
```

(was 6 and 12). The "sets an ask" count is now 36 occurrences over 3 distinct
lines — the deliberate recruiter line (x24) plus the two prohibitions (x5, x7)
that the probe's own heuristic counts as asks and that we now keep on purpose;
`Ask for 10 minutes.` is gone. `scripts/draft-occasions-test.ts` still reports
`0 failures`, which includes its own assertion that no surviving ALSO TRUE line
matches `SETS_THE_ASK`.

## 8. Greeting edge cases (LOGIC-3 F14, OUTPUT-2 #6)

**Reproduction.** `logic3/greeting.ts` before: `"team lead Rachel Stein"` →
`Hi Team,`; `"VP Rachel Stein"` → `Hi Vp,`; `"Dr. Amy"` → `Dear Dr. Amy," -
never their first name alone` (a contradiction in one line);
`"rachel@firm.com"` → `Hi Rachel@firm.com,`.

**The fix.** A leading job title (`JOB_TITLE`: VP/SVP/MD/Managing Director/
Director/Team Lead/Head of …/Associate/Analyst/Partner/Principal/Founder/C-level/
President/Chair/Recruiter) is stripped before the name is read, after the team
check so an inbox still wins. A bare address (`EMAIL_ADDRESS`) never reaches the
greeting: a local part that reads as one plain name is used, anything with a
dot, a digit or initials falls back to `Hello,`. And a title with only one name
after it keeps the title without claiming the name is a surname.

**Evidence.** After: `team lead Rachel Stein` and `VP Rachel Stein` both →
`Hi Rachel,`; `rachel@firm.com` → `Hi Rachel,` with "never the address itself";
`j.smith42@firm.com` → `Hello,`. All 30 rows `output2/greeting.ts` marked CORRECT
are unchanged (`Dr. Amy Adams`, `Dean Martin` vs `Dean Amy Adams`, credentials,
nicknames, angle-bracket addresses, ALL CAPS, team inboxes, "To whom").

## 9. The word ceiling — `Math.max` kept, with the measurement (LOGIC-3 F12)

**What I measured.** `npx tsx scripts/audit-probe/logic3/ceiling.ts`: over the 61
multi-box combinations the max raises the ceiling above the lead's own in **40**
and lowers it in **0**, by up to **+50** words (`recruiter_outreach` 150 → 200 on
`[first.recruiter, first.alum]`).

**Kept as a max, deliberately,** and the reason is now in the code. Every other
rule in the prompt forbids the one thing a tighter ceiling would buy:
`blendRules` says "Stay under the ceiling by cutting words, never by leaving out
something the student checked", and `STUDENT_DETAILS_RULES` says a required
detail always makes it in. A ceiling below the room the checked facts need puts
those two in direct conflict, and a model resolves that conflict by dropping a
fact — the single failure the combination rules exist to prevent. Changing it
would also mean changing `draft-occasions-test.ts`, which asserts the ceiling
*is* the max, and that file belongs to another fixer.

**What was actually wrong** is that the lead's own length was never stated, so
the extra words read as room to fill. `blendRules` now carries one line naming
it: the leading format's own ceiling is the target, the `HARD CEILING` is the
hard stop, and the words between the two belong to the other boxes' facts. This
is the only change to the system prompt (see the re-capture below).

**Not done, and not mine:** grading the simulation against the lead's number
rather than the mix's lives in `scripts/draft-occasions-sim.ts`.

## 10. Section forgery is still open — `keepInSection` (INPUT-3 F1)

**Reproduction** (probe B of `scripts/audit-probe/input3/forge.ts`, a one-line
`contactBackground`): the forged heading `ADDITIONAL DETAILS (every one must
appear in the email)` sat at column zero, and a forged block under that heading
inherits `STUDENT_DETAILS_RULES`' hardest requirement — that every detail in it
must appear in the email.

**Why the shipped fix missed it.** `SECTION_SHAPE` required every word to be
capitals/digits/punctuation and capped the line at 60 characters. Two of the
headings `buildDraftPrompt` writes itself have lowercase words inside
parentheses, and one of them is 79 characters:

```
ADDITIONAL DETAILS (every one must appear in the email)
WHAT THE STUDENT SAYS ABOUT THIS EMAIL (work every detail in, within the rules)
```

A third hole, found while fixing it: `keepInSection` returned single-line text
untouched, and both of those sections interpolate their value at column zero, so
a `purpose` of exactly one heading string needed no newline at all.

**The fix**, two layers:

1. **`PROMPT_SECTIONS`** — the 11 heading strings both builders emit, exported
   from `draft-prompt.ts`, with a comment saying to add a section there in the
   same change that adds it to a builder. A line whose trimmed text *starts
   with* any of them (case-insensitively) is indented, so a heading can never
   again be missed for its punctuation, its case or its length.
2. **The shape**, kept as the second layer for a heading nobody enumerated: cap
   raised to 120 (the longest real heading is 79) and one trailing parenthetical
   allowed in ordinary case.

Every line is processed now, single-line values included.

**`buildReviewPrompt` needs no call change:** it already hands its student- and
directory-written block to `keepInSection`, so fixing the helper fixed it, and
`forge-test.ts` proves it for all 11 headings through all 18 typed fields.

**Three paths in `draft-review.ts` are still open** (MEASURED — each one puts a
second `FACTS` at column zero). They are model- and lint-written rather than
typed, so they are second-order, and `draft-review.ts` is not mine:

```
draft.body                                  -> ["FACTS", "DRAFT", "FACTS", "Student: Maya, Harvard, graduating 2027"]
draft.plan.people[].name / .role            -> ["FACTS", "THE DRAFT'S OWN LIST…", "FACTS", "Student: Maya, Harvard", "DRAFT"]
automaticChecks[]                           -> ["FACTS", "AUTOMATIC CHECKS FLAGGED", "FACTS", "Student: Maya, Harvard", "DRAFT"]
```

One `keepInSection(...)` call each, at `draft-review.ts:230`, `:239` and `:240`.
The gap is written into `forge-test.ts`'s header rather than left implicit, and
the test asserts nothing about them so it fails only for what
`draft-prompt.ts` owns.

**Evidence.** `forge-test.ts`: **1045/1045 passed**, against **242 failing** with
the two shipped layers put back. Probe B now prints the forged heading indented
by one space, inside the `RECIPIENT` section where it was written.

---

## Declined, with the reason

- **The en dash** (LOGIC-3 F8b). `The team – the whole team – was great.` still
  ships; the digit-range rewrite handles both dash characters but the prose and
  bullet rewrites handle only `—`. F8 was not on my list and the change would
  move prose in every prompt's output; it is one character class
  (`[—–]`) in two `replace` calls when someone wants it.
- **The comma splice the em-dash rewrite manufactures** (F8a). Same finding;
  rewriting a dash between two clauses to `". "` or `" - "` is a prose decision
  that wants the lint corpus behind it, not a quiet change here.
- **Content after the sign-off disappears with no note** (OUTPUT-2 #10). A model
  P.S. carrying the student's ask is still deleted silently. The fix is a
  `notesForStudent` line, and `notesForStudent`'s filter lives in
  `draft-pipeline.ts`, which is another fixer's file; doing half of it here would
  add a note that filter may then strip.
- **A fabricated `Re:` on a non-reply type** (OUTPUT-2 #8). `finishDraft` trusts
  `brief.threadSubject` for every non-`repliesInThread` type. Gating it on the
  type actually collecting a thread subject needs the field list in
  `draft-templates.ts` *and* the request wiring in `draft-request.ts`, which is
  another fixer's; latent today (no cold type collects the field).
- **The notes filter** (OUTPUT-2 #6) and **the subject length cap / newline
  strip** (#11, the composer's side) are in files I do not own.
- **A one-word remainder after a title** now keeps the title rather than emitting
  nothing, which is not literally what F14's fix text suggested: emitting nothing
  hands the model the house default `Hi {first name},` over a name whose first
  word is `Dr.`, which is worse than an instruction that keeps the title and
  says the one name may be either name.

## The re-captured fixture

`scripts/draft-tiers-test.ts` asserts byte-identity of the system prompt against
`scripts/draft-fixtures/system-tiers-baseline.json`. **I re-captured it**, after
confirming the diff was exactly what I intended and nothing else:

- 87 of 148 prompts were byte-identical; the 61 that changed are exactly the 61
  multi-box combinations;
- every one of the 61 differed by exactly **+226 characters**
  (`npx tsx scripts/draft-tiers-test.ts | grep -oE "chars [0-9]+ vs [0-9]+" |
  awk '{print $2-$4}' | sort | uniq -c` → `61 226`), which is the length of the
  one `blendRules` line added by item 9 plus its newline, for a three-digit
  ceiling. No other delta appeared;
- nothing else in the system prompt moved: items 1, 7 and 10 change `userText`
  and the promptNotes, which the fixture does not cover, and item 9's comment is
  a comment.

After the re-capture: `148/148 byte-identical`, `33 passing, 0 failing`,
invariant tier **1 value**, per-type 53 values, per-request 102 values, no tier
empty.

## Runs

```
draft-tiers-test                 33 passing, 0 failing · byte-identical 148/148
draft-review-test                139/139 passed
draft-occasions-sim lint-examples 42 Volume V examples linted, 3 findings
draft-bug-hunt                   147/147 passed, 0 failed
draft-occasions-test             0 failures
audit-probe/gradmonth-test       41/41 types: no unfillable graduation-month request
content-limits-test              162/162 passed
npx tsc --noEmit                 clean (exit 0, no output)
audit-probe/fix-prompt-test      154/154 passed, 0 failing
audit-probe/input3/forge-test    1045/1045 passed, 0 failing
draft-guard-note-test            13/13 passed
draft-specimen-test              43/43 passed
draft-stream-test                125 passing, 0 failing
```
