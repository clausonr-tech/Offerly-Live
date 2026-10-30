# LOGIC-2 — the lint's logic in the email draft pipeline

Audit of `src/lib/draft-lint.ts` at `0053b1a`, worktree
`.claude/worktrees/draft-pipeline-perf`. Read-only on `src/` and existing
`scripts/`; every probe written for this audit is under
`scripts/audit-probe/logic2/`. No model call, no database.

**Labels.** **MEASURED** = I ran the command shown and the number is its output.
**REASONED** = read off the code with no run behind it. **ASSERTED-ELSEWHERE** =
a number from earlier work that I could not re-run here (no API), carried with
that caveat.

**Working-tree state while this ran.** Concurrent sessions moved the branch to
`8afe9bf` and left uncommitted edits in `draft-prompt.ts` and `draft-review.ts`
(the `keepInSection` prompt-section fix). MEASURED: `git diff 0053b1a HEAD --
src/lib/draft-lint.ts src/lib/draft-review.ts src/lib/draft-prompt.ts
src/lib/draft-pipeline.ts` is empty, and the uncommitted edits touch prompt
construction only, not `finishDraft` or `guardRevision`. Every reproduction below
therefore holds at `0053b1a`.

**The corpora.** `gold` below means the 234 playbook bodies the checks are meant
to pass: 192 per-type in `src/lib/email-examples.ts` (+v3/v4) plus the 42
Volume V combinations in `email-examples-v5.json`. `795` means those 234 plus
the 87 multi-box and 474 scenario fixtures.

**Context verified before use** (MEASURED, `npx tsx scripts/draft-lint-corpus.ts --json`):
795 bodies, 134 with a non-empty `forReview`, 149 findings, **8 distinct checks
ever fire**, so 15 of the 23 the classifier knows never do. Per corpus:
multi-box 26/87, scenarios 48/474, per-type gold **51/192**, Volume V 9/42.
Model-written bodies with an empty `forReview`: **487 of 561 = 86.8%**. Of the
51 failing gold bodies, 32 carry a filler finding and **23 carry nothing else**;
the pleasantry arm alone hits **20 of 192** (MEASURED,
`npx tsx scripts/audit-probe/logic2/misc-probe.ts filler192`). The brief's
"0 before and after review while the reviewer found 12–13 problems" is
ASSERTED-ELSEWHERE (PLAN-B v2 §2.4, MEASURED-RIG; needs the API).

---

## Findings, ranked

### F1 (critical) — `privateTopicsIn` is wrong in both directions, and one false positive switches off the guard's protection of a typed detail

**The flaw.** `PRIVATE_TOPICS` is a 20-stem word list with `\w*` suffixes. The
stems are generic English for sensitive subjects; the app's domain is finance
recruiting, where several of them are ordinary coverage vocabulary
(`bankrupt\w*` → "bankruptcy", `diagnos\w*` → "diagnostics", `chemo\w*` →
"chemotherapy", `pregnan\w*` → "pregnancy-tech", `therap(y|ist)` →
"therapy-services"). Meanwhile the real surface of "a private thing about a
person" is nowhere near a 20-word list.

**MEASURED** (`npx tsx scripts/audit-probe/logic2/misc-probe.ts private`): of 20
hand-written sensitive disclosures, **20 are missed** — illness, in recovery,
custody battle, ADHD medication, a death in the family, antidepressants,
immigration status, mental health and a hospital stay, IVF, separation,
abortion, a child in a treatment centre, sobriety, disability leave, religion
and voting, HIV status, indicted, tumour, subpoenaed. Of 15 benign
finance/academic sentences, **14 false-positive**; only "the Chapter 11 deal"
escapes, and it escapes because the list has no entry for it, not because the
list understands it.

**The consequence that matters is not the warning.** `draft-review.ts:511`
reads:

```ts
for (const detail of typedDetails(facts)) {
  if (privateTopicsIn(detail).length) continue;   // ← no longer protected
```

So any typed detail the word list hits is exempt from "nothing the student typed
may disappear in the edit". **MEASURED**
(`npx tsx scripts/audit-probe/logic2/private-guard-probe.ts`), one word apart:

| typed detail | `privateTopicsIn` | guard on its deletion |
|---|---|---|
| "Your work on the **restructuring** of Hertz is what got me interested in the group." | `[]` | `ok:false — dropped something the student typed` |
| "Your work on the **bankruptcy** of Hertz is what got me interested in the group." | `["bankruptcy"]` | **`ok:true`** |
| "The **diagnostics** company your team took public is one I have followed closely." | `["diagnostics"]` | **`ok:true`** |

The reviewer can silently delete the one specific thing the student typed, and
the guard that exists to stop that waves it through, because the detail contains
a restructuring term.

Secondary consequences (REASONED from the call sites): a "Before you send" note
on 14-of-15-style benign sentences (`draft-lint.ts:336`), and a live warning
while the student types (`GenerateForm.tsx:316`).

**Fix.** Three separable changes, in this order:
1. Stop using `privateTopicsIn` as the exemption at `draft-review.ts:511`. The
   exemption's purpose is "the reviewer was told to remove this"; that is
   already expressed by the `problems.some(p => p.kind === "private" …)` clause
   on the next line. Delete the word-list clause and keep the reviewer's own
   claim as the only exemption.
