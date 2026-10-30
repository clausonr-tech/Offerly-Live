# OUTPUT-1: are these good emails?

Written 11 October 2026 by the OUTPUT-1 audit, reading 28 real emails the pipeline
produced through `scripts/draft-cli-eval.ts`. Every quote below is verbatim from
those 28 emails; the JSON they came from is in `scripts/audit-probe/output1/`.

```
npx tsx scripts/draft-cli-eval.ts --scenarios=16 --seed=quality --profile=full   --retry-before=600000 --json=scripts/audit-probe/output1/q-full.json
npx tsx scripts/draft-cli-eval.ts --scenarios=12 --seed=quality --profile=sparse --retry-before=600000 --json=scripts/audit-probe/output1/q-sparse.json
```

**`errored`: 0 of 16 and 0 of 12. Both runs are comparable.** Guard: 15 of 16
edits applied in `full` (one rejection), 12 of 12 in `sparse`.
`costUsdSubscription` 1.53 + 0.58, billed to nobody.

**This is quality, not a production replica.** The rig runs `claude-sonnet-5-5`
over the CLI for both the draft and the review call, with no `effort`, no
`thinking` and no fast mode — none of which the CLI exposes. Production drafts on
the paid plan run Opus 5 with fast mode, and the review call runs adaptive
thinking. Nothing here measures latency, the resume-PDF path, or the per-plan
model split. What it does measure is the words that would reach a recipient.

---

## 1. Would this get a reply?

I read all 28 as Rachel Stein (VP, consumer coverage) or Olivia Brandt (campus
recruiter) would: a dozen of these a week, read on a phone, in ten seconds.

**Headline: 14 of the 28 emails cannot be sent as written, and every single one
of the 14 fails for the same reason — a `[bracketed placeholder]` left in the
body.** Twelve of them are the same bracket, `[graduation month]`, for a field
the app does not have and never asks for (there is no graduation-month input in
`DraftPromptInput`; `studentGradYear` is a year). A recruiter who reads
"graduating in [graduation month] 2029" knows exactly what tool wrote it.

Of the remaining 14, I would reply to 13 and the 14th asks for no reply on
purpose.

