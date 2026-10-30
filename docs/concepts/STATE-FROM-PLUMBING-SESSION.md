# State from the plumbing session

Written 12 October 2026 by the session that owns the cross-owner plumbing, for
the session that owns the example corpus and the measurement.

Read with `FINAL-STATE.md`, not instead of it: that file is accurate and this
one does not repeat it. This covers the three things it cannot know — what I
landed, what I am holding uncommitted, and the places where a number recorded
in the audit docs is now wrong.

At the time of writing: HEAD is `cc25046`, my work is `5db0379` plus one
uncommitted batch, and **I am paused awaiting a decision from Kai about whether
both sessions keep working this branch.** Nothing of mine is half-applied.

---

## 1. Landed: `5db0379`

Three items the five fixers left open because the file was not theirs. All three
red-green'd; the red output is quoted in the commit message.

| Item | File | What changed |
|---|---|---|
| OUTPUT-3 MEDIUM | `draft-review.ts` | `studentNotesFromReview` no longer echoes the model's `quote`. The rejected-edit note is now `Check what the review flagged before sending. ${p.fix}` — the app's own words. Red: the note rendered `his gambling debts` verbatim. |
| OUTPUT-2 §6 | `draft-pipeline.ts` | `dedupe` is case- and space-insensitive, keeping the first spelling. The UGLY-BUT-SAFE case in OUTPUT-2 (one note lowercased, both kept) is closed. |
| INPUT-2 F7 / INPUT-3 F7 | `draft-recipient.ts` | `resolveRecipient` refuses an id that is not a uuid, in **both** branches and **above** `getDb()`, so a bad id never opens a connection. The message is the branch's own not-found sentence: a malformed id and an absent id are the same thing to the person reading it. |

Also folded the two draft-path copies of the uuid regex onto `isUuid`
(`lib/firm-links`). **Six copies remain elsewhere** — `dashboard/actions.ts`,
`news/actions.ts`, `notifications.ts`, `firm-matching-rules.ts`,
`firm-delivery-rules.ts`, `video-interview/sessions.ts`, `news/takedown.ts` —
outside this surface and deliberately not chased.

New gate: `scripts/test/draft-recipient-ids.test.ts`, **10/10**, against PGlite
with the real `uuid` columns. A stub that accepted any string would have proved
nothing about the error it exists to stop. Red was the genuine driver error:
`invalid input syntax for type uuid: "notauuid"`.

**This is the commit that voided your run.** `draft-review.ts` was the file.

---

## 2. Finished but UNCOMMITTED — the form-routing hand-offs

`git status` shows: `src/app/(app)/drafts/draft-request.ts` modified (+6/−33),
plus two new files, `src/lib/draft-form-answers.ts` and
`scripts/test/draft-form-routing.test.ts`. It is complete and green, not a
half-edit. It is uncommitted only because I stopped for a decision.

**FIX-FORM §3.1 — the required check now sits above the prompt check.** Load
bearing exactly as the doc said: `conversationDetails` is `required: true` with
no prompt, so `thanks[thanks.chat]` and `thanks[thanks.interview]` were enforced
in the browser alone. Both now raise the student's own label.

**FIX-FORM §3.2 — and here the doc's recommended fix is not sufficient.** This
is the one thing in here you should read before touching the corpus plan.

The slot is `conversationDetails`, whose alias group is
`conversationDetail`, `remarkPoint`, `recruiterExplained`. Measured over every
valid combination crossed with every alias — 24 pairs where the combination
asks something:

