# FIX-SAFETY: the input-validation and blocked-language fixes

Branch `perf/draft-pipeline`, worktree `draft-pipeline-perf`. Closes INPUT-3 F2,
F4 and F5, OUTPUT-3's evasion finding, and INPUT-1 F7. No model call, no
database, no dev server; every number below is from a command run in this tree.

**Owned and changed:** `src/lib/content-limits.ts`, `src/lib/validation.ts`,
`src/app/(app)/profile/actions.ts`, `src/app/onboarding/links/actions.ts`,
`scripts/content-limits-test.ts`, plus `scripts/content-limits-coverage-test.ts`
(the EXEMPT reasons it holds), `scripts/test/sharing-security.test.ts` (the
LinkedIn assertions), and one new file, `src/lib/draft-field-labels.ts`.

## Test results, verbatim

```
$ npx tsx scripts/content-limits-test.ts
162/162 passed                                   # was 64/64; 98 new assertions, 0 failing

$ npx tsx scripts/content-limits-coverage-test.ts
104 actions take input: 46 checked, 58 exempt, 0 missing

$ npx tsx scripts/draft-review-test.ts
139/139 passed

$ npx tsx scripts/draft-stream-test.ts
125 passing, 0 failing

$ npx tsx scripts/draft-guard-note-test.ts
13/13 passed

$ npx tsc --noEmit
(no output, exit 0 - the layout.tsx LayoutProps error is no longer present either)

$ node --import tsx --conditions=react-server --test <every scripts/test file that imports
  lib/validation, content-limits or draft-field-labels>
tests 1578 · pass 1577 · fail 0 · skipped 1
```

`scripts/test/help-knowledge-coverage.test.ts` fails with 5 stale pages, naming
pages this work never touched (`/login`, `/contacts`, `/discovery`): it is
already failing branch-wide. `npm run help:learn` needs an API call, which this
task forbids, so it is the branch's final step, not mine. `/profile` and
`/onboarding/links` are both already in its stale list.

---

## 1. Unicode normalisation in `findBlockedLanguage` (INPUT-3 F4, OUTPUT-3)

### Reproduction, measured here rather than quoted

Both probes, before and after. I did not use the figure in my brief ("9 of 15");
it matches neither probe.

| probe | rows | passed before | passed after |
|---|---|---|---|
| `scripts/audit-probe/input3/malformed.ts` (unicode table) | 15 | **10** | **0** |
| `scripts/audit-probe/output3/evasion-probe.ts` | 43 | **20** | **8** |
| `evasion-probe.ts` false positives (its 10 clean cases) | 10 | 0 | **0** |

Twelve evasion families closed across the union of both probes: U+2019 inside a
word, a straight apostrophe inside a word, soft hyphen, zero-width space,
zero-width joiner, tag characters, fullwidth forms, the `ﬀ` ligature,
combining and precomposed accents, mathematical bold, Cyrillic/Greek
homoglyphs (`а е о р с і х ѕ ӏ ԁ у`, `ο α`, `ı ɡ`), and doubling by exactly
two (`fuuck`, which passed while `fuuuck` was caught).

### The fix

One fourth base reading in `readings()`, `src/lib/content-limits.ts`:

- `fold()` = `NFKD` → drop `\p{Cf}\p{Mn}\p{Me}` → a **partial** confusable map →
  drop a mid-word apostrophe. Run as an *extra* reading beside the text as
  typed, so no reading the old code had is lost (measured: 0 catches lost).
- Gated on `FOLDABLE` (`/[^\x00-\x7f]|['`´]/`): a line of plain ASCII with no
  apostrophe skips the fold entirely.
- `’'` added to the spaced-letter separator class, so `f’u’c’k` joins up.
- The two stretch readings now collapse a double as well as a longer run
  (`([a-z])\1+`). This is safe *because of how the lists are matched*: only
  `fuck`, `nigger`, `nigga` and `faggot` match inside a word, so
  `shiitake → shitake` and `assessment → asesment` are still unmatched words.

### Red-green

```
$ npx tsx scripts/content-limits-test.ts          # assertions added, fix not yet written
119/139 passed
  FAIL disguised (curly apostrophe inside the word): "fu’ck this" -> null
  ... 20 failures, every one a missed evasion; all 54 new false-positive cases already passed

$ npx tsx scripts/content-limits-test.ts          # fix in place
139/139 passed

$ cp <baseline> src/lib/content-limits.ts && npx tsx scripts/content-limits-test.ts
119/139 passed                                     # reverted: red again

$ <restore> && npx tsx scripts/content-limits-test.ts
139/139 passed
```

