# LOGIC-1 — correctness audit of `guardRevision`

Scope: `src/lib/draft-review.ts` at commit `0053b1a` — `guardRevision` and its
helpers (`detailSurvived`/`detailScore`, `findingCategory`,
`wordsRemovedOnInstruction`, `schoolCanonical`/`schoolKey`, `bodyAboveSignOff`,
`loose`, `GROWTH_CEILING`/`SHRINK_FLOOR`, the `note` path). Read-only on `src/`
and on existing `scripts/`.

Every claim below is labelled **MEASURED** (with the command that produced the
quoted output) or **REASONED** (read off the code, not run). Probes live in
`scripts/audit-probe/logic1/`. The existing suite is green at this commit —
`npx tsx scripts/draft-review-test.ts` → **104/104 passed** (MEASURED) — so none
of what follows is caught by it.

The rule order, as written (REASONED, from `src/lib/draft-review.ts:452-567`):

```
0  normalise: body above the LAST line that trims to exactly "Best,"      (:251)
1  greeting (first line) changed                                          (:464)
2  the multiset of [placeholders] changed                                 (:467)
3  a number not in `knownNumbers`                                         (:469)
4  a capitalised non-sentence-initial word not a SUBSTRING of `known`     (:482)
     (<=1 admitted with a note iff hasResumePdf && !studentResumeSummary) (:504)
5  a typed detail that survived the draft does not survive the edit       (:518)
     exempt: the detail names a private topic, OR a reported
     private/hateful problem's quote scores >=0.4 against it              (:516)
6  ASK present before, absent after                                       (:522)
7  shared-school phrasing present before, absent after                    (:531)
8  a lint CATEGORY present after but not before                           (:548)
9  growth ceiling   after > before * 1.2                                  (:551)
10 shrink floor     after < (before - creditedRemoval) * 0.6              (:554)
11 subject: kept unless a spelling/wrong_person problem quotes it         (:560)
```

---

## S1 — CRITICAL. The typed-detail exemption trusts a quote it never verifies

**Flaw.** Rule 5's second escape hatch (`draft-review.ts:516`) is

```ts
if (problems.some((p) => (p.kind === "private" || p.kind === "hateful") && detailScore(detail, p.quote).score >= 0.4)) continue;
```

It checks only that the reviewer's self-asserted `kind` is `private`/`hateful`
and that the quote *resembles the detail*. It does not check that the quote was
ever in the draft, that it is gone from the edit, or that it mentions a private
topic at all. Contrast rule 10's credit, which does check presence and absence
(`:297`). So the cheapest way for the reviewer to delete anything the student
typed is to echo it back as a `private` quote.

