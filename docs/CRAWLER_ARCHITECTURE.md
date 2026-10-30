# The application crawler: how it works

**Written 11 October 2026.** Every count here is a snapshot taken that day; the crawl runs hourly, so they move.

Measured from the code and from 28,597 recorded check runs
(3 September – 10 October). Supersedes the "How it works" sections of the
earlier internal crawler notes, which are not part of this repository and
described a 110-firm crawl that is now 5,102 sources.

Every number here is measured, not estimated. Where a number is the *reason*
a piece of the design exists, it is given at that piece.

---

## What it is for

One question, asked of 5,102 career boards on a schedule: **has this firm
posted an internship a student on Offerly could apply to?**

Everything below exists to answer that without (a) asking any one host too
often, (b) spending the run on boards that never answer, or (c) publishing
something to a student that is not a real, live internship.

---

## The shape of the whole thing

```
                     ┌──────────────────────────────────────┐
                     │ scripts/monitor-run.ts               │  the only entry point
                     │   npm run monitor:run -- --limit N    │  (launchd: scheduled-crawl.sh)
                     └──────────────────┬───────────────────┘
                                        │
           ┌────────────────────────────▼────────────────────────────┐
  SELECT   │ which sources are due                                   │
           │   season band → tier → priorityScore → nextCheckAt      │
           │   LIMIT N, ordered in SQL                               │
           └────────────────────────────┬────────────────────────────┘
                                        │ dueSources[]
           ┌────────────────────────────▼────────────────────────────┐
  DISPATCH │ 16 workers pull from one shared index                   │
           │   each source wrapped in withBudget (180s, CANCELS)     │
           └────────────────────────────┬────────────────────────────┘
                                        │
           ┌────────────────────────────▼────────────────────────────┐
  FETCH    │ fetch-pool: per-host gap FIRST, then a concurrency slot │
           │   12 slots · 2s/host · 10s for apply.workable.com      │
           │   safe-fetch: SSRF-checked every hop, 20s/hop, abortable│
           └────────────────────────────┬────────────────────────────┘
                                        │
           ┌────────────────────────────▼────────────────────────────┐
  READ     │ connector.fetch(source) → listings[] + contentHash      │
           │   21 ATS connectors, else the generic browser connector │
           └────────────────────────────┬────────────────────────────┘
                                        │
                    ┌───────────────────▼───────────────────┐
                    │ 304 or contentHash unchanged?         │──yes──► "no_change", done
                    └───────────────────┬───────────────────┘
                                        │ no
           ┌────────────────────────────▼────────────────────────────┐
  DIFF     │ vs detected_listings → { confirmed, new, missing }      │
           └────────────────────────────┬────────────────────────────┘
                                        │
           ┌────────────────────────────▼────────────────────────────┐
  ENRICH   │ connector.enrich() on NEW first, likely-internships     │
           │   first. Resumable: backfillThinListings runs every     │
           │   check, including unchanged ones.                      │
           └────────────────────────────┬────────────────────────────┘
                                        │
           ┌────────────────────────────▼────────────────────────────┐
  CLASSIFY │ 1. is it a posting at all?      posting-quality.ts      │
           │ 2. is the cycle live?           posting-quality.ts      │
           │ 3. is it an internship?         classify.ts (TITLE only)│
           │ 4. who may apply?               eligibility.ts          │
           │ 5. what is required?            requirements.ts         │
           └────────────────────────────┬────────────────────────────┘
                                        │
              rejected ◄────────────────┴────────────────► auto_approved
                   │         (binary - no queue)                 │
                   │                                             │
                   ▼                                             ▼
         firm_recruiting_events                        internship_postings
         (info sessions, coffee chats)                        │
                                                              ▼
                                                         user_alerts
```

No board at all? The **announcement watcher** diffs the page's prose against
`lastPageText` and writes an `opening_signal` when a sentence *appears*.

---

## Stage by stage

### 1. Selection — which 110 of 5,102