| How the brief slot is read | Pairs sending one typed answer to the model twice |
|---|---|
| `answerFor` (what shipped) | **8 of 24** |
| `briefAnswerFor` (FIX-FORM §3.2's fix) | **6 of 24** |
| group-aware rule (what I implemented) | **0 of 24** |

`briefAnswerFor` closes 2 of the 8, not all of them. It skips an alias the
questions are carrying, but its first term still returns a direct answer to
`conversationDetails` while a *prompted alias* carries that same answer through
`answerFor`'s own alias resolution. The rule that closes it: if **any** member
of the group is asked as a prompted question, the questions carry it and the
brief stays out.

So **FIX-FORM §3.2's "6 brief slots stop duplicating" should be read as a
different metric from mine, or as an overestimate of what that fix achieves.**
I measured rather than quoted, and the numbers above are reproducible from
`scripts/test/draft-form-routing.test.ts`, which prints the count on every run.

The two helpers moved to a new `src/lib/draft-form-answers.ts`. Not a tidy-up:
`draft-request.ts` imports `next/cache`, so a test could not reach them there
without dragging the app-router runtime in behind them — the test died on
`React.createContext is not a function` until they moved.

Red-green for §3.1, with the old order put back: **3 of 5 cases fail**;
restored, **5/5**.

**Not done in this batch:** narrowing the bespoke
`if (isFollowUp && !brief.originalSubject)` branch to the `useOfferlyOriginal`
path (FIX-FORM §3.1's second half). I verified the precondition first and it
holds — `originalSubject` is `required: true, prompt: no` in all 7 follow-up and
reply combinations, so the generic error does now cover the on-screen case — but
I stopped before making the change. **Whoever does it should keep that branch
for the `useOfferlyOriginal` path**, where the field is hidden and a generic
error would name something the student cannot see.

---

## 3. Numbers in the docs that are now stale

Re-baseline against these rather than the figures in the audit write-ups:

| Gate | Was | Now |
|---|---|---|
| `draft-review-test` | 139/139 | **141/141** |
| `draft-pipeline-flow-test` | 64/64 | **66/66** |
| `draft-recipient-ids` | — | **10/10** (new) |
| `draft-form-routing` | — | **5/5** (new, uncommitted) |

Unchanged and verified by me at `5db0379`: `guard-note` 13/13, `specimen`
43/43, `bug-hunt` 147/147, `occasions` 0 failures, `stream` 125 passing,
`tiers` 33 passing, `content-limits` 162/162, `content-coverage` 104 actions /
46 checked / 58 exempt / 0 missing, `gradmonth` 41/41, `fix-prompt` 154/154,
`forge` 1045/1045, `lint-examples` exactly 3 findings. Every one `exit=0`.

I confirmed your D45 point rather than trusting it: `draft-bug-hunt.ts` does set
an exit code now, and `lint-examples` asserts `EXPECTED_FINDINGS = 3`.

`npx tsc --noEmit` is clean. `npm run test` (the full `scripts/test/*.test.ts`
suite) I have **not** run — only the individual gates and my two new test files.
Someone should, before merge.

---

## 4. Not started, and what each one needs

From FIX-PIPELINE's "Still open, for files I do not own":

| Finding | Needs | Where |
|---|---|---|
| INPUT-3 F3 | a `userText.length > 30_000` invariant | `draft-prompt.ts` |
| LOGIC-3 F5 | §3.3 the blanked `fieldAnswers` at `:1006`, and §3.4 the three step prefixes in `SETS_THE_ASK` at `:591` | `draft-prompt.ts` |
| LOGIC-3 F11 | §3.5 `combinedExamplesFor`'s lead rule at `:494` | `draft-prompt.ts` |
| INPUT-2 F5 | a metered feature so the resume read **consumes** an allowance | `plan-quotas.ts`, a counter over `ai_usage` |
| LOGIC-3 F10 (a)(c)(d) | a `draftReview` `AiFeature` + pgEnum value, its own `callWithFallback`, a row that does not eat a second daily unit | `model-registry.ts`, `db/schema.ts`, `ai-runner.ts` |
| LOGIC-3 F4 part 3 | an absolute deadline threaded through `callWithFallback` | `ai-runner.ts` |

Two cautions for whoever picks these up:

- **The pgEnum value needs a drizzle migration, and local dev points at the live
  database.** Generate it; do not apply it without asking Kai.
- **§3.4 touches `SETS_THE_ASK`, which your FIX-PROMPT reworked into 15 phrase
  rules.** Your warning is recorded here so it is not lost: re-read that section
  before patching, or the prohibition-survival behaviour it fixed can re-break.
- **§3.5 changes which stored mixes are reachable**, so it changes which
  examples a given box mix receives. Your corpus plan should be read after it
  lands, not before.

---

## 5. The measurement, as agreed

Your commands, seeds and counts, recorded here so they survive the conversation:

```
npx tsx scripts/draft-cli-eval.ts --scenarios=12 --seed=offerly --retry-before=600000 --json=<path>
npx tsx scripts/draft-cli-eval.ts --scenarios=16 --seed=quality --profile=full --retry-before=600000 --json=<path>
```

Default profile on the first, `--profile=full` on the second.
`--retry-before=600000` is load-bearing: real CLI durations exceed the 60s
production default, so the guard-retry path is otherwise never exercised.
`--seed=offerly --scenarios=12` must not change — it is the seed and size of the
three identical control arms in `MEASURE-1.md` whose spread was zero on
`zeroContractionPre`, `cannedResumePre`, `pleasantryOpenPre`, `issuesPre` and
`threeIStartsPre`, which is what makes movement in those five real at n=12.

**The baseline-trap fix is in hand.** My agent has been told: pin the resolved
`DraftPromptInput` objects to JSON and have the 814a44f harness read those exact
objects instead of calling its own `sims()`; strip any field 814a44f does not
have explicitly and list what was stripped; pin `now` on both sides so
`classYearLabel` cannot drift; record any genuinely-new field as a known
asymmetry rather than papering it. It has also been told **not to spend a single
model call until I send it the word STABLE.** It is doing free setup only.

**The metric set must include content omission, not just voice.** Your point,
carried forward: `issuesPre` rose 12 → 14 against a zero-spread control when
`VOICE_RULES` went into the drafter — a dropped shared school and a typed detail
that did not land. Detail retention and the `invented` / `wrong_person` problem
counts are therefore mandatory in the comparison, or it flatters the branch,
which is the opposite of what Kai asked for.

Sequencing is unchanged: I signal STABLE with a SHA and clean `src/`, one run
serves as both your revamp arm and the pre-corpus baseline, **then** you edit the
corpus, and `COMPARE-PRETODAY.md` records the SHA and states that it predates the
corpus edit.

---

## 6. What I need from you

1. **Nothing, if the split holds.** I have not touched `draft-prompt.ts`,
   `draft-lint.ts`, `email-examples.ts` or the v3/v4/v5 JSON, and I will not
   without telling you first.
2. **Know that `draft-prompt.ts` is still mine and still unpatched.** Four
   patches are queued for it. Until they land, do not treat the prompt text as
   final, and do not start a run.
3. **If Kai has one of us stand down**, this file plus `FINAL-STATE.md` and D46
   is the whole state of my half. The uncommitted batch in §2 is the only thing
   that would be lost, and it is worth keeping — it is the only measured
   correction to a fix write-up on this branch.

## 7. Ownership, as agreed

| Mine | Yours |
|---|---|
| `draft-request.ts`, `draft-form-answers.ts`, `draft-recipient.ts`, `draft-pipeline.ts`, `quick-draft-actions.ts`, `draft-suggestions-db.ts` | `email-examples.ts`, `email-examples-v3/v4/v5.json`, the corpus plan |
| `draft-prompt.ts` (yielded to me for the four patches) | `draft-lint.ts`, `draft-review.ts` after `5db0379` |
| `ai-runner.ts`, `model-registry.ts`, `db/schema.ts`, `plan-quotas.ts` | every rig run and every quality number |

`help:learn` is owed before merge and neither of us has run it. It needs
`.env.local` symlinked into the worktree and should be run last, when the branch
stops moving.
