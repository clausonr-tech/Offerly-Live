# PLAN-B — accuracy architecture for the draft pipeline

Written 11 October 2026 against `docs/EMAIL_DRAFTING_WORKFLOW.md` and the code at commit `814a44f`.
Every number below is labelled **MEASURED** (with the method) or **ESTIMATED** (with the basis).
No Anthropic API call was made. All probes were `node --import tsx --conditions=react-server -e '…'` against the real modules.

---

## 0. The measurements this plan rests on

All of these were produced in this session. Each is reproducible by the stated probe.

| # | Finding | Status |
|---|---|---|
| M1 | 25.0% of the playbook's worked examples (48/192) produce ≥1 `draftChecks().forReview` finding; 14.3% of the Volume V combined examples (6/42). | **MEASURED** — iterate `EMAIL_EXAMPLES` and `email-examples-v5.json`, call `draftChecks({contactName:"Rachel Stein",contactFirm:"Anchorage Capital",gmailSignature:true,studentGradYear:2029,brief:{},purpose:"she said told thought mentioned recommended"}, body)`. The `purpose` string neutralises the context-dependent opinion check, so every finding counted is context-independent. |
| M2 | Breakdown of M1: `filler phrase` 33 (of which `I hope this email finds you well` **20**), `", and thank you"` 14, `", and"` clause-stringing 3, comma splices 3, connector-not-a-cause 1. | **MEASURED**, same probe. |
| M3 | The doc's claim that the fluency checks are "calibrated against the playbook's own Volume V emails, **which pass them**" is false: 6/42 fail. Failing sections: §4 (`thanks.chat+thanks.helped`, comma splice before "they are"), §5 (`stay.congrats+stay.update`, filler), §7 (`first.met+first.referred`, comma splice before "I agree"), §12 ×2 (`stay.congrats+stay.referrer`, `", and thank you"` + filler), §17 (`stay.congrats+stay.redirected`). | **MEASURED**, same probe. |
| M4 | `ASK` matches only **18.2%** of playbook examples (35/192; 26 of them cold types). So the guard's "dropped the ask" rule is inert for ~82% of email shapes. | **MEASURED** — `EMAIL_EXAMPLES.filter(ex => ASK.test(ex.body))`. |
| M5 | `coverage()`'s 5-char stem collides: `intern`/`internal`/`interest`→`inter`; `distressed`/`distribution`→`distr`; `manage`/`management`/`manager`→`manag`; `finance`/`financial`/`financing`→`finan`; `restructuring`/`restructure`→`restr`. | **MEASURED** — byte-identical replica of `contentWords`/`coverage` (they are not exported). |
| M6 | A typed detail can lose its specific half and still pass: detail `"his advice about staffing on live deals and how he moved from audit to restructuring"` against a body that kept only the staffing clause scores **0.43 ≥ 0.4** → guard says nothing was dropped. | **MEASURED**, same replica. |
| M7 | A legitimate paraphrase scores 0.00 and sinks the whole edit: detail `"we ended up talking about his Mustang"` vs body `"We spent most of the conversation on his car."` → coverage 0.00. | **MEASURED**, same replica. |
| M8 | `finishDraft`'s em-dash rewrite **manufactures a comma splice**. Input `"It was great meeting you at the panel—I came away with a lot to think about."` → output `"…at the panel, I came away…"`; `commaSplices()` returns `["I came"]`; `draftChecks().forReview` returns `comma splice before "I came"`. The deterministic layer creates work for the model layer. | **MEASURED** — real `finishDraft` + real `commaSplices`. |
| M9 | `guardRevision` throws away an edit that expands a school name correctly: facts `studentSchool:"Penn"`, edit writes `"the University of Pennsylvania"` → `{ok:false, reason:'added "University"'}`. | **MEASURED** — real `guardRevision`. |
| M10 | `guardRevision` throws away an edit that restores a real resume fact when the resume is a PDF: `hasResumePdf:true`, no `studentResumeSummary`, edit adds `"the Pinecrest investment club"` → `{ok:false, reason:'added "Pinecrest"'}`. Structural: `runDraftPipeline` strips `resumePdf` before building `promptInput`, so the guard sees only a boolean while the reviewer sees the PDF. | **MEASURED** — real `guardRevision`; `draft-pipeline.ts` `const { resumePdf, ...rest } = input`. |
| M11 | The "made the writing worse" test is **count**-based (`after_.length > before_.length`), so an edit that removes one finding and introduces a *different* one passes. Measured: before `['filler phrase: "I wanted to reach out"']`, after `[]` for one pair; and the strict `>` admits 1→1 swaps. | **MEASURED** — real `draftChecks` + real `guardRevision`. |
| M12 | The shrink floor fires on short emails: a 30-word body losing a 13-word private sentence (with a `private` problem reported) is rejected — `{ok:false, reason:"cut from 30 to 17 words"}`. The typed-detail private exemption never gets a chance: the floor fires first. | **MEASURED** — real `guardRevision`. |
| M13 | Body-above-sign-off lengths across the playbook: min 53, p10 75, median 109, max 198 words. Cut budget at median 43 words, growth budget 21; at p10, growth budget 15. | **MEASURED**. |
| M14 | `VOICE_RULES` is 2,385 chars (~645 tok): **20.4%** of the review system prompt (11,682 ch) and would be **10.3%** of a `cold_email` draft system prompt (20,702 → 23,087 ch). | **MEASURED** — real `buildDraftPrompt`/`buildReviewPrompt`. |
| M15 | `plan.sentences` is generated by the drafter on every draft and **read by nothing**. `buildReviewPrompt` uses `draft.plan?.people` only; `PipelineResult.plan` is not consumed in `actions.ts`, `generate-draft.ts`, the UI or any script. | **MEASURED** — grep for `sentences` / `.plan` across `src` and `scripts`. |
| M16 | Gold-corpus voice baseline (192 playbook bodies, greeting and sign-off excluded): pleasantry opening **33.3%**; **zero contractions 75.0%**; 3+ consecutive "I"-openings **15.6%**; resume courtesy line 27.1%; flexibility line 20.8%; discovery phrasing (`I noticed/saw/was glad to see … we/you`) 3.1%; >1 intensifier 0.0%; spaced-hyphen dash 0.0%; double space 0.0%; lowercase sentence start 0.0%; em/en dash present 5.7%. | **MEASURED**. |
| M17 | The mid-sentence-capitalised-word rule uses a **substring** test (`known.includes(word.toLowerCase())`). Probed 18 plausible new proper nouns against a realistic `known` blob: 17 blocked, 1 slipped — `Penn` (substring of `Pennsylvania`), which is benign. The substring hole is real but narrow. | **MEASURED**. |
| M18 | The subscription CLI (`runClaude`, `src/lib/news/claude-cli.ts`) can carry a real draft call for $0 API spend: 5.7s, schema honoured (per `docs/concepts/FINDINGS-probe.md`, independently produced). It exposes no `effort`, `thinking` or fast-mode control and no PDF blocks. | **MEASURED** by the coordinator; I verified the signature `runClaude<T>({model, system, prompt, schema, timeoutMs, imageDir})` and the `CliResult<T>` shape. |

### What M16 means, because it is the load-bearing one

`HOUSE_RULES` tells the drafter "The EXAMPLES below show the format, tone, structure and length to follow… Match their paragraph shape, their warmth". The examples are 75.0% contraction-free and open on a pleasantry a third of the time. The 300-draft simulation found 255/300 contraction-free and 57/300 opening "I hope you are doing well" — **the drafter is obeying the examples, faithfully.** `VOICE_RULES` then asks the reviewer to undo it, one email at a time, under a guard that throws the whole edit away on one slip.

So the accuracy problem here is not a missing lint. It is that **the drafter's strongest signal (192 worked examples) and its voice policy (sent only to the reviewer) disagree**, and the examples win. Any plan that adds checks without addressing that is treating the symptom. This is why R2 below is ranked above everything except the measurement plumbing.

---

## 1. Ranked changes

