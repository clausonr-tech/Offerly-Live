# STREAM-WIRED — the client half, and what the plan-first schema really costs

Built 12 October 2026 on `perf/draft-pipeline`, in the
`draft-pipeline-perf` worktree. `BUILD-S.md` closed with the streaming path
**server-complete and client-absent**: `useDraftStream.ts` imported by nothing,
`GenerateForm.tsx` still on `useActionState(generateDraft)`, and
`DraftStreamPreview` named in a doc comment but never written. This is the
record of wiring it up, and of the measurement `BUILD-S.md` §"UNVERIFIABLE"
item 4 asked for.

---

## Top line

**Wired, flag-gated, and the latency win is real but about twice the size
PLAN-A claimed.** First content reaches the student **≈7.3 s** into a ≈30 s
wait instead of at the end; first body text **≈7.9 s**. PLAN-A §2.1 promised
2–4 s. The gap is the plan-first schema, and the number is measured below
rather than asserted.

**The feature is still worth shipping at 7.3 s** — it removes three quarters of
a silent wait — but the honest claim is "two thirds of the way to the promise",
not "the promise". If anyone wants the remaining 7 s they have to move `plan`
after `body` in `draftOutputSchema`, which is a prompt-accuracy decision, not a
UI one, and it is explicitly **not** part of this work: `PLAN_RULES` has the
model settle who is who *before* writing, and `draft-prompt.ts` is another
owner's file with a measurement run in flight against it.

D7 — the decision `BUILD-S.md` §4 recorded as still open — is now made in code,
and §2.1's four-point design is followed on the three points that apply. The
fourth (an "Edit anyway" escape hatch) is not needed and is **deliberately not
built**: there is nothing to escape from, because the streamed text is not
editable, so no edit can be clobbered.

---

## What was built

| File | What it is |
|---|---|
| `src/app/(app)/drafts/draft-stream-view.ts` | **new.** The state machine, pure: `applyFrame`, `previewView`, `canStream`, `DEAD_STREAM`. No React, no server imports — which is what makes the orders a browser cannot easily be made to produce testable in node. |
| `src/app/(app)/drafts/DraftStreamPreview.tsx` | **new.** The provisional card and the strip that announces the swap. Decides nothing; renders one of the three views. |
| `src/app/(app)/drafts/useDraftStream.ts` | Rewritten around the pure reducer. Adds the browser-capability check and the router refresh (below). The SSE reading loop and both fallback decisions are AGENT-S's, unchanged. |
| `src/app/(app)/drafts/GenerateForm.tsx` | `useActionState(generateDraft)` → `useDraftStream({ enabled: streaming })`. New required `streaming` prop. Renders the preview above the composer. |
| `src/app/(app)/outreach/email/page.tsx` | Passes `streaming={draftStreamingEnabled()}`, read on the server on every request. |
| `scripts/draft-stream-test.ts` | **125 → 178 assertions.** The state machine driven through every sequence below, plus the plan-cost measurement. |

Nothing else was touched. `draft-stream.ts`, `draft-prompt.ts`,
`draft-review.ts`, `draft-lint.ts`, `draft-pipeline.ts`, `draft-templates.ts`
and `email-examples*` are untouched — `git diff --stat` is four files plus this
document.

---

## The measurement: what `plan`-before-`body` costs

`draftOutputSchema` emits `plan` (people + one note per sentence), then
`subject`, then `body`. `TopLevelJsonScanner` can only report a key once it has
arrived, so **nothing reaches the student until the whole outline has been
written.** That cost is now measured, in `scripts/draft-stream-test.ts` under
"what the plan-first schema costs the student", by pushing a schema-shaped
document through the **real scanner and the real gate** one character at a time
and recording the index at which each milestone fires.

Inputs, all measured rather than assumed:

- **132.8 words and 10 sentences per body**, and a **16 762 ms mean draft
  call** — `scripts/audit-probe/output1/q-full.json`, 16 scenarios, Sonnet 5.5.
- **5.393 characters per word including spaces** — computed over the 63
  `notesForStudent` strings in the two probe files. Real prose from this
  pipeline, not a constant about English in general.
- **Plan note length is the one unmeasured input.** No plan text is recorded
  anywhere in the repo — the probe files keep lint, voice and review stats but
  not the model's outline — so it is **swept** rather than guessed. The
  prompt's own two sample roles (`PLAN_RULES`) are 48 and 47 characters, so 60
  is the central case and the table is the sensitivity.