### False-positive testing — the half that mattered

Precision was measured three ways, not argued.

**1. The whole system dictionary, old function vs new.** 235,976 words, each
through both implementations:

```
dictionary: 235976 words; old flagged 52, new flagged 53
NEW false-positive candidates: 1
  + Bastaard -> profanity
catches lost: 0
pair sweep (33710 pairs): 0 new flags
```

One word in 236,000 changes verdict: `Bastaard`, a variant spelling in
`/usr/share/dict/words`, which the doubling collapse reads as `bastard`. I judge
that a correct catch rather than a false positive — someone typing it at a
banker means the word — and record it here so the judgement is visible rather
than buried. Nothing stopped being caught.

**2. A 137-entry non-ASCII corpus** (Russian, Ukrainian and Greek words and
names in ordinary use, hyphenated and apostrophied surnames, accented European
names, fullwidth and ligature text, double-letter finance phrases):

```
corpus: 137 entries; new flags 0, lost catches 0
  both flag "Ass't Treasurer" -> profanity (pre-existing)
  both flag "ASS (Applied Social Science) minor" -> profanity (pre-existing)
  both flag "piss-poor" -> profanity (pre-existing)
```

Those three are the false positives INPUT-3 already noted. They come from the
plain reading, not from anything added here, and they are **not fixed** — see
"declined", below.

**3. A structural check of the confusable map.** The map's image is
`{a,e,o,p,c,i,x,s,l,d,u,g}`. Of the 87 words on the two lists, only `spic`, `ass`,
`piss`, `pissed` and `dildo` are spelled entirely from that image (computed from
the source, not eyeballed), and none of the four stems is, so those are
the only words a token of purely non-Latin letters could fold onto — and each
needs a letter (`ѕ` dze, `ԁ`, `ӏ`) that does not occur in Russian, Ukrainian or
Greek orthography. That is why the map is deliberately partial: `Сбербанк`
folds to `cбepбaнк`, which is no word at all. Widening it to every Greek letter
would buy one more evasion row and put real Greek text at risk, so it was not
widened.

54 of the 98 new assertions in `content-limits-test.ts` are false-positive
cases (21 are evasions), and all 64 original assertions - the 32-case
Scunthorpe-and-friends set included - still pass.

**Cost.** `fold()` is not free on a large blob: 193 KB of apostrophe-bearing
text goes from 5.3 ms to 14.4 ms (16.9 ms when it is non-ASCII), and a short
line is 0.0 ms either way. The gate runs per draft and per stream delta, so this
is comfortable; it is also an argument for the field caps F3 asks for.

### Declined, with the reason

- **A single mid-word separator** (`fu-ck`, `fu.ck`, `fu,ck`) — the three rows
  OUTPUT-3 already classifies as residual. Joining across a `.` has a real
  counterexample: `pdf.uckfield.gov.uk` would join to `pdfuckfield`, which
  matches the `fuck` stem — Uckfield is a town. I have no measurement strong
  enough to show hyphen-joining is safe either, and precision outranks one more
  row, so neither was added.
- **`fvck`, `f&ck`, `kcuf`, `fu😀ck`, `fu\nck`** — vowel substitution, reversal,
  emoji infix and line-splitting. Acceptable residual risk for a word list, as
  OUTPUT-3 says.
- **The three pre-existing false positives** (`Ass't Treasurer`,
  `ASS (Applied Social Science)`, `piss-poor`). Fixing them means making `ass`
  and `piss` not match across a hyphen or apostrophe, which would also stop
  `a$$-hole` and `piss-off`. It is a judgement about the word list, not about
  normalisation, and it is not in this task's scope.
- **Explicitly out of scope, and stated because it will be asked:** no word list
  will ever catch *"women can't handle trading"*. That is the prompts' job
  (`HOUSE_RULES`, `REVIEW_SYSTEM` 3b, `SUGGESTION_SYSTEM`), not this function's,
  and nothing here moves toward semantics.

### Added for the ungated-model-output findings (the coordinator's addition)

