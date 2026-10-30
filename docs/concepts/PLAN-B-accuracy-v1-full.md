# PLAN B — the accuracy architecture

Written 11 October 2026 by PLANNER-B, against `perf/draft-pipeline`. Latency is
PLANNER-A's; where a change here moves latency I say so and stop.

Read `docs/EMAIL_DRAFTING_WORKFLOW.md` for what the pipeline does and
`docs/concepts/BASELINE.md` for what it currently costs. This file is about one
question: **where does the pipeline lose accuracy, and what can be tested.**

## The thesis in four sentences

The guard is not the only all-or-nothing thing in the pipeline. The guard throws
away a whole edit for one slip; the lint declares a draft clean when it is
template prose; the example corpus teaches four of the phrases `VOICE_RULES`
bans; and the one quality signal the guard uses to decide "did this edit help"
is zero on both sides of the comparison seven times in eight. Fixing the guard
alone buys a better editor for a system that cannot tell whether the edit
helped — so the per-edit guard (R1) and the signal it runs on (R2, R3, R4) are
one piece of work, in that order.

---

## 1. Ranked changes

Cost is engineer-days for one person who knows this code. Confidence is my
confidence that the change improves accuracy, not that it can be built.

| # | Change | Accuracy problem it fixes | Evidence the problem is real | Risk | Cost | Confidence |
|---|---|---|---|---|---|---|
| **R1** | **Per-span guard**: align the edit to the draft at sentence level, validate each changed span, apply the spans that pass | One slip in a reviewer edit discards every other fix in it | MEASURED (4 probes, §3.1): a legitimate school-name expansion, a resume-PDF proper noun, a private-detail removal on a short body, and a greeting change each discard the entire edit | Medium-high: partial application can produce incoherent prose (cohesion, §3.1.6); loses the reviewer's freedom to reorder unless `move` detection works | 5–7 d | High |
| **R2** | **Two-tier lint**: `forReview` keeps only patterns the gold corpus never contains; everything gold does contain becomes `voiceReport`, a diagnostic that never reaches the reviewer and never vetoes an edit | The reviewer is handed "problems" the playbook's own examples demonstrate; the guard then measures the reviewer against them | MEASURED: 51/192 per-type and 9/42 Volume V gold examples produce a non-empty `forReview` (`scripts/draft-lint-corpus.ts`); 20/192 contain the exact phrase `I hope this email finds you well` (mine, §2) | Low. Shrinks what the reviewer is told to fix — if the rule was right and the examples wrong, quality drops until R6 lands | 1–2 d | High |
| **R3** | **Delete the count comparison**; the span validator vetoes on a *new finding category*, never on a count | `after.length > before.length` lets an edit swap one defect for another, and is 0-vs-0 on most drafts | MEASURED (mine, §3.2): an edit that removes a filler phrase and introduces a comma splice returns `ok: true`. MEASURED (BASELINE §3): only 13.2% of 561 model-written bodies produce any finding | Low | 0.5 d (inside R1) | High |
| **R4** | **`detailSurvived` replaces `coverage`**: weighted tokens, suffix stemming, and an anchor rule | 5-char-prefix matching at a flat 0.4 both over- and under-fires | MEASURED (mine, §3.3): `intern`/`internal`/`interest` all collapse to `inter`; `distressed`/`distribution` to `distr`; a 7-token detail that loses its specific half scores 0.43 and passes | Low-medium: a stricter anchor rule rejects more edits until R1 makes rejection span-local | 1.5 d | High |
| **R5** | **Measurement plumbing**: a plaintext `review` record on `email_drafts` (or a `draft_review_events` table) | Nothing in this plan can be measured on real traffic. The outcome exists only in a log line and inside an encrypted blob with no decrypt path | MEASURED (code read, §3.4): `email_drafts` has no review column; `email_archive` is AES-256-GCM with no decrypt function in the app and is gated on `mayTrainOn` | Low (privacy review needed: store verdicts and reasons, never body text) | 1 d | High |
| **R6** | **Fix the example corpus**: remove the banned phrasings from `email-examples*.json` | The drafter writes template prose because it is shown template prose | MEASURED (mine, §2): gold is 75.0% contraction-free, 33.3% opens on a pleasantry, 28.1% runs 3+ consecutive "I" openings, and uses `for your reference` 32 times | Medium: 234 hand-written gold emails, edited by hand; a bad edit degrades every draft of that type | 3–4 d | Medium-high |
| **R7** | **Deterministic auto-fixes** in `finishDraft`, including the em-dash bug | `finishDraft` manufactures a comma splice, then the lint reports it, then the reviewer is asked to fix it | MEASURED (mine, §3.5): `panel—I came away` → `panel, I came away` → `commaSplices` returns `["I came"]` | Low-medium: each rewrite needs its counterexample (§3.5) | 2 d | High |
| **R8** | **Truth up the reviewer's prompt**: four specific conflicts, one of which misstates the guard's own thresholds | The reviewer is given a false model of its consequences and two different length ceilings | MEASURED (code read, §6): "grows past 20% or shrinks past 40%" vs "never more than 15% longer" vs code `1.2` / `0.6` | Low | 0.5 d | High |
| **R9** | **Known-set repair**: school-name variants; three-valued verdict for a resume-PDF proper noun | The guard cannot see what the reviewer can see | MEASURED (mine, §3.1.5): `added "Pinecrest"` and `added "University"` each discard a correct edit | Medium: the three-valued verdict deliberately lets an unverifiable proper noun through with a note | 1 d | Medium-high |
| **R10** | **Four new voice checks** — as Tier-2 diagnostics, not `forReview` problems | The lint calls template prose clean | MEASURED (FINDINGS-probe): a draft failing four `VOICE_RULES` bans produced one finding | Low as diagnostics. **High if shipped to `forReview`** — see §2 | 1.5 d | Medium (as specified); Low if promoted to `forReview` before R6 |
| **R11** | **Who's-who code check** `whosWhoConflicts(facts, plan)`; decide `plan.sentences` | A role error reaches the reviewer only as prose; `plan.sentences` is generated and read by nothing | MEASURED (grep, §5): no file reads `plan.sentences` | Low | 1 d | Medium |
| **R12** | **Retire 15 dead checks** into `finishDraft` or widen them | 15 of 23 checks fire zero times across 795 bodies; three are mis-specified, proven by a live miss | MEASURED (BASELINE §3) + MEASURED (probe): `you are also from Atlanta` evades a regex requiring `we're both` | Low | 1 d | Medium-high |

Not ranked here, and deliberately: **R0, the free CLI harness.** `runClaude` in
`src/lib/news/claude-cli.ts` runs the real draft prompt and real schema on the
subscription (MEASURED in FINDINGS-probe: valid draft, 5.7 s, no API spend).
Three of the tests below are only falsifiable because of it. Build
`scripts/draft-cli-eval.ts` first or several of my pass/fail thresholds cannot
be evaluated at all.

---

## 2. The finding that reframes the voice work

You asked me to design a contraction-rate check, a consecutive-"I" check, a
canned-courtesy-line set and a widened discovery regex, each calibrated so the
playbook's gold examples pass. I measured the gold corpus first. Three of the
four cannot be calibrated that way, and the reason is the answer to the
question.

**MEASURED** — 192 per-type playbook example bodies, body above the sign-off,
greeting line excluded. Reproduce by committing this as
`scripts/draft-voice-corpus.ts` (the inline probe I ran is in §8.6):

| Pattern | `VOICE_RULES` says | Gold corpus rate |
|---|---|---|
| Zero contractions in the whole email | "use them naturally (I'm, I'd, don't, it's)" | **144/192 (75.0%)** |
| Opens on a pleasantry (`I hope…` / `Hope…`) | only when there is nothing specific to lead with | **64/192 (33.3%)** |
| Exact phrase `I hope this email finds you well` | throat-clearing; the FILLER rule flags it | **20/192 (10.4%)** |
| 3+ consecutive sentences opening with "I" / "I'm" | "Never three in a row" | **54/192 (28.1%)** |
| 4+ consecutive | — | 20/192 (10.4%) |
| 5+ consecutive | — | 7/192 (3.6%) |
| `for your reference` | the canned resume line | **32/192 (16.7%)** |
| `do not hesitate to` | stiff phrasing | 8/192 (4.2%) |
| `I look forward to hearing from you` | canned courtesy | 5/192 (2.6%) |
| Announces common ground as a discovery | banned | 6/192 (3.1%) — **and all 6 are false positives**, see below |
| Spaced-hyphen dash / double space / lowercase sentence start / >1 intensifier | banned | **0/192 each** |
| Em or en dash present | `HOUSE_RULES`: "No em dashes" | 11/192 (5.7%) |