```
  body 716 chars (132.8 words x 5.393), draft call 16762 ms, uniform character rate assumed
  note  sents  doc    outline  subject  1st body   silence before the outline / before body text
    40     10   1690      620      675       693   6.1s / 6.9s
    60      8   1764      694      749       767   6.6s / 7.3s
    60     10   1890      820      875       893   7.3s / 7.9s      <- central
    60     12   2016      946     1001      1019   7.9s / 8.5s
    80     10   2090     1020     1075      1093   8.2s / 8.8s
   100     10   2290     1220     1275      1293   8.9s / 9.5s
```

**Read it like this.** In the central case the plan is **43% of the draft
document** and the body does not start until **47%** of it has arrived. At the
measured draft throughput that is **7.3 s before the student sees anything and
7.9 s before they see a word of their email**, against a **≈30 s** total wait
(16.6 s draft + 12.5 s review). The sweep's whole range is **6.1–9.5 s**, so
the conclusion does not depend on the one unmeasured input: there is no plausible
plan size at which this is the 2–4 s PLAN-A costed.

Three honest caveats on the number:

1. **Uniform character rate is an assumption.** Tokens are not characters and
   output rate is not perfectly flat. The *share* of the document (43% / 47%)
   is a property of the schema and is solid; the seconds are that share times a
   measured mean.
2. **16 762 ms is a CLI-transport figure** (`q-full.json`'s own `caveat`
   field), not production latency. If production is faster, every number here
   scales down together.
3. **Thinking is not in the path.** `model-registry.ts` gives the draft call
   `thinking: "disabled"` on both tiers, so text begins at the first token.
   Had thinking been on, time-to-first-text would be the thinking block *plus*
   all of the above, and the feature would be worthless. Worth stating because
   turning thinking on for drafting would silently destroy this feature.

**What makes 7.3 s acceptable rather than merely less bad:** the plan is not
dead weight on screen. When it closes, the student gets the model's **outline
of their email** — "Thank her for the panel. / Say Emily Tran sent me. / Ask
for 15 minutes." — which is real information about what they are about to read,
and it is the one thing the plan-first order gives back for the seconds it
costs. The outline is then **replaced** by the body as the body arrives, so it
reads as a loading state with content rather than a list to keep.

---

## What the student sees, stage by stage

| When | What is on screen |
|---|---|
| **Submit → first frame** (0–7 s) | Exactly today's `StagedProgress`: "Reading your profile…", "Writing the email…", "step 2 of 4", "About half a minute". **No provisional card at all**, because until a frame arrives nothing knows there will be one — the flag may be off, the route may 404, the browser may not stream. |
| **The outline lands** (≈7.3 s) | `StagedProgress` disappears and the provisional card replaces it: an **amber dashed-bordered** card, spinner, **"Writing your email…"**, under it **"Not checked yet - Offerly is still reading it against your details."**, then **"What it's going to say"** and the numbered outline. Footer, always: **"Nothing to copy yet. Your email, checked and saved, opens here when it's ready."** |
| **Body arriving** (≈7.9–16.6 s) | The outline gives way to the email itself: a `Subject` line, then the body in the composer's own typeface and size, with a blinking caret where the next word is going. The amber header and the footer line do not move. |
| **Review reading it** (≈16.6–29 s) | The caret stops. The header becomes **"Fact-checking every line against your details…"** and the sub-line becomes **"This is still the first pass. The checked email replaces it when the review finishes."** The text stops changing, so a student who looks up sees a still email that still says it is not checked. |
| **The swap** (≈29 s) | **See below.** |
| **Blocked mid-stream, or the stream dies** | The card **disappears entirely** and the form shows one red line — the same blocked message a finished draft would have failed with, or `DEAD_STREAM`. |

Nothing in the provisional card is a form control. No To field, no editable
body, no Copy, no "I sent this", no Send. There is nothing to click and nothing
to submit, which is why no student edit can exist to be clobbered.

### The swap, exactly

At the `final` frame, three things happen in the same render:

1. **The provisional card is gone.** Not greyed, not read-only — removed. The
   amber dashed box the student was reading is no longer on the page.
2. **In its place is one strip**, `role="status"` (so a screen reader hears it
   rather than finding it later), **green** and pulsing three beats
   (`motion-safe`, ~2.7 s, then still), carrying one of:
   - "**Checked and saved. The review changed the wording** - the email below is the final one." — plus a **"Show the first pass"** disclosure that opens the pre-review body in a white panel labelled "The first pass, before the review. Kept so you can see what changed - not the email to send."
   - "**Checked and saved. The review left the wording as it was** - the email below is the final one." — no disclosure, because there is nothing to compare.
   - **Amber**, not green, when the review never ran: "**Saved, but there wasn't time left to check it. Read it closely before you send it.**" The wording is the pipeline's own (`draft-pipeline.ts:486`, `:587`, `:631`), which is written for students, and the strip does not say "checked", because it wasn't.
