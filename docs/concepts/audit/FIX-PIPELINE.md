# FIX-PIPELINE — the pipeline and the request path

What was fixed in `src/lib/draft-pipeline.ts`, `src/lib/generate-draft.ts`,
`src/app/(app)/drafts/draft-request.ts` and `src/app/(app)/drafts/actions.ts`,
against the findings in `OUTPUT-3-safety.md`, `INPUT-2-profile.md`,
`LOGIC-3-flow.md`, `OUTPUT-2-artifacts.md` and `INPUT-3-hostile.md`.

**One new test file**, `scripts/draft-pipeline-flow-test.ts` — 64 assertions,
no API call and no database (a stub Anthropic client, the same pattern as
`scripts/draft-guard-note-test.ts`):

```bash
npx tsx scripts/draft-pipeline-flow-test.ts
```

It lives apart from `draft-review-test.ts` for the reason
`draft-guard-note-test.ts` does: the review's own tests were being edited in the
same session, and these are the pipeline half. Its blocked-language cases use
**profanity, not a slur** — same word list, same `findBlockedLanguage`, same code
path, and no reason for this repository to carry a slur to prove it.

## Does any of this change what a student sees on a page?

**Yes — five of the twelve do, so `npm run help:learn` is owed before this
branch merges.** Named plainly, because the regenerated knowledge has to match:

