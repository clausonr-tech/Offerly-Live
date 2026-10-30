# Round-1 probe findings (measured 11 October 2026)

Two results, both measured, both load-bearing for the plans.

## 1. The subscription CLI can carry the whole pipeline — quality testing is free

`runClaude` in `src/lib/news/claude-cli.ts` (built for the news pipeline, runs on
Kai's Claude subscription, never the API) carries a real draft call end to end:
the real `buildDraftPrompt` system prompt, the real structured-output schema, and
a valid parsed draft back.

- Model `claude-sonnet-5-5`, `cold_email` / `first.alum`, full student + recipient facts.
- **5.7 seconds**, schema honoured, `finishDraft` applied cleanly.
- Reported usage: 773 output tokens, 8,794 cache-write tokens, `costUsd` 0.043 — subscription accounting, not an API charge.

Two gotchas for whoever builds on this:
- zod 4's `z.toJSONSchema()` emits a `$schema` key the CLI rejects
  (`--json-schema is not a valid JSON Schema`). Strip it. The news pipeline
  sidesteps this by hand-writing plain JSON Schema (`CLASSIFIER_SCHEMA`).
- `tsx` compiles these scripts as CJS, so top-level `await` fails. Wrap in `main()`.
- The CLI takes a text prompt on stdin and images via `imageDir` + the `Read`
  tool. **No PDF document blocks**, so the resume-PDF path cannot be tested this
  way — test the `studentResumeSummary` path, which is the common case anyway.
- The CLI exposes no `effort`, `thinking` or `speed: fast` controls. So:
  **use the CLI for quality A/B (free, unlimited); use the API only for latency.**

## 2. `draftChecks` is a much weaker grader than it looks

The draft the probe produced (reproduced below) fails four things `VOICE_RULES`
explicitly bans. `draftChecks(...).forReview` found **one**.

```
Hi Rachel,

I hope this email finds you well! My name is Maya Patel, and I am a junior at Duke
University studying economics. I found your contact through the Duke alumni database,
and I was glad to see that you are also from Atlanta, which is my hometown.
[...]
Would you have 10 minutes for a call? I am happy to work around your schedule, and I
attached a copy of my resume for your reference.
```

| Problem | In `VOICE_RULES`? | Caught by `draftChecks`? |
|---|---|---|
| `I hope this email finds you well` | yes | **yes** (`FILLER`) |
| 0 contractions in the whole email | yes ("use them naturally") | no — no such check exists |
| 5 sentences open with "I" | yes ("never three in a row") | no — no such check exists |
| `I attached a copy of my resume for your reference` | yes (the canned courtesy line) | no — no such check exists |
| `I was glad to see that you are also from Atlanta` | yes (don't announce it as a discovery) | no — the regex requires `we're both`, so `you are also` slips through |

### Why this matters to the plans

- **It constrains gating the review call on `forReview.length > 0`.** This draft
  would have scored "clean" and skipped the review — and it is exactly the
  template prose the review exists to fix. Any gate must be built on a
  *strengthened* lint, and the strengthening must be measured first.
- **It weakens `guardRevision`'s "made the writing worse" test**, which compares
  `draftChecks` counts before and after. A reviewer edit that fixes contractions
  and I-starts scores identically to one that fixes nothing.
- **It is cheap accuracy upside.** Four new deterministic checks (contraction
  rate, consecutive I-starts, the canned-courtesy-line set, discovery phrasing
  beyond `we're both`) strengthen the grader, the review brief and the guard at
  once, with no model call. The 300-draft simulation numbers quoted in
  `draft-prompt.ts` (57 "hope you are doing well", 65 "attached my resume for
  your reference", 255 no contractions) are the same four problems — so these
  were known at prompt-writing time but never became checks.

### Caveat

One draft is one draft. The distribution claim above rests on the 300-draft
numbers already recorded in `src/lib/draft-prompt.ts`, not on this probe. The
probe proves the checks *can* miss these, not how often they do.
