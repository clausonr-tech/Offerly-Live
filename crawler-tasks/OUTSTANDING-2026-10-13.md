# Crawler — outstanding work, 13 October 2026

Replaces an untracked `CRAWLER-PICKUP.md` that had become a narrative of how
the work went rather than a list of what is left. Tracked, so another session
finds it; dated, so a stale number is obviously stale.

Every figure here was measured against the live database on the date given. The
rule the hard way: a count is not evidence until you read the rows behind it -
see "praktikum" under *Lessons that are now rules*.

## Done, with the evidence

- **416 already-closed jobs retired.** They were still being shown to students,
  the only item on the old list that actively misinformed anyone. Verified 0
  remaining.
- **61 portfolio-board postings retracted** (Coinbase roles published under
  "Blockchain Capital, LLC"). `BANK_AUDIT_SECTORS` and `isPortfolioBoard` fix
  it forward. Verified 0 remaining.
- **3,526 relative `listing_url`s repaired.** 4 `mailto:`/`javascript:` left
  alone, correctly.
- **Per-stage timings exist** - `0049_check_run_stage_timings` (`static_ms`,
  `render_ms`, `enrich_ms`).
- **A recovered year can now release a listing.** The review agent passes the
  year as an INPUT to `classifyListing` rather than patching it onto a returned
  classification, so `needsHumanReview` is recomputed and the deterministic
  gate still decides. This was the old list's item 9, left open on purpose; the
  shape that resolved it is that a model supplies a fact and the rule decides.
- **The agent's denials are measured.** 40-row stratified hand-check, scored:
  **40 agree, 0 wrong** - false-denial rate 0%, 95% CI 0-8.8% (Wilson). The
  rule of three puts the true rate under ~8%.
- **School-level placements are excluded by rule**, not by the accident of an
  underivable cycle.
- **Row-level security on every public table.** Found 16 unprotected in
  production, including `firm_login_codes`, `login_attempts`, `stored_files`
  and `notifications` - all predating migration 0044, which suggests 0044 never
  took effect on the us-east-2 project. `0052` closes them. Verified 16 -> 0,
  none FORCEd.

## Outstanding, ranked

1. **`TITLE_INTERNSHIP_PATTERN` is still unmeasured**, and the number everyone
   was quoting was wrong three ways. Stored verdicts say **9,840** rejections,
   57% of all 17,343 - not 8,441. Re-run through CURRENT code it is **7,159**,
   because rules added since those rows were crawled now catch 2,680 of them
   for other reasons. Measuring a rule means re-running the classifier, never
   reading stored verdicts.

   Three real internships were found inside it by targeted probing, not by
   sampling: MUFG São Paulo's "Estagiário", Bracebridge's "2027 Sophomore
   Winternship", and Weiss's "2027 Underclassmen Fellowship" - the last of
   which was live to students on an old classification that current rules
   rejected, so the next re-classification would have retracted it.

   **Three finds are not a rate.** Nobody can yet say what recall this rule
   costs. The design: stratified sample over the 7,159 with known stratum
   sizes, the review agent as labeller, and a ~40-row human validation slice -
   the existing 40/40 hand-check measured the AGENT's denials, a different
   population, and does not transfer. A blind 1,200-example draw is the wrong
   instrument: ~75% of its labels would land in the stratum where misses are
   rarest.
2. **Thirteen live postings that current rules reject.** Twelve are MBA-level -
   Moelis and Jefferies "2027 Investment Banking Summer Associate", where
   Associate is the MBA role and Analyst the undergraduate one - plus Houlihan
   Lokey's "3 Month Internship" on cycle 2026, now out of range. The
   graduate-degree rule is right to reject them, which makes this a retraction
   decision rather than a classifier bug. It is the only item on this list
   affecting students today.
3. **Stored verdicts are stale corpus-wide.** 21 stored-relevant listings are
   rejected by current code and rejections would now pass; nothing
   re-classifies on a schedule. `reclassify-listings.ts` is safe to use for
   this now - it preserves `reviewAgent` verdicts, which it previously
   discarded, which would have re-spent the whole model budget.