| # | What changes on the screen |
|---|---|
| 9 | A new line in the composer's "Before you send" panel whenever the email was not checked against the student's facts: *"We couldn't double-check this email against your profile and what you typed. Read it over before you send it."* |
| 3 | The set of notes in that panel changes: six ordinary phrasings of "attach your resume" / "your signature is added automatically" stop appearing, and two notes that were being deleted now appear (a note about the **recipient's** signature block, and "attach your resume to the firm's portal, not to this email"). |
| 2 | The **drafted email itself** changes for 28 of the 41 types. They were told the student had no resume; they will stop adding "upload a resume on your profile" notes, and may now offer or mention the resume where the type allows it. |
| 11 | A student who has spent their monthly resume-review allowance and attaches a resume **to the draft form** now gets that allowance's message instead of a silent extra model call. |
| 12 | A malformed recipient id now returns *"Couldn't find that person. Choose who this email is for again."* instead of a 500. |

Items 1, 4, 5, 6, 7, 8 and 10 change nothing a student reads, except that 10
silently truncates a pasted answer past 2,000 characters (4,000 for "what this
email is for" and "anything else to include").

## Red–green, per item

Each fix was reverted on its own with
`scratchpad/redgreen.py` (a scripted reverse-patch, run, restore) and the test
re-run. Every item is listed with the assertions that go red when it is undone;
with all twelve in place the file is **64/64**.

| # | Reverted → | Red assertions |
|---|---|---|
| 1 | gate back to subject+body | 7 — the drafter's note, the reviewer's `fix`, the reviewer's `quote` echo, the archived problem, the gap, `connectionUsed`, the plan sentence |
| 2 | `resumeOnFile: Boolean(resume)` | 1 structural (the behavioural pair is red by construction: **28 of 41** types contradicted themselves, 0 after) |
| 3 | old `APP_HANDLES` regex | 2 — 6 app-handled notes leak, 2 useful notes lost |
| 4 | retry gate back to `elapsed < 60_000` | 1 — the retry is refused at every point in the 50–80 s band |
| 5 | `await callReview()` without its own catch | 3 — problems, rejection reason and the student's warning all lost |
| 6 | no request options on the review | 3 — no timeout, no budget ceiling, SDK retries on |
| 7 | review tokens summed into the draft's, classifier always "capacity" | 5 |
| 8 | the four `reviewGap` assignments removed | 8 |
| 9 | the note suppressed | 4 — the four routes to an unreviewed draft |
| 10 | `field()` trims only | 2 |
| 11 | the allowance gate removed | 1 (`gateAt: -1`) |
| 12 | the id guard disabled | 3 |

A whole-file revert to `HEAD` is red too, but uninformatively: the test imports
`retryFitsBudget`, which does not exist there, and dies on import. The two
**structural** assertions (items 2 and 11) were checked against `HEAD`'s source
directly instead:

```
HEAD  uploadAt 13243        <- the resume read
HEAD  followUpGateAt 15610  <- a check that can still refuse the request
HEAD  gateAt -1             <- no resume-review allowance gate at all
```

The read sat **before** a gate that can refuse the request, and there was no
allowance gate. Both assertions are red at `HEAD`.

---

## 1. `notesForStudent` reached the student ungated (OUTPUT-3, MEDIUM)

**Reproduction.** `findBlockedLanguage` was called on exactly
`` `${draft.subject}\n${draft.body}` ``. Three model-written strings went round
it and rendered in the composer: the drafter's `notesForStudent`,
`problems[].fix` when the edit was applied, and `problems[].quote` echoed as
`Check this before sending: "…"` when it was rejected. No model misbehaviour is
needed — the prompts *instruct* the model to narrate removals into a note, and a
homoglyph slur clears `blockedInForm`, so the model obeys the house rule, keeps
the word out of the email and writes it into a note in plain ASCII. The app then
says it back to its own user, in its own voice, on an authenticated page.

**Fix.** Every string the pipeline hands back is checked, not two. The decision
the brief asked for, and why:

- **The email (subject and body) fails the draft** — unchanged. It is the
  artifact the student asked for and the thing that goes to a real person; there
  is no version of it worth keeping with a slur in it, and no part of it can be
  dropped without handing back an email nobody wrote.
- **Everything else is dropped.** The note, the gap, the review problem go; a
  blocked `connectionUsed` becomes `null` (already a documented valid outcome);
  a blocked guard reason becomes the fixed string `"the edit was rejected"`
  (replaced rather than removed, because dropping the field would make a
  rejected edit read as an accepted one).

  Dropping, not failing, because **the email is already clean**. Failing the
  request would cost the student a draft off their monthly allowance and both
  model calls behind it, in exchange for one advisory sentence the app can
  simply not show. It is also what the sibling feature already does with a
  model-written string (`draft-suggestions-ai.ts:148`).

  One detail worth stating: dropping a **gap** loses the question but not the
  warning — the bracketed placeholder stays in the body, so Composer's own
  unfilled-placeholder gate still stops the send. Asserted in the test.

A count of what was dropped is logged (`[draft] dropped N model-written
string(s)…`) and never the string itself: that log line is the one place that
knows the word, and repeating it there is the same mistake one layer down.

**Declined, with the reason:** `preReview` is **not** gated. It is the record of
what the drafting model wrote before the review edited it, it is never shown to
a student and never sent to anyone, and blanking it would destroy the only
evidence that the review removed something — which is exactly the case worth
keeping. It is sealed into the encrypted archive, under consent
(`mayTrainOn`), and that is where it should stay.

**Reported, not fixed:** `studentNotesFromReview` (`draft-review.ts`, not mine)
still builds the rejected-path note by echoing the model's `quote` verbatim. The
pipeline now gates the result, so nothing reaches the student — but the audit's
other suggestion, rewording to `Check what the review flagged before sending.
${p.fix}`, belongs in that file.

## 2. `resumeOnFile` was wrong for 28 of 41 types (INPUT-2 F1)

**Reproduction.** The resume file was read only for types carrying
`attachResume` / `attachResumeIfMentioned` — **13 of 41** — and
`resumeOnFile: Boolean(resume)` was therefore `false` for the other 28, so
`briefLines` emitted *"The student has no resume on file… add a note to upload a
resume"* in the same prompt that quoted their resume summary. Measured here and
matching the audit exactly:

```
types: 41; read the bytes: 13; contradicted before: 28; contradicted after: 0
custom among them: true
```

**Fix.** `findStudentResume(user.id)` is now called unconditionally — one cheap
row read — and `resumeOnFile` is `Boolean(onFile) || Boolean(resumeSummary)`.
The **bytes** stay gated behind the attach flags exactly as before. The summary
counts too: the prompt quotes it, so saying there is no resume would contradict
the block above it. The post-generation `mentionsAttachedResume` read reuses the
same lookup instead of repeating it.

## 3. `APP_HANDLES` kept what it should strip and stripped what it should keep (OUTPUT-2 #3)

**Reproduction.** `npx tsx scripts/audit-probe/output2/notes.ts`, 25 realistic
notes in. Before: 14 out, with six app-handled phrasings leaking
("Remember to attach a copy of your resume.", "Don't forget your resume.",
"Please attach your résumé.", "Add your resume as an attachment.", "Your email
signature will be added automatically…", "I didn't add your phone number.") and
two genuinely useful notes deleted. After: **25 in, 10 out**, every one correct.

**Fix.** Matched on **subject**, not phrasing — three subjects, each written with
the exception that proves it is the subject being matched:

1. **Attaching the student's resume to this email.** A resume word, an
   attachment word, and no other destination. "Attach your resume to the firm's
   application portal, **not to this email**" names another destination, so it
   survives — it is the one case where the student really must act.
2. **The student's own email signature.** A possessive within range of the word
   "signature". "**Her** signature block says she has moved to the London
   office" has none, so it survives.
3. **The contact lines under the sign-off, as an omission** — a negation, then
   an include/add/put, then the student's phone/email/number/address. Only as an
   omission: `Double-check "October 5" - that date wasn't in what you entered.`
   has the negation and no verb, so it survives.

The guard's proper-noun note still survives (`draft-guard-note-test`, 13/13,
including its own assertion that the note is not stripped as resume
boilerplate).

**Not fixed, and not in scope:** note dedupe is still case-sensitive, so
`"Attach your unofficial transcript before sending."` and its lowercase twin
both survive (OUTPUT-2 §6 calls this UGLY-BUT-SAFE and it is unchanged).

## 4. The retry's dead band (LOGIC-3 F2)

**Reproduction.** The gates read different clocks: the skip gate tested drafting
alone against 80 s, the retry gate tested drafting **plus lint plus a whole
review** against 60 s. With `reviewMsMean` ~10 s the retry was unreachable for
any draft between ~50 s and 80 s — a 30 s band, 37.5% of the admissible range,
and the band where the retry matters most (it rescues 15 of 19 first-turn guard
rejections). In the test:

```
oldRule false at 50s, 60s, 70s, 79s of drafting   newRule true at all four
```

**Fix.** Both gates are cut from one budget. `PipelineConfigs` gains
`requestBudgetMs`, and `generate-draft.ts` passes `120_000` — the outreach
page's own `maxDuration`. The retry gate is now the exported pure function
`retryFitsBudget`, which asks whether what is left of the budget holds another
review **as long as the one just timed** (`reviewMs`, falling back to
`ASSUMED_REVIEW_MS = 18_000` before one has been timed), with
`WRAP_UP_RESERVE_MS = 5_000` held back for the deterministic fixes, the gates
and the caller writing the row.

`reviewSkipAfterMs: 80_000` is **deliberately left explicit** at the figure the
measurements were taken at rather than derived from the budget, so this change
moves the retry window and nothing else. Deriving it would have raised it to
~100 s, which may well be right but is a behaviour change nobody has measured.

`reviewRetryBeforeMs` still works as a flat override, which is what the harness
drives (`--retry-before`); with neither field the old 60 s default applies, so
the CLI evaluation and the tests behave as before.

**Noted, as asked:** the production retry window **has never been exercised by a
measurement**. Every retry figure in the repo was taken with
`--retry-before=600000`, ten times the old default, and
`reviewRetrySkippedForTime` is recorded as DEGENERATE. The doc comment on
`reviewRetryBeforeMs` says so, for whoever changes these numbers next.

## 5. A throwing retry discarded the first turn (LOGIC-3 F3)

**Reproduction.** The retry's `await callReview()` sat in the first call's `try`,
so a 529 on the second turn jumped to the outer catch and overwrote `review`
with `{ problems: [], applied: false, error }`. Measured side by side: retry
fails the guard → 2 problems and 1 student warning kept; retry **throws** → 0
problems, no warning, `rejected` undefined. A transient capacity blip on the
retry was strictly worse than never retrying.

**Fix.** `.catch()` around the retry alone, returning `{ out: null, stop: null }`
so the existing `if (retry.out)` branch keeps the first turn's outcome. Three
lines, as the audit said. The test asserts all three survivors: the problems, the
rejection reason, and the student's "credit team" warning.

## 6. The review was unbounded (LOGIC-3 F4)

**Reproduction.** `new Anthropic()` overrides neither default — `timeout` 10
minutes, `maxRetries` 2. The skip gate bounded the draft; nothing bounded the
review, so draft 79 s + review 50 s = 129 s against `maxDuration = 120` and the
student got nothing: the exact outcome the skip gate's own comment exists to
prevent.

**Fix.** The review call carries `{ timeout: reviewTimeoutMs(…), maxRetries: 0 }`.
`reviewTimeoutMs` is exported and pure: what is left of the budget minus the
reserve, floored at 5 s (a timeout the call cannot meet is no review plus a
wasted request) and capped at 120 s so a caller passing no budget is still
bounded by something other than ten minutes. At a 120 s budget: 55 s left at the
60 s mark, 5 s at the 118 s mark.

`maxRetries: 0` because a retry inside the timeout spends the student's
remaining time on the same call, and the review already degrades cleanly to an
unreviewed draft — that is the better trade this late in a request.

**Declined, with the reason:** part 3 of F4 — `started` resetting when
`callWithFallback` re-runs the whole pipeline on the next model — is **not**
fixed. `requestBudgetMs` does not help: the second invocation is a fresh
`runDraftPipeline` with a fresh `started`, so it believes it has the whole
budget. Fixing it needs `ai-runner.ts` to thread an absolute start time through
`callWithFallback` into the callback, which is not one of these four files.
Reported below.

## 7. The review outside everything that watches a call (LOGIC-3 F10)

**Reproduction (b).** The catch did not discriminate: `retrythrow.ts` case D fed
the review a 400 on our own payload and it took the same path as a capacity
blip, logged only to `console.error`. A permanently broken review request
degrades **every** draft to unreviewed, forever.

**Fix (b).** `classifyReviewError` splits the catch into `capacity` and
`request_invalid`, on the error's `status` and, failing that, a leading status
code in its message (the SDK carries `status`; a re-wrapped error may not, and
the stub tests throw plain `Error`s). A `request_invalid` is loud and says what
it means:

```
[draft] REVIEW REQUEST REJECTED - not a capacity problem. Every draft ships unreviewed until this is fixed.
```

Capacity drops to `console.warn`. The draft still ships either way: losing a
student's email to our own bug would be worse. It is classified here rather than
with `ai-runner`'s `isCapacityError` because `draft-pipeline.ts` is deliberately
not `server-only` — the CLI evaluation imports it — and `ai-runner` is.

**Reproduction (d).** The review's tokens were added into the same `usage`
object the draft's were, and `generate-draft` handed that sum to `runAiFeature`,
which writes one `ai_usage` row whose `model` column is the model the **draft's**
fallback walk landed on. The row's three columns described two different calls at
two different rates.

**Fix (d).** `PipelineResult` gains `draftUsage` (the draft call alone) and
`reviewUsage` (`{ model, input_tokens, output_tokens }`, under the model that
served it). `usage` **keeps its documented meaning** — both calls together —
because that is what it has always meant and `draft-review-test` asserts it.
`generate-draft.ts` now hands `runAiFeature` the **draft's** usage, so the row's
model and its token counts finally describe the same call, and the review's cost
comes back to the caller and onto the pipeline's log line under the review
model's name.

**The trade-off, stated plainly:** a total summed from `ai_usage` no longer
includes the review's share. Before, it included it at the wrong rate under the
wrong model, which answers neither "what did drafting cost" nor "what did
reviewing cost". A durable row for the review needs a `draftReview` value in the
`ai_feature` pgEnum **and** a change to `countsTowardQuota` so it does not eat a
second unit of the student's daily allowance — a migration and an `ai-runner`
change, neither of them one of these four files. Reported below.

**Declined, with the reason:** F10(a) no fallback ladder, and F10(c)
`DRAFT_REVIEW_CONFIG` bypassing `getModelConfig`. Both need the review to become
its own `AiFeature` in `model-registry.ts` with a matching pgEnum value, run
inside its own `callWithFallback`. Same migration as above. F10(c) is latent
today (`claude-sonnet-5` accepts both `effort` and adaptive thinking; only Haiku
does not) but it would bite the moment anyone moves the review to Haiku for
cost — and (b)'s new loud log is what would make that visible instead of silent.

## 8. Observability (LOGIC-3 F17)

**Fix.** `ReviewOutcome.reviewGap?: "skipped_for_time" | "retry_skipped_for_time"
| "capacity" | "request_invalid" | "stopped"`, set at the four existing sites
(the skip gate, the retry gate, the `!out || !guard` branch, and the catch split
on the classifier), and appended to the existing `console.info` as
`· gap=<value>`. Unset when the guard accepted — asserted, so "accepted" stays
distinguishable from "no gap recorded yet".

`reviewRetryMs: null` meaning both "the guard accepted first time" and "the retry
window had closed" is what this closes: the second is now
`gap=retry_skipped_for_time` next to a `review rejected` outcome.

The same log line also now carries the review's model and tokens, which is where
item 7's attribution lives until there is a row for it.

## 9. Telling the student the email was never checked (OUTPUT-3, LOW)

**Reproduction.** Four routes to an unreviewed draft — skipped past the time
gate, a failed call, a `max_tokens`/refusal reply, and the guard discarding the
edit — and the student could not tell any of them from a clean review.

**Fix.** When `review.applied !== true`, one note:

> We couldn't double-check this email against your profile and what you typed.
> Read it over before you send it.

Added **after** the app-handled filter, because this note is the app reporting on
itself, which is precisely what that filter is for. Not added when the review is
off (`review === null`) — that is a configuration, not a failure, and no caller
in the app does it. The test covers all four routes, plus both negatives.

This is student-visible. See the table at the top.

## 10. No length cap on the generate path (INPUT-3 F3)

**Reproduction.** `field()` trimmed and nothing else, while save/send cap at
500/20,000 and the outside-recipient fields at 200/500/2,000. Measured: 100 KB
in `extraContext` plus 100 KB in `purpose` produced a 201,221-byte user message
with nothing truncated, against a monthly allowance that counts **drafts, not
tokens**, and a user message that sits in no cache tier.

**Fix.** One exported helper, `capAnswer(value, max)` — trim then slice — used by
`field()`, `purpose` and `extraContext`. `FIELD_MAX = 2_000` (matching the
outside recipient's longest field), `LONG_FIELD_MAX = 4_000` for `purpose` and
`extraContext`, the two a student may reasonably write a paragraph into.

It truncates rather than refusing: these are answers to one-line questions, no
honest answer comes near 2,000 characters, and a student who meets this limit
has pasted something by accident and would rather have a draft than an error
about a field they did not mean to fill. **The blocked-language gate reads the
whole submission, before any of this**, so truncation can never hide a slur past
it — `content-limits-coverage-test` still reports **0 missing**.

**Reported, not fixed:** the audit's second half — a
`userText.length > 30_000` invariant inside `buildDraftPrompt` — belongs in
`draft-prompt.ts`, which is not one of these files.

## 11. The unmetered model call (INPUT-2 F5)

**Reproduction.** A resume attached to the draft form ran
`replaceStudentResume` → `analyzeResume` → `runAiFeature({feature:"resumeReview"})`
with no `monthlyQuotaError(…, "resumeReviews")`. Worse, at `HEAD` the read sat at
offset 13,243 and a gate that can still refuse the request at 15,610 — so a
submission that failed validation spent the model call and wrote no draft row,
leaving a repeatable read that cost nothing at all.

**Fix.** Two parts:

1. The resume block **moved below every check that can refuse the request**, so
   the read only happens on a draft that is going to be attempted — which the
   monthly draft allowance already counts.
2. The read passes the resume-review allowance: `monthlyQuotaError(user,
   "resumeReviews")` before `replaceStudentResume`. It is the same
   `resumeReview` model call the Resume Review feature spends, so it belongs to
   the same allowance.

**Partly declined, with the reason.** The gate **bounds** the read by the
allowance without **consuming** it: the path writes no `resume_reviews` row, and
it should not — that table requires a score, per-dimension marks, a summary,
strengths and improvements, and inventing a row for a bare extraction would put
a fake review in the student's own review history. Making the read consume an
allowance unit needs its own metered feature (`MONTHLY_QUOTAS` in
`plan-quotas.ts`, a counter that reads `ai_usage` rather than a feature table).
That is a cross-cutting change touching the billing page, and it is reported
below rather than improvised here.

Worth recording: the call was never *entirely* unmetered — `runAiFeature`'s
`reserveQuota` takes one of the student's daily `DAILY_LIMITS` calls for it. F5
is about the **monthly** counter, and that is what is still open.

## 12. `resolveRecipient` had no UUID guard (INPUT-2 F7 / INPUT-3 F7)

**Reproduction.** `recipient.slice("contact-".length)` went straight into
`eq(contacts.id, …)` against a `uuid` column, so `recipient=contact-notauuid`
reaches Postgres as a malformed `uuid` parameter and raises `22P02` out of the
server action — a 500 where the student should get a sentence.

**Fix in my files, as the brief allows.** `draft-recipient.ts` is not mine, so
the guard is at its only caller in the app: an exported `recipientIdError`
in `draft-request.ts`, using the existing `isUuid` from `firm-links.ts`, run
before `resolveRecipient` and returning *"Couldn't find that person. Choose who
this email is for again."* `"outside"` is not an id and is untouched; a bare
`contact-` is refused.

**Reported, not fixed:** `resolveRecipient` itself still has no guard, so any
future caller inherits the defect. The audit's own fix — export the UUID regex
once (it is duplicated in `draft-suggestions-db.ts:25` and
`quick-draft-actions.ts:15`, and exists a third time as `isUuid`) and apply it in
both branches of `resolveRecipient` — belongs in `draft-recipient.ts`.

---

## One thing I wired that was not on my list

`guardRevision` (`draft-review.ts`) gained an optional fifth parameter, `finish`,
documented as *"How the pipeline finishes a body before it ships
(`finishDraft`)"* and defaulting to the identity so the guard stays testable on
its own. Nothing was passing it, so the fix behind it (LOGIC-2 F4: the guard was
judging the reviewer's raw body while `finishDraft` rewrote every em dash
afterwards) was inert in production. Both call sites in `draft-pipeline.ts` now
pass `(body) => finishDraft(promptInput, { ...first, body }).body`.

Verified green afterwards: `draft-review-test` 139/139,
`draft-guard-note-test` 13/13, `draft-stream-test` 125, `draft-bug-hunt`
147/147, `draft-pipeline-flow-test` 64/64. If the guard's owner intended
different semantics for `finish`, this is the line to change.

## Still open, for files I do not own

| Finding | Needs | Where |
|---|---|---|
| OUTPUT-3 MEDIUM | stop echoing the model's `quote` verbatim in the rejected-path note | `draft-review.ts` (`studentNotesFromReview`) |
| INPUT-3 F3 | a `userText.length > 30_000` invariant | `draft-prompt.ts` (`buildDraftPrompt`) |
| INPUT-2 F7 | the UUID guard in the resolver itself, for every future caller | `draft-recipient.ts` |
| INPUT-2 F5 | a metered feature so the resume read **consumes** an allowance, not just passes one | `plan-quotas.ts`, and a counter over `ai_usage` |
| LOGIC-3 F10 (a)(c)(d) | a `draftReview` `AiFeature` + pgEnum value, its own `callWithFallback`, and a row that does not eat a second daily unit | `model-registry.ts`, `db/schema.ts`, `ai-runner.ts` |
| LOGIC-3 F4 (part 3) | an absolute deadline threaded through `callWithFallback`, so a fallback re-run inherits the clock instead of resetting it | `ai-runner.ts` |
| OUTPUT-2 §6 | case-insensitive note dedupe | `draft-pipeline.ts` — mine, but not in this brief; left alone deliberately |

## Verification

```
draft-review-test              139/139 passed          (≥104)
draft-guard-note-test           13/13 passed
draft-stream-test              125 passing, 0 failing
draft-tiers-test                33 passing, 0 failing
content-limits-test           162/162 passed
content-limits-coverage-test   104 actions take input: 46 checked, 58 exempt, 0 missing
draft-bug-hunt                147/147 passed, 0 failed
draft-pipeline-flow-test        64/64 passed
npx tsc --noEmit               clean, 0 errors
```