One ordered SQL query, not a filter in JavaScript (that mattered: the old
version loaded every row and `--firm X --force` stopped working entirely once
the set passed ~4,900 rows with two lateral joins each).

Order of precedence:

| Key | Meaning |
|---|---|
| season band | sectors with applications open, then rolling, then out of season |
| tier | critical 20min · high 2h · standard 12h · discovery 7d · inactive |
| `priorityScore` | sector rank (≤30) + student demand (≤20) + verified programme (15) + AUM tier (≤10) + internship history (10) + rolling (5) − health penalty, plus an opening-window boost (≤50) |
| `nextCheckAt` | oldest first, as the tie-break |

The opening-window boost is the only part that is transient: it is recomputed
from today's date against Internet-Archive-derived history, decays to zero on
its own, and may only ever move a source **up** the queue.

`priorityScore` is a stored column, recomputed on the failure path and by
`scripts/recompute-priority-scores.ts`.

### 2. Dispatch — 16 workers, one index

Workers rather than a `for` loop, pulling from a shared `nextIndex`. The loop
was the bottleneck: it used one of the pool's slots and left the rest idle.
Concurrency bought roughly eighteen-fold parallelism (a run doing 1,492
seconds of work in 80 seconds of wall clock).

What bounds a run now is its **slowest single source**, and no amount of
concurrency divides one source across workers. Hence the budget.

**`withBudget` — 180 seconds per source, and it cancels.** This is new as of
11 October 2026. It used to be `Promise.race([run(), budget])`, which stopped
the *worker* waiting and left the check running: `changed` runs averaged 1,141
seconds against the 180-second budget, with a p95 of 18,002 seconds, a maximum
of 36 hours, and 38 rows left permanently in flight — each abandoned check
still holding a pool slot, a database connection and a Chrome tab.

Cancellation is carried ambiently (`lib/monitoring/deadline.ts`,
`AsyncLocalStorage`) rather than threaded through all 21 connector signatures.
That is deliberate: a connector that *forgot* to pass a signal would compile,
run, and silently be uncancellable — the same failure shape as the script that
forgot `DATABASE_URL`. `safeFetch` and the generic connector's page helper
read the ambient signal; outside a `withAmbientSignal` there is no signal and
nothing changes.

Nothing is lost when the budget fires: the source keeps its place in the
schedule, enrichment is resumable, and a listing already written stays written.

### 3. Fetch — two different protections

`lib/monitoring/fetch-pool.ts` holds two limits that are often confused:

- **`MIN_GAP_MS_PER_DOMAIN` (2s) is politeness.** One promise-chain queue per
  host, so a host is never asked twice inside the gap however busy the crawl
  is. Chained, not timestamp-compared — the timestamp version did nothing
  under concurrency, which is the only situation it existed for.
- **`MAX_CONCURRENT` (12) is a cap on our own machine** — sockets, memory, and
  the one Chromium the generic connector shares.

`VENDOR_MIN_GAP_MS` overrides the gap per host where the vendor has said so:
`apply.workable.com` gets 10 seconds, because all thirteen Workable sources
(then; 58 now) answered 429 at the default and they all share that one host.

**The gap is waited out BEFORE a concurrency slot is taken.** Also new on
11 October. The two awaits were the other way round, so a worker held a slot
while merely sleeping — and 58 sources on a 10-second host could hold all 12
slots for two minutes, stalling the other 5,044 on a vendor they have nothing
to do with. Sleeping outside a slot costs a timer. A source now waits for its
host *and then* for a slot, so its real spacing can only ever be longer than
the gap, never shorter.

`lib/monitoring/safe-fetch.ts` checks **every hop** against private address
ranges (`redirect: "follow"` would let a page bounce us somewhere
`assertPublicUrl` had already refused), pins the checked address to the
connected address against DNS rebinding, and applies a 20s per-hop timeout
*on top of* the run's budget.

