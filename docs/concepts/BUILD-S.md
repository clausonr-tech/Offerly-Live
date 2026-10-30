# BUILD-S — streaming the draft: the record AGENT-S never wrote

Reconstructed by adversarial review, 11 October 2026, on `perf/draft-pipeline`
at `69ee3fd`. D25 says to treat streaming as UNREVIEWED until this document
exists. It exists now, and this is what the review found.

---

## Top line

**Safe to leave in the tree behind its flag — and safer still after the two
defects found here were fixed.** Do not revert.

Two defects were found in the blocked-language gate. Both are fixed in this
worktree, both are covered by new tests, and neither could ever have shown a
student a blocked word — they were a **false-accusation** defect and a
**latent evasion**, not a leak:

1. **The gate rejected clean drafts.** `createTextGate` ran
   `findBlockedLanguage` over the whole accumulated buffer, including the word
   still arriving. `findBlockedLanguage` treats the end of the string it is
   given as a word boundary, so a half-arrived "Associate" read as the whole
   word "ass" and killed the draft. MEASURED, reproducible: `Associate`,
   `assessment`, `assets`, `cocktail`, `Pakistan` and `fire retardant` all
   blocked — four of them the exact words `content-limits.ts`'s own header
   promises will pass. **Fixed**: the check now runs over exactly the
   releasable prefix.
2. **The plan was checked as raw JSON.** A `\u` escape in a plan sentence
   reached the browser as the character it stands for but was checked in its
   escaped form, which no word list can match. **Fixed**: parsed first, checked
   on the decoded strings.

And one finding that reframes the whole feature, which is good news for safety
and bad news for the plan's claimed win:

3. **The client half is not wired up.** `useDraftStream.ts` is imported by
   nothing. `GenerateForm.tsx` still uses `useActionState(generateDraft)`.
   `DraftStreamPreview`, named in `useDraftStream.ts`'s own doc comment, does
   not exist. So **no student can reach the streaming path today**, with the
   flag on or off, and the latency win in PLAN-A §2.1 has not been delivered.

---

## The five questions

### 1. The blocked-language gate — SOUND, after two fixes

`CLAUDE.md` requires the check on the server "before anything is saved, sent to
a model, or shown to another person". Streaming partial text to a browser shows
it to a person, so the gate has to hold per delta, not just at the end. It
does, in four places:

| What is shown | Where it is gated | Against what |
|---|---|---|
| The whole form | `route.ts` `POST`, and again in `runGenerateDraft` | `blockedInForm` over every typed field |
| `plan` (the outline) | `draft-stream.ts:506` | `gateWhole(planText(plan))` — the decoded sentences, names and roles |
| `subject` | `draft-stream.ts:~513` | `gateWhole(event.text)` — decoded, and only once the string closes |
| `body`, per delta | `createTextGate` (`draft-stream.ts:323`) | `findBlockedLanguage` over the releasable prefix |
| The saved email | `draft-pipeline.ts:393` | `findBlockedLanguage(subject + body)` — unchanged, still the last gate |

The body gate is the interesting one. It rests on two rules that have to hold
together:

- **Rule 1 — withhold the undecidable tail.** `unsettledTailLength`
  (`draft-stream.ts:286`) measures the word still being written *plus* any
  trailing run of separated single letters, because `content-limits` joins such
  a run (`f u c k` → `fuck`) before matching. Nothing inside that tail is ever
  released, so a word three characters into becoming a slur is never on screen.
- **Rule 2 — check what you are about to release.** `findBlockedLanguage` runs
  before anything goes out, over exactly the prefix in front of the tail.

Rule 1 was right as written. Rule 2 was wrong, and that is defect 1.

#### The split-delta test, and its result

The task asked for an adversarially-split blocked word (`"fu"` + `"ck"`). That
case was already covered and already passed. **The hole was the mirror image of
it** — a *clean* word split at the character where its prefix reads as a
blocked word — and the existing suite missed it for a specific reason: its
"Scunthorpe and friends pass" assertion pushes all seven safe words **in a
single delta**, so the gate was never asked the question mid-word.

Driven with the split, against the code as AGENT-S left it:

```
BLOCKED(profanity)  "your work as an ass" + "ociate at Goldman."
BLOCKED(profanity)  "I took the ass"      + "essment last week."
BLOCKED(profanity)  "the ass"             + "ets you cover."
BLOCKED(profanity)  "at the cock"         + "tail reception."
BLOCKED(hateful)    "grew up in Paki"     + "stan before college."
BLOCKED(hateful)    "fire retard"         + "ant materials research."
passed              "from Scun"           + "thorpe, England."
passed              "a cl" + "ass" + "ic banking path."
passed              "my p" + "ass" + "ion for markets."
```