| # | Change | Accuracy problem it fixes | Evidence the problem is real | Risk | Cost | Confidence |
|---|---|---|---|---|---|---|
| **R1** | **Per-edit (per-span) guard** replacing all-or-nothing rejection | One slip in a multi-fix edit destroys every other fix — the motivating "fellow Duke alum" incident | Code comment in `draft-pipeline.ts` (5 Oct 2026 incident); M9, M10, M12 are three *measured* classes of good edits destroyed today | Frankenstein bodies from mixing accepted and rejected spans; a monotone alignment cannot represent a reorder (mitigated by an explicit `move` op); more surface area in the one component whose job is to stop fabrication | **High** — 2 new modules, ~600 lines, ~40 tests | **High** that it recovers fixes; **Medium** that the recovered output is always clean — the fixture battery is designed to settle exactly that |
| **R2** | **Reconcile the voice policy with the example corpus**: rewrite the drafter's instruction about the examples, move a distilled voice subset into the drafter, and fix the examples' worst offenders | Drafter template prose, which the reviewer then has to undo under a brittle guard | M16 (75.0% zero contractions, 33.3% pleasantry opening, 27.1% stock resume line in gold); the 300-draft numbers in `draft-prompt.ts`; the coordinator's probe draft | Changing the examples changes every draft of that type; crowding the drafter's attention may cost fact fidelity | **Medium** — prompt text + a corpus edit + a CLI A/B | **High** on the diagnosis; **Medium** on the fix magnitude |
| **R3** | **Plaintext review-outcome record** (`email_drafts.review` jsonb or a `draft_review_events` table) | Nothing in this plan can be measured on real traffic today | The archive is AES-GCM sealed with **no decrypt function in the app by design**, gated on `mayTrainOn`; `email_drafts` has **no** review column; the only signal is the `[draft-review]` console line | Privacy — must store reasons and counts, never content | **Low** — one migration, one write | **High** |
| **R4** | **Category-based, not count-based, lint comparison** in the guard | A reviewer edit that swaps one defect for another passes the "worse" test | M11 | A stricter test rejects more edits — but under R1 it rejects a *span*, not the edit | **Low** — needs R6 (categorised findings) | **High** |
| **R5** | **`detailSurvived()` with an anchor rule**, replacing `coverage()` at 0.4 | Both directions: specific details silently dropped, and good edits destroyed for paraphrasing | M5, M6, M7 | A stricter anchor rule rejects more; under R1 that is one span | **Medium** | **High** |
| **R6** | **Strengthen the lint, calibrated on gold**: categorised findings, a widened discovery regex, a canned-courtesy-line set, a type-aware contraction *rate* check, a consecutive-"I" check — all as **distributional**, not absolute, rules | The grader is weaker than the policy it is meant to enforce; the guard cannot tell a good voice edit from a no-op | Coordinator's probe (4 of 5 defects uncaught); M16 sets the calibration and *refutes* two naive versions | **False positives on gold** — the whole risk. M16 shows a naive contraction check fails 75.0% of gold and a naive I-start check 15.6% | **Medium** | **High** on the discovery regex and courtesy lines; **Medium** on contraction/I-start as distributional checks |
| **R7** | **Fix the deterministic fixers**, starting with the em-dash→comma splice bug; add 6 narrow auto-fixes | Code manufacturing defects that a model call is then asked to fix | M8 (measured bug); M16 (spaced-hyphen, double-space, lowercase-start all 0.0% on gold → safe) | A bad rewrite ships silently, with no model in the loop | **Low** | **High** |
| **R8** | **Truth-up the reviewer prompt**: the guard description, the 15%-vs-20% contradiction, the soften-vs-remove conflict, the `", and thank you"` rule | The reviewer is given a false model of its own consequences and two rules the playbook breaks | C1–C7 below, with quotes; M2 (14 gold examples use `", and thank you"`) | Prompt edits are unfalsifiable without a model in the loop — now cheap via R0-CLI | **Low** | **Medium** |
| **R9** | **Expand the guard's `known` set**: school-name variants, resume text when available, and a three-valued verdict (`accept` / `accept-with-note` / `reject`) for the resume-PDF case | Good edits destroyed for words the reviewer legitimately read | M9, M10 | `accept-with-note` admits an unverifiable proper noun into the body (bounded: ≤1 per edit, and the student is told) | **Low** | **High** |
| **R10** | **Who's-who code check** `whosWhoConflicts(facts, plan)`, and decide `plan.sentences` | Role errors are the stated origin of the review pass; `plan.sentences` is pure waste | M15; `BOX_FACTS` comment ("the live evaluation caught it 'correcting' a draft by deciding the student had met someone other than the recipient") | A noisy string-matching check adds false problems to the reviewer's brief | **Low** | **Medium** |

---

## 2. R1 — the per-edit guard

### 2.1 Why sentence-level alignment and not a diff

A word- or character-level diff (Myers, `diff-match-patch`) produces hunks that straddle sentence boundaries. That breaks the only thing that makes per-edit validation possible: **every rule the guard enforces is a property of a sentence or of the document, never of a word-span.** A comma splice is a property of a sentence; "did this edit add a proper noun" is answerable for a hunk, but "did this edit introduce a comma splice" is not. A word diff also renders a sentence split as one enormous replace hunk, which is exactly the edit we most want to accept.

Granularity: **sentence, anchored in paragraphs.** Paragraph-only granularity is too coarse — the measured incidents (one added firm name, one dropped alum phrase) each sit in one sentence of a 2–4-sentence paragraph, so paragraph granularity would still throw away 2–3 good sentences per slip.

### 2.2 New module: `src/lib/draft-align.ts` (pure)

```ts
export type Seg = {
  i: number;        // index in the flat segment list
  para: number;     // paragraph index within the body above the sign-off
  sent: number;     // sentence index within the paragraph
  text: string;     // the sentence, trimmed, terminal punctuation included
  start: number;    // char offset in the body
  end: number;
};

export type Body = { greeting: string; paragraphs: Seg[][]; signOff: string };

export function segment(body: string): Body;

export type Op =
  | { kind: "keep";    orig: Seg[]; rev: string[] }
  | { kind: "rewrite"; orig: Seg[]; rev: string[] }            // 1:1
  | { kind: "split";   orig: Seg[]; rev: string[] }            // 1:n
  | { kind: "merge";   orig: Seg[]; rev: string[] }            // n:1
  | { kind: "move";    orig: Seg[]; rev: string[]; toPara: number; toSent: number }
  | { kind: "delete";  orig: Seg[]; rev: [] }
  | { kind: "insert";  orig: [];    rev: string[]; afterOrig: number };

export type Alignment = {
  ops: Op[];                        // in ORIGINAL order; inserts carry afterOrig
  paraSplits: { afterOrig: number; group: number[] }[];   // revised added a break
  paraMerges: { origParas: number[] }[];                  // revised removed a break
};

export function alignBodies(original: string, revised: string): Alignment;
export function sim(a: string, b: string): number;   // token Dice, 0..1 — exported for tests
```

**Segmentation.** `sentencesOf` in `draft-lint.ts` collapses newlines and so cannot carry offsets; `segment` is a new, offset-preserving scanner:

1. Hold out line 0 as `greeting` and everything from the last line equal to `"Best,"` onward as `signOff` (reuse the existing `bodyAboveSignOff` boundary logic so the two agree).
2. Paragraphs: split on `/\n[ \t]*\n+/`, keeping offsets. A lone `\n` inside a paragraph is also a sentence boundary.
3. **Mask before scanning**: replace each `PLACEHOLDER` match (`/\[[^\]\n]{2,}\]/g`) and each URL with a same-length filler of `X`. Placeholders may legally contain `.` (`[what to ask Dr. Lee]`), and an unmasked scan splits inside them.
4. Sentence boundary: `/(?<=[.!?])["'”’)]*\s+(?=[A-Z“"(])/`, suppressed when the token before the period is in a fixed abbreviation set — `Mr. Mrs. Ms. Mx. Dr. Prof. Dean St. Jr. Sr. vs. e.g. i.e. U.S. Inc. Co. Ltd.` — or is a single capital letter (an initial).
5. Unmask.

**Alignment, level 1 — paragraph anchoring.** `sim(o, r)` = Dice coefficient over lowercased `[a-z0-9']+` token multisets. Monotone maximum-weight matching by LCS-style DP over `(|O|+1) × (|R|+1)`, match reward `sim` when `sim ≥ 0.35`, gap cost 0. Then two post-passes:

- **Paragraph split**: an unmatched revised paragraph `R_j` adjacent to a matched pair `(O_i, R_k)` where `sim(O_i, R_k ⧺ R_j) > sim(O_i, R_k) + 0.10` → treat `O_i` as split; align sentences against `R_k ⧺ R_j` and record a `paraSplit`.
- **Paragraph merge**: symmetric.

**The structural invariant, and it is the one that keeps patched bodies readable:** *the output's paragraph breaks come from the ORIGINAL, unless every op in the corresponding group is accepted.* A paragraph split is honoured only on full acceptance of that group; otherwise the original break pattern stands. This is what stops a half-accepted edit from re-paragraphing an email.

**Alignment, level 2 — sentences within a matched paragraph group.** Needleman–Wunsch, `score(match) = sim(a,b)`, gap penalty `g = 0.35`. The penalty is chosen so a rewritten sentence at `sim ≥ 0.35` prefers the diagonal (score ≥ 0.35) over delete+insert (cost 0.70) — i.e. a reworded sentence aligns as a `rewrite` rather than disappearing and reappearing. Traceback yields 1:1 / 1:0 / 0:1, then:

- **Split detection**: `1:0` at `i` followed by one or more `0:1` → split if `sim(orig_i, concat(revs)) ≥ 0.45`. Also `1:1 (i↔j)` followed by `0:1 (j+1)` → split if `sim(orig_i, rev_j ⧺ rev_{j+1}) ≥ sim(orig_i, rev_j) + 0.10`.
- **Merge detection**: `1:1 (i↔j)` followed by `1:0 (i+1)` → merge if `sim(orig_i ⧺ orig_{i+1}, rev_j) ≥ sim(orig_i, rev_j) + 0.10`.
- **Move detection** (this closes a real hole — the reviewer is explicitly told "To vary sentence openings, **reorder** or reword a sentence"): an unpaired `insert` whose text has `sim ≥ 0.80` with an unpaired `delete`d original **in the same paragraph** becomes a `move`. Without this, a monotone alignment reads a reorder as delete+insert, rejects the insert, and silently duplicates or loses a sentence. Today's guard *accepts* a pure reorder, so omitting `move` would be a deliberate regression in permissiveness. It is not acceptable.
- Normalisation for `sim`: lowercase, straighten curly quotes, strip punctuation. **Do not** expand contractions — a contraction change should surface as a `rewrite` (its `sim` stays high anyway), not be normalised away, because R6 wants to score it.
- Equal normalised text → `keep`.