`lib/monitoring/robots.ts` is consulted before a browser is launched, so a
disallowed page costs a fetch rather than a Chromium.

### 4. Read — 21 connectors and one fallback

| Connector | Sources |
|---|---|
| generic (browser) | 4,773 |
| bamboohr | 97 |
| greenhouse | 62 |
| workable | 58 |
| getro | 26 |
| workday | 20 |
| ashby, lever | 12 each |
| dayforce, recruitee | 8 each |
| talentlink | 7 |
| breezy | 6 |
| oracle-hcm | 5 |
| icims | 4 |
| eightfold | 2 |
| goldman, jobvite | 1 each |

**93.6% of sources are on the generic connector**, which is why its internal
ordering matters so much. It is **static fetch first, browser only on
failure**: a browser costs roughly a second of CPU and ~100× the memory, and
many career pages serve their listings in the served HTML or in JSON-LD. A
404 is never re-rendered — a dead page is dead, and rendering it would spend a
browser launch to rediscover the same 404.

**The two stages have separate budgets** (11 October 2026). One constant used
to govern both, so a hanging host paid 20 seconds for the fetch and then a
browser launch and another 20 for the navigation — which is how a single
source reached 53.5 seconds against a 4.4-second median. The static fetch now
gets 8 seconds, measured: across 24 random generic sources that answer, it
took a median of 934ms, a p90 of 1,470ms and a maximum of 1,981ms. The render
keeps 20 seconds, which a heavy corporate site legitimately needs.

**And a failed static fetch does not always earn a render.** Four reasons
refuse it — `dns_unresolved`, `connect_refused`, `invalid_url`,
`redirect_limit` — each checked against a real browser rather than argued:
Chromium reports the same `ERR_NAME_NOT_RESOLVED` and
`ERR_CONNECTION_REFUSED`. `tls_error` deliberately still renders, because
Chromium performs AIA chasing to complete an incomplete certificate chain and
Node's undici does not; so does `static_timeout`, because a stalled plain GET
is the canonical reason to try a real browser. See `shouldEscalateToRender` in
`lib/monitoring/fetch-reason.ts`.

**The render waits for listings, not for the network to go quiet.** It used to
navigate on `networkidle2` — at most two connections for 500ms — which an
ordinary careers page reaches in about 1.7 seconds and a site with analytics
or a chat widget never reaches at all, burning the full timeout and then
throwing, so the page was reported unreadable rather than slow. It now
navigates on `load` and polls for candidates every 400ms up to 1,500ms,
stopping the moment any appear. Measured through the real connector against
the twelve highest-yielding generic sources: **0 listings lost, 51 gained** —
Morgan Stanley's TalentLink board had been returning nothing — at the same
wall time as before. `OFFERLY_RENDER_WAIT=networkidle2` restores the old
behaviour without a deploy.

Every connector returns a `contentHash` **derived from the normalised
listings, not the page HTML**. Career pages carry rotating banners, CSRF
tokens and build ids, so a page hash reports "changed" on almost every check;
worse, a page can be byte-identical while a listing's detail changes behind a
stable URL.