`draft-stream.ts:508` (`plan.people[].role`, `plan.sentences[]`) and
`draft-pipeline.ts:355` (`problems[].quote`, `problems[].fix`), like
`notesForStudent`, are model-written strings the subject/body gate never sees.
Both files belong to other fixers, so this provides the one implementation they
can share rather than two divergent ones:

```ts
/** Blocked language anywhere inside something a model wrote - a string, an
 *  array of them, or an object of either, however nested - or null. */
export function findBlockedLanguageIn(value: unknown): BlockedKind | null;

/** The strings in a list that carry nothing blocked, in order, blanks dropped:
 *  for losing one note rather than a draft the student has already paid for. */
export function withoutBlockedLanguage(texts: readonly (string | null | undefined)[]): string[];

/** The part of a string still being streamed that is safe to check: everything
 *  up to the last whitespace, so a half-arrived "Associate" is not read as a
 *  word on the list. A per-delta gate must check this, not the raw partial. */
export function settledText(partial: string): string;
```

`findBlockedLanguageIn` reads strings only (ids, numbers, flags, dates cost
nothing), is bounded at depth 8, survives a cycle, and keeps the
hateful-beats-profanity order. 16 assertions cover the three, including the
"Associate" case that destroyed a real draft:
`findBlockedLanguage(settledText("Dear Rachel, as an Ass")) === null`, while
`findBlockedLanguage(settledText("you are an ass ")) === "profanity"`.

---

## 2. A newline-bearing LinkedIn URL (INPUT-3 F2)

### Reproduction

`new URL()` strips ASCII tab, CR and LF *before* parsing, so a multi-line value
parses as a clean `linkedin.com` address — and both call sites stored the **raw**
input, which keeps the newlines, which then open a forged section in the draft
prompt's STUDENT block and land in the signature of the email the student sends.
The old test only asked whether the schema *accepted* a value; it never asked
what was *stored*. Red, with the new assertions and the old code:

```
✖ a LinkedIn link is stored as the parser read it, never as it was typed
    actual:   '  https://www.linkedin.com/in/someone  '
    expected: 'https://www.linkedin.com/in/someone'
✖ the shared LinkedIn helper is what both entry points store
    TypeError: linkedinLink is not a function
```

### The fix

`linkedinLink(raw)` in `src/lib/validation.ts`, one helper for both entry
points: trim, cap at `LINKEDIN_URL_MAX` (500), **refuse** any value carrying
whitespace or a control character, require `https:` and `(^|\.)linkedin\.com$`,
and return `url.href` — never the input. `profileLinksSchema` runs it in a
`superRefine` (so the precise message survives) and a `transform` (so
`parsed.data.linkedinUrl` *is* the href). `updateLinkedin` calls it directly,
stores `href`, and hands `href` to `fillEmptyProfileFromLinkedIn`. That also
gives `updateLinkedin` the length cap it had none of.

Green: `✔ a LinkedIn link is stored as the parser read it, never as it was typed`,
`✔ the shared LinkedIn helper is what both entry points store`, with the two
pre-existing tests in that file still passing.

### The exemption reason, re-checked

It said *"A LinkedIn URL."* — true of what the validator parsed, false of what
was stored. That is the one exemption drift a self-checking test cannot see, so
both reasons now say what the code does:

- `profile/actions.ts#updateLinkedin`: "A linkedin.com URL — refused if it
  carries whitespace and stored as `url.href`, never as typed (lib/validation
  `linkedinLink`), so what reaches the database and the email signature really
  is only a URL."
- `onboarding/links/actions.ts#saveProfileLinks`: the same, plus the phone
  character class, the school id checked against the `schools` table, and the
  resume file.

---

## 3. The rest of the EXEMPT list, audited by reading the code

58 exemptions. I extracted every exempt function's body and read it against its
stated reason. **Three reasons were wrong or incomplete and are now fixed; one
entry was removed; the other 54 are honest.**

A note now sits above the list saying what the test cannot check, so the next
person adding a reason knows it is a claim nobody verifies.

### Corrected