3. **The composer mounts below it and scrolls itself into view**
   (`scrollOnMount`, already the form's behaviour), holding the saved, gated
   draft with its To field, notes, attachment and Copy.

The strip is keyed on the draft id, so the swap **remounts** it rather than
mutating text in place: it is a new element arriving, which is what makes it
register. **The swap is never silent and never merely implied** — every
terminal state says in words which way it went, including the case where
nothing changed, because a student cannot otherwise tell "the review approved
it" from "the review never spoke".

### What a student sees on the default path: nothing new

With `OFFERLY_DRAFT_STREAM` unset — the default, and it is in no `.env` file —
the first frame never arrives, `streamed` stays false, `previewView` returns
`hidden` at every stage, and the page is `StagedProgress` then the composer:
byte-for-byte today. This is asserted, not assumed (`draftArrived` → "the
action path shows no preview and no swap notice").

---

## The fallback paths

| Failure | What happens | Cost to the student |
|---|---|---|
| **Flag off** | The page passes `streaming={false}`, so **no request is made at all** — the form calls the server action directly. | None. Today's page, and not even a wasted round trip. |
| **Flag on at render, off at the route** (old deploy, flag flipped mid-session) | Route 404s → `!response.ok` → the server action runs. | None. |
| **Browser cannot stream** | `canStream(window)` checks `fetch`, `ReadableStream`, `TextDecoder`, `AbortController` **before** the request. No request is made; the action runs. | None, and one fewer wasted round trip than discovering it from a missing `response.body`. |
| **Signed out / firm account** | Route 401s → the action runs → `getCurrentUser()` redirects properly. Checked in the route *before* the stream opens, because a `redirect()` thrown inside a stream body reaches the browser as nothing. | None. |
| **`fetch` throws, or no `response.body`** | `streamSubmit` returns false → the action runs. Nothing drafted, no quota spent. | None. |
| **Stream dies after it started** | **Does not re-submit.** The draft may already be written and already charged, so a retry would draft and bill twice. The provisional text is cleared and one red line points at Your past emails. The typed form is left intact. | One possibly-wasted draft from the monthly allowance — but never two, and never a silent double charge. |
| **Blocked language mid-stream** | The route's own error frame, with the message a finished blocked draft would have failed with. Provisional text and outline cleared. | A failed draft, as today. |
| **Student closes the tab** | The route latches `open = false` on the first failed enqueue; the work finishes and the row is written. `useDraftStream` aborts the controller on unmount. | None. |

**The provisional text is cleared on both failures, deliberately.** Leaving
half an email on screen after the app has just refused to show the rest of it —
or after the connection died and nothing will ever check it — leaves something
that looks copyable and is not. It goes.

---

## The gates: unchanged, and still all of them

Nothing in this work touches the server. `runGenerateDraft` is the same
function, called the same way, by the same two callers; the only thing that
differs between them is still `onEvent`.

- **The blocked-language gate is untouched.** `createTextGate`,
  `unsettledTailLength`, `gateWhole` and `planText` are byte-identical to what
  `BUILD-S.md` verified. The "Associate"/"assessment"/"cocktail" defect and the
  `\u`-escaped-plan defect stay fixed, and all 125 of their assertions still
  pass inside the 178.
- **Everything the browser is shown has already been through the server gate.**
  The preview renders exactly the strings the route sent and adds nothing: no
  client-side word list, no second opinion, no re-assembly of withheld text.
- **The saved row is still the fully-checked one**, written once, after
  `draftChecks` → review → `guardRevision` → `findBlockedLanguage(subject +
  body)` (`draft-pipeline.ts:393`).
- **`scripts/content-limits-coverage-test.ts`: `104 actions take input: 46
  checked, 58 exempt, 0 missing`** — unchanged. No server action and no API
  route was added: the only new server-side code is a boolean read on an
  existing page.

## One behaviour change worth naming: `router.refresh()`

`useActionState` ran the action inside a transition, so Next applied the
action's `revalidatePath("/outreach")` / `("/contacts")` to the client router
and the page updated. A **route handler's** `revalidatePath` only invalidates
the server cache — nothing tells the open router about it — so on the streaming
path "Your past emails" would not have appeared after writing the first email.
`useDraftStream` now calls `router.refresh()` once, on `final` and on a
successful action result. Cost: one page fetch per generated draft. It restores
today's behaviour rather than changing it, and it is the only thing in this
change that reaches outside the form.

---

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **clean** for everything in this change. One unrelated error is live in the shared tree: `scripts/audit-probe/formats/rules-vs-format.ts(36,73)` — `'custom' does not exist on type Record<ExampleTypeId, …>`, another owner's in-flight `email-examples` work. |
| `npx tsx scripts/draft-stream-test.ts` | **178 passing, 0 failing** (was 125) |
| `npx tsx scripts/content-limits-coverage-test.ts` | `104 actions take input: 46 checked, 58 exempt, **0 missing**` |
| `npx tsx scripts/content-limits-test.ts` | 162/162 |
| `npx tsx scripts/draft-review-test.ts` | 141/141 |
| `npx tsx scripts/draft-guard-note-test.ts` | 13/13 |
| `npx tsx scripts/draft-pipeline-flow-test.ts` | 66/66 |
| `npx eslint` on all five changed/new files | One error, **pre-existing**: `GenerateForm.tsx:203 react-hooks/set-state-in-effect`, in the field-suggestions effect this change never touches. Proved by linting `git show HEAD:…GenerateForm.tsx` — same error, same rule. |
| `scripts/test/help-knowledge-coverage.test.ts` | **FAILS.** See below. |

### The 53 new assertions

The component's state machine is driven directly, from a fresh submission,
through the sequences a browser is hard to produce on purpose:

1. **Arriving** — nothing before the first frame; the outline on the plan frame
   with no email text; deltas concatenating in order; `draft-finished` settling
   the text. Asserted across *every* intermediate state: `provisional === true`,
   `actionable === false`, `draft === null`, and no view reads as resolved.
2. **Review reading it** — the label changes, the caret stops, the first pass is
   captured for the comparison.
3. **Blocked mid-stream** — text, outline and subject cleared; no draft; the
   pipeline's own blocked message; nothing pending; no preview; and
   `findBlockedLanguage` finds nothing in what had been released.
4. **Stream dies** — the same clearing, and a message that points at the saved
   drafts rather than inviting a re-submit (asserted: contains "past emails",
   does not contain "try again").
5. **Review applied an edit** — the swap is announced, the headline says the
   wording changed, the first pass is kept, the state's text becomes the saved
   text.
6. **Review changed nothing** — still announced, headline says the wording
   stood, no first pass offered.
7. **Guard rejected the reviewer's edit** — `changed` is computed from the text,
   not taken from the reviewer's `applied` flag, so it correctly reads
   unchanged.
8. **Review skipped** — the pipeline's student-facing reason is shown, the
   student is told to read it closely, and the strip does not claim the email
   was checked.
9. **The unstreamed path** — `draftArrived` produces the draft, shows no
   preview and no swap notice, and never claims anything streamed.
10. **`canStream`** — all four capabilities present passes; each one missing,
    and no `window` at all, fails.
11. **The measurement** — all three milestones fire, in schema order, and the
    first body text lands past a quarter and before half of the document. If a
    future schema change moves `body` first, that assertion fails and this
    document is wrong, which is the point of asserting it.

### Rendered, not just typechecked

`DraftStreamPreview` was rendered with `react-dom/server` against the same
stubbed sequences; all five states produce the expected markup and wording, and
the action path produces **0 characters of HTML**. That is a render check, not a
browser check.

### What is NOT verified, and cannot be here

- **That any of this works against a real stream.** No browser was driven and
  no model was called. The four unverifiable items in `BUILD-S.md` are all
  still unverifiable, and this work adds nothing to that list and removes
  nothing from it.
- **Time-to-first-text in production.** The 7.3 s above is a measured
  *share of the document* times a measured *mean call duration*. It is not a
  stopwatch on a real draft.
- **That Vercel does not buffer the response.** Still the single thing that
  would make the feature deliver nothing while appearing correct.
- **That the pulse, the amber card and the swap read well on a screen.** Both
  themes, both widths, and whether the swap actually catches an eye, are
  judgments a person has to make.

### `npm run help:learn` is owed — not run here

`scripts/test/help-knowledge-coverage.test.ts` fails: **25 student pages and 5
firm pages stale**. That is far more than the four `BUILD-S.md` recorded, and
**most of it is not this branch** — pages like `/schedule`, `/signup` and
`/networking/clubs` have no file from this work in their source sets. This
change's own contribution is **`/outreach/email`** (its `page.tsx` and
`GenerateForm.tsx`) and **`/drafts`** and **`/drafts/[id]`** (already stale
through `actions.ts` and `draft-request.ts` before this work; now also through
`useDraftStream.ts`, `draft-stream-view.ts` and `DraftStreamPreview.tsx`).

**Does a student see anything new on a page?** On the shipping default — flag
unset — **no**: identical pixels, asserted. With the flag on, **yes**, and it
is a whole new surface: the provisional card, the outline, the live body and
the swap strip. Since the flag is off by default, the knowledge entries should
describe the page as it ships. Either way the hashes moved, so **Kai must run
`npm run help:learn` and commit the regenerated `help-knowledge.json` with the
code.** Not run here: it costs money and hits the network.

---

## Manual steps for Kai, on http://localhost:3014

The dev server is already running off this worktree and hot-reloads. Do these
in order; stop at the first that surprises you.

1. **Flag off first — prove nothing changed.** With `OFFERLY_DRAFT_STREAM`
   absent from `.env.local`, open `/outreach/email`, fill in a draft and
   generate. Expect exactly what you get today: the four-stage progress panel,
   then the composer. **No amber card and no green strip at any point.** If you
   see either, the flag is not being read where I think it is and nothing else
   in this list matters.
2. **Turn it on.** Add `OFFERLY_DRAFT_STREAM=on` to `.env.local`, restart the
   dev server (`.env.local` is read at boot), and generate another draft.
   Remember: **this spends a draft from the monthly allowance and writes a real
   row in the live Supabase project**, as does step 1.
3. **Time it with a stopwatch, and write the number down.** Three things to
   catch: (a) the progress panel runs for the first several seconds; (b) the
   **outline** appears — this should be around **7 s**, and that is the number
   this whole document is about; (c) the **body** starts filling in a word or
   two later. If the outline and the whole body appear together at the end,
   something is buffering the response and the feature is delivering nothing —
   that is `BUILD-S.md`'s unverified item 3, and it is the one failure mode
   that looks like success in the logs.
4. **Read the card while it fills.** Confirm the amber header says "Not checked
   yet", the footer says "Nothing to copy yet", and there is **nothing to
   click** — no Copy, no editable body, no Send.
5. **Watch the moment the review finishes.** The amber card should vanish, a
   green strip should pulse into its place saying whether the review changed
   the wording, and the composer should scroll itself into view. If the review
   changed something, click **"Show the first pass"** and check the two texts
   really do differ — that is the honesty claim, and it is checkable by eye.
6. **Confirm the saved row is the reviewed text**, not the text you watched
   arrive: `select subject, body from email_drafts order by created_at desc
   limit 1`, compared with what the composer shows.
7. **Check "Your past emails" appears** at the bottom of `/outreach/email`
   right after your first draft, without a manual reload. That is the
   `router.refresh()` above; if it is missing, say so.
8. **Kill the stream mid-draft** — DevTools, Network, go offline a few seconds
   after the body starts. Expect the card to vanish and one red line pointing
   at Your past emails. **Expect no second draft to be generated**, and check
   your allowance only moved by one.
9. **Both themes.** Generate once in dark mode. The card and the strip are
   pinned to literal hex for the reason `Composer` is, but "compiles" and
   "looks right" are different claims and only you can make the second.
10. **Turn the flag back off** when you are done, and run `npm run help:learn`
    and commit `help-knowledge.json` before any of this merges.

---

## What a reviewer should not have to rediscover

- **The state machine is in a React-free file on purpose.** Every interesting
  failure here is an *ordering* problem, and `draft-stream-view.ts` exists so
  those orders can be asserted in `npx tsx` instead of argued about or clicked
  at. Any new frame type, or any change to what the student is told, belongs
  there and gets a case in `scripts/draft-stream-test.ts`.
- **`streamed` is load-bearing, not bookkeeping.** It is the only thing
  separating "the flag is off" from "the stream has not started yet", and it is
  what keeps the default path byte-identical. Dropping it would put an empty
  amber card in front of every student on the non-streaming path.
- **`changed` is measured from the text, never from `review-finished.applied`.**
  The guard can reject a reviewer's edit after the reviewer reported applying
  one, and the student must be told what happened to the words, not what the
  reviewer intended.
- **The 7.3 s is the schema's, not the implementation's.** 43% of the draft
  document is written before the first key the student can be shown. No amount
  of UI work moves that; only reordering `draftOutputSchema` does, and that is
  a prompt-accuracy decision with a measurement run in flight against it.