The three that passed did so only because `\b` needs a word boundary before the
match (`cl|ass|ic` has a letter before it); the six that failed had a space.
**"Associate" is in a large share of finance outreach emails.** The outcome for
the student was: the draft is thrown away, they are told "the draft came back
with language we don't allow", and the attempt has already cost them a unit of
their monthly allowance — `runAiFeature` reserves before the call, and the
abort happens inside it. A false accusation, charged for.

The fix (`draft-stream.ts:337`, `:359`, `:372`) bounds the check to the
releasable prefix: `check(safe)` in `push`, `check(buffer.length)` in `flush`.
Why that is still safe, in full:

- The prefix checked is *the same string* as the prefix released, so nothing
  goes out unchecked. Releases stay monotone prefixes of text that was clean
  when it was released.
- A blocked word sitting in the tail is not released, and is caught on the next
  push, once the word ends — or by `flush()`, which `streamDraftCall` calls on
  `string-done`.
- The release boundary is at whitespace and outside any separated-letter run,
  which are the only two ways `content-limits` joins text across a gap. So no
  blocked reading can span the boundary.
- The only behaviour given up: when a blocked word is the *last* thing in the
  body, the upstream abort now happens at `string-done` rather than one delta
  earlier. The text was never releasable either way, and
  `draft-pipeline.ts:393` is still behind it.

Two existing assertions had to be amended, and the reason is worth recording
rather than hiding: both drove the gate one character at a time over an input
whose blocked word *ends the input* (`"…you retard."`, `"…f u c k"`), and both
broke off the loop on a latch without ever calling `flush()`. They were
asserting the old, wrong resolution of a genuinely undecidable state. They now
run to completion the way `streamDraftCall` does, and a new case
(`"…you retard. Thanks."`) proves mid-stream latching still happens when the
word actually settles.

`scripts/draft-stream-test.ts`: **91 → 125 assertions, 0 failing.** The new
ones are 10 clean-word split cases (including every one of them fed a single
character at a time, the worst case there is) asserting *not blocked and
released whole*, plus 4 converse cases asserting a real blocked word split at
the same kind of boundary still latches and that `findBlockedLanguage` finds
nothing in whatever was released.

#### Defect 2: the plan was checked in the wrong alphabet

`gateWhole(event.raw)` checked the plan's **raw JSON**, then parsed it and sent
the **decoded** strings to the browser. Those are two different strings.
`{"role":"a bitch of a boss"}` contains no word any
list can match, and `findBlockedLanguage` confirms it: clean. Decoded, the
student reads the slur. Fixed at `draft-stream.ts:452`/`:506` — parse first,
then check `planText(plan)`, which is every sentence, name and role the student
will see, defensively `String()`-ed because a half-written reply is not the
schema yet. The regression test asserts both halves: that the escaped document
*would* have slipped past a raw check, and that the call now fails.

`subject` and `body` were never exposed to this: both arrive through
`decodeStringFrom`, which handles `\uXXXX` properly (`draft-stream.ts:~100`).

**Verdict: SOUND** as it now stands. DEFECTIVE as AGENT-S left it, on both
counts.

### 2. Every existing gate still runs before the draft is saved — SOUND

The streamed text is provisional and nothing else. `onEvent` is the only thing
that changes about the pipeline (`draft-pipeline.ts`, `PipelineConfigs.onEvent`),
and all it changes is `parseWith(...)` → `streamDraftCall(...)` for the draft
call. Everything after that line is one code path:

`finishDraft` → `draftChecks` → review call → `guardRevision` (+ the one
retry) → `finishDraft` again on the accepted edit → `draftChecks` for the
student's notes → `findBlockedLanguage` on the final subject and body
(`draft-pipeline.ts:393`) → `db.insert(emailDrafts)` → `archiveGenerated` →
`revalidatePath("/outreach")` and `("/contacts")`.