Now compare against the three numbers the comment in `draft-prompt.ts` records
from the 300-draft simulation: 57/300 opened "I hope you are doing well",
65/300 said "I attached my resume for your reference", 255/300 used no
contractions.

**The drafter's output distribution matches its example corpus, not its rules.**
255/300 contraction-free output from a corpus that is 75.0% contraction-free.
65/300 "for your reference" from a corpus using it 32 times. 57/300 pleasantry
openings from a corpus where 33.3% open that way. That is not a prompt-adherence
failure; it is successful imitation. The note above `VOICE_RULES` says it
itself — "every rule above was followed, yet the emails read as one template."

### What this does to idea #2

Moving `VOICE_RULES` into the drafter sets 2,385 characters of rules (MEASURED;
~645 tokens ESTIMATED at 3.7 ch/tok) against 192 worked demonstrations of the
opposite. The 300-draft result is direct evidence of which of those two wins.
So: **adopted, but only as arm 2 of a three-arm experiment, and I predict arm 2
alone moves the voice metrics by less than arm 3.** Design and attribution in
§4.2.

### What this does to the four new checks

The "gold must pass" discipline that `draft-lint.ts` documents is the right
discipline. Applied honestly it says: a check for contractions, pleasantries,
I-runs or the resume courtesy line **cannot be a `forReview` problem today**,
because sending it to the reviewer means instructing the reviewer to delete what
the drafter was shown, and then measuring the reviewer's edit against a rule the
drafter had no way to know. Hence **R2, the two-tier lint**:

- **Tier 1 — `forReview`** (unchanged destination): a pattern the gold corpus
  contains **zero** times. These are defects by the playbook's own standard.
  Today that is: comma splice (gold 3/192 — see the exception below),
  dash-as-punctuation (0), double space (0), space before punctuation (0),
  lowercase sentence start (0), >1 intensifier (0), and the widened discovery
  rule once it is actually zero on gold (§2.1).
- **Tier 2 — `voiceReport`** (new; never in the review prompt, never a guard
  veto, used only by corpus scripts and the CLI A/B): contraction deficit,
  pleasantry opening, I-run, canned courtesy lines, the FILLER pleasantry arm,
  the `, and thank you` rule (gold 25 hits across 795 bodies, including 3 of 42
  Volume V).
- A Tier-2 pattern is **promoted to Tier 1 only after R6 drives its gold rate to
  zero.** That is the sequencing, and it is the position you asked for: **the
  FILLER rule is right and the examples are stale** — but the rule must not act
  on drafts until the examples are fixed, or the system is punishing the
  drafter for obeying it.

Everything else in the gold corpus that contradicts the rule stack, since you
asked: `for your reference` (32), `do not hesitate to` (8), em/en dashes (11 —
against `HOUSE_RULES`' flat "No em dashes", and `finishDraft` strips them from
drafts but not from the examples the drafter reads), `, and thank you` (25
across 795, 3 in Volume V), `I look forward to hearing from you` (5),
`I hope all is well` (3), `thank you in advance` (2).

### 2.1 The four checks, as designed

All four live in `src/lib/draft-lint.ts`. Signature:

```ts
export type VoiceFinding = { check: VoiceCheckId; detail: string; tier: 1 | 2 };
export function voiceChecks(
  input: Pick<DraftPromptInput, "type" | "alsoTypes" | "boxIds" | "contactName" | "contactRole">,
  body: string,
): VoiceFinding[];
```

`draftChecks` returns a third array, `voiceReport: VoiceFinding[]`; `forReview`
gains only the Tier-1 subset. `buildReviewPrompt` is unchanged — it takes
`forReview` and never sees Tier 2.