2. Require a possessive/person context, not a bare stem: match
   `(?:his|her|their|my|the recipient's|…)\s+(?:\w+\s+){0,2}(?:cancer|divorce|…)`
   and drop the `\w*` on the stems that have a finance homonym
   (`bankrupt`→`bankruptcy|bankrupt` only as a personal predicate,
   `diagnos`→`diagnosed`, `chemo`→`chemo`). That alone kills most of the 14.
3. Accept that the miss list cannot be closed by words. The check should be
   scoped to what the student typed in the "what we talked about" fields and
   routed to the model, which already has a `private` problem kind; keep the word
   list only as a cheap pre-warning that never gates anything.

---

### F2 (critical) — `commaSplices`' two exclusion lists are arbitrary word lists; they false-positive on ordinary introductory phrases and that false positive throws away the reviewer's whole edit

**The flaw.** `INTRODUCTORY` is a 42-word list anchored at the start of the
sentence, and `SUBORDINATE` is a 17-entry list matched anywhere in the segment
before the comma. Neither asks the structural question — "does the text before
the comma contain its own subject and finite verb" — so both over- and
under-exempt. `SPLICE_START` is also a closed subject list
(`I|we|he|she|they` plus five literal phrases).

**MEASURED** (`npx tsx scripts/audit-probe/logic2/splice-probe.ts`):

- **10 of 10** constructed introductory phrases whose first word is simply not
  on the list are reported as comma splices: *"To answer your question, I am a
  sophomore…"*, *"Thanks to your introduction, I had a call with Ben…"*,
  *"Reading your note again this morning, I was glad…"*, *"Beyond the internship
  itself, I am curious…"*, *"Along with my resume, I attached…"*, *"Apart from
  the timing, I am flexible…"*, *"Having read the fund's latest letter, I came
  away…"*, *"Speaking with Elias last week, I realised…"*, *"Of all the
  conversations I had this fall, I think…"*, *"Like many students in the club, I
  built…"*.