Verified by diff, not by reading: the body of the old `generateDraft`
(`5eb4fe7:src/app/(app)/drafts/actions.ts`) against the new
`runGenerateDraft`, comment-stripped and whitespace-normalised, differs by
**exactly four lines** — the function name, the dropped `_prevState`, the added
`opts`, and `onEvent: opts.onEvent`. Nothing else. `INPUT_FIELDS` → 23
fields, byte-identical to `DRAFT_INPUT_FIELDS`. `DRAFT_SKIP_FIELDS` is the old
inline array verbatim. `studentNotes` and `parseTaken` hash-identical;
`collectInputs` differs only by the constant's new name. Every item the review
brief asked about is present and in its original order: `blockedInForm`,
`monthlyQuotaError`, the resume-upload path, `suggestionRecord`,
`archiveGenerated`, both `revalidatePath` calls.

**The row is written once, after everything.** This is a deliberate and
welcome divergence from PLAN-A §2.1, which specified `persistDraft(…,
"pre-review")` before the review and an update after. The plan called that a
robustness win; it is also a way to persist text that has not been through the
final gate. The implementation did not take it. **Say so in the record: the
"dropped laptop leaves a saved draft" benefit in §2.1 was not built, and the
reason to prefer what was built is that the saved row can only ever be the
fully-gated one.**

**Quota is reserved exactly once.** `generateEmailDraft` wraps the draft call
*and* the review in a single `runAiFeature({feature:"draft"})`, which calls
`reserveQuota` once (`ai-runner.ts:113`, `:248`); the route adds no second
call. The monthly check (`monthlyQuotaError`) happens once in
`runGenerateDraft`. And the client cannot double-charge: `useDraftStream`
returns `true` — suppressing the action fallback — the moment the stream has
produced a frame or returned 200, precisely because the draft may already be
written and billed. That reasoning is correct and the comment explaining it is
the best thing in the file.

**Verdict: SOUND.**

### 3. Fast mode — PRESERVED. There is no trade-off, and that is the finding

The hypothesis in the brief — that paid users trade real speed for perceived
speed — is **false**. `streamWith` (`draft-stream.ts:428`) mirrors
`parseWith` exactly: `cfg.speed !== "fast"` → `client.messages.stream`;
otherwise `client.beta.messages.stream({...params, speed: "fast", betas:
["fast-mode-2026-02-01"]})`. `model-registry.ts` gives `draft.pro`
`speed: "fast"`, so the paid tier keeps it on the streaming path.

Verified against the installed SDK (`@anthropic-ai/sdk@0.117.1`) rather than
taken on trust, because PLAN-A §2.1 flagged structured-output streaming as the
feature's main feasibility risk:

- `BetaMessageStream.createMessage` posts `{...params, stream: true}` to the
  beta endpoint (`lib/BetaMessageStream.js:114`), so `speed` and `output_config`
  ride along.
- Both `finalMessage` paths run the parser over the stored params
  (`MessageStream.js:409/433`, `BetaMessageStream.js:423/447`), and
  `maybeParseMessage` populates `parsed_output` whenever
  `output_config.format` has a `parse` — which `zodOutputFormat` does
  (`lib/parser.js:9-27`). So a streamed fast-mode call returns
  `parsed_output` exactly as `parse` does.
- `'text'` is emitted per `text_delta` (`MessageStream.js:373`), which is what
  makes reading the JSON as it arrives possible at all.

So §2.1's named fallback ("if `output_config` + `.stream()` turns out not to
expose usable deltas, drop `body-delta`") was **not needed**. Record that: the
feasibility question is closed, in the affirmative, with file-and-line
evidence. The one wart is honest and commented — a `as never` cast because
`BetaMessageStreamParams` is the non-parseable variant, so TypeScript infers
`ParsedT = null` on the beta path although the runtime parses.

**Verdict: SOUND.**

### 4. The pre-review text problem — UNDOCUMENTED-RISK (the decision D7 needs was never made in code)

D7 required that the student is never left believing provisional text is final.
PLAN-A §2.1 specified how: composer mounts read-only on `draft-finished`, Copy
/ Send / "I sent this" disabled while reviewing, an "Edit anyway" escape hatch
that stops the review being applied over their typing, and a word-level diff
strip when the review changes something.

**None of that exists.** No component consumes the stream, so there is no
read-only state, no disabled controls, no escape hatch and no diff.

What `useDraftStream` does provide is the raw material for it, and it is
honest about provisionality in its types: a `stage` machine
(`starting`/`writing`/`checking`/`done`), `preReviewBody` captured on
`review-started`, and `reviewChanged`. What it does **not** provide is any way
to edit — there is no setter for `subject` or `body` — so as written the
student's edits *cannot* be clobbered, because the student cannot type into
streamed state at all. `Composer` only ever mounts from `draft`, which is set
on `final`.