**(a) `contraction_deficit` — Tier 2.**
Rule: fires when *all* of — the lead type is contraction-eligible; the body has
≥6 sentences; zero contraction tokens `/[A-Za-z][’']\s?(m|re|s|ve|d|t|ll)\b/`;
and ≥2 expansion sites `/\b(I am|I would|I will|I have|it is|that is|you are|do not|does not|cannot|is not|will not)\b/gi`.
Eligibility: ineligible when `boxIds` contains `first.inbox` or
`first.recruiter`, when `RECRUITER_ROLE.test(contactRole)` or
`TEAM_RECIPIENT.test(contactName)`, or when the lead type is an
offer-decision or professor letter — which needs a new boolean on
`EMAIL_TYPES`, `formalRegister?: true`, set on those types rather than inferred
from an id regex.
False-positive risk: high, and the type exemption is the whole defence.
Counterexample that makes it unsafe: a 9-sentence recommendation-letter request
to a professor, entirely in full forms — correct as written. Second
counterexample: a 6-sentence email where every expansion site sits inside a
quoted thread subject.
Calibration: the check must flag **≤ 25% of contraction-eligible gold bodies**
(against the naive rule's 75.0%). Gold rate under this exact rule is NOT yet
measured — measuring it is part of the test in §4.10.

**(b) `i_run` — Tier 2.**
Rule: ≥N consecutive sentences whose first token matches `/^I(?:[’']\w+)?\b/`,
counted across the body above the sign-off, greeting excluded, sentence split by
the shared offset-preserving splitter from §3.1.1.
Threshold: **N = 5**, not the 3 `VOICE_RULES` states. MEASURED gold rates:
≥3 → 28.1%, ≥4 → 10.4%, ≥5 → 3.6%. N=3 is unusable; N=5 is the first value in
range for a Tier-1 promotion after R6, and is the value to use as a Tier-2
diagnostic now so the A/B metric is stable across the corpus fix.
False-positive risk: low at N=5. Counterexample that makes it unsafe: a
three-sentence email where every sentence must begin with "I" ("I'm a sophomore…
I spent last summer… I'd love to hear…") — excluded by requiring 5.
Note the discrepancy this exposes: `VOICE_RULES` states a rule its own examples
break in 28.1% of cases. R8 should either change the rule text to five or R6
should fix the corpus; the rule and the corpus must not disagree.

**(c) `canned_line` — Tier 2.**
Rule: a fixed set of exact stock strings, not the concept. Flagging the concept
is wrong: gold mentions the resume in a courtesy line in 27.1% of bodies and
offers flexibility in 20.8% — `VOICE_RULES` asks for those lines in *fresh
words*, not for their absence. So the check is a blacklist of the stock
phrasings: `for your reference`, `for your review`,
`please let me know if you have any questions`, `at your earliest convenience`,
`I look forward to hearing from you`, `do not hesitate to`,
`thank you in advance`, `I hope all is well`.
MEASURED gold hits: 32, 0, 0, 0, 5, 8, 2, 3. All non-zero ones are Tier 2 until
R6 removes them; the four zero-rate ones can go to **Tier 1 immediately**.
False-positive risk: low — these are literal strings.
Counterexample that makes it unsafe: a student who typed "please let me know if
you have any questions" as their own requested wording; the drafter is told
typed content is required, so the check must skip a string that appears in
`typedDetails(facts)`. That exemption is required, not optional.

**(d) `discovery_phrasing` — widened, Tier 1 once it is zero on gold.**
The probe's miss was `I was glad to see that you are also from Atlanta`; the
existing regex requires `we're both`. But my first widening — any
`I (noticed|saw|was glad to see|learned|gather|realized) … (we|you)` — produced
**6 gold hits, and I inspected all six: every one is a false positive**
(`I saw on LinkedIn this morning that you [were promoted]`,
`I saw that you [moved to the credit team]` ×3, `I noticed that you …`,
`I saw the announcement that you …`). Noticing the *recipient's news* is not
banned; announcing *common ground* as a discovery is.
So the discriminator is the object, not the verb. Rule:
`/\bI (?:noticed|saw|learned|gather|realized|was glad to (?:see|learn))\b[^.!?]{0,60}?\b(?:we(?:'re| are)? both|you (?:are|went|studied|grew up)[^.!?]{0,30}?\b(?:also|too|as well)|also (?:from|at|went to|studied)|same (?:hometown|school|town))\b/i`
— it requires an explicit shared-trait marker (`both`, `also`, `too`,
`as well`, `same hometown/school`) within 60 characters of the discovery verb.
MEASURED on gold with the narrow object requirement: this must return **0/192**;
verifying that is a hard gate in §4.10. It catches the probe's string
(`you are also from Atlanta`) and rejects all six gold news-noticing sentences.
False-positive risk: low. Counterexample that makes it unsafe: "I saw that you
also cover industrials, as well as healthcare" — `also` plus `as well` about the
recipient's coverage, not common ground. Mitigation: require the marker to be
followed within 30 characters by a shared-trait noun or a place/school token
from `facts` (hometown, school, club) — i.e. the check consults the facts, which
makes it `draftChecks`-shaped rather than a pure regex. Accept the extra
coupling; a context-free version is not safe.

### 2.2 The 15 dead checks (R12)

MEASURED (BASELINE §3): 15 of 23 checks fire zero times across 795 bodies. One
correction to the premise in the task: a check that never fires costs **no**
reviewer attention — `AUTOMATIC CHECKS FLAGGED` only lists findings. What a dead
check costs is maintenance and the illusion of coverage. So the test for
deletion is not "did it fire" but "is it subsumed, mis-specified, or cheap
insurance":

- **Subsumed by a deterministic fix → delete from the lint, move into
  `finishDraft` (R7):** double space; space before punctuation; repeated word;
  lowercase sentence start; capital after a colon; dash used as punctuation;
  split `to then`; `also` with `too`. (8 checks.) A defect a regex can detect and
  a string transform can repair should never be described to a model.
- **Mis-specified → widen (R10d and two siblings):** announces the common ground
  as a discovery (proven to miss `you are also from Atlanta`); calls the student
  an alum (requires `we're both … alums`; misses `as a fellow alum myself`);
  `both` doubled with `too`. (3 checks.)
- **Rare but catastrophic → keep as written:** congratulations after the ask;
  the class year repeated beside the signature; common ground tacked onto a
  paragraph; more than three `Thank you` openers. (4 checks.) These are cheap,
  and each is a defect no human reader would forgive.

---

## 3. Adopted designs

### 3.1 R1 — the per-span guard

Replaces nothing on the happy path. `guardRevision` stays exactly as it is and
runs **first**: if the whole edit passes, it is applied wholesale and no
alignment work happens. The span machinery runs only where today the pipeline
discards everything. That makes the blast radius precisely "edits currently
rejected", keeps all 71 existing tests green unchanged, and means a bug in the
aligner cannot damage an edit that is clean today.

Files: new `src/lib/draft-align.ts`, new `src/lib/draft-guard.ts`, edits to
`src/lib/draft-lint.ts`, `src/lib/draft-review.ts` (prompt text only),
`src/lib/draft-pipeline.ts` (call site, outcome type, retry condition — rebase
onto the `PipelineTimings` work).

#### 3.1.1 Segmentation (`draft-align.ts`)

```ts
export type Seg = { i: number; para: number; sent: number; text: string; start: number; end: number };
export function segment(bodyAboveSignOff: string): { greeting: string; paragraphs: Seg[][] };
```

- Line 0 of the body is the **greeting** and is never a span. The existing
  greeting rule becomes "the greeting is emitted from the original, always" —
  which is strictly better than today, where a changed greeting destroys the
  edit (MEASURED: existing test `g5`).
- Paragraphs: split on `/\n[ \t]*\n+/`, offsets preserved.
- Sentences: before scanning, **mask** `[placeholder]` spans (the `PLACEHOLDER`
  regex permits `.` inside, e.g. `[what you want to ask Dr. Lee]`) and URLs,
  replacing each with an equal-length filler so offsets survive; then split on
  `/(?<=[.!?])["'”’)]*(?:\s+|\n)(?=[A-Z“"(\[])/`; then unmask. Do not split after
  a token in a fixed abbreviation set (`Mr. Mrs. Ms. Dr. Prof. Dean St. Jr. Sr.
  vs. e.g. i.e. U.S. Inc. Co. Ltd.`) or after a single capital letter and a
  period (initials). A single newline inside a paragraph is also a boundary.
- This is a **new** function, not `sentencesOf` from `draft-lint.ts`, because
  that one collapses newlines and so cannot carry offsets. `draft-lint.ts`
  should be refactored to call it so the lint and the guard agree on what a
  sentence is; disagreement there is a silent correctness hazard.

#### 3.1.2 Alignment

```ts
export type Op =
  | { kind: "keep" | "rewrite"; orig: Seg[]; rev: string[] }   // 1:1
  | { kind: "split";  orig: Seg[];  rev: string[] }            // 1:n
  | { kind: "merge";  orig: Seg[];  rev: string[] }            // n:1
  | { kind: "move";   orig: Seg[];  rev: string[]; fromIndex: number }
  | { kind: "delete"; orig: Seg[];  rev: [] }
  | { kind: "insert"; orig: [];     rev: string[]; afterOrig: number };

export function alignBodies(original: string, revised: string): {
  greeting: { original: string; revised: string };
  groups: { paraIndices: number[]; ops: Op[]; revParagraphBreaks: number[] }[];
};
```

Similarity is a token Dice coefficient over normalised tokens (lowercase, strip
punctuation outside placeholders, straighten quotes, **do not** expand
contractions — a contraction change must read as a rewrite, and Dice stays high
anyway).

**Level 1 — paragraph anchoring.** LCS-style DP over original × revised
paragraphs, match reward `sim(o,r)` when `sim ≥ 0.35`, gap cost 0, yielding a
monotone pairing. Then two post-passes: a revised paragraph left unmatched and
adjacent to a matched pair `(O_i, R_k)` is a **paragraph split** of `O_i` when
`sim(O_i, R_k ⧺ R_j) > sim(O_i, R_k) + 0.1`; symmetrically for a **merge** of two
originals into one revised. Anything still unmatched on the revised side becomes
one `insert` anchored after the preceding matched paragraph.

**The structure invariant: the output's paragraph breaks come from the ORIGINAL
unless every op in the group that changed them is accepted.** This is the single
rule that stops partial acceptance from producing a visibly broken email, and it
is fixture F9/F9b.

**Level 2 — sentence alignment inside a group.** Needleman–Wunsch over the
group's original and revised sentences: `score(match) = sim(a,b)`, gap penalty
`g = 0.35` (so a reworded sentence at `sim ≥ 0.35` prefers a diagonal match over
delete+insert, which costs 0.70). Traceback gives 1:1 / 1:0 / 0:1. Then:

- *Split detection:* `1:0` at `i` followed by one or more `0:1` → split when
  `sim(orig_i, concat(revs)) ≥ 0.45`. Also `1:1 (i↔j)` followed by `0:1 (j+1)` →
  split when `sim(orig_i, rev_j ⧺ rev_{j+1}) ≥ sim(orig_i, rev_j) + 0.1`.
- *Merge detection:* `1:1 (i↔j)` followed by `1:0 (i+1)` → merge when
  `sim(orig_i ⧺ orig_{i+1}, rev_j) ≥ sim(orig_i, rev_j) + 0.1`.
- *Move detection:* an `insert` whose text has `sim ≥ 0.8` with some `delete`d
  original sentence in the same group becomes a `move`. Without this, the
  aligner's monotone assumption silently forbids reordering — which the reviewer
  is explicitly told to do ("To vary sentence openings, reorder or reword a
  sentence"), and which today's guard permits. This is a real cost of per-span
  guarding and `move` is the mitigation. Fixture F19.
- Normalised-equal texts → `keep`.

Cost is `O(n·m)` with `n, m ≤ 11` sentences (MEASURED: gold bodies run 3–11
sentences, median 7). Negligible; no latency claim needed.

**Why sentence-level NW and not a word or character diff.** Every rule the guard
enforces is sentence-scoped: a comma splice is a property of a sentence, not of
the words that changed; "added a capitalised word" needs to know whether the word
opens its sentence. A word-level hunk like `great → glad` cannot be lint-checked
and a hunk that straddles a sentence boundary cannot be independently validated
— which is the entire point of the change. Sentence alignment also makes
split/merge first-class instead of surfacing as one giant replace hunk covering
the whole paragraph, which would re-create today's all-or-nothing behaviour at
paragraph granularity.

#### 3.1.3 Local validation, per op (`draft-guard.ts`)

```ts
export type SpanVerdict = { op: Op; verdict: "accept" | "accept-with-note" | "reject"; reason?: string; note?: string };
export function applyReviewEdit(
  original: { subject: string; body: string },
  revised:  { subject: string; body: string },
  facts: DraftPromptInput,
  problems: ReviewProblem[],
): { subject: string; body: string; applied: "all" | "partial" | "none"; verdicts: SpanVerdict[]; backoffs: string[]; notes: string[] };
```

- **L1 Placeholders.** The multiset of `PLACEHOLDER` matches in `op.rev` must
  equal that in `op.orig`. A `delete` of a sentence holding a placeholder fails
  here, correctly.
- **L2 Numbers.** Every digit run in `op.rev` must be in `knownNumbers`, built as
  today (facts JSON minus `now`, plus the original subject and body).
- **L3 Capitalised words.** As today but **token-exact, not substring**. Today's
  `known.includes(word.toLowerCase())` is a substring test over one blob;
  MEASURED, it admits `Penn` because `pennsylvania` is in the facts — benign
  here, unprincipled in general. Build `knownTokens: Set<string>` from
  `/[a-z0-9'’]+/g` over the original subject, original body and facts JSON, then
  add, deterministically:
  - school-name variants: for `studentSchool`, `alumniSchool`, `contactSchool`,
    `contactFirm` — the full string's tokens, plus the string with
    `University|College|School|Institute|of|the|at` removed, plus its bare first
    token. This fixes the MEASURED rejection of `Penn → the University of
    Pennsylvania` without opening a substring hole.
  - every token of `typedDetails(facts)`.
- **L3b Three-valued verdict for the resume-PDF case.** When
  `facts.hasResumePdf && !facts.studentResumeSummary`, the reviewer can see
  proper nouns the guard provably cannot (MEASURED: a correct edit naming a real
  club from the PDF is rejected as `added "Pinecrest"`). In that configuration an
  otherwise-passing op with exactly one unknown capitalised token becomes
  `accept-with-note`: the op is applied and a note is added —
  `Check that "Pinecrest" is right; it came from your resume rather than what you typed.`
  At most **one** such op per edit; a second makes both `reject`. Justification:
  the guard cannot distinguish a recovered resume fact from a fabrication, the
  student can, and the alternative is MEASURED to destroy correct edits. Better
  long-term fix, out of scope here: thread extracted resume text into
  `DraftPromptInput` so the guard sees what the reviewer sees.
- **L4 Lint veto — by category, never by count.** `spanLint(text)` returns the
  categorised subset of findings computable from one span (long sentence; `, and`
  clause-stringing; `also`/`too`; connector-not-a-cause; `to then`; the five
  common-ground patterns; comma splice; Tier-1 canned lines; dash-as-punctuation;
  repeated word; lowercase start; capital after colon; the opinion check; the
  class-year check). **Veto iff a category present in `rev` is absent from
  `orig`.** The count comparison is deleted (R3).
  This is the direct answer to "the count is usually zero on both sides":
  the validator never asks whether the edit *improved* — it asks only whether the
  edit *introduced* a defect. Improvement is unmeasurable at request time
  (MEASURED: 13.2% of model-written bodies produce any finding at all) and is
  therefore measured elsewhere — post hoc from R5's records and from the CLI
  A/B. A guard that tries to score improvement on a signal that is zero 87% of
  the time is not conservative, it is noise.
- **L5 Greeting.** Not an op. If `greeting.revised !== greeting.original`, record
  one rejected pseudo-op and emit the original greeting. The rest of the edit
  still applies (today: everything is lost).
- **L6 `insert`.** Reject by default — a pure insertion is new content, not an
  edit. One exception: accept when it passes L1–L4 **and** it lifts some typed
  detail from `detailSurvived === false` on the original body to `true` on the
  assembled body. That exception exists to serve
  `STUDENT_DETAILS_RULES` and the reviewer's own instruction to "work it back in
  using FACTS' own words". Fixtures F10 (reject) and F11 (accept).
- **L7 Cohesion propagation.** If `op_k`'s revised text begins with a referential
  cue —
  `/^(It|This|That|They|Those|These|He|She|His|Her|Their|Both|Also|However|But|And|So|Then)\b/`
  — and the immediately preceding op was rejected, reject `op_k` too. Iterate
  forward to a fixpoint. A rejected `merge` reverts to both originals; a rejected
  `split` reverts to the one original. This is the honest cost of the design:
  partial acceptance can orphan a pronoun, and this rule buys safety by
  discarding good spans. Fixture F12.

#### 3.1.4 Assembly

Walk the original's sentence order per group, emitting accepted revised text or
original text verbatim; join sentences with one space; join paragraphs with
`\n\n` **using the original's breaks** unless the structure invariant releases
them; prepend the original greeting; append everything from the original's
sign-off line onward (`finishDraft` rebuilds the signature regardless).

#### 3.1.5 Global phase, on the assembled body

| Rule | On failure |
|---|---|
| G1 every typed detail that survived in the original survives in the assembly (`detailSurvived`, R4) | revert the ops overlapping the original sentences with the highest per-sentence support for that detail, until satisfied |
| G2 `ASK.test(original) ⇒ ASK.test(assembly)` | revert the op containing the ask sentence |
| G3 the shared-school regex still matches | revert the op whose original text matched it |
| G4 document-level lint categories not widened (congrats-after-ask, `Thank you` count, I-run) | revert the implicated op; re-run |
| G5 word count within `[0.55, 1.20] ×` original, **excluding words removed by ops that the reviewer flagged `private` or `hateful`** | revert ops by descending `|Δwords|` until inside |
| G6 zero accepted ops | outcome `"none"`; the draft goes out as written, exactly as today |

G5's exclusion is required by measurement: MEASURED, a correct removal of a
13-word private sentence from a 30-word body is rejected today as "cut from 30
to 17 words" (57% < 60%). The floor is calibrated for long bodies; MEASURED body
lengths above the sign-off are min 53 / p10 75 / median 109 / max 198 words, so
the cut budget is 43 words at the median but only 30 at p10. Raising the floor to
0.55 and exempting flagged private removals fixes the measured case without
loosening the ceiling.

G2 is worth a caveat I should not hide: MEASURED, the `ASK` regex matches only
35/192 (18.2%) of gold bodies, so "dropped the ask" is inert for roughly four
emails in five regardless of this plan. Widening `ASK` is its own task; it is not
in this plan and the plan does not claim ask protection it does not have.

#### 3.1.6 Outcome, retry, and what gets recorded

`ReviewOutcome` gains `applied: "all" | "partial" | "none"`,
`spans: { accepted: number; rejected: number; reasons: string[] }`, and
`backoffs: string[]`. Keep a boolean alias for existing readers. The log line
appends `· spans 5/7`.

Retry policy changes: retry **only** when `accepted / total < 0.5` or a global
back-off reverted ≥2 ops. Today every rejection retries. Fewer retries is a
latency change — **arithmetic deferred to PLANNER-A.**

`REVIEW_SYSTEM`'s "HOW TO EDIT" must be rewritten (R8): telling the reviewer its
edit is "thrown away whole" once that is false gives it a wrong model of its own
consequences and invites it to under-edit.

### 3.2 R3 — the count comparison

MEASURED, this returns `ok: true` today:

```
before: ['filler phrase: "I wanted to reach out"']   (1 finding)
after : ['comma splice before "it was"']             (1 finding)
guard : {"ok":true}
```

`after_.length > before_.length` is strictly-greater, so a one-for-one swap of a
filler phrase for a comma splice passes. Combined with the 13.2% base rate, the
test is close to inert. Delete it; L4's category veto replaces it.

### 3.3 R4 — `detailSurvived` replaces `coverage`

MEASURED probes of the current function (replica of the exact source, since
`coverage` is not exported; verdicts cross-checked end to end through
`guardRevision`):

| Detail | Body | Score | Verdict | Correct? |
|---|---|---|---|---|
| `I want to learn about the credit and distressed group recruiting process` | generic body naming "group" and "recruiting process" | 0.57 | kept | borderline FP |
| `his advice about staffing on live deals and how he moved from audit to restructuring` | body keeps "advice about staffing", drops audit/restructuring | **0.43** | **kept** | **false positive** — the specific half is gone |
| `I manage the investment club portfolio` | "Management consulting investments clubbed portfolios" | 0.75 | kept | false positive |
| `interned at Evercore in restructuring` | "interested in internal restructuring at Evergreen" | 0.67 | kept | false positive |
| `we ended up talking about his Mustang` | "We spent most of the conversation on his car." | 0.00 | dropped | correct at detail level |
| `call on 10/6 at 3pm` | "Could we speak on October 6?" | 0.25 | dropped | false negative |

Root cause is the 5-character prefix: MEASURED, `intern`, `internal`, `interest`
and `interested` all collapse to `inter`; `distressed` and `distribution` to
`distr`; `restructuring` and `restructure` to `restr`.

Design:

```ts
export function detailSurvived(detail: string, body: string, threshold?: number): boolean;
export function detailAnchors(detail: string): string[];
```

1. **Stem** by stripping one suffix from a fixed list (`s es ed ing ly ion ions
   ment ments al er ers`) and requiring the stem to be ≥4 characters — MEASURED,
   this separates `intern`/`internal`/`interest` and
   `distress`/`distribution` while keeping `manage`/`management` together.
2. **Weight** tokens: 1.0 for a *specific* token — capitalised in the typed
   detail, or containing a digit, or absent from `DETAIL_COMMON`; 0.4 otherwise.
   `DETAIL_COMMON` is generated once from the playbook corpus (tokens appearing
   in ≥10% of the 192 gold bodies), committed as a constant in `draft-lint.ts`
   alongside its generator script, so it is auditable and deterministic rather
   than a hand-written stoplist.
3. **Anchor rule — the real fix.** Every weight-1.0 token that appears in the
   *original* body must appear in the revised body. A typed detail's proper
   nouns, numbers and rare words are anchors; losing an anchor the draft had is a
   drop whatever the ratio says. This catches the MEASURED 0.43 false positive
   directly.
4. Weighted ratio `≥ 0.4` as the secondary condition.

The `Mustang → his car` case (MEASURED 0.00) is **not** a scoring bug — the
student's word is genuinely gone, and it should be caught. What fixes it is R1:
only the paraphrasing span is reverted, not the edit. With the anchor rule the
reviewer can rewrite everything around an anchor freely, which is the behaviour
the reviewer's own instructions ask for.

### 3.4 R5 — measurement plumbing

MEASURED, from the schema and `email-archive.ts`:

- `email_drafts` (schema.ts:947) has **no** column for the review outcome.
- `email_archive` (schema.ts:1180) stores the pre-review draft and the review
  object inside `generatedCiphertext`, AES-256-GCM under `EMAIL_ARCHIVE_KEY`,
  and the module says in a comment that there is deliberately **no decrypt
  function in the app**. It is additionally gated on `mayTrainOn(userId)`.

So real-traffic guard rejection rates are currently obtainable only from the
`[draft-review]` log line. The archive could answer the question but needs a key,
a new server-only decrypt module, and consenting users. Nothing in this plan
should be justified by archive data until that exists.

Minimum change: add `review jsonb` to `email_drafts`, written at generation,
holding `{ applied, spans: {accepted, rejected}, reasons: string[], problemKinds: string[], backoffs: string[] }`
— verdict metadata only, **no body text and no quotes** (a `reason` string
currently embeds a quoted fragment, e.g. `added "Pinecrest"`; store the rule id
and the token class, not the token, or the column becomes content). One Drizzle
migration, one write in `actions.ts`. Note: I did not run a database query and
this plan proposes none; `npm run dev` hits the live database.

### 3.5 R7 — deterministic auto-fixes

The em-dash bug first, because it is MEASURED and it makes work for a model:

```
input  : "It was great meeting you at the panel—I came away with a lot to think about."
finishDraft → "It was great meeting you at the panel, I came away with a lot to think about."
commaSplices → ["I came"]
draftChecks.forReview → ['comma splice before "I came"']
```

`finishDraft`'s `.replace(/\s*—+\s*/g, ", ")` manufactures a comma splice, the
lint reports it, and the reviewer is asked to fix it. Replacement rule:

1. Count dashes in the sentence. **Exactly two** → parenthetical: the inner span
   becomes `, inner, `. Counterexample that makes a period unsafe:
   `the three groups—credit, equities and rates—all recruit sophomores`.
2. **One** dash → clause test on the right-hand side (`/^(I|we|he|she|they|it|that|this)\b\s+\w+/i`
   or a determiner-plus-finite-verb pattern): a full clause → `. ` plus
   capitalisation of the next word; otherwise `, `.
3. Digit–dash–digit stays `-` (already handled). A line-initial dash stays a
   bullet (already handled).

| Auto-fix | Rule | Counterexample that would make it unsafe |
|---|---|---|
| em dash | above | paired parenthetical dashes |
| spaced hyphen as dash (`[A-Za-z,.!?] - [A-Za-z]`) | same clause test as the em dash | a hyphenated bullet line, excluded by requiring a letter before the space |
| `also … too` | drop `too` only when it matches `/,?\s+too(?=[.,!?]|$)/` | `I also worked on two deals, too few to generalise from` — `too` as a degree adverb |
| class year `(Class of 2029)` when the signature carries it | delete the parenthetical and the preceding space | when `gmailSignature` is true the app adds no signature — the existing condition already covers it; keep it |
| double space, space before punctuation | collapse, skipping URLs and placeholders | a deliberately aligned block, which these emails never contain (MEASURED 0/192 on gold) |
| repeated word | delete the second, keeping the existing `that`/`had` exclusions, and never across a sentence boundary | `New York, New York`; `very, very` |
| lowercase sentence start | capitalise, unless the token is lowercase-then-uppercase (`iPhone`, `eBay`) or inside brackets | `iPhone` |
| capital after a colon | lowercase only when the word is in a fixed function-word list (`does do did is are was were how what when where why whether if can could would should will`) | `my two questions: Anchorage's process and the timeline` |

**Not automated, with reasons.** Filler phrases: the mechanical fix leaves
`To learn more about your group.`, and MEASURED, 20/192 gold bodies use the
pleasantry the rule targets — the fix here is R2 plus R6, not a rewriter.
General comma splices: choosing between a period, a semicolon and a joining
word changes emphasis (`She suggested I write, she interned there`), so only the
dash-created subclass is automated. `to then`: `I hope to then move into credit`
has no mechanical repair that preserves meaning. Connector-that-isn't-a-cause:
requires judging whether a causal relation holds. These four stay with the
model.

### 3.6 R9, R11 and R8 in brief

**R9** is covered in L3/L3b above.

**R11** — `whosWhoConflicts(facts, plan): string[]`, pure, in `draft-lint.ts`,
decidable from strings: (1) a `plan.people` entry whose role contains
"recipient" must have a name matching `contactName` (first-name or full); (2)
with `first.referred` checked, exactly one person's role must contain
`referr|suggested|introduced` and it must not be the recipient; (3) with
`first.met` or `first.conference` checked, the person whose role contains "met"
must be the recipient. Conflicts append to `AUTOMATIC CHECKS FLAGGED` and, if
the reviewer does not resolve them, to `notesForStudent`.
`plan.sentences`: MEASURED by grep, **nothing reads it** — not
`buildReviewPrompt` (which uses `plan.people` only), not `actions.ts`, not the
UI. Either use it (check each typed detail appears in ≥1 planned sentence, which
localises a drop before the body is even read) or stop asking for it. I
recommend using it; it is the cheapest who's-who signal available. Output-token
implications → PLANNER-A.

**R8** — the four prompt corrections are in §6.

---

## 4. Falsifiable tests

Every test below is runnable with no Anthropic API call. Tests marked **[CLI]**
call the subscription harness (`runClaude`), which is free but non-deterministic;
each of those states a sample size and a noise-aware threshold. Tests marked
**[PURE]** are deterministic.

New harnesses, both in the style of `scripts/draft-review-test.ts` (plain `tsx`,
a `t(name, ok)` assertion helper, prints `n/m passed`, `process.exitCode = 1` on
any failure), both added to `test:all`.

### 4.1 [PURE] R1 fixture suite — `npx tsx scripts/draft-align-test.ts`

Base `INPUT`, `DRAFT` and `SIGNATURE` are imported from the existing
`scripts/draft-review-test.ts` constants so no new scaffolding is invented.
**Metric: expected verdict and expected final body for all 19 fixtures.
Threshold: 19/19. Any single failure fails the suite.**

| # | Original → edit | Guard today | Expected with R1 |
|---|---|---|---|
| F1 | 3 real fixes (filler removed, comma splice repaired, `(Class of 2029)` dropped) **and** `a fellow Duke alum` dropped — the motivating incident | reject-all | spans 1–3 accepted; the school-dropping span reverted by G3; final body contains all three fixes **and** `a fellow Duke alum` |
| F2 | `Hi Rachel,` → `Dear Rachel,` plus one comma-splice fix | reject-all | greeting stays `Hi Rachel,`; the splice fix applied |
| F3 | sentence 1 reworded well; sentence 2 gains `at Goldman` | reject-all | sentence 1 accepted; sentence 2 reverted; `Goldman` absent |
| F4 | `15 minutes` → `20 minutes`, plus a good rewording elsewhere | reject-all | ask sentence reverted (`15 minutes` kept); rewording applied |
| F5 | the span holding `[what you want to learn]` is rewritten without the placeholder | reject-all | that span reverted; placeholder present in the final body |
| F6 | a clean 1:1 rewording (today's `g1`) | accept | `applied: "all"`, `verdicts.length === 0` — asserts the fast path, i.e. the aligner never ran |
| F7 | one sentence → two, both clean | accept | one `split` op accepted; paragraph count unchanged |
| F8 | two sentences → one, creating `, we had our call` | reject (worse) | the `merge` op rejected by L4; both originals kept verbatim |
| F9 | paragraph 2 split in two, all ops clean | accept | the new break is kept; 4 paragraphs |
| F9b | same, but one op in the group fails L2 | reject-all | **3** paragraphs — original structure — and the failed sentence is the original |
| F10 | a new sentence inserted with no typed-detail basis | accept (today) | `insert` **rejected**; paragraph unchanged. A deliberate tightening |
| F11 | typed detail `we talked about his Mustang` absent from the draft; the reviewer inserts it | accept | `insert` **accepted** via L6; `Mustang` present |
| F12 | sentence 2 rewritten with a new number; sentence 3 begins `It was the part that stuck with me.` | reject-all | **both** 2 and 3 reverted (L7 cohesion); final reads with the original 2 and 3 |
| F13 | filler phrase removed, comma splice introduced | **accept** (MEASURED hole) | the splice-introducing op rejected; the filler removal kept |
| F14 | `hasResumePdf: true`, no summary; edit adds `Pinecrest` | reject-all (MEASURED) | `accept-with-note`; `Pinecrest` present; a note names it. With `hasResumePdf: false` → reject |
| F15 | facts `studentSchool: "Penn"`; edit writes `the University of Pennsylvania` | reject-all (MEASURED `added "University"`) | accepted via the school-variant known set |
| F16 | 30-word body; a 13-word private sentence removed with a `private` problem | reject-all (MEASURED `cut from 30 to 17 words`) | accepted; G5 excludes flagged private removals |
| F17 | every sentence rewritten with an invented fact | reject-all | `applied: "none"`; final body **byte-identical** to the original |
| F18 | the reviewer mangles the signature (today's `g17`) | accept | accept — unchanged behaviour |
| F19 | the last two sentences of a paragraph swapped, no other change | accept | `move` detected and accepted; final = the reordered body |

### 4.2 [CLI] R6 + idea #2 — three-arm A/B, `npx tsx scripts/draft-cli-eval.ts --arms base,rules,corpus`

The only design that can attribute the improvement, which is what you asked for.

- **Arm 1 `base`**: today's drafter prompt, today's examples.
- **Arm 2 `rules`**: + the distilled voice subset in the drafter prompt (the six
  rules the lint can score: throat-clearing, pleasantry policy, I-run,
  intensifier budget, contraction policy, canned courtesy lines). ~900 chars
  ESTIMATED from the 2,385-char `VOICE_RULES` (MEASURED length).
- **Arm 3 `corpus`**: arm 2 + the repaired example corpus (R6).

Design: paired — the same N situations through all three arms, drawn from
`sims()` in `scripts/draft-occasions-sim.ts` so the situation distribution is
not invented. **N = 40** situations × 3 arms = 120 CLI calls ≈ 12 min at the
MEASURED 5.7 s/call, zero API spend.

Primary metric, per arm: **mean Tier-2 `voiceReport` findings per draft**
(contraction deficit, pleasantry opening, I-run ≥5, canned line, discovery
phrasing).
Secondary, the guard against crowding — **fact fidelity, three deterministic
scores on the same drafts**:
- `detailRetention` = share of typed details with `detailSurvived(detail, body)`;
- `hallucinationRate` = share of drafts containing a proper-noun token or digit
  run absent from `knownTokens(facts)`;
- `placeholderDiscipline` = share of drafts where `gaps` and the bracketed
  markers in the body correspond exactly.

**Pass/fail.**
- Arm 2 vs arm 1: adopt the distilled rules iff the paired bootstrap (10,000
  resamples, seeded) 95% CI for the reduction in mean voice findings excludes 0.
- Arm 3 vs arm 2: adopt R6 iff the same test clears, and **report both effect
  sizes** — that is the attribution.
- **Veto on either arm**: `detailRetention` must not drop by more than 2
  percentage points and `hallucinationRate` must not rise at all (paired CI
  excluding 0 in the wrong direction fails the arm). This is the
  attention-crowding detector, and it is the reason the secondary metrics are
  mandatory rather than nice to have.
- My prediction, on the record so it can be wrong: **arm 2's effect will be
  smaller than arm 3's.** If arm 2 alone clears the bar and arm 3 adds nothing,
  my §2 thesis is wrong and R6 should be dropped.

Caveats that must be printed in the output: the CLI exposes no `effort`,
`thinking` or fast-mode controls and the probe ran `claude-sonnet-5-5`, so this
measures the prompt's effect on a nearby model, not on the production
Opus-low/Sonnet-medium configuration; and no PDF document block is supported, so
only the `studentResumeSummary` path is exercised.

### 4.3 [PURE] R2/R10/R12 calibration — `npx tsx scripts/draft-voice-corpus.ts`

Runs `draftChecks` and `voiceChecks` over all 795 stored bodies plus the 234
gold example bodies, printing per-check rates by corpus and by tier, `--json`
for diffing, in the style of `scripts/draft-lint-corpus.ts`.

Hard gates:
- **Tier 1 must be zero on gold.** Every Tier-1 check fires on **0/234** gold
  bodies. Any Tier-1 check with a non-zero gold rate fails the build — that is
  the mechanical form of the calibration discipline `draft-lint.ts` claims.
- The widened `discovery_phrasing` rule returns **0/192** on the per-type gold
  corpus (today's naive widening MEASURED 6/192, all false positives) **and**
  flags the probe's string `I was glad to see that you are also from Atlanta`.
  Both conditions, or fail.
- `contraction_deficit` flags **≤25%** of contraction-eligible gold bodies
  (naive rule MEASURED 75.0%).
- `i_run` at N=5 flags **≤5%** of gold (MEASURED 3.6%; at N=3 it is 28.1%, which
  is why N=3 fails).
- `canned_line`'s four zero-rate members stay at **0/234**.
- After R6: every Tier-2 check's gold rate is **0**, and each is promoted to
  Tier 1 in the same commit. R6 is not done until this gate passes.

### 4.4 [PURE] R4 — `detailSurvived`

A fixture table of 24 `(detail, originalBody, revisedBody, expected)` rows
including all six MEASURED rows in §3.3 with their corrected verdicts. **Metric:
24/24.** Plus a corpus check over the 192 gold bodies: taking a random seeded
6-token window of a body as the "detail", `detailSurvived(window, body)` is true
for **100%**, and `detailSurvived(window, bodyWithWindowRemoved)` is false for
**≥95%** (failures listed individually).

### 4.5 [PURE] R1 property suite — `npx tsx scripts/draft-align-corpus.ts`

A seeded mutator (fixed LCG) turns each of the 192 gold bodies into five edit
classes: (a) benign — contraction toggles, a split at the first `, and `, a
filler deletion; (b) poisoned — inject exactly one of {a new proper noun, a new
digit run, a changed placeholder, a dropped ask, a dropped shared-school phrase};
(c) mixed — one benign and one poisoned span; (d) structural — split, merge,
paragraph split; (e) reorder. 192 × 5 = 960 pairs. Assertions:

| Inv | Claim | Threshold |
|---|---|---|
| INV1 | the final body contains no proper-noun token or digit run absent from an independently recomputed known set | 0 violations |
| INV2 | the final greeting equals the original greeting | 0 |
| INV3 | the placeholder multiset is unchanged | 0 |
| INV4 | `draftChecks(final)` categories ⊆ `draftChecks(original)` categories | 0 |
| INV5 | `ASK(original) ⇒ ASK(final)` | 0 |
| INV6 | final word count ∈ `[0.55, 1.20] ×` original, excluding flagged private removals | 0 |
| INV7 | class (a): final === the revised body (full acceptance) | **≥95%**, misses listed |
| INV8 | class (c): final contains the benign change **and** not the poison | **≥90%** — the headline number. Today's guard scores **0%** on class (c) by construction. Report as `recovered_fraction` |
| INV9 | paragraph count equals the original's unless every op in a restructured group was accepted | 0 |
| INV10 | running the applier twice gives identical output | 0 |
| INV11 | no mechanical corruption: `!/ {2,}| ,|,,|\.\./.test(final)`, every paragraph non-empty | 0 |
| INV12 | class (e): the reorder is applied via `move` | ≥90% |

### 4.6 [PURE] R7 auto-fixes

A fixture table of input → expected output for each of the eight rewrites, plus
each counterexample from §3.5's table → expected **unchanged**. **Metric:
100%.** Corpus gate: applying the auto-fixers to all 234 gold bodies introduces
**zero** new `draftChecks` categories, and the em-dash fixer changes exactly the
**11** gold bodies MEASURED to contain an em or en dash — no more.

### 4.7 [PURE] R11 who's-who

A fixture table of 12 `(boxIds, plan.people, expected conflicts)` rows. **12/12.**
The drafter's plan is an input, so no model is needed.

### 4.8 [PURE] Regression

`npx tsx scripts/draft-review-test.ts` prints **≥71/71 passed** (MEASURED
baseline: 71/71), `npm run test` passes, and `npm run typecheck` reports only the
one pre-existing `LayoutProps` error documented in BASELINE.md. R1's fast path
is what makes the 71 unchanged.

### 4.9 [CLI] End-to-end review effect — `npx tsx scripts/draft-cli-eval.ts --review`

N=40 paired situations, drafted then reviewed through the CLI, guarded twice:
once with `guardRevision` alone and once with `applyReviewEdit`. Metrics:
`applied` distribution and mean accepted-span fraction. **Pass: the per-span
guard applies at least one span on ≥60% of the edits `guardRevision` rejects,
with zero INV1–INV6 violations.** The 60% is ESTIMATED from the fixture mix, not
measured; the zero-violation half of the gate is the part that must hold
absolutely.

### 4.10 What cannot be tested in this round

- Whether the review pass is worth its latency. Needs real pre/post pairs, i.e.
  R5 then production traffic.
- Real guard rejection rates. Same.
- Whether partial application reads worse to a human than no application. Needs
  human judgement on CLI output; propose 20 pairs, blind, after R1 lands.
- Any claim about the production model configuration: the CLI cannot set effort,
  thinking or fast mode.

---

## 5. Idea #5 — the plan and WHO'S WHO

**Rejected: a separate cheap structured call for who's-who.** Three reasons.
(1) The check needs the same `FACTS` the reviewer already holds, so keeping it
where it is costs no marginal input and splitting it out costs a third serial
model call. (2) What `WHO'S WHO` actually prevents is the **reviewer**
mis-correcting a role — the code comment says exactly that ("the live evaluation
caught it 'correcting' a draft by deciding the student had met someone other
than the recipient"), so `BOX_FACTS` must sit in the reviewer's context whether
or not a third call exists. (3) A role error the reviewer cannot settle is
already routed to the student via `needsStudent`, which is the right destination
for a judgement call about who someone is.

**Adopted instead: R11**, the deterministic `whosWhoConflicts` check above, plus
a decision on `plan.sentences`, which MEASURED is read by nothing.

---

## 6. Idea #6 — what in the prompt stack is redundant, contradictory or
counterproductive

Quotes are verbatim from the current files.

**C1 — the reviewer is given two length ceilings, and neither matches the code.**
`REVIEW_SYSTEM`: *"thrown away whole if it … grows past 20% or shrinks past 40%"*
and, four bullets later, *"Stay close to the draft's length: never more than 15%
longer."* The code is `after > before * 1.2` and `after < before * 0.6`. So 20%
and 40% are right, 15% is a tighter rule that is never enforced. One sentence,
matching the code.

**C2 — "thrown away whole" becomes false the moment R1 ships.** Telling the
reviewer its edit is discarded wholesale, when spans are now applied
independently, gives it a wrong model of its own consequences and invites it to
bundle conservatively. Must be rewritten in the same commit as R1.

**C3 — soften versus remove: the drafter is told to produce exactly what the
reviewer is told to delete.** `STUDENT_DETAILS_RULES` (drafter): *"a health
condition becomes \"a medical leave\" or \"health reasons\", a pregnancy becomes
\"family reasons\""*. `REVIEW_SYSTEM` rule 3: *"even when softened (\"his
gambling addiction\" is not fixed by writing \"his poker obsession\"). Remove it
and tell the student."* The removal then has to survive a guard whose private
exemption keys on `privateTopicsIn(detail)` or on the reviewer's `quote`
covering the typed detail at ≥0.4 — and MEASURED, a legitimate removal of a
keyword-free private detail (`he is going through a messy separation`) is
rejected anyway, on the shrink floor. One policy, one place: the drafter
removes-and-notes whatever `privateTopicsIn` matches and never softens; the
reviewer's rule 3 stays as the net; both prompts quote the same list.

**C4 — the pleasantry is simultaneously permitted, taught and punished.**
`VOICE_RULES`: *"Use a pleasantry (\"I hope you're doing well\") only when there
is nothing specific to lead with, and never more than one."* `draft-lint.ts`
`FILLER` flags `I hope this (email|message|note) finds you well` unconditionally
as a *"filler phrase"*. MEASURED: 20/192 gold examples contain that exact phrase,
33.3% open on a pleasantry, and the filler rule is the single largest source of
findings on the gold corpus (33 of 62). Fix: R2 moves the pleasantry arm to Tier
2, R6 removes it from the examples, then it is promoted back.

**C5 — the reviewer is told to fix a construction the playbook uses.**
`REVIEW_SYSTEM` rule 6: *"A statement and a thank-you are two sentences: \"Ben
and I had our call. Thank you again for connecting us.\", never \"Ben and I had
our call, and thank you again…\"."* MEASURED, the gold `redirect_sequence`
example reads *"Dorothy and I spoke on Tuesday, and thank you again for sending
me her way."* — and `, and thank you` appears 25 times across 795 bodies,
including 3 of 42 Volume V examples. Either narrow the rule (fire only when the
sentence already carries two other clauses) or fix the examples. Taking a
position: **narrow the rule.** The construction is fine in short sentences; the
rule was written against long ones.

**C6 — a documented calibration claim that does not hold as written.**
`draft-lint.ts`: the checks are *"calibrated on the playbook's own Volume V
emails, which pass them."* MEASURED (BASELINE §3): true for `fluencyIssues` (3
findings in 42 Volume V examples, matching
`scripts/draft-occasions-sim.ts lint-examples`), false for `draftChecks` as a
whole — 9/42 Volume V and 51/192 per-type examples produce a non-empty
`forReview`. The comment must name which function it is talking about, and R2's
Tier-1 gate makes the claim mechanically enforced instead of asserted.

**C7 — the reviewer is told to use the resume the guard cannot see.**
`REVIEW_SYSTEM`: *"Never add a fact, name, number, date, place or claim"* and
*"If the draft left a typed detail out …, work it back in using FACTS' own
words"*, while `runDraftPipeline` sends the resume PDF to the reviewer but hands
the guard only `hasResumePdf: Boolean(resumePdf)`. MEASURED: an edit restoring a
real club name from the PDF dies as `added "Pinecrest"`. Fixed by R9/L3b.

**C8 — three layers each doing part of the dash job, and the deterministic layer
creating work for the model layer.** `HOUSE_RULES`: *"No em dashes"*;
`finishDraft` rewrites them to commas; `draftChecks` then reports the comma
splice that rewrite created (MEASURED); `REVIEW_SYSTEM` separately says *"No
dashes as punctuation, including a spaced hyphen"*. R7 collapses this into one
correct transform. And note MEASURED: 11/192 gold examples contain an em or en
dash, so the rule contradicts the corpus here too.

**C9 — redundant but harmless, listed so nobody "fixes" it twice.** `GAP_RULES`
already tells the model *"never tell the student to attach their resume"*, and
`APP_HANDLES` in `draft-pipeline.ts` filters such notes anyway. Belt and braces;
keep both.

**C10 — the register rule has no way to know the register.** `VOICE_RULES`:
*"Keep full forms in emails to a recruiting team or inbox, offer decisions, and
letters to professors."* `buildReviewPrompt` never states the email's type; the
reviewer must infer it from the situation summary and `WHO'S WHO` (where
`first.inbox` does say *"The email goes to a recruiting team's inbox, not a
person."*). Add the lead type's label to the review prompt — one line, and
`contraction_deficit` needs the same `formalRegister` flag anyway.

### On free rein over the prompt stack

You have it, and the measured case for using it is R6, not a rewrite of the
rules. The rules are mostly right and mostly followed (the 300-draft note says
so). What is wrong is that 234 worked examples demonstrate the opposite of five
of them. Rewriting prose that a model already obeys is the lower-yield half of
the job.

---

## 7. Rejected

| Rejected | Why |
|---|---|
| A separate structured who's-who call | §5: a third serial call for a check that must stay in the reviewer's context anyway |
| Moving `VOICE_RULES` out of the reviewer | The reviewer is the only component that sees the finished text, which is what the rules are about. Moving a copy to the drafter is arm 2 of §4.2; *removing* it from the reviewer gives up the only place it can be enforced |
| Promoting the four new voice checks straight into `forReview` | MEASURED: gold is 75.0% contraction-free, 33.3% pleasantry-opening, 28.1% at 3+ I-runs, 32 uses of `for your reference`. Shipping these as problems instructs the reviewer to delete what the drafter was shown. Tier 2 until R6 |
| Auto-fixing filler phrases | The mechanical fix leaves `To learn more about your group.`; and the targeted phrase is in 10.4% of gold |
| A general comma-splice auto-fix | Period vs semicolon vs joining word changes emphasis; only the dash-created subclass is mechanical |
| Auto-fixing `to then` and connector-not-a-cause | No meaning-preserving mechanical rewrite exists |
| A character or word-level diff for alignment | A hunk that straddles a sentence boundary cannot be independently validated, and a word-level hunk cannot be lint-checked — §3.1.2 |
| An LLM judge for span validation | Reintroduces the failure mode the guard exists to backstop, and costs a third call. Separately, no API budget this round |
| Dropping the guard and trusting the reviewer | MEASURED behaviour the guard catches today includes added firms, added numbers, dropped placeholders and dropped typed details |
| More than one review retry | Each retry is a full serial call; R1 reduces the need for the one that exists |
| Keeping the `draftChecks` count comparison | MEASURED: a defect-for-defect swap passes, and the counts are 0-vs-0 on ~87% of model-written bodies |
| Justifying anything from the archive in this round | MEASURED: the archive is encrypted with no decrypt path in the app and is consent-gated. R5 first |

---

## 8. Dependency order

**Phase 0 — make the signal trustworthy.** No dependencies; nothing downstream
is measurable without these.
- R5 (plaintext review record, one migration).
- R0 (`scripts/draft-cli-eval.ts`) — needed by §4.2 and §4.9.
- R2 (two-tier lint) + `scripts/draft-voice-corpus.ts` (§4.3) with the Tier-1
  gate enforced.
- R12 (retire or widen the 15 dead checks) — lands with R2, same file.

**Phase 1 — the primitives R1 consumes.** Parallelisable.
- R3: categorised lint findings (`spanLint`), replacing the count comparison.
- R4: `detailSurvived` + `DETAIL_COMMON` and its generator.
- R9: the known-set repair (school variants, the three-valued verdict).
- R10: `voiceChecks` as Tier 2 — needed as the §4.2 metric.

**Phase 2 — the guard.** `draft-align.ts`, then `draft-guard.ts`, then the
pipeline call site (rebase onto `PipelineTimings`), then the retry policy. R8's
prompt corrections **must land in the same commit as R1** — C2 is false the
moment R1 ships.

**Phase 3 — independent of the guard, dependent on Phase 0.**
- R7 auto-fixes (the em-dash bug first; its corpus gate is only meaningful once
  R2's corpus harness exists).
- R6 example corpus repair, then the §4.2 three-arm A/B, then promote each Tier-2
  check whose gold rate reached zero.

**Phase 4.** R11 (who's-who check, `plan.sentences` decision).

The one ordering mistake to avoid: shipping R1 before R2/R3. A span validator
whose veto signal is the current lint would be vetoing on a signal that is zero
87% of the time and that fires on the playbook's own gold emails a quarter of the
time.

---

## 9. Provenance of every number

**MEASURED by me this session**, via `node --import tsx --conditions=react-server -e`
against the real modules in this worktree. Each should be committed as a script
before anyone depends on it; the probes are reproducible as written.

| Claim | How |
|---|---|
| `finishDraft` turns `panel—I came away` into a comma splice that `draftChecks` then reports | `finishDraft` + `commaSplices` + `draftChecks` on one body |
| `Penn` in facts + an edit writing `the University of Pennsylvania` → `added "University"` | `guardRevision` |
| A resume-PDF proper noun (`Pinecrest`) → `added "Pinecrest"` | `guardRevision` with `hasResumePdf: true`, no summary |
| A 13-word private removal from a 30-word body → `cut from 30 to 17 words` | `guardRevision` with a `private` problem |
| Filler-for-splice swap → `ok: true` | `guardRevision` + `draftChecks` |
| `ASK` matches 35/192 (18.2%) of gold; 26 of 35 are cold types | `ASK` over `EMAIL_EXAMPLES` |
| `coverage` scores: 0.57, 0.43, 0.75, 0.67, 0.00, 0.33, 0.25 on the §3.3 rows; `inter`/`distr`/`restr` stem collisions | exact replica of the private `coverage` source, cross-checked through `guardRevision` |
| Body-above-sign-off words: min 53, p10 75, median 109, max 198 | 192 gold bodies |
| Sentences per body: min 3, median 7, max 11 | same |
| `VOICE_RULES` 2,385 ch; review system 11,682 ch; `cold_email` draft system 20,702 ch; shares 20.4% and 10.3% | `VOICE_RULES.length`, `buildReviewPrompt`, `buildDraftPrompt` |
| The §2 gold-corpus table (75.0% / 33.3% / 10.4% / 28.1% / 10.4% / 3.6% / 16.7% / 8 / 5 / 6 / 0 / 0 / 0 / 0 / 11) | 192 gold bodies above the sign-off, greeting excluded |
| All 6 widened-discovery gold hits are false positives | inspected individually; listed in §2.1(d) |
| 48/192 and 6/42 gold bodies trip `forReview` with the opinion check suppressed | `draftChecks` with typed text containing `said/told/mentioned` — consistent with BASELINE's 51/192 and 9/42 unsuppressed |
| `plan.sentences` is read by nothing; `email_drafts` has no review column; `email_archive` has no decrypt path | grep + schema and `email-archive.ts` read |
| `src/lib/draft-pipeline.ts` is modified in this worktree (288 → 335 lines) | `git status`, `git diff` |

**MEASURED by others, taken as given** (BASELINE.md and FINDINGS-probe.md,
both with reproduction commands): 51/192 and 9/42 gold bodies trip `forReview`;
15 of 23 checks fire zero times across 795 bodies; the 8 that fire and their
counts; 13.2% of 561 model-written bodies produce any finding; 487/561 have an
empty `forReview`; 71/71 on `draft-review-test.ts`; the 6,056-char cacheable
head; the CLI probe at 5.7 s with no API spend; the four `VOICE_RULES` misses on
the probe draft.

**ESTIMATED**, with basis: all token counts (characters ÷ 3.7, the ratio
BASELINE and the workflow doc both use — no tokenizer was run); the distilled
voice subset at ~900 chars (proportion of the measured 2,385); engineer-day
costs in §1 (my judgement from reading the code); the ≥60% span-recovery
threshold in §4.9 (from the fixture mix, not from traffic); the §4.5 thresholds
of ≥95% / ≥90% (my judgement — they are the numbers a tester should push back on
first if the aligner comes in close to them).

**Deliberately not claimed**: any latency or cost number. Where a change here
moves latency — R1's reduced retry rate, R6's unchanged prompt size, R11's
output tokens for `plan.sentences` — the arithmetic belongs to PLANNER-A.
