# The resume review's thinking: 2.2x the wait, and no coverage difference

13 October 2026. `resumeReview` is the most expensive configuration in the
product — six calls (five critics and a synthesis), each at `high` effort on the
free tier and `xhigh` on the paid one, every one with adaptive thinking and a
6,000-token ceiling. Nobody had measured whether the thinking earns it.

Runs, fixture and scoring: `scripts/audit-probe/resume-review-2026-10-13/` and
`scripts/resume-review-live-eval.ts`.

---

## 1. What had to be built first

`reviewResume` ran its six calls inside `runAiFeature`, so no script could reach
them — the same condition that left the draft review at medium + adaptive for a
month. `runResumeReviewCalls(client, cfg, input)` is now split out, behaviour
unchanged; `reviewResume` still owns the filename check, the quota, the usage
row and the error translation.

**Ground truth, not a judgement call.** The fixture is a synthetic
sophomore-finance resume carrying **twelve planted flaws**, each one something a
`DIMENSIONS` brief names explicitly, spread across all five critics: an
objective statement, a references line, a missing GPA, two weak-verb bullets, a
bullet with no outcome, a non-standard section heading, inflated adjectives, two
date formats, cliché filler, a tense slip, and a typo. The score is how many the
review actually names.

## 2. What it found

| tier | arm | wall clock, 6 calls | flaws found | output tokens | cost | issues |
|---|---|---|---|---|---|---|
| free | `Sonnet high + adaptive` **(shipped)** | **51,511 ms** | 12/12 | 7,313 | $0.0794 | 17 |
| free | `Sonnet high + disabled` | **24,035 ms** | 12/12 | 3,106 | $0.0375 | 17 |
| free | `Sonnet high + disabled` (repeat) | **22,945 ms** | 12/12 | 3,208 | $0.0386 | 18 |
| pro | `Opus xhigh + adaptive` **(shipped)** | **69,636 ms** | 12/12 | 9,137 | $0.0986 | 19 |
| pro | `Opus high + disabled` | **30,295 ms** | 12/12 | 3,995 | $0.0472 | 20 |

**A student currently waits 52 seconds for a resume review on the free tier and
70 on the paid one.** Thinking off: 23 and 30. Coverage is identical, output
tokens fall by about 58%, cost by about 52%, and the thinking-off arms raise
*more* issues, not fewer.

Two notes on reading that table honestly:

- **The per-dimension scores came out byte-identical between arms (8/6/8/9/4).
  That is not independent evidence.** `PENALTY` makes a dimension's score a
  function of how many issues it raised, and both arms raised the same counts,
  so identical scores follow arithmetically.
- **The pro arm changes two variables at once.** Opus 5 rejects
  `thinking: disabled` above `high` effort, so `xhigh + adaptive` → `high +
  disabled` is the only reachable thinking-off config. Confounded, and
  unavoidable.

## 3. Why this is NOT being shipped on this evidence

The registry's own comment records a prior judgement:

> This is the deepest judgment call in the product, and it was running with
> reasoning off at below-default effort — which is most of why its output **read
> generic**. Adaptive thinking and xhigh effort are the fix.

**Twelve planted flaws measure coverage. "Reads generic" is about prose, and
this harness cannot see it.** Shipping a 2.2x speedup against a recorded quality
judgement, on a metric that does not measure the thing the judgement was about,
is the mistake this project keeps writing decision entries about.

Two things do count in favour of the change, and they are why it is a
recommendation rather than a dead end:

1. **The configuration that produced the generic output is not this one.** The
   comment says reasoning off *at below-default effort*. Both arms here keep
   effort at `high`. Thinking-off-at-high-effort has never been tried.
2. **On a side-by-side read of the actual prose, the thinking-off arm holds up.**
   Both name the student's real material and give concrete instructions — the
   adaptive arm asks for "how many names in the screen, what type of model,
   which company you pitched"; the thinking-off arm asks for "universe size,
   model count, AUM, number of pitches" and additionally catches the date-format
   inconsistency in its summary. That is one reader on one synthetic resume, so
   it is a reason to measure properly, not a result.

## 4. What would settle it

Three or four **real** student resumes, reviewed under both arms, read side by
side — or a prose judge in the shape of `scripts/draft-reply-grader.ts`, scoring
specificity rather than coverage. Either is cheap: the arms above cost $0.30 in
total.

## 5. A separate finding, worth acting on sooner

Both pro arms failed on the first attempt with:

> rate_limit_error: This request would exceed your rate limit of **0 fast mode
> input tokens per minute** (model: claude-opus-5)

**This organisation has no fast-mode capacity at all.** `speed: "fast"` is set on
four paid-tier configs (`firmMatch`, `draft`, `resumeReview`, `resumeRewrite`).
Production survives it — `ai-runner` drops speed and retries the same model
before descending the model chain, which is exactly what that fallback is for —
but it means every paid-tier invocation of those four features spends a
guaranteed failed round-trip before doing any work, for a feature that cannot be
delivered. Either get the capacity enabled or drop `speed: "fast"` until it is.

## 6. What this does not say

- **One synthetic resume, one run per arm** (two on free). The flaw detectors
  are keyword matches, like `help-assistant-eval`'s — crude, transparent, and
  identical across arms, which is what matters when arms are compared with each
  other.
- **12/12 is a ceiling.** This design can detect degradation and not
  improvement, which is right for "is the thinking needed" and wrong for
  anything else. A harder resume might separate the arms.
- Nothing here measures the synthesis pass's prose, the rewrites' quality, or
  behaviour on a document that is not a resume.