- **9 of 10** constructed real splices are missed, 6 because the sentence happens
  to open with a listed word (*"This summer I built a screening model from
  scratch, I learned more from it…"*, *"Last week I spoke with Ben, he was
  generous with his time."*, *"So the process is now behind me, I wanted to say
  thank you properly."*) and 3 because `SUBORDINATE` matched a preposition in
  the prefix (`as` in "working **as** a research assistant, I enjoy it";
  `before` in "send the model over **before** Friday, it is almost finished").
  `INTRODUCTORY` is anchored at the sentence start, so a listed opener
  suppresses the check for **every** comma in that sentence (REASONED from
  `before = sentence.slice(0, m.index)`).
- A real splice whose second clause starts with `it`/`that`/`there`/a noun is
  invisible: *"Your point about customer concentration stuck with me, it
  reframed how I read retail."* → `[]`.
- Reach of the exclusions over gold: **816** comma-bearing sentences, of which
  `INTRODUCTORY` matches the opening in **153 (18.8%)** and `SUBORDINATE`
  matches the first prefix segment in **180 (22.1%)**; **224 (27.5%)** are
  suppressed by one or the other.

**The gold hits are mostly its own false positives.** MEASURED
(`npx tsx scripts/audit-probe/logic2/tier-probe.ts`): the check fires on 5 gold
bodies and **4 are not splices** —
`interview_check_in#4` "Regardless of the outcome, I am grateful…",
`offer_extension#3` "To be fully transparent with you, I have a final round…",
`v5#19` "…and having heard you speak, I agree with him.",
`thank_you_interview#6` (a three-clause serial list on sponsorship). Only
`v5#12` is a genuine splice.

**Consequence.** `guardRevision` turns this into a whole-edit veto. MEASURED,
same probe: a revision that rewrites one sentence as *"Having read the fund's
latest letter, I came away with one question…"* produces
`{"ok":false,"reason":"made the writing worse: introduced comma splice"}` —
every other fix in that edit is discarded, and the retry prompt then tells the
reviewer to put the "defect" back.

**Fix.** Replace both lists with one structural test on the prefix: strip
leading subordinators and participials, then require a *finite* verb agreeing
with a *nominative* subject (a small closed verb-form test is enough:
`is|are|was|were|am|have|has|had|will|would|did|do|does` plus `-ed/-s` forms
after a pronoun or determiner+noun). Widen `SPLICE_START` to `it|that|there|you`
plus determiner-headed subjects in the same pass. If that is too much for now,
the minimum honest change is to **stop feeding this check into the veto set**
until its gold false-positive rate is 0 — see F6.

---

### F3 (high) — the widened `ASK`'s "100% precision" does not survive leaving the committed sample; the `let me know` arm matches offers, which the rule's own docstring excludes

**Re-derivation of the claim.** MEASURED
(`npx tsx scripts/audit-probe/logic2/ask-probe.ts sample`): on the 40-body
hand-labelled sample committed in `scripts/draft-review-test.ts`, TP=27, FP=0,
FN=3 → **recall 90.0%, precision 100.0%**. The claim reproduces exactly. I read
all 10 bodies labelled "no ask" and all 3 false negatives; the labels are
defensible (`not_now_reply#1`'s "please just say so" is the one I would call
borderline). Corpus-wide, MEASURED: ASK matches **131/192** per-type and
**151/234** gold bodies.

**But the sample is the first example of each type, and the rule is evaluated on
the same bodies it was fitted to.** MEASURED
(`… ask-probe.ts heldout`): on the **31 held-out bodies of those same ten
"no ask" types** (examples #2 onward, never read by the labeller), ASK fires on
**10**. Reading all 10: three are genuine asks the type label does not cover
(`not_now_reply#2`, `thank_you_phone_screen#2`, `#3`), one is borderline
(`decline_offer#5` "I would welcome the chance to talk again" — a conditional
sentiment of exactly the shape the docstring excludes), and **six are pure
courtesy offers** —

```
thank_you_interview#3   "Past this, please let me know if there is anything else you need from me!"
thank_you_interview#5   "Please let me know if there is anything else you need from me, and thank you again!"
thank_you_interview#6   "Please let me know if there is anything further you need from me…"
thank_you_superday#2    "Please let me know if there is anything else you need from me…"
thank_you_superday#3    "Please let me know if there is anything else you need from me…"
thank_you_phone_screen#4 "Please let me know if there is anything else I should do on my end."
```

By the sample's own convention these are not asks: `thank_you_interview#1`'s
"please do not hesitate to reach out" is labelled **false**, and the docstring
says in terms that an offer is not an ask. The 100% figure is an artifact of
which body per type was sampled.

**Scale.** MEASURED (`… ask-probe.ts corpus` / `letmeknow` / `offeronly`):
`\blet me know\b` is the second-largest arm — **37 gold bodies, sole trigger in
25**. I read all 37: ~21 are "let me know if there is anything else you need
from me"-shaped offers. **19** gold bodies have *every* ASK-matching sentence
offer-shaped; reading those 19, **14 are pure offers** and 5 mix an offer with a
real request in one sentence. Two arms are dead on gold: `do you have
(time|…)` → **0/234**, `any chance you` → **0/234**.

**Three consequences, all MEASURED.**

1. **The ask-ordering judgement flips.** `fluencyIssues` takes
   `askAt = sentences.findIndex(ASK.test)` — the *first* match.
   (`… ask-probe.ts ordering`)
   - False positive: *"I hope your week is going well. Please let me know if
     there is anything else you need from me. I also saw that you were promoted
     to Vice President this month, so congratulations to you."* →
     `["congratulations come after the ask"]`, in an email with no ask at all.
   - False negative: *"Please just name a time and I will make it work. I also
     saw the promotion news, so congratulations on that."* → `[]`; the
     imperative-request family is absent from ASK, so there is no ask to be
     after.
2. **The guard vetoes the removal of a canned line as "dropped the ask".**
   `draft-review.ts:521`. MEASURED
   (`npx tsx scripts/audit-probe/logic2/interaction-probe.ts`, §4): an edit whose
   only change is deleting *"Please let me know if there is anything else you
   need from me."* returns `{"ok":false,"reason":"dropped the ask"}`. That line
   is exactly what PLAN-B §4(c) and R11 want the reviewer to remove. The lint
   and the plan are pointed at each other.
3. **Recall's residue is structural, not random.** The three FNs are the
   imperative family (`call_scheduling`: "please just name a time", "send me
   the number"), the `Would <noun> work?` family (`coffee_in_person_reply`:
   "Would Marlow Coffee on Chandler Street work?") and the embedded-question
   family (`recruiter_follow_up`: "My two questions were whether … runs a
   sophomore insight program"). None is representable by the current twelve
   alternatives.

**Fix.**
- Split the regex in two and give the two users different ones.
  `ASK_REQUEST` (what the guard must not let disappear) excludes offers:
  subtract `/let me know (?:if|whether)[^.!?]{0,40}\banything (?:else|further|more)\b/`
  and `/if there is anything (?:else|further)/` before the `let me know` arm
  fires, or require `let me know` to be followed by a time/availability/update
  object. `ASK_ANY` can stay broad for diagnostics.
- Add the three missing families: `\bplease (?:just )?(?:name|send|point|share|confirm|let)\b`,
  `\bwould (?:\w+ ){0,4}work (?:for you|on your end)\b`,
  `\bmy (?:two )?questions? (?:were|are|was)\b.*\bwhether\b`.
- Re-measure recall and precision on bodies the labeller has not seen: label a
  fresh 40 drawn at random across all 234 (not one per type), and commit both
  the labels and the seed. Note the interval: 27/30 is 90% with a 95% CI of
  roughly 73–98%, so "90%" should be written as "≥70% at 95% confidence", which
  is what the committed assertion already tests.
- Make the ordering checks use the *last* ask, or the ask with the strongest
  arm, rather than `findIndex`.

---

### F4 (high) — `finishDraft` manufactures a comma splice, and the guard's lint veto is computed on text that is not the text that ships

**The flaw.** `finishDraft` ends with `.replace(/\s*—+\s*/g, ", ")`
(`draft-prompt.ts:1071`). An em dash joining two independent clauses becomes a
comma joining two independent clauses — the exact object `commaSplices` reports.

**MEASURED** (`npx tsx scripts/audit-probe/logic2/interaction-probe.ts`, §1):

```
model wrote : "…the introduction to Ben — he was generous with his time, and the call was useful."
draftChecks : []
after finishDraft : "…the introduction to Ben, he was generous with his time, and the call was useful."
draftChecks : ["comma splice before \"he was\""]
```

**The ordering is worse than the rewrite.** In `draft-pipeline.ts`,
`preReview` is post-`finishDraft`, `guardRevision(preReview, out, …)` reads
`out.body` **raw**, and the shipped body is `finishDraft(out.body)` — applied
*after* the veto. So the veto judges a different string than the student
receives. MEASURED, same probe §2: a revision that uses an em dash where the
original used a full stop gives

```
categories in the original (post-finishDraft) : []
categories the guard sees in the revision      : []   → veto passes
categories in the body that actually ships     : ["comma splice"]   ← introduced by the edit
```

and §3 the mirror image: a reviewer that writes a spaced hyphen is vetoed
(`dash as punctuation`) for a defect `finishDraft` does **not** fix, so the veto
and the fixer disagree in both directions.

**Fix.** (a) make the em-dash rewrite clause-aware: `— ` before a capital or a
pronoun+finite-verb becomes `. ` + capitalise, not `, `; keep `, ` only for
appositives. (b) Guard the *finished* revision:
`guardRevision(preReview, finishDraft(promptInput, out), …)`, so the veto, the
lint handed to the reviewer and the shipped text are all the same string.
(b) is one line and fixes the class, not the instance.

---

### F5 (high) — three mis-specified checks miss almost every shape of the defect they name; one of them is the phrase the rest of the pipeline is built around

**MEASURED** (`npx tsx scripts/audit-probe/logic2/misc-probe.ts misspec`):

| check | caught | missed |
|---|---|---|
| discovery-as-announcement | 1 of 6 | "I was glad to see that **you are also** from Atlanta." · "I noticed that **you also went** to Duke." · "I saw that **we share** a hometown." · "I learned you were in the investment club **too**." · "…saw you are a Duke alum **as well**." |
| student called an alum | 1 of 5 | "**As a fellow Duke alum**, I was glad to see your note." · "I am a fellow Duke student, and I gather **you also studied** there." · "**We are both Duke people**…" · "As **fellow alumni** of the Calloway School…" |
| `"both"` doubled with `"too"`/`"as well"` | 2 of 4 | "I am from Atlanta **too**, and I gather you are **as well**." (no `both`) · the same doubling at more than 60 characters' distance, which `[^.!?]{0,60}` cannot span |

The alum miss is the costly one: *"As a fellow Duke alum"* is the exact string
PLAN-B R11 names as a contaminating specimen **and** the string the guard's
`sharedSchool` regex protects (`draft-review.ts:526`). So the pipeline teaches
the phrase, protects it from removal, and the check written to catch it does
not see it.

**Fix.** PLAN-B §4(d)'s proposed discovery regex is right: MEASURED, I ran it
as written and it matches *"I was glad to see that you are also from Atlanta."*
and *"I noticed that we are both from Atlanta."* while excluding the gold true
negative *"I saw the announcement that you were promoted to Vice President."* For the alum check, key on the
*subject* rather than on `we're both`:
`/\b(?:as a|I am a|I'm a) fellow [\w ]{0,20}(?:alum|alumn\w+)\b|\bwe (?:are|'re) both [\w ]{0,20}alum/i`.
For the doubling check, drop the 60-character window and test the sentence for
`\bboth\b` and `\b(?:too|as well)\b` co-occurring, or `\b(?:also)\b` and
`\b(?:too|as well)\b`.

---

### F6 (high) — the two-tier proposal's promotion condition is not a ratchet: it rewards a check that matches nothing, and §4 simultaneously culls and promotes the same six checks

The proposal (PLAN-B v2 §4) is **right in its core judgement**: a pattern gold
contains must not be a `forReview` problem, "never reward a span for reducing
findings" is correct, and "default-allow + veto only" is the right shape for the
guard. Four defects in the logic as written.

**(a) The promotion condition is satisfiable by breaking the check.** The rule
is "promotion is per-check, only once the gold rate reaches 0". A regex that
matches nothing, anywhere, scores a perfect 0.0% on gold. MEASURED
(`npx tsx scripts/audit-probe/logic2/misc-probe.ts goldrate` +
`tier-probe.ts` §c): the discovery check's gold rate is **0/234 = 0.0%**, which
makes it Tier-1-eligible **today**, while it matches **0 of 3** of the defects it
exists to catch (F5). The same holds for "student called an alum" (0.0%),
`"both"` doubled (0.0%), "lowercase sentence start" (0.0%, and structurally
blind — F7) and "capital after a colon" (0.0%, lexeme-locked — F7). §4's own
prose knows this ("Zero firings means the regex is wrong") but the *condition*
does not encode it. **Fix: the promotion gate needs two halves — gold rate 0
*and* a committed positive-control set of true-positive strings the check must
still match, asserted in `draft-lint-calibration.ts`.** Without the second half
the ratchet turns the wrong way.

**(b) A check can sit in Tier 2 forever, and §5's own answer does not prevent
it.** §7.5 says the 0%-gold assertion is "what makes it a ratchet rather than a
graveyard". It isn't: nothing schedules a re-measure, nothing owns the
narrowing, and for the pleasantry arm the stated path to 0% is *to edit the
gold corpus* (R2c). The reference against which promotion is judged is an
editable artifact that the same plan proposes to edit, so "gold rate 0" can be
reached from either side — by narrowing the check or by deleting the 20
counterexamples. That is a movable benchmark, not a ratchet. **Fix: freeze a
calibration snapshot (`email-examples` at a named commit) as the promotion
reference, and require a check to carry an expiry — Tier 2 with no promotion and
no narrowing after N weeks is deleted, not renewed.**

**(c) §4 puts the same six checks in Tier 1 and in the cull list.** "Tier 1,
`forReview` (veto-eligible): spaced-hyphen dash, double space, space before
punctuation, lowercase sentence start, repeated word, capital after colon; plus
the comma-splice and discovery checks once narrowed" — and then "Delete from the
lint, move to `finishDraft` as auto-fixes (8): double space; space before
punctuation; repeated word; lowercase sentence start; capital after colon; dash
as punctuation; split 'to then'; 'also'+'too'." If both happen, **the veto set
is exactly {comma splice, discovery}** — the two checks whose false-positive
behaviour F2 and F5 measure. The plan should say which of the two it means; the
honest reading is that the veto set becomes empty until those two are narrowed,
and an empty veto set is a defensible outcome given §2.4's own "default-allow".

**(d) "A category absent from the original" is a sound veto only if every Tier-1
check has a zero false-positive rate on *revisions*, which is a different
population from gold.** Gold is finished human prose; a revision is a model
rewriting one sentence inside finished prose, and a rewrite that introduces an
introductory phrase trips F2's false positive. MEASURED (`tier-probe.ts` §b): the
veto fires with `made the writing worse: introduced comma splice` on a revision
whose only change is *"Having read the fund's latest letter, I came away with
one question…"*. The veto is also coarse by design — unlimited new instances of
a category the original already had pass — which is defensible, and is not what
I would change. What I would change: compute the veto on the **finished**
revision (F4), and require a Tier-1 check to have 0 false positives on a
committed set of *revision pairs*, not only on gold.

One more gap: §4 assigns no tier to four of the eight checks that actually fire
— **"common ground doubled with like you/me" (18 of 795, the third-largest
firer), "relays an opinion nobody typed" (12), "clauses strung together" (3),
"connector that isn't a cause" (3)** — and none to "long sentence" (1).
MEASURED gold rates: 0.0%, 5.1%, 1.3%, 0.4%, 0.0% of 234. On the proposal's own
rule, "invented opinion" at 5.1% belongs in Tier 2 and must leave the veto set;
it is currently in it.

---

### F7 (medium) — the dead 15, one verdict each, with the unreachability proved where I claim it

MEASURED (`npx tsx scripts/audit-probe/logic2/dead-probe.ts`; gold rates from
`misc-probe.ts goldrate`).

| check | verdict | evidence |
|---|---|---|
| **lowercase sentence start** | **unreachable except on the first sentence** | `sentencesOf` splits only on `(?<=[.!?])\s+(?=[A-Z“"])`, so a lowercase sentence start is never *produced* as a separate sentence. `"I am a sophomore at Duke. i would love 15 minutes…"` → one sentence, `[]`. `"i am a sophomore…"` → fires. The check can only see a body whose first line after the greeting is lowercase. |
| **capital after a colon** | **mis-specified** | the regex is `/\bquestions?: [A-Z]\w*/` — the lexeme `question(s)` is required. `"My two questions: Does…"` fires; `"One ask: Could we…"` and `"A quick note: The deck is attached."` do not, though the category is named "capital after a colon". |
| **class year in the signature** | **its zero is partly vacuous** | 0 of 234 gold bodies contain `(Class of NNNN)` at all, **and** `draft-lint-corpus.ts`'s `minimal()` passes `studentGradYear: null`, which switches the check off: same body, `studentGradYear: null` → `[]`, `2029` → fires. So for 234 of the 795 the check could not fire whatever the text said. |
| **says how the student found them** | **unreachable from `forReview`** | `draftChecks` calls `fluencyIssues(text, null)`; all three ctx-gated checks need `ctx !== null`. Probe: with ctx → `["says how the student found them…","the student's background dropped out"]`; through `draftChecks` → `[]`. |
| **asks a recruiter for a call** | **unreachable from `forReview`** | same. |
| **the student's background dropped out** | **unreachable from `forReview`** | same. Three of the 26 `FINDING_KINDS` categories are therefore dead in production *and* in the guard's veto set. (They are live in `draft-occasions-sim.ts`, which passes a real ctx — so delete them from `draftChecks`' reachable set, not from `fluencyIssues`.) |
| discovery-as-announcement · student called an alum · `"both"` doubled | **mis-specified** | F5. |
| too many "Thank you" openers | **rare but right, and calibrated one off the ceiling** | gold distribution of `^Thank you` sentence openers: 0→16, 1→139, 2→75, **3→4**; max is 3 and the threshold is >3. Fires on a constructed 4. Keep, and know that 4 gold bodies sit exactly at the line. |
| congratulations after the ask | **reachable, rare, and now FP-prone** | fires on a constructed input; also fires with no ask present at all once `let me know` matches (F3). |
| common ground tacked onto a paragraph | **rare but right** | fires on two constructed paragraphs; overlaps "common ground doubled" on the `like me` form (one input produced both findings). |
| `"also"` and `"too"` in one sentence · split `"to then"` · double space · space before punctuation · repeated word | **rare but right; all deterministic** | each fires on a constructed input; all 0.0% of gold. These are the five that genuinely belong in `finishDraft` as auto-fixes. |
| dash used as punctuation | **rare but right, with a small gap** | `/[A-Za-z,.!?] - [A-Za-z]/` requires a letter or sentence punctuation before the hyphen: MEASURED, `"No reply needed - thank you again."` and `"Tuesday - Thursday"` fire, `"My number is (555) 010-1234 - please excuse the typos."` returns `[]` (digit before the hyphen). It fires at 0 on 795 mainly because `finishDraft` converts the dashes the model actually writes before the check runs. |

---

### F8 (medium) — `FILLER` is incoherent as a concept: it rejects the playbook's phrasing and is blind to the commoner variant

MEASURED (`misc-probe.ts filler` / `filler192`), gold:

| arm | per-type (192) | all gold (234) |
|---|---|---|
| `I (just )?wanted to (reach out\|follow up\|say\|touch base)` | 12 | 15 |
| `I hope this (email\|message\|note) finds you well` | **20** | 20 |
| `made all the difference\|exactly what I needed\|even more excited` | 1 | 1 |

Variants the rule does **not** match, in the same gold corpus:
`I hope you are doing well` → **26 bodies**, `I hope (you are|you're) (doing)
well` → **32**, `I hope all is well` → **3**. So the one pleasantry the playbook
writes most often is unflagged while a rarer sibling is a `forReview` problem,
and 23 of the 51 failing gold bodies fail on nothing else.

**Fix.** PLAN-B's answer (demote the pleasantry arm to Tier 2 now, fix the
examples, promote with a 0%-gold assertion) is the right shape, with F6(a)'s
positive control attached. Separately: if the concept is "a stock opener that
says nothing", the rule must cover `I hope you are doing well` too, or it is
measuring which phrasing the author of the regex happened to think of.

---

### F9 (medium) — the invented-opinion gate is wrong in both directions

**The flaw.** `draftChecks` disables the check if **any** of
`said|thought|told|mentioned|recommended` appears anywhere in
`brief + purpose + extraContext`; otherwise it flags
`(?:she|he|they|Name) (thought|said|mentioned|felt|believes?) you('d|would|were|are|might|could)`.

**MEASURED** (`misc-probe.ts opinion`), body = *"Emily thought you would be the
right person to talk to about the group."*:

| what the student typed | finding |
|---|---|
| `"Emily suggested I reach out to you."` | flagged as an invented opinion |
| `"Emily referred me to you."` | flagged |
| `"Emily put me in touch."` | flagged |
| `"Emily pointed me your way."` | flagged |
| `"Emily said you would be a good person to talk to."` | not flagged |
| `"Emily mentioned you."` | not flagged |

So a real referral typed in the app's own vocabulary (`suggested`, `referred`,
`put me in touch`, `pointed me your way` — the exact phrasings
`first.referred` / `first.pointed` and PLAN-B R11's own specimen *"Emily Tran
suggested I reach out to you."* use) is reported to the reviewer as fabrication,
while one stray `mentioned` anywhere in any field switches the check off for the
whole email. Its 12 gold firings (5.1%) are likewise an artifact: the corpus
harness passes empty typed fields, so the gate is open for all 234, and one of
the 12 is the playbook's own *"Devin thought you would be the right person to
talk to…"* (`v5#19`).

**Fix.** Widen the gate verb list to the referral family
(`suggested|referred|pointed|introduced|connected|put me in touch|encouraged|advised|offered`)
and, better, gate per *person*: only suppress the finding for the name the
student's text attributes a statement to. Then re-measure the gold rate with a
realistic input rather than `{}`.

---

### F10 (low) — `resumeLooksLikeSomeoneElses` flags firm names and application words as a stranger's name

MEASURED (`misc-probe.ts resume`), student "Alex Rivera":

| filename | verdict |
|---|---|
| `Resume - Goldman Sachs Analyst.pdf` | **someone else's** (false positive) |
| `Morgan Stanley Resume.pdf` | **someone else's** (false positive) |
| `Resume Summer Analyst Application.pdf` | **someone else's** (false positive) |
| `My Resume (Spring Recruiting).pdf` | **someone else's** (false positive) |
| `Aidan Resume.pdf` | mine (false negative — one name-like word is below the ≥2 threshold) |
| `Aidan Matus-Enochs - Resume 1.docx` | someone else's (correct) |
| `Priya Ravenel CV.docx` | someone else's (correct) |
| `Alex Rivera Resume.pdf` / `Clauson Resume.pdf` / `kai_clauson_resume.pdf` / `Resume.pdf` / `Resume Jan 2026.pdf` | mine (correct) |

Any two capitalised words outside the 17-word `RESUME_WORDS` list read as a
name. Firm names, role words and "My … (Spring Recruiting)" are all common in
real filenames, and the consequence is a wrong accusation on the profile page
and in the draft request path.

**Fix.** Require the two capitalised words to be *adjacent* and not separated by
a reserved word, exclude a firm-name list (the app already has firms and sectors
in the database) and the recruiting vocabulary (`analyst|associate|intern|
summer|spring|fall|winter|application|program|sophomore|junior|senior|
my|final|v\d`), and treat a single name-like word adjacent to the student's own
surname as a match rather than requiring two.

---

### F11 (low) — `formatPhone` reformats things that are not US numbers

MEASURED (`misc-probe.ts phone`): `"0208315532"` → `"(020) 831-5532"`,
`"1234567890"` → `"(123) 456-7890"`, `"000-000-0000"` → `"(000) 000-0000"`,
`"11111111111"` → `"(111) 111-1111"`. Ten digits is the only test; NANP forbids
`0` or `1` as the first digit of an area code or an exchange. Correct behaviour
on everything else I tried: `15550101234`, `555.010.1234`, `+1 (555) 010-1234`
→ `(555) 010-1234`; `+44 20 7946 0958`, `+33 1 42 68 53 00`, `911`,
`555-010-1234 x12`, `1-800-FLOWERS`, `555.010.1234 (mobile)` all returned as
typed. **Fix:** one extra condition — `/^[2-9]\d\d[2-9]\d{6}$/` on `ten`, else
return as typed.

---

### F12 (low) — the sentence splitter breaks on abbreviations, and the sign-off finder knows one closing

MEASURED (`npx tsx scripts/audit-probe/logic2/splitter-probe.ts`):
`"I am free Tuesday at 9:00 a.m. Eastern time, I will send a calendar invite."`
splits into `["I am free Tuesday at 9:00 a.m.","Eastern time, I will send a
calendar invite."]`, so the prefix before the comma is 2 words, under the
3-word floor, and the splice is missed. `"Dr. Alvarez said you would be…"`
splits after `Dr.`, which also removes the first word of the real sentence from
every word-count check. Gold is full of `a.m./p.m.` times, so this is live, not
hypothetical.

`draftChecks` finds the sign-off with `lastIndexOf("Best,")` only. I could not
make a finding out of a `Sincerely,`-ended body (`Best regards,`, `Sincerely,`,
`Thank you,` all returned `[]` on the signature I tried), so this is a latent
asymmetry rather than a demonstrated defect: in the pipeline `preReview` has
been through `finishDraft` (always `Best,`) while the guard lints the reviewer's
raw `out.body`, where nothing guarantees it. **Fix:** share one
closing-detection helper with `finishDraft`'s `CLOSING` regex, and add
`a\.m\.|p\.m\.|Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.|Inc\.|e\.g\.|i\.e\.|St\.|No\.` to a
negative lookbehind in `sentencesOf`.

---

## Cleared

What I probed and found sound, so it does not need looking at again:

- **`ASK`'s abstention on offers and sentiments.** The three shapes the docstring
  names are genuinely not matched, and that is load-bearing for precision:
  `"I would love to stay in touch"` (`decline_offer#1`), `"I am happy to send
  anything else that would be useful"` (`thank_you_offered_help#1`), `"please do
  not hesitate to reach out"` (`thank_you_interview#1`, `thank_you_superday#1`).
  The requirement that the softened families carry a request object is doing
  exactly the work the comment claims. MEASURED, `ask-probe.ts sample`/`print`.
- **The 40-body sample's labels.** I read all 10 "no ask" bodies and all 3 false
  negatives in full and agree with every label (one borderline:
  `not_now_reply#1`). The 90%/100% figure is honestly computed *on that sample*;
  my objection is to its generalisation, not to its arithmetic.
- **`commaSplices`' two deliberate floors.** `before < 3 words` and
  `lastSegment ≤ 3 words` do what the comment says: `"I grew up outside Atlanta
  and, like you, I am a long way from home."` is not flagged. The short-aside
  exclusion is sound; it is the two word lists that are not.
- **The guard's "lint is a veto, never a score" decision** (`draft-review.ts`
  530–548). Replacing `after.length > before.length` with a category-difference
  test is right, the reasoning in the comment is right, and "an empty lint is
  never a reason to reject" is right. My objections are to *which* categories it
  vetoes on and *which text* it reads, not to the shape.
- **PLAN-B §4's central judgements**: a pattern gold contains must not be a
  `forReview` problem; the discovery widening's `you are also` discriminator
  (MEASURED: its §4(d) regex catches the probe string and still excludes the
  "I saw the announcement that you…" true negative); "never auto-fix a canned line";
  "a never-firing check costs maintenance and false confidence, not reviewer
  attention"; Tier-2 categories must stay out of the veto set.
- **`formatPhone` on everything except an invalid 10-digit string** (F11 list).
- **`DETAIL_COMMON` being generated rather than hand-written**, with a test that
  fails on drift — the right pattern, and the one the word lists in F1/F2 should
  copy.
- **`draft-lint-corpus.ts` as an instrument**: its numbers reproduce exactly, and
  its own limits section is honest. The one caveat is F7's `minimal()` input,
  which silently disables one check over 234 bodies.
- **The per-sentence structure of `fluencyIssues`** (long sentence, `, and`
  chains, `also`+`too`): no false positive found on gold — 0.0%, 1.3% and 0.0%
  of 234 respectively, and the 3 `, and` firings I read are real chains.

## What I did not cover

`draft-stream.ts`, `scripts/draft-stream-test.ts`, `src/app/api/drafts/`,
`useDraftStream.ts` and `draft-request.ts` were in flight and not read. Anything
needing a model call (the rig's `lintForReview` 0-before-and-after result, R11's
contagion measurement) is carried as ASSERTED-ELSEWHERE. `DETAIL_COMMON`'s
regeneration and `detailSurvived` were out of scope.

---

## Prioritised improvements

| # | Change | Why now | Cost |
|---|---|---|---|
| 1 | **Delete the `privateTopicsIn` clause at `draft-review.ts:511`** | one word in a typed detail currently removes the guard's protection of it (F1); the reviewer's own `private` problem kind already expresses the real exemption | 1 line |
| 2 | **Guard the finished revision: `guardRevision(preReview, finishDraft(promptInput, out), …)`** | the veto currently judges a string the student never sees, and the em-dash rewrite introduces the very category it vetoes on (F4) | 1 line |
| 3 | **Take `comma splice` out of the veto set until it is narrowed** | 10/10 constructed introductory phrases and 4 of its 5 gold hits are false positives, and each one discards the reviewer's entire edit (F2) | 1 line + a test |
| 4 | **Split `ASK` into `ASK_REQUEST` (guard) and `ASK_ANY` (diagnostics); subtract the offer forms from the first** | the guard vetoes removing exactly the canned line the plan wants removed, and the ordering check fires on emails with no ask (F3) | half a day |
| 5 | **Add the positive-control half to the promotion gate in `draft-lint-calibration.ts`** | without it, "gold rate 0" promotes a regex that matches nothing; three such checks qualify today (F6a) | half a day |
| 6 | **Replace `INTRODUCTORY`/`SUBORDINATE` with a finite-verb test, and widen `SPLICE_START` to `it/that/there/you` and determiner-headed subjects** | 27.5% of gold's comma-bearing sentences are currently suppressed outright, and the commonest second clause (`it …`) is invisible (F2) | 1–2 days |
| 7 | **Fix the three mis-specified regexes (F5), discovery per PLAN-B §4(d)** | the alum check misses the one phrase the rest of the pipeline is built around | half a day |
| 8 | **Widen the invented-opinion gate to the referral verb family and gate per person (F9)** | the check currently calls a real referral a fabrication in the app's own vocabulary | half a day |
| 9 | **Resolve §4's Tier-1/cull contradiction and assign the five unassigned live checks (F6c, F6d)** | as written, the veto set after R6′ is exactly the two checks with the worst false-positive rates | document edit |
| 10 | **Move the five deterministic mechanics into `finishDraft`; delete `lowercase sentence start` and the three ctx-only categories from `draftChecks`' reachable set; re-point `capital after a colon` at any colon (F7)** | one is structurally blind, three are dead code in production, one is lexeme-locked | half a day |
| 11 | **Either widen `FILLER`'s pleasantry arm to `I hope you are doing well` or demote the whole arm (F8)** | 26 gold bodies use the unflagged variant; 23 of 51 gold failures are filler-only | 1 line either way |
| 12 | **`formatPhone` NANP validity; `resumeLooksLikeSomeoneElses` firm/role exclusions (F10, F11)** | user-visible noise, low blast radius | 2 hours |
| 13 | **`sentencesOf` abbreviation lookbehind; share one closing regex with `finishDraft` (F12)** | silently changes every word-count and prefix test on any email with a time in it | 2 hours |

## Reproducing everything here

```bash
cd .claude/worktrees/draft-pipeline-perf
npx tsx scripts/draft-lint-corpus.ts --json            # the 795-body baseline
npx tsx scripts/audit-probe/logic2/ask-probe.ts sample      # 27/0/3 → 90.0% / 100%
npx tsx scripts/audit-probe/logic2/ask-probe.ts heldout     # 10 of 31 held-out no-ask bodies fire
npx tsx scripts/audit-probe/logic2/ask-probe.ts corpus      # per-alternative attribution
npx tsx scripts/audit-probe/logic2/ask-probe.ts letmeknow   # all 37 "let me know" sentences
npx tsx scripts/audit-probe/logic2/ask-probe.ts offeronly   # 19 offer-only bodies
npx tsx scripts/audit-probe/logic2/ask-probe.ts ordering    # the ordering FP and FN
npx tsx scripts/audit-probe/logic2/splice-probe.ts          # 10 FPs, 10 FNs, exclusion reach
npx tsx scripts/audit-probe/logic2/dead-probe.ts            # the dead 15, with the proofs
npx tsx scripts/audit-probe/logic2/tier-probe.ts            # gold splices, the FP veto, the gate
npx tsx scripts/audit-probe/logic2/interaction-probe.ts     # finishDraft + guard ordering
npx tsx scripts/audit-probe/logic2/private-guard-probe.ts   # the one-word guard bypass
npx tsx scripts/audit-probe/logic2/splitter-probe.ts        # abbreviations and the sign-off
npx tsx scripts/audit-probe/logic2/misc-probe.ts misspec|filler|filler192|phone|resume|private|goldrate|opinion
```