| # | prof | situation | words/ceiling | verdict | why |
|---|---|---|---|---|---|
| 601 | full | recruiter + alum | 126/200 | **would reply** | Two answerable questions, right length. Winces at "writing to a fellow Duke alum and fellow Atlanta native" — two "fellow"s in one clause. |
| 602 | full | recruiter, not alum | 120/180 | **off-putting** | `[graduation month]`. Otherwise a clean, if faceless, email. |
| 603 | full | referral + alum | 126/200 | **would reply** | Strong hook (club president interned on her team). But **zero question marks**: the review turned the ask into "I wonder if you'd have 10-15 minutes for a call." |
| 604 | full | referral, not alum | 149/180 | **would reply** | Referral carries it. "how you moved from college into consumer coverage" is vague — the fix for a real mismatch left a limp sentence. |
| 606 | full | referral + recruiter + alum | 146/200 | **off-putting** | `[graduation month]`. |
| 607 | full | referral + recruiter | 128/180 | **off-putting** | `[graduation month]`, plus "suggested I write to you, and I interned on her team" — Olivia has to work out whose team. |
| 614 | full | referral + met + alum | 147/200 | **would reply** | Best cold email in the set. Opens on the turnaround, then her own line about repeat customers, then the referrer, then one clean ask. |
| 615 | full | referral + met | 138/180 | **would reply** | Same shape, slightly flatter. "I can fit whatever time suits your week" is a genuinely fresh flexibility line. |
| 616 | full | referral + met + recruiter | 159/180 | **off-putting** | Worst in the set. Guard rejected the edit, so a 59-word opening sentence ships, with `[graduation month]` and a note describing a fix that never happened. |
| 617 | full | referral + met + recruiter + alum | 147/200 | **off-putting** | `[graduation month]`. Content is good; "a sophomore from Atlanta" dangles (Olivia is never told Atlanta is shared). |
| 644 | full | conference + pointed + recruiter | 163/170 | **off-putting** | `[graduation month]`, and the longest email here at 96% of its ceiling. |
| 645 | full | conference + pointed + recruiter + alum | 162/200 | **off-putting** | `[graduation month]`, and it stacks two connections: "an Atlanta native like you" and "a fellow Duke alum". |
| 646 | full | conference + pointed + recruiter | 152/180 | **off-putting** | `[graduation month]`. |
| 647 | full | thanks: chat + offered help | 74/150 | **would reply** | **The best email of the 28.** Short, specific, thanks once, carries the req number. |
| 660 | full | second convo + redirected | 104/150 | **would reply** | "The summer analyst application closes October 15. Would you have 15 minutes before then?" — a reason to answer today. |
| 661 | full | second convo + redirected + update | 102/150 | **would reply** | Congratulations, loop closed, deadline, one ask. Review found nothing to change and was right. |
| 801 | sparse | recruiter + alum | 116/200 | **off-putting** | `[graduation month]`, and "graduating in [graduation month] 2029, writing to a fellow Duke alum" bolts the shared school onto the end. |
| 804 | sparse | referral + recruiter | 104/165 | **off-putting** | `[graduation month]`. Unchanged by review, 0 problems — a clean draft with a hole in it. |
| 805 | sparse | met + alum | 137/200 | **would reply** | Good opening. Ends on the rules' own example line and drops the thank-you entirely. |
| 806 | sparse | referral + met | 125/180 | **would reply** | Review's reorder earns its keep: turnaround first, referrer second. |
| 807 | sparse | all four first-contact boxes | 130/200 | **off-putting** | `[graduation month]` plus "at Duke, where you're a fellow Duke alum" — says Duke twice and means neither. |
| 808 | sparse | conference + recruiter | 119/170 | **off-putting** | `[graduation month]`. |
| 809 | sparse | pointed + alum | 95/200 | **off-putting** | "after I emailed him about [what you originally asked Marcus about]" — tells Rachel the sender didn't bother. |
| 815 | sparse | update + congrats | 102/150 | **would reply** | Congratulations first, update second, no ask. A two-line reply is easy. |
| 816 | sparse | referrer + update | 68/150 | **would reply** | Short and warm. The review cut the one sentence with a pulse (see §4). |
| 817 | sparse | referrer + congrats | 53/110 | **no reply wanted** | 53 words, ends "Please don't feel you need to write back." Correctly expects nothing. |
| 818 | sparse | referrer + congrats + update | 74/150 | **would reply** | Same email, one paragraph longer, still good. |
| 819 | sparse | redirected + update | 68/150 | **off-putting** | A thank-you with `[one specific thing from Ben's advice]` as its middle paragraph. |

**Totals: 13 would reply, 14 off-putting, 1 deliberately expects no reply, 0 that
I would merely ignore.** That last point is worth saying plainly: nothing here is
bland enough to slide past unnoticed. These emails either land or they announce
themselves as generated.

---

## 2. Does it sound like a real student?

**The contraction count moved; the voice moved much less.** Across all 28 final
emails there are 68 contractions. Here is every one, by form:

```
i'm:42   i'd:8   i've:6   you're:5   it's:4   we're:1   i'll:1   don't:1
```

**Forty-two of 68 are "I'm", and 56 of 68 are first-person "I'm / I'd / I've".
Exactly one negation contraction appears in 28 emails** ("don't", in 817). No
"that's", no "isn't", no "doesn't", no "wasn't". And 48 of the 68 sit inside the
identity-and-credentials sentence — the one that was going to say "I'm a
sophomore at Duke" whatever else changed:

> "My name is Maya Okafor, and **I'm** a sophomore at Duke University from
> Atlanta, studying Economics and graduating in [graduation month] 2029." (602)

So the honest reading of "0 contractions in 12 of 12 drafts → ~2.25 per draft" is
that the drafter stopped writing "I am a sophomore". That is a real improvement —
"I am a sophomore at Duke University" is a tell — but it is not the same as the
emails sounding conversational.

**Where contractions do appear outside the credential sentence, they sound
natural, not bolted on.** All 20 of them read as a person wrote them:

> "**I'll** keep you posted on what comes next." (816)
> "Please **don't** feel you need to write back." (817)
> "Would you have 15 minutes before then to hear what **I've** picked up and tell
> me where my thinking is still thin?" (660)
> "**It's** attached so **it's** easy to forward, and my application is in under
> req #55120." (647)

Not one of the 68 is misplaced or grammatically strained. The failure mode is
absence, not awkwardness.

**The best sentences in the 28.** These are the ones I would not guess were
generated:

> "Would you have 15 minutes before then to hear what I've picked up and tell me
> where my thinking is still thin?" (660) — the ask admits a weakness, which is
> why it reads as a person.
> "Your point that consumer deals come down to repeat customers connects directly
> to my interest in consumer and retail M&A." (614)
> "It was kind of you to offer to pass my resume along. It's attached so it's easy
> to forward, and my application is in under req #55120." (647)
> "I can fit whatever time suits your week." (615) — the only flexibility line in
> the set that could not be pasted into another email.

**The worst sentences in the 28.** Every one of them is the shared-school clause,
and the damage happens on both sides of the review:

> "I'm an economics sophomore at Duke, **a fellow Duke alum's school**, and this
> past summer..." (809, pre-review — a phrase that means nothing)
> "I'm writing as **a fellow Duke alum's junior**, a consumer sector analyst in
> the Duke Investment Club..." (645, pre-review — likewise)
> "I'm a sophomore studying economics **at Duke, where you're a fellow Duke
> alum**." (807, post-review — names Duke twice, says it badly)
> "...graduating in [graduation month] 2029, **writing to a fellow Duke alum**."
> (801, post-review — the connection tacked onto the end of a date)
> "I'm an economics sophomore at Duke **writing to a fellow Duke alum**." (809,
> post-review)
> "My name is Maya Okafor, and I'm a sophomore at Duke University, graduating in
> 2029, **writing to a fellow Duke alum and fellow Atlanta native**." (601)

Ten of the 28 emails have the alum box checked. **Six of those ten carry a
mangled version of this one clause** — two garbled by the drafter, four welded in
by the review. `VOICE_RULES` and the review prompt both print `a fellow Duke
alum` as "the shape for saying so"; both models treat it as a string to insert.

**Do they read better or merely different than before the voice change?** Better,
narrowly. "I am a sophomore" is gone, and nothing reads stilted where a
contraction landed. But the second-largest gain claimed for the change — that the
emails stop sounding like one template — did not arrive. See below.

---

## 3. Do they all sound the same?

Yes, and the repetition is concentrated exactly where the input does *not* force
it. One honest caveat first: there is one simulated student with one resume line,
so her Pinecrest sentence recurring is partly unavoidable. The sentences below
that *are* avoidable are the openers, the closers and the courtesy lines, and
those are the worst offenders.

**The closing line is one line.** Of 28 emails, **16 end with the identical
sentence "Thank you for your time!"** and two more end "Thank you so much for your
time!" — **18 of 28 (64%) close on one phrase.** In the `full` run it is 13 of 16.
The last thing every recipient reads is the same six words, whether the email was
a cold referral, a conference follow-up or a recruiter question.

**The opening follows two formulas.** Six emails open on a near-identical meeting
line, three of them identical including the greeting:

> "Hi Olivia, It was great to meet you at the SEO Career Summit in New York."
> (645, 646, 808 — word for word)
> "It was good to meet you at the SEO Career Summit in New York." (602)
> "It was a pleasure meeting you at the SEO Career Summit in New York." (644)

and four more open on the referrer in one shape: "Emily Tran, president of the
Duke Investment Club, ..." (604, 606, 607, 616).