Complexity: `O(n·m)` with `n, m ≤ ~20` sentences. Negligible; defer any latency statement to PLANNER-A.

### 2.3 New module: `src/lib/draft-guard.ts`

```ts
export type SpanVerdict = {
  op: Op;
  verdict: "accept" | "accept-with-note" | "reject";
  reason?: string;        // why rejected, or what the note says
  note?: string;          // for accept-with-note, a notesForStudent line
};

export type EditOutcome = {
  subject: string;
  body: string;
  applied: "all" | "partial" | "none";
  verdicts: SpanVerdict[];
  backoffs: string[];     // global invariants that forced a revert, in order
  notes: string[];        // accept-with-note lines for notesForStudent
};

export function applyReviewEdit(
  original: { subject: string; body: string },
  revised:  { subject: string; body: string },
  facts: DraftPromptInput,
  problems: ReviewProblem[],
): EditOutcome;
```

**Fast path, and it is deliberate.** `applyReviewEdit` first calls the existing `guardRevision`. If the whole edit passes, it is accepted wholesale with `applied: "all"` and **no alignment work at all**. The span machinery runs only on edits that today are thrown away. Consequence: zero behaviour change, and zero new failure modes, on every edit that currently succeeds; the existing ~20 `guardRevision` unit tests remain valid and unmodified. `guardRevision` stays exported and unchanged.

**Phase A — per-op local rules** (`known` built as today, plus R9's additions):

- **L1 Placeholders**: the multiset of `PLACEHOLDER` matches in `op.rev` must equal that in `op.orig`. (A `delete` of a sentence holding a placeholder fails here — correct; a gap must survive.)
- **L2 Numbers**: every digit-run in `op.rev` must be in `knownNumbers`.
- **L3 New capitalised words**: as today but scoped to the op's sentences and **token-exact, not substring** (closes M17's `Penn`-via-`Pennsylvania` accident in the permissive direction while R9 handles the legitimate direction properly). Sentence-initial words stay exempt. Verdict is three-valued per R9.
- **L4 Span-local lint non-regression, by category**: `spanLint(op.rev) ⊆ spanLint(op.orig)` **by category** (R4) — no category present in the revised span that is absent from the original span. Count comparison is what M11 breaks.
- **L5 Greeting**: not an op. A changed first line is recorded as one rejected verdict; the original greeting is kept and **the rest of the edit still applies**. Today this alone destroys everything (existing test `g5`).
- **L6 `insert`**: rejected by default — a pure insertion is not an edit, it is new content — **unless** it raises some typed detail's `detailSurvived` from false (in the original) to true (in the assembled body), and passes L1–L4. This exception is not a loophole; it is the mechanism `STUDENT_DETAILS_RULES` and the reviewer's "work it back in using FACTS' own words" already assume exists.
- **L7 Cohesion propagation** — the honest answer to "won't this produce Frankenstein prose?". If op `k`'s revised text begins with a referential cue — `/^(It|This|That|They|He|She|His|Her|Their|Those|These|Both|Also|However|But|And|So|Then)\b/` — and the immediately preceding op was rejected, reject op `k` too. Iterate forward to a fixpoint. A rejected `merge` reverts to both original sentences; a rejected `split` reverts to the one. This is the mitigation most likely to be wrong in practice, which is why it gets its own fixture (F12) and a corpus invariant.

**Phase B — global invariants on the assembled body, each with a targeted back-off:**

- **G1 Typed details**: for each typed detail where `detailSurvived(detail, original)`, require `detailSurvived(detail, assembled)`. Back-off: revert the ops overlapping the original sentences with the highest per-sentence support for that detail, until satisfied.
- **G2 Ask**: `ASK.test(original) ⇒ ASK.test(assembled)`. Back-off: revert the op containing the ask sentence. (Note M4: this rule is inert for 82% of shapes; widening `ASK` is tracked in R6, not here.)
- **G3 Shared school**: as today. Back-off: revert the op whose original text matched `sharedSchool`.
- **G4 Document-level lint non-regression by category**: congratulations-after-ask ordering, "Thank you" sentence count, 3+ consecutive "I"-openings, cross-boundary repeated word. Back-off: re-run the document lint with each candidate op individually reverted (≤20 ops × microseconds) and revert the one that clears it.
- **G5 Word window** on the assembled body: ceiling `1.2×`, floor **`0.55×`** (raised from 0.6 because under partial acceptance growth and shrink are both attributable to identifiable ops, and M12 shows 0.6 fires on legitimate short-email deletions). Additionally per-op: an op may not grow its span by more than `1.6×` or `+12` words. Deletions whose original text is covered ≥0.4 by a reviewer `private`/`hateful` problem quote are **excluded from the floor computation** — that is the direct fix for M12.
- **G6** If no ops survive → `applied: "none"`, body byte-identical to the original.

**Retry policy.** Retry only when `accepted/total < 0.5`, or a global back-off reverted ≥2 ops. Otherwise skip it: the retry exists because one slip cost the whole edit, and that premise is gone. Fewer retries is a latency change — **arithmetic deferred to PLANNER-A**.

**Outcome record.** `ReviewOutcome.applied` becomes `"all" | "partial" | "none"` with `spans: { accepted, rejected, reasons[] }`. Keep a boolean alias `appliedAny` so existing callers compile. The log line gains `spans 5/7`.

### 2.4 Files and signatures

| File | Change |
|---|---|
| `src/lib/draft-align.ts` | **new** — `segment`, `alignBodies`, `sim`, types above |
| `src/lib/draft-guard.ts` | **new** — `applyReviewEdit`, `spanLint`, `knownTokens`, `assemble` |
| `src/lib/draft-lint.ts` | categorised findings (R4/R6): `fluencyIssues` returns `Finding[] = {category: string; detail: string}[]`, with `formatFinding()` so the reviewer's brief and student notes are byte-identical to today; add `spanLint`, `detailSurvived`, `whosWhoConflicts` |
| `src/lib/draft-review.ts` | `guardRevision` unchanged; `REVIEW_SYSTEM` edited per R8; `coverage` replaced by `detailSurvived` internally |
| `src/lib/draft-pipeline.ts` | call `applyReviewEdit`; extend `ReviewOutcome`; new retry condition. **Merge with the concurrent `PipelineTimings` edit.** |
| `src/db/schema.ts` + migration | R3 |
| `scripts/draft-align-test.ts`, `scripts/draft-align-corpus.ts`, `scripts/draft-voice-ab.ts` | **new** tests |

### 2.5 Falsifiable test — fixtures

**Command:** `npx tsx scripts/draft-align-test.ts`
Style: identical to `scripts/draft-review-test.ts` — plain tsx, `t(name, ok, got?)`, prints `N/M passed`, `process.exitCode = 1` on any failure. Reuse that file's `INPUT`, `DRAFT` and `SIGNATURE` constants so no new scaffolding is needed. Add to `test:all`.

**Metric:** fixtures passed / fixtures total. **Threshold: 24/24. Any failure fails the change.**

Each fixture asserts three things: the per-span verdicts, `applied`, and a property of the final body.

| ID | Original → edit | Guard today | Expected spans | Expected final body |
|---|---|---|---|---|
| F1 | 4-sentence body with filler + comma splice + `(Class of 2029)`; edit fixes all three **and** drops `a fellow Duke alum` | reject-all | 3 accept, 1 reject (G3) | contains all three fixes **and** `fellow Duke alum` |
| F2 | edit changes `Hi Rachel,` → `Dear Rachel,` and fixes a splice | reject-all | greeting reject, 1 accept | starts `Hi Rachel,`; splice fixed |
| F3 | sentence 1 reworded well; sentence 2 gains `at Goldman` | reject-all | 1 accept, 1 reject (L3) | reworded s1; **no** `Goldman` |
| F4 | `15 minutes` → `20 minutes`; other sentences reworded | reject-all | ask-sentence reject (L2), rest accept | `15 minutes` retained |
| F5 | edit drops a sentence containing `[what you want to learn]` | reject-all | that op reject (L1) | placeholder present |
| F6 | clean paraphrase (M7-adjacent, passes today) | accept | `applied:"all"`, `verdicts.length === 0` | equals the revised body; assert `alignBodies` never called |
| F7 | one sentence → two, both clean | accept | 1 `split` accept | same paragraph count as original |
| F8 | two sentences → one, introducing `…with Ben, we had our call` | reject (worse) | `merge` reject (L4) | both original sentences verbatim |
| F9 | reviewer adds a paragraph break; all ops clean | accept | all accept | **4** paragraphs (break honoured) |
| F9b | same, but one op in that group rejected | reject-all | 1 reject | **3** paragraphs (original structure) |
| F10 | reviewer inserts `I would also love to hear how you chose credit.` (no typed backing) | accept today | `insert` reject (L6) | sentence absent |
| F11 | typed detail `we talked about his Mustang` absent from the draft; reviewer inserts it | accept | `insert` accept (L6 exception) | contains `Mustang` |
| F12 | s2 rewritten (rejected, new number); s3 begins `It was the part that stuck with me.` | reject-all | s2 reject, s3 reject (L7) | original s2 **and** s3 |
| F13 | edit removes a filler **and** adds a comma splice (M11) | **accept** (count 1→1) | splice op reject (L4), filler op accept | filler gone, no splice |
| F14 | `hasResumePdf:true`, no summary; edit adds `Pinecrest` (M10) | reject-all | `accept-with-note` | contains `Pinecrest`; `notes` names it |
| F14b | same with `hasResumePdf:false` | reject-all | reject (L3) | no `Pinecrest` |
| F15 | facts `studentSchool:"Penn"`; edit writes `the University of Pennsylvania` (M9) | reject-all | accept (R9 variants) | contains the full name |
| F16 | 30-word body; reviewer deletes a 13-word private sentence with a `private` problem (M12) | reject (`cut from 30 to 17`) | delete accept; G5 excludes it | sentence gone |
| F17 | every sentence rewritten with an invented fact | reject-all | all reject | `applied:"none"`, body **byte-identical** to original |
| F18 | reviewer reorders two sentences in one paragraph | accept | 1 `move` accept | both sentences present exactly once, order swapped |
| F19 | reviewer reorders **across** paragraphs | accept | `insert` reject + `delete` reject | body unchanged in both paragraphs (documented limitation) |
| F20 | abbreviation `Dr. Lee` mid-sentence | n/a | segmentation: 1 sentence, not 2 | — |
| F21 | placeholder containing a period `[what to ask Dr. Lee]` | n/a | segmentation: 1 sentence | placeholder intact |
| F22 | edit identical to the original | accept | `applied:"all"`, 0 verdicts | identical |
| F23 | revised body is empty string | reject | `applied:"none"` | identical to original |
| F24 | determinism: run F1 twice | — | identical `EditOutcome` JSON | — |