4. **A firm-attribution bug.** MUFG's São Paulo "Estagiário" is recorded twice,
   the second row under Intrepid Investment Bankers - same URL, two firms. Found
   while reading listings rather than counting them, and not investigated.
5. **A third of `open` listings may point at dead pages.** Of 30 title-phrase
   rejections the agent re-examined, 10 had a `listing_url` that no longer
   carried the posting. If it holds, ~1,500 stale rows. `decideClosure` only
   ever sees a board listing, never the posting's own page. Measure on a ~300
   sample before deciding what to do.
3. **The rejection-reason vocabulary is free text.** Closing it into an enum is
   the prerequisite for counting or sampling rejections. It must be added as a
   NEW column: four consumers match the reason TEXT - `adjudicate-rejections.ts`
   twice, `classifier-report.ts`, `audit-connector-conversion.ts` - so each
   migrates individually, or the rescue tool silently matches nothing again.
4. **10,502 rejected rows carry no reason.** The source is fixed going forward.
   A backfill via `reclassify-listings.ts` is now SAFE - it preserves
   `reviewAgent` verdicts, which it previously discarded, which would have
   re-spent the whole model budget. Some reasons cannot be recovered.
5. **Reason reporting on the other 20 connectors.** Only `generic` sets
   `inconclusiveReason`, so ~14% of failures still carry no cause. Do it
   through a shared `fetchFailureReason` rather than 20 copies.
6. **Enrolment still cannot see ATS slugs.** `careersCandidates()` now probes
   `careers.<host>` and `jobs.<host>` as well as same-host paths, so
   `careers.kroll.com` is reachable; `boards.greenhouse.io/<firm>` is not,
   because guessing an ATS slug is a different and riskier act. Likely the main
   cause of 0.2% conversion in asset & wealth management. Finding a real board
   cannot erode precision - no classification rule moves.
7. **Rule R5 is over-broad** - `\b(how to|what to expect|tips for|a guide to|q&a|takeover:)\b`
   in `posting-quality.ts`. Measure across all 9,782 titles before removing:
   its only two investment-banking hits are recruiting events already rejected
   elsewhere, so it carries risk without buying anything there.
8. **Per-source timeouts.** The timings now exist, so a learned per-source
   timeout can replace the single global 8s. This improves the median rather
   than trading it: a board answering in 500ms gets 2s, one needing 12s gets
   18s.
9. **The internship vocabulary is duplicated across four lists** -
   `TITLE_INTERNSHIP_PHRASES` and `CYCLE_WORDS` in `classify.ts`,
   `UNAMBIGUOUS_STUDENT_TITLE` and `STILL_STUDYING` in `llm-adjudicate.ts`.
   They are deliberately different lengths and must stay so: relevance is
   wider than proof-of-studenthood, and a word in `CYCLE_WORDS` lets a nearby
   year become a cycle. Consolidating means one source with explicit
   per-purpose subsets, not one list.
10. **The school rule is title-scoped.** A posting whose school audience is
    stated only in the body is not caught. One such listing exists today and it
    is the same one. Widening to the body would have to exclude "high school
    diploma or equivalent", which 58 relevant listings carry as a qualification
    floor.
11. **`fintech`, `market_infrastructure`, `private_credit` and `sales_trading`
    are unmeasurable** - 0 relevant listings each, so no sector comparison can
    include them.
12. **Coverage is 85 of 22,554 firms.** 4,995 monitored, 397 ever-yielding, 85
    with a live posting. 319 sources are homepage-only and need re-enrolling.