**Failing input (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe1-deletion-credit.ts
```

```
1e  the typed detail is deleted from the body
  no report
    -> REJECTED: dropped something the student typed: "his advice about staffing on live deals and how he moved fro…"
  reported kind:"private", quote = the detail itself (never in the draft, never removed)
    -> ACCEPTED
```

The typed detail is `conversationDetails: "his advice about staffing on live
deals and how he moved from audit to restructuring"`. The edit removes it from
the body entirely and replaces it with generic filler. The quote supplied is a
verbatim copy of the typed detail — a string that appears nowhere in the draft
body in that form, and which the edit obviously did not "remove".

**Consequence for a student's email.** The one thing the student actually typed —
what they talked about with this person — is silently deleted, and the email
they send says nothing specific. If the problem carries `needsStudent: false`,
the student is told nothing: `studentNotesFromReview` filters on `needsStudent`
(`draft-review.ts:570`) and the pipeline adds only those notes
(`draft-pipeline.ts:343-345`) (REASONED). `draftChecks(...).forStudent` would
not catch it either, because nothing private is left in the final body.

**Fix.** Require the quote to be real and gone, exactly as rule 10 already does,
and require the quote itself to look private:

```ts
const removedPrivately = (p: ReviewProblem) =>
  (p.kind === "private" || p.kind === "hateful") &&
  p.quote.trim() &&
  loose(original.body).includes(loose(p.quote)) &&
  !loose(revised.body).includes(loose(p.quote));
```

and gate the exemption on `removedPrivately(p) && detailScore(detail, p.quote).score >= 0.4`.
Prefer additionally `privateTopicsIn(p.quote).length > 0 || p.kind === "hateful" ...`
— see S2 for why the bare `kind` is not evidence.

---

## S2 — CRITICAL. The deletion credit is unauthenticated, and double-counts

Three separate defects in `wordsRemovedOnInstruction` (`:288-305`).

**(a) `kind` is self-asserted and never corroborated.** `privateTopicsIn` exists
and is used for the *other* exemption at `:514`, but the credit at `:294` keys
only on the string `"private"`. So the reviewer can label any sentence it wants
to cut as private and have its words removed from the shrink denominator.

**(b) A trivial mislabelled quote buys a deletion elsewhere.** The credit is the
whole *carrier sentence*, so a two-word quote inside a 46-word sentence credits
46 words — and those 46 words of slack then pay for words cut somewhere the
reviewer was never told to touch.

**(c) `extra` sums overlapping quotes without deduplication** (`:300`). A quote
that straddles a sentence boundary belongs to no carrier, so its own word count
is added; nothing stops several overlapping straddling quotes from each adding
their words, and nothing caps the total at `before`. Once
`onInstruction > before`, `(before - onInstruction) * 0.6` is negative and the
floor can never fire for any `after`.

**Failing inputs (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe1-deletion-credit.ts
```

```
body above sign-off: 124 words; private topics in it: []

1b  SAME deletion, the two sentences reported as kind:"private" (they contain no private topic)
    -> ACCEPTED

1c  124 -> 73 words. The 46-word sentence goes (carries the quote) AND 18 further words elsewhere.
  no report
    -> REJECTED: cut from 124 to 73 words
  one 2-word quote, kind:"private" -> "real money"
    -> ACCEPTED
      ("real money" private topics: [])

1d  38 -> 10 words, with 3 OVERLAPPING straddling quotes (no single sentence contains any of them)
  no report
    -> REJECTED: cut from 38 to 10 words
  3 overlapping straddling quotes
    -> ACCEPTED

1f  38 -> 5 words, 4 overlapping straddling quotes (credit sums past the whole body)
  no report
    -> REJECTED: cut from 38 to 5 words
  4 overlapping straddling quotes
    -> ACCEPTED
```

1d/1f: 38 words down to 10, and then to 5, on a body with **no private topic in
it anywhere** — i.e. the floor, the one rule that exists to stop the reviewer
gutting an email, is switched off by four fabricated problem records.

**Consequence for a student's email.** The student sends a near-empty email,
or an email with two-thirds of what they wrote removed, and the guard reports
nothing wrong. The D19 trade — "the floor is not raised and not removed … what
changes is the denominator" — does not hold as built: the denominator is
attacker-controlled.

**Fix.**
1. Corroborate the label: credit a `private` quote only when
   `privateTopicsIn(p.quote).length > 0`, and a `hateful` quote only when
   `findBlockedLanguage` (per the project's content-limits rule) fires on it.
   The reviewer's prompt already quotes the rule it is applying, so this costs
   it nothing when it is honest.
2. Count credited words as a set of character spans, or at minimum
   `Math.min(extra + credited, before)`, so overlapping quotes cannot double.
3. Cap the total credit at some fraction of the body (e.g. 0.5 · `before`): a
   private detail is a sentence, not an email. Above that, reject and surface it
   to the student instead, which is what `needsStudent` is for.

---

## S3 — HIGH. Three more instances of the M12 shape: rules 6, 7 and 8 pre-empt the rule-10 allowance

**Flaw.** D19's deletion credit was added at rule 10 only. The *same* removal —
the reviewer dropping the sentence that carried a private detail, which is what
rules 3/3b of `REVIEW_SYSTEM` tell it to do — is rejected by rule 6 when that
sentence also carried the ask, by rule 7 when it also carried the shared-school
line, and by rule 8 when the cut leaves a lint-visible seam. Each of these runs
*before* the credit and knows nothing about it. This is exactly the M12 shape:
an earlier rule firing on an edit a later rule was taught to allow.

**Failing inputs (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe2-ordering.ts
```

```
2a  the private detail and the ask share one sentence (private topics: ["divorce"])
    the reviewer does what rule 3 of its prompt says and removes the sentence:
    -> REJECTED: dropped the ask

2b  the private detail and the shared school share one sentence (private topics: ["cancer","diagnosis"])
    -> REJECTED: dropped the shared school

2c  the private sentence is cut from the middle of a paragraph, leaving the join as a double space
    lint categories before: []
    lint categories after:  ["double space"]
    -> REJECTED: made the writing worse: introduced double space
```

2a's body: *"I would love to hear how you kept recruiting on track through your
divorce, if you have 15 minutes."* — the private detail and the ask are one
sentence, which is how a student types it.

**Consequence for a student's email.** The edit is thrown away, so the draft is
kept as it was (`draft-pipeline.ts:336-340`) — and the draft is the one with
`divorce`, `cancer diagnosis`, `rehab` in it. The student is warned by
`draftChecks(...).forStudent` (the `privateTopicsIn` note), but the words are
still in the body they are about to send. This is the identical failure mode
D19 was opened to close, reached by three other routes.

2c is additionally a **false positive that costs a model call**: the only thing
wrong with the edit is a stray double space the guard could trivially tolerate
or normalise.

**Fix.** Compute the credited removal **once, before rule 6**, and let the three
rules consult it:
- rule 6: skip when the ASK match in the original sits inside a credited span
  (the correct behaviour is to accept and attach a `needsStudent` note telling
  the student the ask needs rewriting, not to keep the private detail).
- rule 7: same test against the shared-school match.
- rule 8: exempt the purely mechanical categories (`double space`,
  `space before punctuation`, `lowercase sentence start`) when a credited span
  was removed — or normalise whitespace in `revised.body` before linting, which
  is strictly better and fixes 2c with no exemption at all.

---

## S4 — HIGH. `detailSurvived`'s stemmer is not idempotent, so a plural does not match its own singular

**Flaw.** `stem` (`:343`) strips one suffix from `SUFFIXES` and stops. For a word
whose singular *itself* ends in a strippable suffix with ≥4 letters left — the
`-er` and `-ing` families — `stem(X + "s") = X` but `stem(X) ≠ X`. So
`stem("partners") = "partner"` while `stem("partner") = "partn"`, and the two
never meet in `bodyStems`; `bodyExact` does not save it either. The anchor clause
then reports the word as lost and the whole edit is rejected.

**Failing inputs (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe4-detail-survived.ts
```

```
4b  plural-in-detail vs singular-in-body (same word, same meaning)
  detail "bankers" vs body "banker": LOST   | detail "banker" vs body "bankers": LOST
  detail "managers" vs body "manager": LOST   | detail "manager" vs body "managers": LOST
  detail "mergers" vs body "merger": LOST   | detail "merger" vs body "mergers": LOST
  detail "traders" vs body "trader": LOST   | detail "trader" vs body "traders": LOST
  detail "meetings" vs body "meeting": LOST  | detail "meeting" vs body "meetings": LOST
  detail "briefings" vs body "briefing": LOST | detail "briefing" vs body "briefings": LOST
  detail "earnings" vs body "earning": LOST  | detail "earning" vs body "earnings": LOST
  detail "quarters" vs body "quarter": LOST  | detail "quarter" vs body "quarters": LOST
  detail "partners" vs body "partner": LOST  | detail "partner" vs body "partners": LOST
  detail "semesters" vs body "semester": LOST | detail "semester" vs body "semesters": LOST
  detail "applications" vs body "application": survives | ...
  BROKEN PAIRS: 10/14 -> bankers/banker, managers/manager, mergers/merger, traders/trader,
    meetings/meeting, briefings/briefing, earnings/earning, quarters/quarter,
    partners/partner, semesters/semester
```

Reachability on the real corpus (MEASURED, same command):

```
4e  reachability on the real corpus (192 bodies)
  bodies containing at least one word whose singular/plural pair does NOT match: 32/192 (16.7%)
  the pairs, most common first:
    partners/partner           12 bodies
    earnings/earning            7 bodies
    mornings/morning            3 bodies
    considers/consider          2 bodies
    postings/posting            2 bodies
    ... semesters/semester, recruiters/recruiter, speakers/speaker, careers/career, ...
```

The 16.7% is the share of bodies that *use* such a word; the false reject needs
the typed detail and the body to disagree in number on it, which is a narrower
conjunction I did not measure.

**Consequence for a student's email.** A perfectly good edit is thrown away
because the student typed "the partners on the desk" and the reviewer wrote "a
partner on the desk". Per D23 that is one of the rejections that fires a third
model call on 40% of drafts — so this is a latency cost as well as an accuracy
one.

**Fix.** Make `stem` a fixed point: loop until no suffix applies, or strip a
trailing `s`/`es` *first* and then run the suffix pass. One line:

```ts
function stem(word: string): string {
  let w = word.toLowerCase();
  for (let i = 0; i < 3; i++) {
    const next = stemOnce(w);
    if (next === w) break;
    w = next;
  }
  return w;
}
```

Guard the ≥4-letter floor on each pass, and regenerate the fixture rows in
`scripts/draft-review-test.ts` so the change is pinned.

---

## S5 — MEDIUM. The subject gate opens on a one-character quote

**Flaw.** `subjectFix` (`:560`) is satisfied by *any* `spelling`/`wrong_person`
problem whose trimmed quote is a substring of the original subject — including a
single letter. The second condition, `subjectWords.every((w) => known.includes(w))`,
only restrains vocabulary, not meaning (and is itself the substring test of S9).

**Failing input (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe7-misc.ts
```

```
7a  the subject rewrite gate
  no problem reported, new subject
    -> ACCEPTED                              (subject correctly kept)
  spelling problem quoting "e" (any substring of the old subject opens the gate)
    -> ACCEPTED
    -> subject returned: {"ok":true,"subject":"Sophomore studying finance at Penn"}
```

Original subject: `"Referred by Jeff Moreno"`. One problem record,
`{kind:"spelling", quote:"e"}`, replaces it wholesale.

**Consequence for a student's email.** On a referral email the referrer's name in
the subject line is the reason it gets opened. It is replaced by a generic line,
with no note to the student.

**Fix.** Require the quote to be a word, not a character — e.g.
`/^[\w'’.-]{2,}(\s+[\w'’.-]+)*$/` and `>= 3` characters — and require the
*other* words of the subject to be unchanged: accept the new subject only when
it differs from the original by edits confined to the quoted span.

---

## S6 — MEDIUM. Rule 0 looks for the literal string `"Best,"`, so a reworded sign-off makes the guard judge the signature

**Flaw.** `bodyAboveSignOff` (`:249-253`) finds the last line that trims to
exactly `"Best,"`. The reviewer is not told this string is load-bearing, and the
comment at `:452` explains the signature must *not* be judged because it is
rebuilt from the profile afterwards. Reword the sign-off and the exclusion stops
working on the revised side only, so the signature's words and digits become new
facts.

**Failing input (MEASURED).**

```
npx tsx scripts/audit-probe/logic1/probe2-ordering.ts
```

```
2d  the reviewer rewrites the sign-off word ("Best," -> "Best regards,"). The signature is rebuilt
    from the profile afterwards regardless, so nothing in it should be judged - but rule 0 no longer finds it.
    -> REJECTED: added the number "29"
```

The `29` is from `University of Pennsylvania ’29` in the signature — a string the
pipeline writes itself and overwrites regardless.

**Consequence.** A good edit is discarded for a change that is thrown away
anyway, and the rejection reason is nonsense to a reader. Another avoidable
retry.

**Fix.** Match the sign-off by shape, not by literal: the last line matching
`/^(best|best regards|thanks|thank you|sincerely|warmly|all the best|regards)[,.]?$/i`,
and fall back to the *original's* sign-off index when the revised body has none.

---

## S7 — MEDIUM. The category veto cannot see worsening within a category

**Flaw.** D19 replaced the count comparison with a category veto, and the
comment at `:538-546` says so deliberately: "More of a kind the draft already
had is not a fabrication and not the guard's business." That is a defensible
line, but it is worth knowing exactly what it gives up, because the question the
brief asks — can a reviewer swap one defect for another within a category? — is
yes, including a strict worsening.

**Failing inputs (MEASURED), with word count held so the length rules do not interfere.**

```
npx tsx scripts/audit-probe/logic1/probe5-category-veto.ts
```

```
5a  filler phrase A -> filler phrase B (same category, length held)
  before findings: ["filler phrase: \"I wanted to reach out\""]
  after  findings: ["filler phrase: \"I hope this email finds you well\""]
    -> ACCEPTED

5b  one comma splice -> three comma splices, length held
  before findings: ["comma splice before \"we had\""]
  after  findings: ["comma splice before \"we had\"","comma splice before \"I learned\"","comma splice before \"they answered\""]
    -> ACCEPTED

5c  52-word sentence -> 69-word sentence, paragraph length held
  before findings: ["long sentence (52 words): ..."]
  after  findings: ["long sentence (70 words): ..."]
    -> ACCEPTED

5d  CONTROL: dash as punctuation -> double space (different categories)
    -> REJECTED: made the writing worse: introduced double space
```

5b is the sharpest: one comma splice becomes three and the veto sees no change.
5c lets a 52-word sentence grow to 70.

A second limit on the veto's reach, same command (MEASURED):

```
5e  categories the veto actually observes across all 192 corpus bodies: 6
  clauses strung together, comma splice, connector that isn't a cause, filler phrase,
  invented opinion, thank-you joined with and
  never observed (20 of 26): long sentence, also and too, split to then, ... background dropped out, ...
```

Three of the unobserved categories (`how the student found them`,
`call asked of a recruiter`, `background dropped out`) are **structurally**
unreachable from the veto, because `draftChecks` calls `fluencyIssues(text, null)`
(`draft-lint.ts:303`) and those checks sit behind `if (!ctx) return issues`
(`draft-lint.ts:138`) (REASONED; `draft-lint.ts` is LOGIC-2's scope and their
`scripts/audit-probe/logic2/dead-probe.ts` probes the same thing).

**Consequence for a student's email.** The review pass may hand back writing
that is measurably worse on the one axis `draftChecks` can see, and the guard
calls it an improvement. In practice the harm is bounded — `forReview` is empty
for most drafts — but 5b is a real regression path.

**Fix (cheap and local).** Keep the veto, and add a per-category count ratchet
with a tolerance of one: reject when
`after.filter(c).length > before.filter(c).length` for any category where the
before-count is non-zero. That catches 5b without reintroducing the
total-count comparison D19 correctly deleted. 5c needs the finding's own
severity (word count) compared, which is a `draft-lint` change, not a guard one.

---

## S8 — MEDIUM. 1.2 / 0.6 permits twice as much deletion as addition, at every length, and the reviewer's job needs addition

**Measured body lengths of the real corpus** (`npx tsx scripts/audit-probe/logic1/probe6-asymmetry.ts`),
which confirm the figures in the brief:

```
6a  body-above-sign-off word counts over 192 corpus bodies
    min 53  p10 75  p25 88  median 109  p75 132  p90 157  max 198
```

**What the multipliers permit (MEASURED, same command):**

```
    before | max after | +words | min after | -words | ratio del:add
        75 |        90 |    +15 |        45 |    -30 | 2.00:1
       109 |       130 |    +21 |        66 |    -43 | 2.05:1
       198 |       237 |    +39 |       119 |    -79 | 2.03:1
```

Verified against `guardRevision` itself, not just arithmetic (MEASURED, same command):

```
6c  verified against guardRevision
    75 -> 90 words   -> ACCEPTED
    75 -> 91 words   -> REJECTED: grew from 75 to 91 words
    75 -> 45 words   -> ACCEPTED
    75 -> 44 words   -> REJECTED: cut from 75 to 44 words
    198 -> 237 words -> ACCEPTED
    198 -> 238 words -> REJECTED: grew from 198 to 238 words
    198 -> 119 words -> ACCEPTED
    198 -> 118 words -> REJECTED: cut from 198 to 118 words
```

**Flaw.** At p10 (75 words) the reviewer may delete 30 words — 40% of the email
— with no instruction, no report and no note, but may add only 15. Deletion is
the dangerous direction (it is how a typed fact, an ask or a reason goes
missing) and it has both the looser bound *and* a credit mechanism (S2) that
loosens it further. Addition is the direction the reviewer is explicitly told to
work in — rules 3/3b replace a private detail, and the M10 rationale is that it
is "told to work a typed detail back in" — and it gets the tighter bound and no
credit at all.

**Failing input for the addition side (MEASURED, same command):**

```
6d  growth has no instruction credit, unlike shrink
    61 -> 91 words, restoring a typed detail the draft had dropped
    -> REJECTED: grew from 61 to 91 words
```

**Consequence for a student's email.** On a short draft the reviewer cannot put
back a detail the drafter dropped, which is the single most valuable thing the
review pass does for a student who typed a long `conversationDetails`.

**Fix.** Make the growth ceiling additive-plus-multiplicative, so short bodies
get real headroom: `after > Math.max(before * 1.2, before + 30)`. And give
growth the symmetric instruction credit — words added inside a span that
restores a `typedDetails` entry the draft had lost (`detailSurvived(detail,
original.body) === false && detailSurvived(detail, revised.body) === true`)
should come out of the growth numerator. Do **not** loosen the floor; S2 is the
reason it needs tightening, not loosening.

---

## S9 — LOW. The substring hole is real but narrow, and is a *short-token* hole

**Flaw (known going in).** `known.includes(word.toLowerCase())` at `:482`.

**Quantified (MEASURED).** `npx tsx scripts/audit-probe/logic1/probe3-substring.ts`
inserts each of 129 plausible invented proper nouns (30 firms, 32 people, 16
places, 19 months/weekdays, 16 schools, 16 clubs) mid-sentence into a real body
and asks whether the guard admits it. Trials where the word is already a *whole
word* in `known` are excluded, so every pass below is the substring test alone.

```
A  short draft, sparse facts  (|known| = 683 chars)
  OVERALL: 1/129 invented proper nouns ADMITTED (0.8%)   [Reno]
B  realistic draft, full brief  (|known| = 1720 chars)
  OVERALL: 4/129 invented proper nouns ADMITTED (3.1%)   [Ana, Ali, Reno, Tuck]
C  the real corpus: 192 example bodies x 129 invented nouns
  OVERALL: 382/24563 admitted (1.6%)
    Reno           192/192 bodies (100%)
    Ana             50/192 (26%)     Ines  45/192 (23%)
    March           18/192 ( 9%)     Ali   18/192 ( 9%)
    Ross            14/192 ( 7%)     Easter 14/192 ( 7%)
    Rosa 10, Ian 9, Ares 3, Eva 3, Tuck 3, Lena 2, Austin 1
```

So the hole is **narrow in aggregate (1.6%)** and consistent with PLAN-B M17's
17-of-18. Its shape is what matters (MEASURED, same command):

```
  LENGTH of the 14 words ever admitted by the substring test:
    3 letters: 4   4 letters: 7   5 letters: 1   6 letters: 2
  for comparison, the 129 words tried:
    3: 8  4: 14  5: 23  6: 23  7: 20  8: 19  9: 10  10: 9  11: 2  12: 1
  longest word ever admitted: 6 letters; longest tried: 12
```

**Nothing of 7 letters or more was ever admitted**, on any of 192 bodies. Half of
the 3-letter names and half of the 4-letter names were. "Reno" passes on 100% of
bodies for one reason: the fixture's referrer is **Mo-reno**.

`schoolRenderings` widens it slightly, because the canonical name is long
(MEASURED, `probe7-misc.ts`):

```
  and the school's own name donates substring surface: "Sylvan" (inside pennSYLVANia)
    -> ACCEPTED
```

**Consequence for a student's email.** The reviewer invents a short name — a
person's first name ("Ana", "Ali", "Ian", "Eva"), a city ("Reno"), a business
school ("Ross", "Tuck") — and it reaches the recipient as a fact the student
never gave. A short invented first name is the worst case here: an email that
names the wrong person.

**Fix.** Test whole words, which is what was meant:

```ts
const knownWords = new Set(known.match(/[a-z0-9']+/g) ?? []);
// ... if (!knownWords.has(word.toLowerCase()) && ...)
```

If a whole-word set turns out to reject legitimate morphological variants (e.g.
`known` has "Pennsylvania's" and the edit writes "Pennsylvania"), fall back to
the substring test only for words of **7+ letters**, which the measurement above
shows admits nothing invented from this list. Re-run probe 3 and the lint corpus
after the change.

---

## S10 — LOW. The shared-school rule fires on any `alum*` word

**Flaw.** The regex at `:526-529` is
`` `\\balum\\w*|\\byou also (?:studied|went)|…` `` — the first alternative is
independent of `schoolWord`, so any sentence containing "alumni" counts as the
shared-school claim.

**Failing input (MEASURED).** `npx tsx scripts/audit-probe/logic1/probe7-misc.ts`

```
7b  the shared-school rule keys on `\balum\w*` anywhere, independently of the school word
  an unrelated "alumni directory" reworded away
    -> REJECTED: dropped the shared school
```

The draft said *"I found your name in the alumni directory for the investment
club"*; the edit reworded it to *"I came across your name through the investment
club"* — which `draft-lint`'s own `says how the student found them` check wants
removed when there is a real connection.

**Consequence.** A correct edit rejected, and another retry. (Only when
`alumniSchool` is set, so the blast radius is verified-shared-school drafts.)

**Fix.** Require the school word near the alum word:
`\balum\w*\b[^.!?]{0,40}\b${schoolWord}|\b${schoolWord}\b[^.!?]{0,40}\balum\w*`,
keeping the other alternatives as they are.

---

## S11 — LOW. `loose` denies the credit when the reviewer normalises its own quote's punctuation

**Flaw.** `loose` (`:265`) folds case, curly quotes and whitespace runs — and
nothing else. A reviewer that quotes the sentence it removed but writes an em
dash where the draft had a comma gets no credit at all.

**Failing input (MEASURED).** `npx tsx scripts/audit-probe/logic1/probe7-misc.ts`

```
7d  `loose` normalises case, curly quotes and runs of whitespace - and nothing else
  quote matches exactly
    -> ACCEPTED
  quote differs by an em dash the reviewer substituted
    -> REJECTED: cut from 32 to 19 words
```

**Consequence for a student's email.** The private-removal edit is thrown away
on a punctuation mismatch, so `divorce` stays in the body the student sends —
the M12 outcome again, by a fourth route.

**Fix.** Add dash and punctuation folding to `loose` for the *credit* comparison
only (keep the strict version for the greeting and placeholder tests, where
exactness is the point): collapse `[‐-―-]` to `-`, and strip
`[,;:]` before comparing. Note the error direction here is the safe one, so this
is a false-negative fix, not a soundness fix.

---

## S12 — LOW. The rejection reason names one defect of several, and the retry is told only that

**Flaw.** Every rule returns on its first hit, and `draft-pipeline.ts:321`
interpolates `guard.reason` into the retry prompt as the complete list of what
to put right.

**Failing input (MEASURED).** `npx tsx scripts/audit-probe/logic1/probe2-ordering.ts`

```
2f  one edit with TWO fabrications (a year and a firm). The retry prompt interpolates guard.reason verbatim:
    -> REJECTED: added the number "2024"
```

The edit added both `2024` and `Goldman Sachs`; only the number is named.

**Consequence.** The retry fixes the number, keeps the invented firm, and is
rejected again — one wasted Sonnet call, which per D23 is the 40%-of-drafts
latency cost.

**Fix.** Collect all rule-4/rule-3 violations before returning (they are already
accumulated for names; do the same for numbers) and join them in `reason`.

---

## S13 — LOW. Rule 1 forbids the reviewer's own CHECK #1 in the greeting

**Flaw.** Rule 1 compares the first line byte-for-byte. The subject path (rule
11) explicitly admits a `spelling`/`wrong_person` fix; the greeting admits none.

**Failing input (MEASURED).** `npx tsx scripts/audit-probe/logic1/probe2-ordering.ts`

```
2e  the reviewer fixes a misspelled recipient name in the greeting (its CHECK #1 / rule "spelling")
    -> REJECTED: changed the greeting to "Hi Rachel,"
```

The draft greeted "Hi Rachael,"; `contactName` is "Rachel Stein".

**Consequence.** The whole edit is discarded, and the misspelled name is still
in the greeting. This is arguably by design (the greeting is generated from the
profile, so a misspelling there is an upstream bug), but the asymmetry with the
subject path is not stated anywhere and the reviewer's prompt does not tell it
to leave the greeting alone.

**Fix.** Either admit the same narrow exception as the subject (a reported
`spelling`/`wrong_person` whose quote is in the original greeting, with every
word of the new greeting known), or add one line to `REVIEW_SYSTEM` telling the
reviewer the greeting line is fixed and to report a wrong greeting with
`needsStudent: true` instead.

---

## Cleared

These I probed and found sound. Unless noted, MEASURED via
`npx tsx scripts/audit-probe/logic1/probe7-misc.ts`.

- **Numbers are matched exactly, not by substring.** `knownNumbers` is a set of
  digit runs (`:470`), so `208` is rejected even though it sits inside the
  student's phone number `15550101234` in `known`:
  `numbers are matched EXACTLY … -> REJECTED: added the number "208"`. This is
  the right design and is exactly what rule 4 should have copied.
- **The placeholder rule is a multiset comparison** (`:467`), so a placeholder
  cannot be added, removed or swapped: `adds a [placeholder] -> REJECTED`.
- **The greeting rule holds**: `changes the greeting -> REJECTED: changed the greeting to "Dear Ms. Stein,"`.
- **The real fabrication protections hold**: `invents a firm -> REJECTED: added "Goldman"`;
  `invents a number -> REJECTED: added the number "25"`; a gutted email is
  rejected both via the typed-detail rule and, with no typed details at all, via
  the floor.
- **The ask rule holds**: `drops the ask -> REJECTED: dropped the ask`.
- **A plain rewording is accepted**: `-> ACCEPTED`. The guard is not
  trigger-happy on the ordinary case.
- **Both D19 false positives are genuinely fixed.** `Penn` →
  `the University of Pennsylvania` is accepted, *and so is the reverse
  direction*, which D19 did not report. An exactly-quoted private removal on a
  short body is accepted (7d, first row).
- **`schoolCanonical`/`schoolKey` are as strict as D19 claims.** `Penn State`
  canonicalises to `penn state university`, not to Penn; `UNC Charlotte` has no
  canonical form at all; and `Wharton` for `Penn` is still blocked
  (`-> REJECTED: added "Wharton"`). The "only the canonical name, never the
  nickname group" decision is implemented as written.
- **`detailSurvived`'s anchor clause does its job.** Probe
  `probe4-detail-survived.ts` 4c: of four "detail loses its most specific half"
  cases, three are caught — the dropped anchor (`anchorsLost=["moved","audit","restructuring"]`),
  the dropped number (`["2026"]`) and the dropped proper noun (`["huntsman","hall"]`).
  The one that passes is a detail made *entirely* of `DETAIL_COMMON` words
  ("the reference call with the summer team about the process"), where by
  construction there is no anchor to lose. So the specific answer to "does a
  detail that loses its most specific half still pass?" is **no, except when the
  detail has no specific half**.
- **The stemmer's merges are mostly the intended ones.** 4d: `banker`/`banking`,
  `intern`/`interns`, `mentor`/`mentoring`, `sector`/`sectors`,
  `manage`/`managing` all match, which is the point of stemming. Two are wrong
  but harmless — `closing`/`closed` and `found`/`founder` — and both err toward
  accepting an edit, not toward fabrication.
- **`loose`'s error direction is conservative** (S11): a mismatch denies credit
  rather than granting it, so it can only cause a false reject.
- **`bodyAboveSignOff` does keep the signature out of judgement** in the normal
  case, which is why the `"Duke University 201929"` class of failure does not
  sink edits. S6 is only about the literal-string detection.
- **`GROWTH_CEILING`/`SHRINK_FLOOR` are single named constants interpolated into
  `REVIEW_SYSTEM`** (`:142-143`), so the prompt and the guard cannot drift apart
  — the D19 remedy is correctly in place, and `probe6` 6c confirms the enforced
  boundaries are exactly `floor(before*1.2)` and `ceil(before*0.6)`.
- **The lint categories do classify.** 5e shows all 6 categories the corpus
  produces have a `FINDING_KINDS` entry; nothing fell through to `"other"`.
- **Existing suite is green**: `npx tsx scripts/draft-review-test.ts` → 104/104.

---

## Prioritised improvements

1. **Authenticate the private/hateful claim** before either exemption trusts it:
   quote must be in the original, absent from the revision, and corroborated by
   `privateTopicsIn` / the content-limits check. Fixes **S1** and **S2(a)/(b)**.
   One helper, used in two places.
2. **Make the credit a set of spans and cap it.** Fixes **S2(c)** — the floor
   being switchable off is the worst single property in the file.
3. **Compute the credited removal once, before rule 6, and let rules 6, 7 and 8
   consult it** (plus normalise whitespace before linting). Fixes **S3**, the
   three remaining M12 instances, which are the ones that leave a private detail
   in the student's email.
4. **Make `stem` a fixed point.** Fixes **S4**: a one-line change that removes a
   whole family of false rejections and the retry each one costs.
5. **Whole-word `known` test, with a 7+-letter substring fallback if needed.**
   Fixes **S9** and the same hole in the subject gate.
6. **Tighten the subject gate** to a real quoted word plus a span-confined edit
   (**S5**), and **detect the sign-off by shape** (**S6**).
7. **Give growth an additive floor and an instruction credit** (**S8**) so the
   reviewer can actually restore a dropped detail on a short email. Do not touch
   `SHRINK_FLOOR`.
8. **Add a per-category count ratchet** to the veto (**S7**), **require the
   school word near `alum*`** (**S10**), **fold dashes in `loose` for the credit
   comparison** (**S11**), **accumulate all violations into one reason**
   (**S12**), and **decide the greeting asymmetry explicitly** (**S13**).

Items 1–4 are correctness; 5–6 are correctness with a smaller blast radius;
7–8 are mostly false-positive and latency work, which D23 shows is now a
first-class cost.