### 2.6 Falsifiable test — corpus property battery

**Command:** `npx tsx scripts/draft-align-corpus.ts`

Corpus: the 192 playbook example bodies as "originals". A **seeded** mutator (fixed LCG seed `0x0FFE12`, printed in the header so runs are reproducible) generates five edit classes per body:

- **(a) benign** — contraction toggles (`I am`↔`I'm`, `I would`↔`I'd`, `do not`↔`don't`, `it is`↔`it's`); split at the first `", and "` into two sentences; remove a `FILLER` match and re-capitalise.
- **(b) poisoned** — inject exactly one of: a new proper noun, a new digit-run, a changed placeholder, a dropped ask sentence, a dropped shared-school phrase.
- **(c) mixed** — one benign span plus one poisoned span, in different sentences.
- **(d) structural** — a sentence split, a sentence merge, a paragraph split.
- **(e) reorder** — swap two sentences within a paragraph.

Assertions over all 192 × 5 = 960 pairs:

| Inv | Assertion | Threshold |
|---|---|---|
| INV1 | the final body contains no proper noun or digit-run absent from an independently recomputed `known` | **0 violations** |
| INV2 | final greeting line === original greeting line | **0** |
| INV3 | placeholder multiset of final === original | **0** |
| INV4 | `draftChecks(final).forReview` categories ⊆ `draftChecks(original).forReview` categories | **0** |
| INV5 | `ASK.test(original) ⇒ ASK.test(final)` | **0** |
| INV6 | word count of final ∈ `[0.55, 1.2] ×` original, excluding private-flagged deletions | **0** |
| INV7 | class (a): final === revised (full acceptance) | **≥ 95%**, every miss listed |
| INV8 | **class (c): final contains the benign change AND not the poison** | **≥ 90%** |
| INV9 | paragraph count of final === original, unless the whole split/merge group was accepted | **0** |
| INV10 | class (e): both sentences present exactly once, reordered | **≥ 90%** |
| INV11 | determinism: two runs byte-identical | **0** |
| INV12 | no corruption: `!/ {2,}| ,|,,|\.\./.test(final)` and no empty paragraph | **0** |

**INV8 is the headline.** Today's guard scores **0%** on class (c) by construction — one poisoned span destroys the benign one. The script prints `recovered_fraction` for both the old and the new path side by side. If the new path cannot clear 90% there, R1 has not earned its cost and should be abandoned rather than tuned.

---

## 3. R2 — reconciling the voice policy with the example corpus (and the verdict on idea #2)

### 3.1 The finding, stated plainly

**Move `VOICE_RULES` into the drafter: ADOPT, but only as part of a larger change, and not wholesale.**

The question as posed — "does moving the rules reduce the review's workload enough to matter?" — has the wrong denominator. The reviewer is not removed either way: it still does who's-who, invented facts, private content, mismatch and fluency. `VOICE_RULES` is 20.4% of its prompt (M14) and the review call stays. So the latency/cost case is nil (PLANNER-A's lane) and the accuracy case is "fewer voice defects reaching the guard" — plausible, and now **testable for free** via M18.

But M16 says the reason the drafter writes template prose is not that it lacks the rules. It is that **its 192 worked examples are template prose by the rules' own standard**: 75.0% zero contractions, 33.3% pleasantry opening, 27.1% the stock resume line, 5.7% containing the em dashes `HOUSE_RULES` bans. And `HOUSE_RULES` tells it to "Match their paragraph shape, their warmth". Adding `VOICE_RULES` to the drafter sets up a direct contradiction between the prose rules and the 192 demonstrations, and demonstrations usually win.

### 3.2 What to change

**R2a — the drafter's instruction about the examples.** Add to `HOUSE_RULES`, immediately after the "EXAMPLES show the format" bullet:

> "The examples are correct about structure, order, length and what each paragraph does. They are **not** a model for sentence rhythm or word choice: many of them open on a pleasantry, avoid contractions, and use stock courtesy lines. Take their shape; write the sentences the way the VOICE section says."

This is the single highest-leverage prompt edit in the plan, and it is cheap. It is also the one claim I would most want a model in the loop to settle.

**R2b — a distilled voice subset in the drafter** (~900 chars, estimated from the six bullets): the pleasantry rule, throat-clearing, varying sentence openings, the contraction policy, the courtesy-line rule, and the common-ground phrasing rule. Chosen because these are **exactly** the rules R6's lint can score — so the effect is measurable. **Keep the full `VOICE_RULES` in the reviewer**: it is the only component that sees finished text, and these are properties of finished text.

**R2c — fix the worst gold examples.** 20 examples open `I hope this email finds you well`; 52 use a stock resume line. Rewriting the worst offenders in `email-examples-v3/v4.json` changes the demonstration, not just the instruction. Scope: the 20 pleasantry openings first; measure before going further. **Risk**: this changes every draft of those types, and the examples are the product's accumulated taste — this needs Kai's sign-off, not an agent's.

### 3.3 Detecting that the drafter got worse at facts — offline, no API

The crowding worry is specific: more voice text competing with `HOUSE_RULES`, `STUDENT_DETAILS_RULES` and the examples for attention on facts. Three scores, all pure code, all computable on any corpus of drafts:

```ts
// src/lib/draft-fidelity.ts
export function factFidelity(facts: DraftPromptInput, draft: RawDraft): {
  detailRetention: number;   // typed details with detailSurvived(detail, body) / total
  hallucinations: string[];  // proper nouns + digit-runs in the body absent from facts
  gapDiscipline: boolean;    // every [bracket] in the body appears in gaps, and vice versa
  planConflicts: string[];   // whosWhoConflicts(facts, draft.plan)
};
```

**R2 test — command:** `npx tsx scripts/draft-voice-ab.ts --n 40 --seed 7`

Paired A/B through `runClaude` (zero API spend, M18). Arm A = current drafter prompt; arm B = R2a+R2b. Same 40 situations in both arms, drawn deterministically from `scripts/draft-scenarios.ts` (seeded). Serial cost ≈ 40 × 2 × 6s ≈ 8 minutes.

| Metric | Direction | Pass/fail |
|---|---|---|
| `voiceScore` = mean R6 findings per draft | lower is better | **B < A, and the paired bootstrap (10,000 resamples) 95% CI for the mean difference excludes 0** |
| `detailRetention` | must not fall | **B ≥ A − 0.02** (absolute) |
| `hallucinations` per draft | must not rise | **B ≤ A**, and **B = 0 required on ≥ 95% of drafts** |
| `gapDiscipline` | must not fall | **B ≥ A** |
| `planConflicts` per draft | must not rise | **B ≤ A** |

Fails on any row → do not ship R2b. **Stated caveats:** the CLI exposes no `effort`/`thinking`/fast-mode control and the probe ran `claude-sonnet-5-5`, so this measures the **prompt's** effect on a nearby model, not the production Opus-low config; N=40 gives roughly ±0.3 findings/draft resolution (**ESTIMATED** from a Poisson assumption at a ~1.5 findings/draft base rate — treat as indicative, which is why the gate is the bootstrap CI and not the point estimate).

### 3.4 Attributing the improvement between the lint and the prompt

The coordinator asked how to separate "strengthen the lint" from "give the drafter the voice rules". They are separable because **the lint is a measuring instrument and the prompt is a treatment.** Procedure, in order:

1. Build and freeze R6's checks. Print the gold-corpus baseline (M16's table) and commit it as a fixture. **Nothing is attributed to the lint** — it changes no output; it changes what we can see. Its only claim is "these rates are now observable", falsified by the gold calibration test (§5).
2. With the lint frozen, run the §3.3 A/B. Any movement is attributable to the prompt, because the instrument did not move.
3. Second arm, same instrument: R2a alone vs R2a+R2b. Separates "stop imitating the examples" from "here are the voice rules". My prediction, to be falsified: **R2a alone recovers most of the contraction and pleasantry gap** (ESTIMATED from M16 — the gold rates and the 300-draft rates are close enough, 75.0% vs 85.0% zero-contraction, that imitation is the better explanation than ignorance).
4. Only a change that moves a *production-path* metric gets credit. The lint's contribution to accuracy is indirect and shows up through R1/R4: a review brief that names real defects and a guard that can tell a good voice edit from a no-op.

---

## 4. R6 — the missing voice checks, calibrated on gold

The coordinator's framing — "calibrate against the playbook's gold emails, which MUST pass" — is the right discipline, and applied honestly it **refutes two of the four requested checks in their naive form.** M16:

- A check "this email has no contractions" fails **75.0%** of gold (144/192).
- A check "3+ consecutive sentences open with I" fails **15.6%** of gold (30/192).
- A check "opens on a pleasantry" fails **33.3%** of gold (64/192).
- A check "uses the stock resume line" fails **27.1%** of gold (52/192).

So gold cannot be the pass bar for absolute versions of these. Two honest options: (i) make the checks **distributional** — they grade a corpus, not an email, and feed the review brief only when a per-email rule can be stated safely; or (ii) accept that gold is *not* gold for voice and fix the corpus (R2c) before calibrating. **I recommend both**: ship the distributional versions now; recalibrate after R2c.

### 4.1 Contraction check — type-aware, rate-based

```ts
export function contractionRate(main: string): { contractions: number; opportunities: number; rate: number };
export function contractionFinding(typeId: EmailTypeId, boxIds: string[], main: string): Finding | null;
```

- **Opportunities**: occurrences of `/\b(I am|I have|I would|I will|it is|that is|do not|does not|did not|cannot|can not|is not|are not|was not|were not|I had|you are|we are|they are|there is)\b/gi`. **Contractions**: `/[A-Za-z][’']((m)|(re)|(s)|(ve)|(d)|(t)|(ll))\b/g`.
- **Exempt types** (full forms are correct per `VOICE_RULES`): any email where `boxIds` includes `first.inbox` or `first.recruiter`, or `TEAM_RECIPIENT`/`RECRUITER_ROLE` matches, or the type is an offer decision or a professor letter. The type list must be read from `EMAIL_TYPES`, not hard-coded by id, and the exempt set is asserted non-empty in the test.
- **Per-email rule, deliberately weak**: flag only when `opportunities ≥ 6 && contractions === 0` and the type is not exempt. **Rationale**: on gold this fires on a strict subset of the 75.0%, and the opportunity floor keeps it off short emails. The honest statement is that the per-email version is *advisory*; the real signal is the corpus rate.
- **False-positive risk**: high, and acknowledged. `VOICE_RULES`' own exemption list ("recruiting team or inbox, offer decisions, and letters to professors") is not fully determinable from `boxIds` — a cold email to a person who happens to be formal is not exempt but reads fine in full forms.
- **Counterexample that makes it unsafe**: a `thanks_professor`-style letter, or any email whose recipient was typed as a committee ("Hello Admissions Committee,"): full forms are correct, the box may not say so, and the check would push the reviewer to insert contractions into a letter that should not have them. Mitigation: exempt whenever the greeting matches `TEAM`/`TITLED` in `draftChecks`, which already detects exactly this.

### 4.2 Consecutive-"I" check

```ts
export function iOpeningRun(main: string): number;  // longest run of sentences opening "I"
```

- **Rule**: flag when the longest run `≥ 4`, not 3. **Measured justification**: at `≥ 3`, 15.6% of gold fails; the coordinator's probe draft has **5**. A threshold of 4 keeps the probe-class defect flagged while cutting the gold false-positive rate (I did not measure the `≥4` gold rate — **this must be measured and asserted in the calibration test before shipping**, and if `≥4` still trips >5% of gold, the check ships as corpus-only).
- Counts sentences in `main` (greeting and sign-off excluded), opening token `I` or `I'm`/`I'd`/`I've`/`I'll`.
- **False-positive risk**: low-moderate. A short email of 3 sentences, all legitimately first-person, cannot reach 4.
- **Counterexample that makes it unsafe**: a thank-you email that is genuinely a narration of what the student did after a conversation — 4 consecutive "I" sentences can be the correct shape there. Mitigation: exempt types whose format steps are first-person narration; or accept the flag, since the reviewer's instruction is to *reorder or reword*, not to delete.

### 4.3 Canned-courtesy-line set

```ts
const COURTESY: { category: "resume" | "flexibility" | "easy_out"; stock: RegExp; preferred: string }[];
export function courtesyFindings(main: string): Finding[];
```