| key | verdict |
|---|---|
| `profile/actions.ts#updateLinkedin` | **was wrong** — "A LinkedIn URL" of a field that stored the raw input, newlines and all. Fixed in code and re-worded (item 2). |
| `onboarding/links/actions.ts#saveProfileLinks` | **was wrong**, same cause. Fixed and re-worded. |
| `learn/practice-actions.ts#getPracticeQuestion` | **incomplete** — "Round settings picked from fixed options" never mentioned its second parameter, `seenPrompts: string[]`, which is free strings from the browser. Verified harmless: `lib/practice-session.ts:161,193` uses them only as a `Set` to exclude bank prompts already served — never stored, never shown, never sent to a model (`grep seenPrompts` finds exactly those two uses). Re-worded to say so. |
| `firms/(portal)/students/actions.ts#saveCriteriaAction` | **removed.** Its reason claimed "checkbox choices only" while its own code comment says "majors and places arrive as text" and filters both through `findBlockedLanguage`. The action *is* checked, so the entry was dead weight the test could not flag — the counts are identical without it (46 checked, 58 exempt, 0 missing). |

### Honest, with words present and a stated reason other than "no words"

| key | verdict |
|---|---|
| `dashboard/actions.ts#searchFirmsForPicker` | honest — a typed search term, trimmed and capped at 100, filters public firm names for the person typing; not stored, not shown to anyone else. Reason says exactly that. |
| `networking/clubs/actions.ts#searchStudentsAction` | honest — a president's name search; `searchStudentsToAdd` trims, needs 2+ characters, escapes `%_\` for the LIKE, checks presidency, limits 8. Not stored, not shown. |
| `learn/video/actions.ts#submitVideoAnswer` | honest — an audio file plus its transcript of the student's own answer, shown back only to them. CLAUDE.md exempts uploaded files by name. |
| `profile/actions.ts#uploadResume` | honest — an uploaded file. (INPUT-3 F8's separate point, that the *extracted* summary reaches the prompt ungated, is a finding about `resume-profile.ts`, not drift in this reason.) |
| `profile/actions.ts#uploadAvatar` | honest — verified: `avatar-storage.ts:32` discards the filename for `${randomUUID()}.jpg` and checks the JPEG magic number. |
| `profile/actions.ts#changePassword`, `#deleteAccount`, `firms/(portal)/settings/actions.ts#changePasswordAction`, `login/actions.ts#logIn`, `firms/auth-actions.ts#firmLogin`, `#firmDemoLogin`, `#firmResetStep` | honest — passwords, email addresses and numeric codes, all named in CLAUDE.md's own exemption sentence. |
| `profile/school-verification-actions.ts#requestSchoolVerification`, `#confirmSchoolVerification` | honest — a school email address resolved against an allowlist, and a numeric code. |
| `profile/actions.ts#updatePhone` | honest — `^[+()\d\s.-]{7,20}$` admits no letter and no newline. |

### Honest: ids, flags and fixed choices only (verified one by one)

`admin/firms/actions.ts#approveFirmAccountAction`, `#setFirmOwnerAction`,
`#restorePostAction` · `applications/actions.ts#untrackApplication` and
`applications/untrack-actions.ts#untrackFirm` (strings used only to match an
existing row for deletion; nothing stored) ·
`contacts/contact-actions.ts#setContactRepliedAction` ·
`dashboard/actions.ts#addTopFirm` ·
`discovery/firm/[slug]/generateContactsAction.ts#generateContactsAction` ·
`drafts/quick-draft-actions.ts#draftEmailForContact` (UUID-checked key; the
email is written through `generateDraft`, which gates the form and the output) ·
`drafts/suggestion-actions.ts#suggestDraftFields` (key capped at 100; the
model's suggestions pass `findBlockedLanguage` in `parseSuggestions`) ·
`learn/practice-actions.ts#completePracticeRound` (signed receipts) ·
`learn/video/actions.ts#startVideoInterview`, `#setVideoTrainingChoice`,
`#requestTrainingUpload` · `networking/actions.ts#toggleFollow` ·
`networking/clubs/actions.ts#leaveClubAction`, `#addMemberAction`,
`#removeMemberAction` · `networking/feed-actions.ts#loadFeedPage`,
`#toggleReaction` · `networking/peer-actions.ts#togglePeer` ·
`news/actions.ts#reportNewsStory`, `#saveNewsAccess` ·
`nudge-actions.ts#markPromptFlashSeen`, `#completeThankYouPrompt`,
`#markAppliedFromReminder` · `profile/actions.ts#updateTimeZone` ·
`profile/billing/actions.ts#startCheckout` ·
`profile/connections/email-actions.ts#setFirmPostEmailsAction` ·
`profile/connections/sharing-actions.ts#setFirmSharingAction`,
`#setTrainingChoiceAction` · `consent/actions.ts#acceptCurrentPolicy` ·
`firms/(portal)/events/actions.ts#setEventOpenAction` ·
`firms/(portal)/internships/actions.ts#setPostingOpenAction` ·
`firms/(portal)/team/actions.ts#approveTeammateAction`, `#removeTeammateAction`,
`#transferOwnershipAction` · `api/feed/seen/route.ts#POST` ·
`api/reminders/send/route.ts#POST` · `api/stripe/webhook/route.ts#POST`.

### The three blind spots, confirmed rather than chased (INPUT-3 F5)

1. **Inline `"use server"` is invisible** (the filter anchors the directive at
   the top of the file). Checked every file in `src/` that contains the string
   anywhere: five are not top-anchored, and four of those only *mention* it in
   a comment explaining why they are not action modules
   (`drafts/draft-request.ts`, `discovery/firmFilterParams.ts`,
   `discovery/firm/[slug]/cycles.ts`, `lib/recruiting-answer-keys.ts`). The one
   real case is `admin/firms/page.tsx`, with the five inline actions INPUT-3
   names; `takeDown` carries a typed `reason` and forwards to
   `takeDownPostAction`, which calls `blockedLanguageError`, behind
   `requireAdminPage()`. No live hole.
2. **Only `POST|PUT|PATCH` route handlers are scanned.** Counted:
   **13 `GET`, 4 `POST`, and no `PUT`, `PATCH` or `DELETE` handler exists at
   all.** Of the 13 GETs, exactly one writes anything —
   `api/auth/google/callback/route.ts`, inserting an `emailConnections` row
   (userId, provider, email, tokens). No typed words. No live hole.
3. **`export const` arrow actions are invisible.** Searched every
   `export const … = (async) (` in `src/`: the seven hits are pure helpers and
   client-side formatters, none of them a server action. None exists today.

---

## 4. The error that names 15 boxes out of 139 (INPUT-1 F7)

### Reproduction, measured

The labels came from `DRAFT_INPUT_FIELDS`, a hand-kept list of 23 entries in
`draft-request.ts`. Measured against the question definitions:

```
names a student can type into: 139 (reachable questions: 134)
named by the hand-kept list: 15
named by draftFormLabels(): 139
still unnamed: none
```

Eight of the hand list's 23 entries are the outside-recipient block, so of the
139 boxes a student can type into, it names 15 — `purpose` among the unnamed,
and `purpose` is the only box the "something else" occasion has, so its single
error named nothing at all. Pinned as an assertion:

```
a hand-kept label list leaves the box unnamed
  blockedInForm(form with purpose, {extraContext: …})
    === '"One of your answers" contains profanity. Remove it to continue.'
```

### The fix, and the one line that is not mine

New `src/lib/draft-field-labels.ts` — `draftFormLabels()` derives name → label
from each email type's own `fields` (so a question hidden behind another answer
is named too), from the shared brief questions every occasion asks for
(including the `showWhen` ones, by trying each select answer once), and from the
two boxes the form itself owns (`purpose`, `extraContext`). Pure, cached, no
database. It names **139 of 139**. Four assertions in
`content-limits-test.ts` hold it there, and the first enumerates the question
definitions rather than listing names, so a question added tomorrow is covered
or the test fails:

```ts
every question the form can ask has a label (123 questions)   // EMAIL_TYPES[].fields, none unlabelled
the custom occasion's only box is named                        // purpose -> "What is this email for?"
a shared brief question is named                               // financeInterest -> "What part of finance draws you?"
the gate names the box, not "one of your answers"
//   '"What is this email for?" contains profanity. Remove it to continue.'
```

(The harness prints only the total, `162/162 passed`; the names above are the
assertions, and each fails loudly with its own line if it stops holding.)

**Handoff — one line, in files owned by FIX-PIPELINE.** The three gate call
sites (`drafts/draft-request.ts:201`, `drafts/actions.ts:35`,
`api/drafts/generate/route.ts:72`) each need:

```ts
blockedInForm(formData, { ...draftFormLabels(), ...Object.fromEntries(DRAFT_INPUT_FIELDS) }, DRAFT_SKIP_FIELDS)
```

The hand list stays on top deliberately: it owns the recipient block
(`outsideName` …) and its wording for `introName`/`introReason` ("Intro to",
"Why them") reads better in an error than the question's own "Who?"/"Why them?".
Until that line lands, the derived labels are built and tested but not in the
error message.