So the honest answer to "does it clobber their edits / is the final swap
visible or silent": **the swap is silent in the hook** (`case "final"` replaces
`subject` and `body` outright), and nothing visible is built on top of it yet.
That is tolerable only because nothing can reach it. **The D7 decision is still
open and must be made before the hook is wired to a component** — whoever does
that work should treat §2.1's four-point design as the spec and this section as
the reason it is still owed.

**Verdict: UNDOCUMENTED-RISK.** Not a defect in shipped behaviour; a missing
decision that becomes a defect the moment the UI lands.

### 5. Degrading safely — SOUND, with one deliberate divergence

- **Flag, and its default.** `draftStreamingEnabled`
  (`draft-request.ts:43`): `env.OFFERLY_DRAFT_STREAM === "on"`. Anything else,
  including unset, is off. Read per request, not at module load, so it flips
  without a rebuild. It appears in no `.env` file. **Default OFF, confirmed.**
- **Flag off.** The route 404s before touching anything. The client treats a
  non-OK response as "this deploy doesn't stream" and posts the server action
  instead.
- **Never started.** `fetch` throws, or `!response.ok`, or `!response.body` →
  `streamSubmit` returns `false` → the action runs. Nothing was drafted, no
  quota spent. A 401 (signed out, or a firm account) lands here too, and the
  action path then redirects properly — which is the point of checking auth in
  the route *before* opening the stream, since a `redirect()` thrown inside a
  stream body reaches the browser as nothing at all.
- **Died mid-flight.** Here the implementation deliberately does **not** do
  what the brief expected. It does not fall back, because the draft may already
  be saved and already charged; re-submitting would draft and bill twice.
  Instead it reports `DEAD_STREAM` — "the connection dropped… check Your past
  emails — it may have saved" — with the typed form left intact. **That is the
  right call** and it is the more honest failure: the alternative is a silent
  double charge.
- **Student closes the tab.** The route's `send` latches `open = false` on the
  first enqueue failure; the work carries on and the row is still written. Good.

**Verdict: SOUND.**

---

## Also checked

- **The coverage test is real, not an exemption.** `--list` shows
  `app/api/drafts/generate/route.ts#POST` as **checked**, not exempt, and the
  suite reports `104 actions take input: 46 checked, 58 exempt, 0 missing`. The
  gate is in the route's own body, as the rule requires. Worth noting for the
  future: `draft-request.ts` is neither a `"use server"` file nor a route, so
  the coverage test does not see `runGenerateDraft` at all — the gate holds
  anyway because that function calls `blockedInForm` itself, which is the
  belt-and-braces the comments claim. A third entry point would be invisible to
  the test but still gated by the function it must call.
- **CSRF on the new front door.** A route handler does not get the Next.js
  Server Action origin check, so this is a new unauthenticated-POST surface in
  principle. It is mitigated: the session cookie is `sameSite: "lax"`
  (`auth.ts:59`), which is not sent on a cross-site POST, so such a request
  arrives unauthenticated and gets the 401. No action needed; recorded so
  nobody has to rediscover it.
- **One cosmetic rough edge, not fixed.** The route checks auth, then
  `runGenerateDraft` calls `getCurrentUser()` inside the stream body. If a
  session dies in between, `redirect()`'s `NEXT_REDIRECT` error is caught by
  the route's `catch` and its `message` is sent to the student as the error
  text. Very narrow window, ugly rather than unsafe, and fixing it means
  touching the auth shape — reported rather than changed.
- **`docs/EMAIL_DRAFTING_WORKFLOW.md` does not mention streaming.** It never
  names `/api/drafts/generate` or the flag, and still describes the draft form
  as having one front door. Accurate for the flag-off path; stale the moment
  the flag goes on.

## Does a student see anything different? Yes — `npm run help:learn` is owed

Not because of any pixel: this branch changes **no component and no page**
(`GenerateForm.tsx` and `QuickDraft.tsx` differ from `5eb4fe7` but not from
`main` — the `StagedProgress` work is already on main, not part of this branch).
With the flag off and the hook unwired, the student-visible behaviour is
byte-for-byte what it was.

But the help-knowledge rule is enforced on **code hashes**, and
`scripts/test/help-knowledge-coverage.test.ts` **fails on this branch**:

```
stale: /drafts            (its code changed since it was learned)
stale: /drafts/[id]       (its code changed since it was learned)
stale: /outreach/email    (its code changed since it was learned)
stale: /profile           (its code changed since it was learned)
```