13. **Opening-window predictions yield one firm.** Observations are keyed on the
    calendar year a firm POSTED, not the cycle a role was FOR - keying on cycles
    passed 8 firms, 7 of which had both postings in the same calendar year
    (Leerink's two "years" were eight days apart). With only thirteen months of
    collection, one firm qualifies. It grows by itself; the Internet Archive
    path exists because the Archive can reach back years today and we cannot.
14. **Cross-process politeness.** The review agent and the crawl are separate
    processes with separate fetch pools, so per-host courtesy is not shared.
    Needs the crawler's participation.

(The numbering above shifted when four items were inserted; the ranking is
what matters, not the numbers.)

## Lessons that are now rules

- **Judge a candidate word by reading every listing it would affect, never by
  how few there are.** `praktikum` was added to `CYCLE_WORDS` because it
  rescued one listing, and removed because that listing was a careers week for
  school pupils. A cycle is the last gate before publishing.
- **Measure with the pattern that will ship.** A school-rule pattern was
  "measured" with a boundary-free SQL `~*` and carried a trailing `\b` that
  matched neither word it was written for - German compounds append. Corpus
  checks now run through `classifyListing` itself.
- **A test that cannot fail is worse than no test.** Two this session: one
  fixture had a full stop where the rule forbids one, so it passed whether or
  not the rule existed. Re-break the code and watch the test go red.
- **The pre-filter may be wider than the publishing rule, and that asymmetry
  is deliberate.** `UNAMBIGUOUS_STUDENT_NOUNS` in llm-adjudicate knows words
  `TITLE_INTERNSHIP_PATTERN` does not. That looks like drift worth tidying and
  is not: the first is a pre-filter where a false positive costs one model
  call, the second PUBLISHES, where a false positive puts a full-time job in
  front of a student as an internship. It was closed in the wrong direction
  here, and `scripts/test/title-pattern-languages.test.ts` failed and said so -
  it had been written specifically to stop that. A word belongs in the
  publishing rule only once the corpus produces a posting to check it against.
- **Build the real object in a measurement, never cast past the type.** Every
  corpus re-classification in this session built its listing without
  `externalJobId` and used `as never`, so `posting-quality` fired on 4,381 real
  postings and 77 phantom "needs re-enrichment" rows were reported. The cast
  silenced the error that would have caught it on the first run. A helper that
  builds a `NormalizedListing` from a database row would make this a compile
  failure.
- **A derived window needs two years behind it, and must not outrank a
  sighting.** A first attempt wrote free text into
  `firm_monitoring_sources.historical_opening_window`, bypassing the
  `opening_signals` precedence and calling one cycle's date a window for 38 of
  45 firms. All 55 writes were reverted; the record is in
  `scripts/data/opening-windows-2026-10-13.reverted.json`.

## Standing rules this work must obey

- **Every crawler audit and fix covers all 14 sectors and reports per sector.**
- **Only real postings reach students.** Zero non-internships published is a
  property worth protecting.
- **Content limits** (`src/lib/content-limits.ts`) on every place a person can
  type words; the coverage test must report 0 missing.
- **Other sessions edit this checkout live. Stage only your own files**, and
  never `git stash` - the stack is shared.
- Scripts open the database via `openScriptDb()` from `scripts/_db.ts`, never
  `new PGlite` - `scripts/test/script-db-guard.test.ts` enforces it.
- Anything that changes live data is recorded to a dated file under
  `scripts/data/` **before** the write.
- Migrations replay from 0006 in ONE transaction, so every statement must be
  idempotent and a multi-statement file needs `--> statement-breakpoint`.
  Getting this wrong breaks every deploy, not just the migration.
- `detected_listings` is never deleted - it is the only record of when a firm
  posted. Enforced by `scripts/test/history-is-never-deleted.test.ts`.

## Gates

```bash
npm test                                          # ~22,800 tests
npx tsc --noEmit -p tsconfig.json
npx tsx scripts/content-limits-coverage-test.ts   # must report 0 missing
npx tsx scripts/content-limits-test.ts            # must report 162/162
npm run build                                     # PRs here run no build
```

Run them **one at a time**. Three concurrent suites against the shared database
produce failures in all three that look real and are not; a 30-minute
three-way stall this session was self-inflicted that way.

A fresh worktree has no `.next/types`, so `tsc` reports one phantom error
(`LayoutProps` in `src/app/layout.tsx`) until those generated types exist.
Copy them from a built checkout; it is not a real failure.

Also check `~/offerly-audit/last-scheduled-run.txt`. The database CA
certificate was being read from a Dropbox CloudStorage path, which evicts
files - **59 of 106 scheduled runs failed on it**. It now reads from
`~/.config/offerly/supabase-ca.pem`. If `FAILED monitor-run` entries have
stopped, the fix held.