`truncated` is set by connectors that can hit a ceiling (the generic candidate
cap, iCIMS's page cap). It exists because the caller **closes** stored
listings absent from a fetch, and "there was more and we stopped" is the
opposite fact from "those postings ended".

### 5. The scheduler's two counters

This is the part most worth understanding, because the two look alike and mean
opposite things.

| | `failureCount` | `consecutiveInconclusive` |
|---|---|---|
| set by | a real answer that something is wrong (404, 4xx other than 403) | no answer at all (0, 403, 408, 429, 5xx) |
| affects `sourceHealth` | yes — degraded at 2, broken at 5 | **never** |
| retry | exponential, to 24h | 15/30/45min while patient, then doubling to a 24h cap |
| reset by | any successful read | any successful read |

`isInconclusive()` keeps 403 and 429 off `failureCount` on purpose. A 403 is a
CDN refusing to serve *us* and says nothing about whether the firm has
internships; two real investment banks were three strikes from being written
off. A 429 is a vendor asking us to slow down, and the only correct response
is to slow down.

**`consecutiveInconclusive` is new on 11 October 2026 and closes the hole that
fix left.** The retry interval was `inconclusiveRetryMs(failureCount + 1)` —
called from the one branch that deliberately never increments `failureCount`.
The argument was therefore permanently 1, the growth written inside that
function was unreachable, and a board that answers nothing was asked every
15 minutes indefinitely. Measured:

- **351 sources had never once produced a successful read** across 3+ attempts.
- They had consumed **12,902 of 28,597 check runs — 45% of the entire crawl.**
- **319 of the 351 still read `failure_count = 0`**, i.e. healthy.

Per sector, share of runs that were inconclusive:

| sector | runs | inconclusive | never-answered sources |
|---|---|---|---|
| consulting | 99 | 95% | 1 |
| sales_trading | 42 | 93% | 1 |
| insurance | 205 | 86% | 6 |
| other_finance | 2,047 | 77% | 51 |
| asset_wealth_management | 6,634 | 70% | 120 |
| hedge_fund | 4,771 | 67% | 66 |
| private_equity | 8,172 | 61% | 67 |
| real_estate | 900 | 57% | 20 |
| market_infrastructure | 7 | 57% | 0 |
| commercial_banking | 81 | 53% | 3 |
| venture_capital | 1,512 | 49% | 12 |
| **investment_banking** | **3,897** | **16%** | **1** |
| fintech | 4 | 0% | 0 |

Investment banking at 16% against 49–95% everywhere else is the signature of
a crawler designed and tuned on the one sector that has ATS connectors. The
other thirteen inherited the schedule without the coverage.

`Retry-After` still wins outright inside the patience window — it is the
vendor's own statement about its own load. Past it, it becomes a **floor**:
"try again in 30 seconds" on the two-hundredth attempt is not an instruction
to keep asking every 30 seconds forever.

### 6. Classification — five gates, in this order

`posting-quality.ts` first, because the cheapest rejection is the one that
never reaches the classifier:

1. **Is it a posting at all?** Navigation furniture ("Find Summer Analyst
   Programs") renders as a link and is not a job.
2. **Is the recruiting cycle live?** A 2024 posting still on a board is not an
   opportunity.
3. **Is it an internship?** `classify.ts` — **title only, deliberately.** A
   description mentioning an internship programme is not a posting for one.
4. **Who may apply?** `eligibility.ts` reads "Class of 2028", "rising senior",
   "Anticipated graduation date: Fall 2027 – Spring 2028" deterministically
   and costs nothing.
5. **What is required?** `requirements.ts`.

Outcome: `rejected` · `auto_approved` — binary, decided by
`publishableWithoutReview`. There is no queue; a rejection states its reason
and is recoverable (`reclassify-listings.ts`).

**A rejection is not a deletion.** A listing rejected as an event is filed
into `firm_recruiting_events` and shown on the firm page, with an "add to my
calendar" action that reads every word **from the row, not the form**.

`board-collapse.ts` degrades a source that went from having listings to having
none — checked on *both* success paths, since a rule guarding only one would
fire on a quiet board and stay silent on a busy one. A 304 or an unchanged
hash can never be collapse evidence: such a read carries no listings by design.

### 7. The model is not in the crawl

The hot path is entirely deterministic. The two LLM stages are **separate,
offline scripts**:

- `scripts/backfill-eligibility.ts` → `llm-extract.ts` (Haiku) for eligibility
  stated in prose a phrase list cannot match.
- `scripts/adjudicate-rejections.ts` → `llm-adjudicate.ts` for listings
  `rejected` on a recruiting-cycle question, or on the title phrase list alone.
  It records its evidence on the row and never moves the status.

Both carry the same contract: **quote verbatim or be discarded.** An answer
whose quote does not appear in the text it was given is thrown away rather
than trusted — that is the whole safety property, not a formality. A model
asked to copy a sentence and checked against the source cannot invent a
graduation year, because the invention has nowhere to hide.

Job descriptions are untrusted third-party text, so: passed as data inside a
delimiter, system prompt says instructions inside it are content to be read
rather than followed, output schema-constrained, and **everything coming back
goes through `findBlockedLanguage`** — it is about to be shown to a student
either way.

### 8. Publication

`promote-approved-listings` moves `auto_approved` rows into
`internship_postings` and writes `user_alerts`. The crawled copy is filtered
through the blocked-language check on the way, because it is text from pages
we do not control being shown to a student.

Only `isRealPosting` rows reach students: if it is not in the Internships tab,
it must not appear anywhere else.

---

## Where the data lives

| Table | Role |
|---|---|
| `firm_monitoring_sources` | 5,102 rows — one board, its tier, score, schedule and both counters |
| `monitoring_tiers` | 20min / 2h / 12h / 7d / inactive |
| `monitoring_check_runs` | per-source audit trail, one row per check |
| `detected_listings` | 20,938 rows — what each board showed, with classification |
| `internship_postings` | 1,186 rows — what students see |
| `firm_recruiting_events` | what the classifier rejected as an event, not a job |
| `opening_signals` | Archive-derived predictions and announcement hits |

**Every script opens it through `scripts/_db.ts`.** This was not true until
11 October 2026: `src/db/open.ts` switched on `DATABASE_URL` but only five of
49 scripts used it, so the crawler wrote 28,597 runs into Supabase while
`crawl-status.ts`, `crawl-inspect.ts`, `classifier-report.ts`,
`verify-classifier-corpus.ts` and every `audit-*.ts` read `local-data/pglite`,
last written 21 September — twenty days stale, reported as current.
`adjudicate-rejections.ts` *wrote* its verdicts there.
`scripts/test/script-db-guard.test.ts` now fails the suite if a script
constructs PGlite directly, with an allowlist for the five tools whose subject
genuinely *is* a PGlite directory.

---

## Operating it

```bash
lsof -i :3001 -sTCP:LISTEN -t                  # local PGlite only; moot on hosted Postgres
npm run monitor:run -- --limit 25              # a crawl
npm run monitor:run -- --firm "Kroll" --force  # one firm, ignoring its schedule
npx tsx --env-file=.env.local --conditions=react-server scripts/crawl-status.ts
```

Knobs, all environment variables because the right value is a property of the
machine and the database plan rather than of anything the code knows:

| | default |
|---|---|
| `OFFERLY_FETCH_CONCURRENCY` | 12 |
| `OFFERLY_CRAWL_WORKERS` | 16 |
| `OFFERLY_SOURCE_BUDGET_MS` | 180,000 |
| `OFFERLY_DB_POOL` | 12 |

Raising fetch concurrency further is not worth much: measured 20 September,
60 sources each way, 90 seconds at a cap of 4 and 80 seconds at 12 — 11%,
because the pool stopped being the constraint once the crawl went concurrent.

---

## What is still wrong

1. **Nobody has ever reviewed a listing.** `reviewed_by` is NULL on all
   21,716 rows. The review queue held 705 open listings, and reviewing it
   showed it was not full of hard calls — it was full of search links, nav
   links, articles about applying ("How to Land a Balyasny Internship"),
   press releases and site sections. Five rules in `posting-quality.ts` now
   reject those by name, each measured against all 9,411 distinct stored
   titles with no false positives. What remains in the queue after that is
   the real question, and it is small.
2. **3,244 listings were classified as genuine internships and abandoned**
   when they closed unreviewed — `monitor-run.ts` retires an unreviewable
   queued listing on closure. So `review_status = 'rejected'` conflates
   15,240 real classifier rejections with 3,244 abandonments, and any
   accuracy metric computed over "rejected" measures a mixed population.
3. **One non-internship reached students.** "Search for graduate and intern
   roles" is live with `is_active = true`. The new rules catch it; the
   reclassify that would retract it is held because it would also retract
   141 others, and those depend on the open question below.
4. **Is bank Internal Audit in scope?** 83 listings turn on it. The
   accounting-practice exclusion treats "2027 Internal Audit Summer Analyst
   Program" at a bank the same as a Big 4 audit practice, and the rule's own
   comment calls that deliberate. Until it is settled, do not run
   `reclassify-listings.ts --apply`: it would retract 142 published postings,
   correctly for tax and assurance interns and programme-family pages,
   wrongly for internal audit if these are in scope.
5. **The accuracy of the gates is unmeasured.** The only labelled set is 30
   hand-written incident cases. `TITLE_INTERNSHIP_PATTERN` is the sole reason
   for 8,441 rejections — 46% of all of them — and has never been measured.
   A trustworthy figure needs roughly 1,200 stratified labels.
6. **Per-stage timings are not stored.** `response_bytes` is now real rather
   than always 64, but there is still no record of how long the robots check,
   the static fetch, the render and the detail fan-out each took. Six
   separate investigations on 11 October 2026 had to measure it by hand; a
   `timings` column would have made each one a single query.
7. **38 check-run rows sit unfinished** from 7 October, debris from before
   the per-source budget cancelled work. They inflate every "in flight"
   count. The budget's own cleanup is now scoped to the current attempt so it
   cannot mislabel them.
8. **Docs drift.** the earlier internal crawler notes describe 110
   firms and ~456 checks a day. Both are a year of growth out of date and
   point here.

---

# Appendix: the algorithm, step by step

Precise enough to reimplement. Every predicate below is in the code at the
file named beside it.

## Phase 0 — startup

1. `openScriptDb()` → Postgres when `DATABASE_URL` is set, else PGlite from
   `PGLITE_DATA_DIR` (no default — the default was the directory lost on
   18 September 2026, and silently opening it cost two sessions).
2. Parse `--limit N` (default 10), `--firm <substring>`, `--force` (requires
   `--firm`), `--all`.
3. Compute the season band per sector (`season.ts`): `0` applications open,
   `1` rolling, `2` out of season.

## Phase 1 — selection

```
SELECT * FROM firm_monitoring_sources
WHERE (force ? TRUE : next_check_at <= now())
  AND (firmFilter ? firm_id IN (SELECT id FROM firms WHERE name ILIKE %f%) : TRUE)
ORDER BY seasonBand(sector_category) ASC,
         tier.check_interval_minutes ASC,
         priority_score DESC,
         next_check_at ASC
LIMIT N
```

`priority_score` (`priority.ts`), recomputed on failure and by
`recompute-priority-scores.ts`:

```
score  = sectorWeight(rank, 14)            # ((14 - rank + 1) / 14) * 30, rank clamped 1..14
       + min(20, topFirmCount * 4)         # students who top-listed the firm
       + (firm.hasVerifiedProgram ? 15 : 0)
       + aumTierBonus(aum, sector)         # 10 / 6 / 3 at $100B / $10B / $1B, AUM-relevant sectors only
       + (source.hasConfirmedInternshipHistory ? 10 : 0)
       + (source.isRolling ? 5 : 0)
       - (health == "degraded" ? 10 : health == "broken" ? 25 : 0)
       + openingWindowBoost                # 0..50, recomputed from today, POSITIVE ONLY
```

Then one query reads every `prediction` opening signal for the whole run (not
one per source) into `windowByFirm`.

## Phase 2 — dispatch

```
workers = min(OFFERLY_CRAWL_WORKERS=16, dueSources.length)
nextIndex = 0
each worker loops:
    i = nextIndex++;  if i >= len: return
    try   withBudget(source[i], () => checkSource(source[i], i))
    catch isPoolExhausted(err) -> sleep 2-5s, retry ONCE, then log and continue
          otherwise            -> log UNCAUGHT and continue
```

`withBudget` owns a controller, a 180s timer and a race:
- at expiry it aborts the controller with a `BudgetExpired` (a `DeadlineExpired`
  subclass, so `fetch-reason.ts` names the failure as ours, not the board's)
- that signal goes to `run` BY PARAMETER, checked at every stage boundary in
  `checkSource` (`stopIfCancelled`) — which stops a cancelled source between
  stages, but cannot stop a read stuck inside one request
- and the SAME signal goes into ambient scope via `withAmbientSignal`
  (`deadline.ts`, AsyncLocalStorage), where `safeFetch` and the generic
  connector's `withPage` read it — that is what aborts the in-flight read
- the race stands in front of both: cancelling is cooperative, so a connector
  honouring neither must not be able to pin the worker
- on expiry: close the check run as `error`, log, move on. No failure charged,
  no health change, source keeps its place. The cleanup is bounded to runs
  started by THIS attempt, so it cannot mislabel an older unfinished row.
- a thrown error that is *not* this deadline's reason still propagates.

## Phase 3 — one source's check (`checkSource`)

1. **Skip** if the tier is `inactive` → push `next_check_at` +30d, return.
2. **Open a check run** row (`monitoring_check_runs`, `started_at = now()`).
3. **Compute this check's interval**:
   `intervalMs = applyUrgency(tier.checkIntervalMinutes * 60_000, windowUrgency(firm))`
   — a multiplier that may only ever *shorten*, floored at `MIN_INTERVAL_MS`,
   ×4 slower out of season.
4. **Pick the connector**: `connectors.find(c => c.canHandle(source))`, else
   `generic`.
5. **Fetch** inside `pooledFetch(url, task)`:
   - wait the host's turn, holding nothing (`max(2s, VENDOR_MIN_GAP_MS[host])`)
   - **then** take one of 12 concurrency slots
   - **then** sleep out any remainder of the gap since this host's last ISSUED
     request, re-measured after every wake
   - `safeFetch`: `assertPublicUrl` every hop, pinned DNS, ≤5 redirects,
     8s static / 20s render, abortable
   - `isAllowedByRobots` before any browser launch
6. **Branch on the result:**

```
if isInconclusive(status)            # 0, 403, 408, 429, 5xx
    attempt = source.consecutive_inconclusive + 1
    wait    = inconclusiveWaitMs(attempt, retryAfterMs)
            = attempt <= 3 ? (retryAfterMs ?? 15min * attempt)
                           : max(retryAfterMs ?? 0, min(24h, 45min * 2^(attempt-3))) * jitter(0.5..1.5)
    write next_check_at += wait, consecutive_inconclusive = attempt
    outcome = error, message "inconclusive: HTTP n (reason)"
    NO failure charged, NO health change
    return

if status >= 400                     # a real answer: 404, 401, 406 ...
    recordFailure()                  # failureCount++, health degraded@2 broken@5,
                                     # backoff min(24h, interval * 2^min(fc,5)),
                                     # consecutive_inconclusive = 0
    return

if notModified or contentHash == source.last_content_hash
    outcome = no_change
    health  = healthAfterSuccess(..., notModified = true)
    failureCount = 0, consecutive_inconclusive = 0
    backfillThinListings()           # still runs: enrichment is resumable
    return
```

7. **Diff** against `detected_listings` for this source, keyed on
   `externalJobId`: `{ confirmed, new, missing }`.
8. **Enrich** (`connector.enrich`, optional): NEW listings first, ordered by
   `TITLE_INTERNSHIP_PATTERN` match, only where
   `isThinDescription(description, title)` AND the listing was first detected
   within the last 7 days — `shouldRetryEnrichment`. Without that bound a
   permanently thin page was re-fetched on every check forever: 233 listings
   across 91 sources, one set for 38 days. Run in its *own* pool slot,
   outside the index fetch's slot, 25 at most with a 700ms gap between.
9. **Classify** each listing (`classifyListing(listing, source.sectorCategory)`):

```
quality = assessPostingQuality(listing)
    title length within [MIN_TITLE, MAX_TITLE]           # MAX measured on the
                                                         # title MINUS a trailing
                                                         # parenthetical, so a
                                                         # multi-city consulting
                                                         # posting is not "a paragraph"
    not a mailto:/contact-us stub, not a filter control,
    not a search or nav link, not an article about applying,
    not a press release, not a section of a site
          ↓ fail → rejected (not a posting), reason recorded
cycle   = deriveRecruitingCycle(listing)
    isStaleCycle(cycle) → rejected (cycle over)
internship? TITLE_INTERNSHIP_PATTERN against title + division ONLY
    — never the description: a description mentioning an internship
      programme is not a posting for one
    offProfessionReason(title, division) → rejected
    graduateAssociateReason(...)         → rejected
eligibility = readEligibility(description)          # "Class of 2028",
                                                     # "rising senior", date ranges
    empty → inferFromFirmPattern(firm)               # only from a sibling
                                                     # listing in THIS run
requirements = extractRequirements(description)
```

10. **Route**:
    - `relevant == false` → `rejected`; if it reads as an event, write
      `firm_recruiting_events` (shown on the firm page)
    - `publishableWithoutReview(c)` = `!c.needsHumanReview && c.recruitingCycle != null`
      → `auto_approved`
    - otherwise → `rejected`, with `reasonForUncertainty` naming which of the
      five conditions held it back. The same rule decides a re-read
      (`reviewStatusAfterReread`), so fresher evidence about the same listing
      cannot reach a verdict the first read could not.
11. **Close the absent** (`decideClosure`), in this order — each guard exists
    because skipping it recorded a live internship as closed:

```
status != "open"                 -> keep
seen in this fetch               -> keep
options.fetchFailed              -> keep  ("no board to be absent from")
options.truncated                -> keep  (checked BEFORE age: a capped board
                                           is capped on every check, so age
                                           would eventually clear the bar)
missingFor <= intervalMs * 1.5   -> keep  (one outage must not look like closure)
else                             -> close
```

12. **Write**, flushed in batches inside the loop rather than once at the end,
    so a mid-way failure loses a batch and not the board.
13. **Health** (`healthAfterSuccess` → `isBoardCollapse`): a board that went
    from having listings to having none is `degraded`, never on a 304, an
    unchanged hash, or a **truncated** read — each of those carries no
    listings by design, so none can be evidence that a board emptied.
14. **Update the source**: `last_attempted_at`, `last_success_at`,
    `next_check_at += intervalMs`, `failure_count = 0`,
    `consecutive_inconclusive = 0`, `last_etag`, `last_content_hash`,
    `last_page_text`.

## Phase 3b — the board-less path

A source whose connector returns no listings but does return `pageText`:

```
added = addedSentences(source.last_page_text, pageText)
detectAnnouncement(added) -> write an opening_signal
```

An opening is a sentence that **appeared**, not one that is present — matching
against the whole page would re-report the same evergreen line every cycle.
The first check can never raise an announcement, because there is nothing to
diff against. A render that fails after a successful static read still
reaches here: the static HTML is reported rather than discarded, which is the
only way a firm with no board is ever seen at all.

## Phase 4 — publication (separate step)

`promote-approved-listings` moves `auto_approved` → `internship_postings`,
filtering every field through `findBlockedLanguage` on the way, and writes
`user_alerts`. Only `isRealPosting` rows reach students.

## Phase 5 — offline, not in the crawl

- `scripts/backfill-eligibility.ts` → `llm-extract.ts` (Haiku) for eligibility
  stated in prose.
- `scripts/adjudicate-rejections.ts` → for listings stuck on a cycle question.

Both: **quote verbatim or be discarded.** An answer whose quote is not present
in the source text is thrown away. Output is schema-constrained and passes
through `findBlockedLanguage` before it can reach a student.