Attributed, by resolving each page's source set against the branch's changed
files: `/drafts` is stale through `actions.ts`, `draft-request.ts` and
`useDraftStream.ts`; `/drafts/[id]` through `actions.ts` and
`draft-request.ts`; `/outreach/email` through `actions.ts`. **Those three are
this branch's doing.** `/profile` has no branch file in its sources — it is
stale for an unrelated reason already on `main`, and will be swept up by the
same run.

**Kai must run `npm run help:learn` and commit the regenerated
`help-knowledge.json` with the code.** Not run here: it costs money and hits
the network.

---

## What remains UNVERIFIABLE without running the app

Everything above was established from code, from the installed SDK, and from
tests that need no server, no database and no API. These four cannot be:

1. **That a real streamed structured-output reply arrives as `text_delta`s
   whose concatenation is the JSON document.** The SDK source says it does and
   the stub proves the scanner handles any chunking, but no real response has
   been through `TopLevelJsonScanner`. This is the single assumption the whole
   feature rests on.
2. **That `parsed_output` really comes back from a streamed *fast-mode* call.**
   The parser code path is verified; the live beta endpoint is not.
3. **That a proxy or the host does not buffer the response.** `no-transform`
   and `X-Accel-Buffering: no` are set, which is the right ask, but whether
   Vercel honours it for a 120-second `text/event-stream` is an empirical
   question. If it buffers, the feature silently delivers nothing it promises.
4. **Time-to-first-text.** PLAN-A claims 25–45 s → ~2–4 s. Unmeasured.

### Manual steps for Kai

Do them in this order; stop at the first that fails.

1. **Wire or probe.** Nothing in the UI posts to the route, so the only way to
   exercise it is directly. With `OFFERLY_DRAFT_STREAM=on` in `.env.local`,
   signed in as a student in a browser, from that page's console:
   `fetch("/api/drafts/generate", {method:"POST", body:new FormData(document.querySelector("form"))})`
   and read the body. Expect `plan`, then `subject`, then a run of
   `body-delta`, then `draft-finished`, `review-started`,
   `review-finished`/`review-skipped`, `final`. **This spends a draft from the
   monthly allowance and writes a real row** — it is the live Supabase project.
2. **Check the first `body-delta` arrives seconds in, not all at once at the
   end.** If every frame lands together, item 3 above has failed and the
   feature is buffered to death.
3. **Confirm the saved row equals the `final` frame**, and that it is the
   reviewed text, not the pre-review text. One `select subject, body from
   email_drafts order by created_at desc limit 1`.
4. **Fast mode on a paid account**: confirm `[draft-review] … draft NNNNms`
   lands in the same range as the non-streaming path for the same plan. If it
   roughly doubles, `speed: "fast"` is not reaching the beta endpoint.
5. **Turn the flag back off** when done. There is no UI behind it, so leaving
   it on buys nothing and exposes the route.

---

## Verification run

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | only the pre-existing `src/app/layout.tsx(20,56) LayoutProps` |
| `npx tsx scripts/draft-stream-test.ts` | **125 passing, 0 failing** (was 91) |
| `npx tsx scripts/draft-review-test.ts` | 104/104 |
| `npx tsx scripts/draft-guard-note-test.ts` | 13/13 |
| `npx tsx scripts/content-limits-coverage-test.ts` | `104 actions take input: 46 checked, 58 exempt, 0 missing` |
| `npx tsx scripts/content-limits-test.ts` | 64/64 |
| `scripts/test/help-knowledge-coverage.test.ts` | **FAILS** — 4 stale pages, see above. `help:learn` owed. |

Changed by this review: `src/lib/draft-stream.ts` (the two gate fixes),
`scripts/draft-stream-test.ts` (the split-delta cases, the escaped-plan case,
and two assertions amended to run to `flush`). `draft-prompt.ts` and
`draft-review.ts` were not touched — a measurement run is in flight against
them. Nothing committed.

## What a reviewer should not have to rediscover

- The streaming path is **server-complete and client-absent**. Judge it as a
  server feature behind a flag, which is sound, not as a shipped latency
  improvement, which it is not.
- The gate's hard part is not "can a slur get through" — the withheld-tail rule
  handles that and always did. It is **"can a clean word be mistaken for a
  slur"**, because an incremental scanner sees every prefix of every word, and
  the end of a buffer looks exactly like the end of a word. Any future change
  to `unsettledTailLength`, to `createTextGate`, or to the word lists in
  `content-limits.ts` has to be tested against split deltas in **both**
  directions. The suite now does that; keep it that way.