**The courtesy lines are the rules' own examples.** `VOICE_RULES` prints "Any time
that suits you works for me" as the fresh alternative to a banned line. It appears
verbatim in three emails (603, 805, 806), and a near-variant in a fourth ("Any day
that suits you before then works for me", 660). All four were written *by the
review pass*, replacing "I'm happy to fit whatever time suits you". The rig's own
`cannedLines` metric went **up** through review in `sparse` (8 → 10).

**Sentences appearing word for word in more than one email** (28 emails, final
versions):

| times | sentence |
|---|---|
| 16 | "Thank you for your time!" |
| 12 | "Second, does it feed into the summer analyst class?" |
| 8 | "First, when does the sophomore program open?" |
| 8 | "This (past) summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews." |
| 5 | "My resume is attached." |
| 4 | "Consumer and retail M&A is the part of finance that draws me most." |
| 4 | "My name is Maya Okafor." |
| 4 | "I have two questions about (recruiting at) Morrow & Pike." |
| 3 | "Any time that suits you works for me, and my resume is attached." |
| 2 | "I'm Maya Okafor, a sophomore from Atlanta studying economics at Duke, and you're a fellow Duke alum." |

Two sentence-*shapes* worth naming because no rule bans them and both read as
machine output:

- **"My name is Maya Okafor."** as a standalone four-word sentence, in four
  emails. The review created it by splitting "My name is Maya Okafor, and I'm a
  sophomore..." to break a run-on. It fixes one rule and produces a form letter.
- **"I have two questions about X. First, ...? Second, ...?"** in 12 emails. The
  numbered-prose instruction is visible in the output as a fill-in-the-blanks
  frame.

And the subject lines: **every one of the 28 is in Title Case** ("Great to Meet You at the SEO
Career Summit in NYC"). Nobody types a subject line in Title Case. Five are
compound, joined with ", and" — "Referred by Emily Tran, and Great to Meet You at
the SEO Career Summit NYC" is 13 words of two situations stapled together.

---

## 4. Pre-review vs post-review

The review edited 25 of 28 emails (three came through unchanged: 616, whose edit
the guard rejected, and 661 and 804, which it returned untouched with zero
problems). Reading the pairs:

**It is a clear net win on structure.** Its best move, made in five emails
(614, 615, 617, 806, 807), is to put the specific thing first and the referrer
second:

> **pre (616-style, 614):** "Emily Tran, who is president of the Duke Investment
> Club and interned on your team, suggested I write to you, and I was glad to meet
> you at the SEO Career Summit in New York before I got the chance."
> **post (614):** "I enjoyed hearing about the grocery chain turnaround you worked
> on when we met at the SEO Career Summit in New York."

**It catches invented facts the drafter smuggles in.** 601's draft said
"graduating in **May** 2029" — a month that exists in no input anywhere. The
review cut it to "graduating in 2029", which is also the proof that
`[graduation month]` was never needed in the other twelve emails. It also
repaired both garbled alum clauses (645's "a fellow Duke alum's junior", 809's "a
fellow Duke alum's school").

**Three cases where it made the email worse.**

1. **603 — it removed the question mark.** The one thing a cold email needs is an
   easy yes.
   > **pre:** "Would you have 10-15 minutes for a call? I'm happy to fit whatever
   > time suits you, and my resume is attached."
   > **post:** "I'd love to hear how you moved from Duke into consumer coverage,
   > and I wonder if you'd have 10-15 minutes for a call. Any time that suits you
   > works for me, and my resume is attached."

   Of the 20 first-contact emails, 603 is the only one with **no question mark
   anywhere in it**. A direct ask became a hedge, and the flexibility line became
   the rules' own example. (Six of the eight thank-you and stay-in-touch
   emails have no question mark either, correctly: they ask for nothing.)

2. **816 — it cut the only sentence with a voice.** 89 words to 68.
   > **pre:** "Since then, I spent the summer as an intern at Pinecrest Wealth
   > Partners, where I built a dividend stock screen. **It's been a good way to
   > practice the kind of analysis I'd like to do more of.**"
   > **post:** "Since then, I interned at Pinecrest Wealth Partners for the summer
   > and built a dividend stock screen."

   The cut sentence was reported as `invented`. It asserts nothing about anyone
   but the sender's own preference; what is left is a CV line. Same pattern in
   660, which lost "it gave me a much clearer picture of the team" and "so
   following brands closely has been a natural extension of that work".

3. **807 and 801 — it degraded a working sentence to satisfy the alum rule.**
   > **801 pre:** "I'm a sophomore at Duke University, **your alma mater**,
   > graduating in [graduation month] 2029."
   > **801 post:** "I'm a sophomore at Duke University graduating in [graduation
   > month] 2029, **writing to a fellow Duke alum**."
   > **807 pre:** "I'm a sophomore at Duke, **where you also studied**."
   > **807 post:** "I'm a sophomore studying economics **at Duke, where you're a
   > fellow Duke alum**."

   "your alma mater" and "where you also studied" were both better English than
   what replaced them. The review traded them for the phrase its prompt prints.

**And one case where a rejection cost everything.** 616's edit was thrown away
whole:

```
dropped something the student typed: "president of the Duke Investment Club, interned on her team"
```

The retry ran (`--retry-before=600000`) and failed the same way. Six reported
problems — a mismatch, two structure, two flow, one tone — went in the bin with
it, so 616 ships the opening sentence quoted in §5 below. One phrase lost out of a
159-word email cost the student every other fix. `guardAcceptRate` 0.938 sounds
fine; the one rejection is the worst email in the corpus.

---

## 5. The small stuff that ruins an email

**Placeholders — the single biggest defect.** 14 of 28 emails ship a bracket:
`[graduation month]` ×12, `[what you originally asked Marcus about]` (809),
`[one specific thing from Ben's advice]` (819). The last two sit mid-email in
*thank-you* notes. `GAP_RULES` already says "If the step can simply be left out
without the email reading oddly, leave it out", and a missing event day "is not a
gap" — 601 ("graduating in 2029"), 805 and 806 (no graduation sentence at all)
prove that the month is exactly such a case. It is not even a sim artifact: the
app has no graduation-month field to fill.

**Subject lines.** Best: "15 Minutes Before October 15?" (660, 661 — the ask is in
the subject) and "Duke '29: Questions About the Morrow & Pike Sophomore Program"
(801). Worst: the five compound ones joined with ", and", up to 13 words. All 28
are Title Case, which is itself a tell. No misspellings, no wrong names, and
the review left every subject alone — correct behaviour.

**Signature block — clean.** All 16 `full` emails end with the same five correct
lines (name, "Duke University '29", school email, phone); no placeholder ever
reached the signature. The 12 `sparse` emails correctly stop at "Best," for the
Gmail signature to follow, though only one of the 12 (804) tells the student that
is why.

**Greetings — correct everywhere.** "Hi Rachel," to the VP, "Hi Olivia," to the
campus recruiter; first name only, no "Dear Ms.", no surname. 817 and 818 write
"Ben and I just had our call" where the student typed "ben ortega"; the grader
flags that as a missing answer and the grader is wrong — a human would never want
the surname there.

**Length — inside every ceiling, and still too long.** `overCeilingPost` is 0 in
both runs; the closest is 644 at 163/170. But the `full` emails average 134 words
and spend two sentences of it on an identical credential paragraph. The two best
emails in the set are 74 words (647) and 53 words (817). The ceiling is not the
constraint that is failing; the padding is.

**The worst single sentence, verbatim (616, 59 words, first thing Olivia reads):**

> "Emily Tran, president of the Duke Investment Club and a former intern on your
> team, suggested I write to you, and it was a pleasure to meet you at the SEO
> Career Summit in New York, where we talked about the grocery chain turnaround
> you worked on."

---

## 6. `notesForStudent`

63 notes across 28 emails, 1–4 each. The good ones are genuinely non-obvious and
tell the student something only the pipeline knows:

> "I left out the 10-minute call request. With a campus recruiter, the two
> questions are the one ask." (808)
> "You wrote that you want to learn how she moved from Duke into consumer
> coverage, but Rachel isn't a Duke alum. I wrote 'from college' instead so the
> email doesn't imply a shared school." (604)
> "You didn't say how you know Emily, so the draft only says she interned on the
> consumer team and told you to reach out. Add how you know her if you'd like."
> (804)

**But six of the 28 carry a note that is wrong, stale or contradicts the email in
the student's hand.** The cause is structural: the drafter's notes describe the
pre-review draft, and nothing re-checks them against the email that actually
ships.

1. **809 — a note about a phrase that no longer exists.**
   > note: "The phrase 'a fellow Duke alum's school' reads awkwardly, so reword it
   > to fit your voice, for example 'I'm an economics sophomore at Duke, where I
   > understand you also studied.'"

   The review already removed that phrase. The student goes hunting for text that
   is not there.

2. **645 — a note that contradicts the email.**
   > note: "I used Duke as the shared connection and left out Atlanta so the email
   > doesn't stack two."
   > final email: "I'm an Atlanta native like you and a sophomore at Duke
   > University... Marcus Delacroix suggested I write to you, a fellow Duke
   > alum..."

   Both connections are in there. The note says the opposite.

3. **616 — a note claiming a fix that was thrown away.**
   > note: "Check this before sending: 'a former intern on your team'. Took out
   > the claim that Emily interned on Olivia's team..."

   The guard rejected that edit, so the claim is still in the email. The note is
   generated from the rejected edit's `fix` text, in the past tense
   (`studentNotesFromReview` prefixes it with "Check this before sending" but
   leaves "Took out..." as written). A student who trusts it sends an email
   containing the exact claim they were told had been removed.

4. **607 — internal prompt jargon.**
   > "**FACTS** say you interned on Emily's team, not that she interned on
   > Olivia's."

   "FACTS" is a section header in the review's system prompt. A student has never
   seen the word.

5. **660 and 661 — pipeline plumbing exposed.**
   > "Your timeline says today is September 20, but **your system date reads
   > October 11**." (660)
   > "Your notes put today at September 20 in one place and October 11 in
   > another." (661)

   The student did not put two dates anywhere; the simulation's `now` and the real
   clock disagree. The model noticed a real inconsistency and correctly flagged
   the deadline risk, which is good instinct, but it reported it as the student's
   mistake in words no student can act on.

One more that is merely redundant: 819 carries four notes, two of which are about
the same placeholder ("You didn't say what came out of the conversation with Ben,
so I left a highlighted spot" and "Left the placeholder as is. Replace it with one
specific piece of advice from Ben before sending.").

Accuracy of the rest is good. I checked every note against the typed answers in
`scripts/draft-occasions-sim.ts`: no note misreports what the student typed, and
the two `needsStudent` escalations (607's and 616's who-interned-where ambiguity,
615's Duke mismatch) are exactly the calls a human would want flagged.

---

## The three changes I would make

### 1. Never write `[graduation month]`. Write around a missing month.

Twelve of 28 emails — 43% — are unsendable for one reason, and it is the same
reason. The app has no graduation-month field, so this bracket can only ever be
noise, and `GAP_RULES` already instructs the drafter to leave out a step that can
be dropped without the email reading oddly. 601's review proves the clean version
("graduating in 2029"), and 805/806 prove that the sentence can omit graduation
entirely.

**Why this first:** it is the only defect in the set that flips a verdict on its
own. Of the twelve bracket emails, ten have nothing else wrong with them, so
fixing this alone moves my counts from 13/28 *would reply* to about 23/28 —
without touching a sentence of prose. (The two that stay off-putting are 616, for
its 59-word opening sentence, and 807, for its alum clause — recommendations 2
and 3.) It is also the
cheapest thing on this list: one line in `GAP_RULES` naming the class-year case,
plus a `draftIssues` check that already exists (`placeholder: [graduation month]`
is reported today and ignored).

### 2. Kill the fixed closing line, and stop the review pasting its own example.

"Thank you for your time!" ends 16 of 28 emails word for word; the thank-you-for-
your-time family ends 18 of 28. "Any time that suits you works for me" — printed
in `VOICE_RULES` as the *fresh alternative* — appears verbatim in three emails and
in all three the **review** put it there, which is why `cannedLinesPost` (10) is
higher than `cannedLinesPre` (8) in the `sparse` run.

**Why:** the closer is the last thing the recipient reads and it is currently
identical across a cold referral, a conference follow-up and a recruiter query. It
is also the easiest place to prove variety, because the right version is already
in the corpus: 660's "Any day that suits you before then works for me" names this
email's deadline, and 817's "Please don't feel you need to write back" names this
email's situation. The concrete change is to treat the closer like the banned
resume lines — forbid the stock family outright in both prompts, require the final
sentence to name something specific to this email, and add "Thank you for your
time" to the `cannedLines` families the rig already counts so a regression shows
up as a number.

### 3. Stop welding in `a fellow Duke alum`.

Six of the ten alum-box emails have a damaged shared-school clause: two garbled by
the drafter ("a fellow Duke alum's school", "a fellow Duke alum's junior") and
four grafted by the review ("at Duke, where you're a fellow Duke alum", "writing
to a fellow Duke alum", "a fellow Duke alum and fellow Atlanta native"). In two of
them the review replaced perfectly good English — "your alma mater", "where you
also studied" — with worse.

**Why:** this is the one sentence in the email whose whole job is warmth, and it
is the sentence most likely to be broken. The cause is visible in the prompts:
both `VOICE_RULES` and the review's rule 6 print the exact string `a fellow Duke
alum` and call it "the shape", and both models paste the shape. The fix is to stop
printing a phrase at all — state the requirement ("say plainly, inside the
sentence that introduces the student, that the recipient went to their school")
and give two or three *different* worked examples with different schools and
different grammar, so there is no single string to copy. The existing
`repeatedSentences` and `cannedLines` metrics will show whether it worked.

---

### What I did not find

Worth recording, because they are the things the project worries about:

- **No blocked language, no profanity, no private details.** `blockedLanguage` 0
  in both runs.
- **No hallucinated people, firms or numbers** in any of the 28 final emails. The
  one invented fact in the set ("May 2029") was caught and removed by the review.
- **No email over its word ceiling**, in either profile.
- **No pleasantry openings** (`pleasantryOpenPre/Post` 0 of 28). Not one email
  opens on "I hope this finds you well" — that rule is holding completely.
- **No three-in-a-row "I" openings** in any final email.