- Stock patterns (from `VOICE_RULES`' own named examples, so the rule and the policy cannot drift):
  - resume: `/\b(I(?:'ve| have)? attached (?:a copy of )?my resume (?:for your (?:reference|review)|below)?|my resume is attached for your reference)\b/i` — preferred: "My resume's attached in case it's useful"
  - flexibility: `/\bI(?:'m| am) happy to work around your schedule\b|\bwhatever works best for you\b/i` — preferred: "Any time that suits you works for me"
  - easy out: `/\bI (?:completely )?understand if you(?:'re| are) (?:too )?busy\b|\bno worries (?:at all )?if not\b/i` — preferred: "No worries at all if the timing's wrong"
- **Rule**: flag the stock phrasing and name the preferred phrasing in the finding, so the reviewer is told what to write, not only what is wrong.
- **False-positive risk**: low — these are exact phrasings, and the finding is advisory.
- **Counterexample that makes it unsafe**: an auto-fix. "I attached a copy of my resume for your reference" → "My resume's attached in case it's useful" is a *meaning-preserving* swap that nonetheless makes every email say the same new thing. **Do not auto-fix; flag only.** The whole point of these rules is variety; a deterministic rewriter produces a new template.
- **Gold impact**: 27.1% + 20.8% (M16) trip the resume/flexibility concepts; the regexes above are narrower than the concept probes, so the gold hit rate must be re-measured in the calibration test and the thresholds set from it.

### 4.4 Widened discovery-phrasing regex

Current: `/\bI (?:noticed|saw|gather|learned|was glad to learn|realized) (?:that )?we(?:'re| are) both\b/i`. It requires `we're both`, so the probe's **"I was glad to see that you are also from Atlanta"** slips through.

Proposed:

```
/\bI (?:noticed|saw|see|gather|learned|found|was (?:glad|excited|happy) to (?:see|learn|find)|realized|came across)\b[^.!?]{0,60}?\b(?:we(?:'re| are)? both|you (?:are |were )?also|you (?:too|as well)|we share|you(?:'re| are) (?:also )?(?:a|an|from))\b/i
```

- **Measured gold impact**: a close probe of this shape (`I noticed|saw|was glad to see|learned|gather|realized … we|you`) matches **3.1%** of gold (6/192) — safe to widen.
- **False-positive risk**: low-moderate. The `[^.!?]{0,60}?` window can bridge an unrelated clause.
- **Counterexample that makes it unsafe**: "I saw that you are also speaking at the conference next month" — a legitimate observation about the recipient's *news*, not an announced commonality, and flagging it would push the reviewer to delete a real fact. Mitigation: require the matched tail to name a commonality class — school, hometown, club, employer, or a token that appears in `detectedOverlaps` — rather than accepting any `you are also`. **Implement with that restriction**; the unrestricted version is the unsafe one.

### 4.5 What R6 means for the guard (coordinator's point 2)

Three consequences, all of which change the R1 design as written above:

1. **The guard cannot currently distinguish a good voice edit from a no-op**, because `draftChecks` has no contraction, I-run or courtesy-line category. The "worse" test is therefore blind to most of what `VOICE_RULES` asks the reviewer to do. R6 does not just add detection — it is what makes the guard's lint comparison *about* the reviewer's actual job.
2. **The comparison must be by category, not by count** (R4, M11). With R6's new categories this gets sharper: an edit that converts 0 contractions to 4 while introducing one comma splice must be judged as "one new defect category" (reject that span) rather than netting out.
3. **Voice categories must be `spanLint`-local where possible and document-level where not.** Contraction rate and the I-run are inherently document-level: a single rewritten sentence cannot be judged on them. So they live in **G4**, not L4, with the back-off that reverts the op that introduced the regression. The courtesy-line and discovery checks are sentence-local and belong in **L4**. Getting this split wrong is the most likely way R1 ships with a subtly wrong guard, so each voice category gets an explicit `scope: "span" | "document"` field in the `Finding` type, asserted in the test.

### 4.6 R6 test — gold calibration

**Command:** `npx tsx scripts/draft-lint-calibration.ts`

Runs every check over all 192 `EMAIL_EXAMPLES` bodies and all 42 Volume V examples, prints a rate table, and asserts a **committed** threshold per check. Thresholds, set from M16 and intended as a ratchet:

| Check | Max gold hit rate | Basis |
|---|---|---|
| discovery phrasing (restricted) | **≤ 5%** | MEASURED 3.1% for the unrestricted shape; the restricted one is narrower |
| courtesy lines (exact stock phrasings) | **≤ 10%** | ESTIMATED — the concept probes measured 27.1%/20.8%, the exact regexes are much narrower; **must be measured and the threshold re-set in the first implementation step** |
| consecutive-I (`≥ 4`) | **≤ 5%** | ESTIMATED from MEASURED 15.6% at `≥ 3`; **must be measured at `≥ 4`** |
| contraction (per-email, non-exempt, `opportunities ≥ 6 && contractions === 0`) | **≤ 40%** | MEASURED 75.0% for the naive version; the opportunity floor and exemptions must cut it roughly in half. If it cannot reach 40%, the check ships **corpus-only** and the per-email version is dropped |
| spaced-hyphen dash, double space, lowercase start | **0%** | MEASURED 0.0% each |
| em/en dash present | — | MEASURED 5.7%; reported, not gated (`finishDraft` strips them) |

The script also prints the existing checks' gold rates so M1–M3 become a standing regression test: **`filler phrase` must fall below 33/192 after the C4 recalibration (R8), and `", and thank you"` must fall below 14/192 or the rule must be removed.** Pass/fail: every gated row at or under threshold.

---

## 5. R5 — replacing `coverage()`

### 5.1 Measured failure modes

- **False negatives** (the student's detail is gone and the guard does not notice): M6 — a long detail keeps its generic half and scores 0.43.
- **False positives** (a good edit is destroyed): M7 — a paraphrase scores 0.00.
- **Stem collisions** (both directions): M5 — `intern`/`internal`/`interest` → `inter`; `distressed`/`distribution` → `distr`.
- **Structural**: unweighted — a 1-token detail is all-or-nothing; a 7-token detail can lose its only proper noun and pass.

### 5.2 Design

```ts
export function detailSurvived(detail: string, body: string): boolean;
export function detailScore(detail: string, body: string): { score: number; anchorsLost: string[] };
```

1. **Tokenise** as today (`[a-z0-9#]+`, length ≥ 4 or containing a digit, minus `CONTENT_STOP`).
2. **Weight**: `w(t) = 1` if `t` is an **anchor** — capitalised in the typed detail, contains a digit, or absent from `DETAIL_COMMON`; else `0.4`. `DETAIL_COMMON` is generated from the playbook corpus (tokens appearing in ≥10% of the 192 bodies), committed as a constant in `draft-lint.ts` alongside the generator script, so it is deterministic and auditable rather than a hand-written list.
3. **Match**: exact token match, or equal stems under a **suffix-stripping** stemmer (`s, es, ed, ing, ly, ion, ions, ment, ments, al, er`) requiring stem length ≥ 4. Measured effect: separates `intern`/`internal`/`interest` and `distressed`/`distribution` (M5), keeps `manage`/`management`/`manager` together.
4. **Verdict**: `survived = (Σw(matched) / Σw(all) ≥ 0.4) && anchorsLost.length === 0`, where `anchorsLost` = anchors present in the **original** body and absent from the candidate.

**The anchor rule is the substantive change.** M6 is exactly "the ratio held but the specific half vanished"; the anchor clause catches it. And it makes the guard *more* permissive where it matters: the reviewer may paraphrase everything around an anchor freely, which is most of what it is asked to do.

**M7 stays rejected, correctly.** `Mustang → his car` genuinely drops the student's word. What fixes M7 is R1: only the paraphrasing span reverts, not the edit.

### 5.3 Test

**Command:** `npx tsx scripts/draft-detail-test.ts`

- **Fixture table, 24 rows**, including every M5/M6/M7 case with its expected verdict. Threshold **24/24**. Required rows: M6 → `false` (today `true`); M5 collisions → `false` for each unrelated pair (today `true`); M7 → `false` (unchanged, documented as span-level handling); `cars` present → `true`; `cars` absent → `false`; `call on 10/6 at 3pm` vs `Could we speak on October 6?` → `false` (anchor `3pm` lost) with `anchorsLost: ["3pm"]`.
- **Corpus sanity**: for all 192 bodies, take a seeded 6-token window of the body as the "detail": `detailSurvived(window, body) === true` for **100%** (0 violations), and `detailSurvived(window, bodyWithWindowRemoved) === false` for **≥ 95%**.
- **Agreement report**: print the confusion matrix between `coverage ≥ 0.4` and `detailSurvived` over those 192×2 pairs so the behaviour change is visible and reviewable rather than asserted.

---

## 6. R7 — deterministic auto-fixes

`finishDraft` already rewrites em dashes, signatures and subjects. The test for promoting a check from the reviewer to code: **is the rewrite a function of the string alone, with a counterexample set small enough to enumerate?**

### 6.1 Automate

| # | Check | Rewrite rule | Counterexample that would make it unsafe |
|---|---|---|---|
| 1 | **em dash (fix the existing bug, M8)** | If a sentence contains exactly **2** dashes → the inner span becomes `, X, ` (parenthetical). If **1** → test the right-hand side for a full clause (subject pronoun/determiner + finite verb, reusing `SPLICE_START`): clause → `. ` + capitalise; else `, `. Never ` - `. | `"the three groups—credit, equities and rates—all recruit"`: a paired parenthetical. A blanket `. ` splits it into nonsense; a blanket `, ` (today) produces the measured comma splice. Hence the pair/single branch. |
| 2 | **`also … too`** | Only when `too` is pre-punctuation or sentence-final: drop `/,?\s+too(?=[.,!?]|$)/`. Otherwise leave. | `"I also worked on two deals, too few to generalise from"` — `too` as a degree adverb. Excluded by the pre-punctuation restriction. |
| 3 | **spaced hyphen as a dash** | Same clause test as (1) on `[A-Za-z,.!?] - [A-Za-z]`. | A dash bullet at line start, and numeric ranges. Both excluded by requiring a letter immediately before the space-hyphen. Gold incidence **0.0%** (M16), so the rewrite is near-no-op on good text. |
| 4 | **`(Class of 2029)`** | Delete the parenthetical and one preceding space, when `!gmailSignature && studentGradYear` (the condition the existing check already uses). | The parenthetical is the *only* statement of the year **and** the app's signature is not appended — already excluded by the `gmailSignature` condition. |
| 5 | **double space / space-before-punctuation** | Collapse. Skip inside URLs and placeholders. | A URL or a quoted code token. Gold incidence **0.0%**. |
| 6 | **capital after a colon** | Lowercase the next word **only** if it is in a fixed function-word list (`does do did is are was were how what when where why whether if can could would should will`). | `"my two questions: Anchorage's process"` — a proper noun. Excluded by the closed list. |
| 7 | **repeated word** | Delete the duplicate, keeping the existing `that`/`had` exclusions, and only within one sentence. | `"New York, New York"`, `"had had"`. Excluded by the sentence restriction and the list. |
| 8 | **lowercase sentence start** | Capitalise. Skip a lowercase-then-uppercase token (`iPhone`, `eBay`) and anything inside brackets. | `"iPhone"`; a placeholder opening a sentence. Gold incidence **0.0%**. |

### 6.2 Do not automate — these need the model

| Check | Why | Decisive counterexample |
|---|---|---|
| **filler phrases** | The deletion is not local. `"I wanted to reach out to learn more about X"` minus the filler leaves `"To learn more about X."` — ungrammatical. And **20/192 gold examples** (M2) legitimately open `I hope this email finds you well`, which `VOICE_RULES` conditionally permits. | Any filler whose removal leaves a dependent clause. |
| **comma splices (general)** | The fix chooses between a period, a semicolon and a joining word, and the choice carries emphasis. | `"It was a great panel, it really was."` — an intentional echo; a mechanical period flattens it. The one splice subclass that *is* safe to fix is the one code created (item 1). |
| **`to then`** | Reordering changes meaning: `"I hope to then move into credit"` → `"…move into credit then"` is not the same claim. | — |
| **connector-not-a-cause** | Requires judging whether a causal relation holds; the lint only pattern-matches three regexes and the correct fix is to re-split the sentence. | — |
| **canned courtesy lines (R6)** | A deterministic rewriter replaces one template with a *new* template, defeating the purpose. | — |

### 6.3 Test

**Command:** `npx tsx scripts/draft-autofix-test.ts`

- **Fixture table**: for each of the 8 automated fixes, ≥3 rows — a positive (input → exact expected output) and **every counterexample above as a row expecting the string UNCHANGED**. Threshold **100%**.
- **M8 regression row, named**: `"…at the panel—I came away with a lot to think about."` → output contains `"panel. I came away"`, and `commaSplices(output).length === 0`. This is the measured bug; it must have its own named assertion.
- **Corpus invariant**: apply all auto-fixes to the 192 gold bodies. Assert **(a)** no body gains a `draftChecks` category it did not have (0 violations), **(b)** the number of bodies changed is ≤ the number currently tripping the corresponding lint, printed per fix. Rationale: on gold text the fixers must be near-no-ops, and M16's 0.0% rates for items 3, 5 and 8 make that a sharp test.

---

## 7. R9 — the guard's `known` set, and a three-valued verdict

1. **School-name variants** (fixes M9). Build a variant set from `studentSchool`, `alumniSchool`, `contactSchool` and `contactFirm`: the full string, the string minus `University|College|School|Institute|of|the|at`, and the bare first significant word. Add all variant tokens to `knownTokens`. Measured effect: `Penn` ↔ `University of Pennsylvania` passes in **both** directions without reopening the substring hole (M17).
2. **Resume text when it exists**: add `studentResumeSummary` tokens (already in facts via `JSON.stringify`, but make it explicit and token-level rather than substring).
3. **The PDF case (M10) gets a third verdict.** When `hasResumePdf && !studentResumeSummary`, an op whose only local failure is one unknown capitalised word is `accept-with-note`: the span is applied and a note is added — `Check that "Pinecrest" is right; it came from your resume, which we could not read as text.` Bounded: **at most one** such op per edit; a second makes both `reject`.
   **The argument, since this is the one place I deliberately weaken fabrication control:** the reviewer is *shown the PDF by design* ("Without it, real experience from an unread PDF looks invented and gets cut"). A proper noun it takes from the resume is a real fact about the student; one it invents is a fabrication; **the guard cannot distinguish them, because the pipeline does not give it the text.** The choice is between destroying good edits silently (measured, today) and admitting one unverified proper noun while telling the student. The second is honest and visible. The *better* fix is to extract the PDF text once and pass it in; `accept-with-note` is the fallback for when nobody has.
4. **Keep the substring test nowhere.** Token-exact everywhere, with the variant set as the only widening.

**Test**: F14/F14b/F15 in §2.5, plus a table of 12 (facts, candidate token, expected verdict) rows covering each variant generator, and **INV1 in §2.6 recomputed independently of the implementation** — if R9 widens `known` wrongly, INV1 catches it on 960 pairs.

---

## 8. R10 — the plan, WHO'S WHO, and `plan.sentences`

**Should who's-who checking be its own cheap structured call? REJECT.** Three reasons:

1. `WHO'S WHO` is 1–3 lines of **deterministic** text from `BOX_FACTS` and costs nothing to keep where it is. The check it enables needs the same `FACTS` the reviewer already has in context, so splitting it out buys no context reduction and spends a whole serial model call.
2. The thing `WHO'S WHO` prevents is the **reviewer** mis-"correcting" roles — the `BOX_FACTS` comment says precisely that ("the live evaluation caught it 'correcting' a draft by deciding the student had met someone other than the recipient"). So it must be in the reviewer's context whether or not a third call exists. Removing it to a separate call would *reintroduce* the measured bug.
3. A role error the reviewer cannot settle already routes to the student via `needsStudent`, which is the right destination for a judgment call.

**ADOPT instead — a pure code check.**

```ts
export function whosWhoConflicts(
  facts: Pick<DraftPromptInput, "boxIds" | "contactName" | "brief">,
  plan: RawDraft["plan"],
): string[];
```

Three rules decidable from strings:
- a person whose `role` contains `recipient` must have a `name` matching `contactName` (full or first-name match);
- if `first.referred` is checked, exactly one person's role must match `/referr|suggested|introduced/i`, and it must **not** be the recipient;
- if `first.met` or `first.conference` is checked, the person whose role matches `/\bmet\b/` must be the recipient.

Conflicts are appended to the reviewer's `AUTOMATIC CHECKS FLAGGED` block and, if unresolved, become a student note. **Test**: a 12-row fixture table of (boxIds, plan, expected conflicts) — fully offline, since the plan is an input. Threshold 12/12. Plus: 0 conflicts on a hand-built table of 8 correct plans (false-positive gate).

**`plan.sentences`: it is dead output (M15).** Two options. **(a) Use it**: before reading the body, assert every typed detail appears in ≥1 planned sentence — a pure code check that localises a dropped detail to a *planned* sentence, which is strictly more actionable than discovering it missing from the body. **(b) Drop the field.** Recommend (a), with (b) as the fallback if the check proves noisy. Either way the current state — generating it on every draft and reading it nowhere — is indefensible. Output-token arithmetic: **PLANNER-A's lane.**

---

## 9. R8 — prompt-stack conflicts, with quotes

| ID | Conflict | Fix |
|---|---|---|
| **C1** | `REVIEW_SYSTEM` gives the reviewer **two different ceilings**. Bullet 1: *"thrown away whole if it … grows past 20% or shrinks past 40%"*. Bullet 4: *"Stay close to the draft's length: never more than 15% longer."* Code: `after > before * 1.2`, `after < before * 0.6`. The 15% is not enforced anywhere. | One sentence, matching the code. |
| **C2** | *"Your edit is checked before it is used, and **thrown away whole** if…"* becomes **false** under R1. A reviewer given a false model of its own consequences will keep bundling defensively, or under-edit. | Rewrite to describe span-level acceptance: "Each change you make is checked on its own. A change that adds a fact is dropped; the rest of your edit is kept. So fix everything you see — one slip no longer costs the others." |
| **C3** | **Soften vs remove.** Drafter (`STUDENT_DETAILS_RULES`): *"a health condition becomes \"a medical leave\" or \"health reasons\", a pregnancy becomes \"family reasons\""*. Reviewer (rule 3): *"even when softened (\"his gambling addiction\" is not fixed by writing \"his poker obsession\"). Remove it and tell the student."* The drafter is instructed to produce exactly what the reviewer is instructed to delete — and the deletion then has to survive the guard (M12: a legitimate removal was rejected on the shrink floor). | One policy, one place. The **drafter** removes-and-notes anything `privateTopicsIn` matches (never softens); the reviewer's rule 3 stays as the net. Both prompts quote the same list. |
| **C4** | **The pleasantry, three ways.** `VOICE_RULES`: *"Use a pleasantry (\"I hope you're doing well\") only when there is nothing specific to lead with"* — conditional. `draft-lint` `FILLER`: `/I hope this (?:email|message|note) finds you well/` — **unconditional** `forReview` problem. `HOUSE_RULES`: silent. MEASURED: **20/192** gold examples contain that exact phrase (M2). So the lint hands the reviewer a "problem" the examples teach the drafter to produce and `VOICE_RULES` permits. | Make the pleasantry finding conditional: flag only when a specific lead exists (a referrer, a meeting, news, or a question in the first two sentences). Gold rate must fall below 20/192 (asserted in §4.6). |
| **C5** | **The thank-you join.** Reviewer rule 6: *"A statement and a thank-you are two sentences: … never \"Ben and I had our call, and thank you again…\"."* MEASURED: the playbook's own `redirect_sequence` example reads **"Dorothy and I spoke on Tuesday, and thank you again for sending me her way."** — `", and thank you"` appears in **14/192** examples (7.3%), including **3 of 42** Volume V (M2, M3). The reviewer is told to "fix" a construction the gold corpus uses. | Narrow it (flag only when the sentence already carries two other clauses) or remove it. Not both ways. |
| **C6** | **Doc/code drift.** `EMAIL_DRAFTING_WORKFLOW.md`: the checks *"are calibrated against the playbook's own Volume V emails, **which pass them**."* MEASURED: 6/42 Volume V and 48/192 per-type examples produce ≥1 `forReview` finding (M1, M3). | Either the lint changes or the claim does. §4.6 makes it a standing test so it cannot drift again. |
| **C7** | **The resume PDF.** Reviewer: *"Never add a fact, name, number, date, place or claim"* **and** *"If the draft left a typed detail out…, work it back in using FACTS' own words."* The reviewer is shown the PDF; the guard gets `hasResumePdf: boolean`. MEASURED: restoring a real resume fact is rejected as `added "Pinecrest"` (M10). | R9: variants, resume text where available, and `accept-with-note`. |
| **C8** | **Three layers, one job.** `HOUSE_RULES` "No em dashes" (drafter) → `finishDraft` dash→comma (code) → `draftChecks` comma-splice (code) → reviewer "No dashes as punctuation" (model). MEASURED: the code layer **creates** the defect the model layer is then asked to fix (M8). | R7 item 1. |
| **C9** | **Contraction policy addressed to the wrong reader.** `VOICE_RULES` says *"Keep full forms in emails to a recruiting team or inbox, offer decisions, and letters to professors"* — but it is sent **only to the reviewer**, and `buildReviewPrompt` never states the email type; the reviewer must infer it from the situation summary and `WHO'S WHO` (only `first.inbox` says so outright). | Add the type label and the ceiling to the review prompt's `FACTS` block. (Also what makes R6's exemption list implementable.) |
| **C10** | *Redundant but harmless, for the record:* `GAP_RULES` already tells the model never to mention attaching the resume, **and** `APP_HANDLES` filters such notes downstream. Belt and braces; no change needed, but worth knowing the filter is not compensating for a contradictory instruction. | None. |

**Free rein on voice.** The user has granted it where the result is measurably better. The prompt stack is 20,702 characters for one `cold_email` (M14) and the conflicts above are the symptom of accretion. My recommendation is **not** a rewrite in this round: there is no way to show a rewrite is better until R6's instrument and the §3.3 CLI A/B harness exist. Build the instrument, land C1–C5 as targeted edits, then propose a rewrite with the A/B already in place to judge it. A rewrite shipped before the instrument is unfalsifiable, which is the thing this plan is supposed to stop doing.

---

## 10. R3 — making any of this measurable on real traffic

Today the guard's rejection rate is **not knowable**:

- `email_drafts` has **no** review column (`subject`, `body`, `modelSubject`, `modelBody`, `gaps`, `inputs`, `suggestions`, `pushedToGmailAt` — nothing about the review). **MEASURED** by reading `src/db/schema.ts:947–1030`.
- `email_archive` stores the review inside `generatedCiphertext`, AES-256-GCM, and **there is deliberately no decrypt function in the app** ("There is no decrypt function in the app on purpose"). It is additionally gated on `mayTrainOn(userId)`, so it covers consenting users only. **MEASURED** by reading `src/lib/email-archive.ts`.
- The only live signal is the `[draft-review]` console line (outcome + reject reason + counts), which is in the host's logs and not queryable as data.

**So: no local query is possible, and none should be attempted — `npm run dev` points at the live database and I did not run anything against it.** What the schema *would* let us measure, if R3 lands:

```ts
// src/db/schema.ts — on emailDrafts
/** The review pass's outcome: counts and reasons, never content. */
review: jsonb("review"),
// { applied: "all"|"partial"|"none", problems: number, needsStudent: number,
//   spans: { accepted: number, rejected: number },
//   reasons: string[],        // guard reason codes only, e.g. "added_capitalised"
//   categories: string[] }    // lint categories before/after
```

Reason **codes**, not free text, and no email content — that keeps it a metrics column rather than a second archive. Then the questions this plan needs answered become one SQL query each: guard rejection rate overall and by reason; partial-acceptance rate and spans-accepted distribution; retry rate and retry success; lint-category frequency on real drafts versus the gold corpus; and the edit delta between `modelBody` and `body` (already available) as a proxy for whether students accept reviewed prose.

**Test**: `npm run db:generate` produces exactly one migration adding one nullable column; `npx tsx scripts/draft-review-test.ts` asserts `runDraftPipeline`'s outcome object serialises to the documented shape and **contains no substring of the draft body** (a privacy assertion, 0 violations).

---

## 11. Rejected

| Rejected | Reason |
|---|---|
| **A separate structured who's-who call** | Needs the same `FACTS` the reviewer already holds, so it saves no context and costs a serial call; and `WHO'S WHO` must stay in the reviewer regardless, because the measured bug was the *reviewer* mis-correcting roles. Replaced by a free code check (R10). |
| **Moving `VOICE_RULES` out of the reviewer** | The reviewer is the only component that sees finished text, and every voice rule is a property of finished text. Removing it gives up the one place the rules are enforceable. A distilled subset is *added* to the drafter; nothing is removed from the reviewer. |
| **Auto-fixing filler phrases** | Not a local deletion (`"I wanted to reach out to learn more about X"` → `"To learn more about X."`), and **20/192 gold examples** use the pleasantry that `VOICE_RULES` conditionally permits (M2). Replaced by recalibration (C4). |
| **Auto-fixing comma splices in general** | The fix chooses between period, semicolon and conjunction, and the choice carries emphasis. Only the splice the em-dash rewrite itself creates is safe to fix (R7 item 1, M8). |
| **Auto-rewriting canned courtesy lines** | A deterministic rewriter substitutes one template for a new template — the exact failure the rules exist to prevent. Flag with the preferred phrasing; let the model write it. |
| **A naive contraction check ("no contractions = defect")** | MEASURED: fails **75.0%** of the gold corpus (M16). Replaced by a type-aware rate check with an opportunity floor, shipped corpus-only if it cannot clear a 40% gold rate. |
| **A consecutive-"I" check at `≥ 3`** | MEASURED: fails **15.6%** of gold (M16). Threshold moved to `≥ 4`, and that rate must itself be measured before shipping. |
| **Character/word-level diff for span alignment** | Hunks straddle sentence boundaries, so the lint rules — all sentence- or document-scoped — cannot be evaluated per hunk, and a sentence split degenerates into one giant replace. |
| **An LLM-as-judge for span validation** | Reintroduces the failure mode the guard exists to backstop, and adds a third serial call. The guard's value is that it is pure and testable without an API. |
| **Dropping the guard and trusting the reviewer** | The guard's rules each trace to a measured incident, and an email with one invented detail is worse than a clunky one. The problem is the *granularity*, not the existence. |
| **More than one retry** | The retry exists because one slip cost the whole edit. Under R1 that premise is gone, so the retry narrows rather than widens (R1 §2.3). |
| **Gating the review call on `forReview.length === 0`** | The coordinator's probe draft scores one finding while failing four `VOICE_RULES` items, so it would skip the review — exactly the prose the review exists to fix. Revisit only after R6 lands and its gold calibration holds. Latency gating is PLANNER-A's lane regardless. |
| **Querying the live database for guard rejection rates** | `npm run dev` points at the live DB; the archive has no decrypt path by design and is consent-gated. Replaced by R3. |

---

## 12. Dependency order

**Phase 0 — make things visible (nothing changes behaviour).**
1. **R3** — review-outcome column. Independent, unblocks every real-traffic claim.
2. **R6** — categorised `Finding` type with `scope: "span" | "document"`, the four new checks, and `scripts/draft-lint-calibration.ts` with committed gold thresholds. **This is the instrument; freeze it before measuring anything else.**
3. **R0-CLI** — a thin `scripts/lib/draft-cli.ts` wrapper over `runClaude` (strip `$schema` from `z.toJSONSchema()`, wrap in `main()`, `studentResumeSummary` path only, no PDF). Unblocks every model-in-the-loop test at $0 API spend.

**Phase 1 — the guard's dependencies.**
4. **R4** — category-based lint comparison (needs R6's categories).
5. **R5** — `detailSurvived` + `DETAIL_COMMON` generator + `scripts/draft-detail-test.ts`.
6. **R9** — `known` set: school variants, resume text, the three-valued verdict.

**Phase 2 — the guard.**
7. **R1a** — `draft-align.ts` + `scripts/draft-align-test.ts` fixtures F20–F24 (segmentation and alignment only). Land and verify alignment before any guard logic depends on it.
8. **R1b** — `draft-guard.ts`, `applyReviewEdit`, the fast path through `guardRevision`, fixtures F1–F19.
9. **R1c** — `scripts/draft-align-corpus.ts` property battery. **If INV8 < 90%, stop and reconsider R1 rather than tuning thresholds to pass.**
10. **R8** — reviewer prompt truth-up. **Must land with R1b**: C2 describes the guard, and shipping R1 while the prompt says "thrown away whole" leaves the reviewer with a false model of its consequences.
11. **R1d** — pipeline wiring, the new `ReviewOutcome`, the narrowed retry. **Merge with the concurrent `PipelineTimings` edit in `draft-pipeline.ts`.**

**Phase 3 — the rest.**
12. **R7** — auto-fixes, after R6 so the corpus invariant is meaningful.
13. **R10** — `whosWhoConflicts`, and the `plan.sentences` decision.
14. **R2** — R2a (the examples instruction), then the §3.3 CLI A/B, then R2b only if it passes all five gates, then R2c (the corpus edit) with Kai's sign-off.

**Regression gate at every phase:** `npm run test && npm run typecheck && npx tsx scripts/draft-review-test.ts && npx tsx scripts/draft-align-test.ts && npx tsx scripts/draft-align-corpus.ts && npx tsx scripts/draft-detail-test.ts && npx tsx scripts/draft-autofix-test.ts && npx tsx scripts/draft-lint-calibration.ts`. Add the five new scripts to `test:all`. `scripts/draft-review-test.ts` must keep printing `N/N passed` with N never decreasing.

---

## 13. Where I think this plan is weakest

Stated so the tester knows where to push hardest.

1. **L7, cohesion propagation, is a heuristic.** A referential-cue regex is a crude proxy for discourse dependency. It will over-reject (a sentence legitimately starting "It" after a rejected span) and under-reject (a dependency carried by a noun phrase rather than a pronoun). F12 tests one case; INV12 catches gross corruption; neither proves the prose reads well. **The only real test is a human reading 20 partially-accepted bodies.** I would gate R1's rollout on that, and I cannot automate it.
2. **INV7 at 95% and INV8 at 90% are judgement calls** (ESTIMATED, not derived). If the implementation lands at 85% on INV8 the right response is to inspect the 15% and decide, not to lower the threshold. I have written them as hard gates to force that conversation.
3. **R6's contraction check may not be shippable per-email at all.** M16 says the naive version fails 75.0% of gold. If the type-aware version with an opportunity floor cannot clear 40%, it ships corpus-only — and then the guard still cannot score a contraction edit, which blunts part of R1's value. I would rather say that now than discover it after R1 lands.
4. **The CLI A/B measures a different model configuration than production** (no effort/thinking/fast-mode control; the probe ran `claude-sonnet-5-5`). A prompt effect that shows up on the CLI model may not transfer to Opus-low. It is still worth far more than no measurement, and it costs $0.
5. **Every "evidence that problem is real" entry in §1 is either a code comment, a simulation, or my own probes.** None of it is production data, because production data is unreadable by design (R3). The plan is therefore self-aware about its own epistemic base: **R3 first.**

---

## Critical Files for Implementation

- `/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf/src/lib/draft-review.ts`
- `/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf/src/lib/draft-lint.ts`
- `/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf/src/lib/draft-pipeline.ts`
- `/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf/src/lib/draft-prompt.ts`
- `/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf/scripts/draft-review-test.ts`

Supporting: `src/lib/email-examples.ts` + `email-examples-v3/v4/v5.json` (the gold corpus every calibration test reads), `src/lib/news/claude-cli.ts` (free model-in-the-loop testing), `src/db/schema.ts` (R3).
