# Where this branch stands

Written 12 October 2026 at commit `5db0379`, 18 commits ahead of `main`.
**Nothing is pushed. Nothing is merged. The live platform is unaffected.**

## What is measured, and what is not

**Measured and solid — deterministic, no model involved.** Every figure below
comes from a unit test or an exhaustive probe that runs offline and is pinned by
a regression test. These do not depend on any rig run.

**Measured and solid — one model-output before/after.** The voice change was
A/B'd against three identical control arms with a spread of exactly zero on the
five voice metrics, with the prompt files hashed before and after. That result
stands.

**NOT measured: current end-to-end output quality.** The last valid rig
measurement predates all five fixers. Two attempts to re-measure were discarded:
the first died on a usage limit (8 of 12 and 16 of 16 scenarios errored), the
second was voided when a concurrent session committed to `src/lib/draft-review.ts`
mid-run. **No one should quote a current quality number, including me.**

## The one metric that has never moved

`cannedResumePre` = **8**, across three control arms, the voice change, and all
five fixers. It is the signature of the untouched example corpus: `for your
reference` appears 32 times in the 192 gold bodies, and a prompt rule cannot
outvote 32 demonstrations. This is the next change and it is not yet made.

## Pending, in order

1. **The example corpus edit.** The plan (`CORPUS-EDIT-PLAN.md`) is being
   produced read-only; the edit itself is unstarted. It is blocked on (a) the
   plan landing and (b) a stable measurement window.
2. **The shared measurement.** Agreed with the concurrent session: it signals
   "stable" with a SHA and clean `src/`, then one run serves as both its revamp
   arm and this branch's pre-corpus baseline. Command, seed and scenario count
   are fixed and recorded in that exchange.
3. **`npm run help:learn`** — owed before merge. Five student-visible changes,
   including the drafted email itself for 28 of 41 types.
4. The carried-forward queue in D46.

## Division of work with the concurrent session

Two interactive sessions share this branch. Agreed split: the other session owns
the cross-owner plumbing (`ai-runner`, `model-registry`, `db/schema`,
`plan-quotas`, `draft-request`); this session owns the example corpus and the
quality measurement. `draft-prompt.ts` was yielded to it for four handoff
patches.

A flaw was found in its pre-today baseline before it spent the calls: its
harness selects scenarios by seed, and `draft-occasions.ts` changed today, so
the same seed no longer selects the same situations. It was told to pin the
resolved inputs rather than the seed, and to pin `now` so the class-year
calculation cannot drift.
