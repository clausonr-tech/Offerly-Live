# The review call's thinking was buying nothing, and costing half the wait

12 October 2026. Three arms of 20 situations on the **API path**, one call in
flight, run back to back in one sitting so API load is shared, then graded
blind. Everything is in `scripts/audit-probe/review-config-2026-10-12/` —
the timings, the emails, the verdicts and the script that produced them.

```bash
scripts/audit-probe/review-config-2026-10-12/run.sh <outdir>   # the three arms (~$1.58)
npx tsx scripts/draft-reply-grader.ts --input=<outdir>/C-low-nothink-drafts.json --arm=post
```

---

## 1. Why this was worth looking at

`audit/LATENCY-API-2026-10-12.md` found that the review call is **~72% of what a
student waits** and the draft only ~21% — the reverse of what every latency idea
in this project had assumed, because the `claude` CLI rig the project times on
has no `effort` and no `thinking` setting and so cannot see this axis at all.

Reading the configs then gave the cause away for free. The review was the only
call in the pipeline not running at the cheapest setting:

| | model | effort | thinking |
|---|---|---|---|
| draft | sonnet 5 | `low` | `disabled` |
| **review** | sonnet 5 | **`medium`** | **`adaptive`** |

And the token counts confirmed it: the review emitted a mean of **2,541 output
tokens** — 79% of every output token the pipeline spends — to return a subject,
a body and a handful of `problems`, which for a 140-word email is about **320
tokens of actual answer**. The other ~2,200 were thinking.

The justification in the code was *"adaptive thinking at medium effort gives it
room to compare every claim with FACTS before editing"*. Plausible, and never
measured.

## 2. The arms

| arm | review config |
|---|---|
| **A** (control) | `effort: medium`, `thinking: adaptive` — what shipped |
| **B** | `effort: medium`, `thinking: disabled` |
| **C** | `effort: low`, `thinking: disabled` |

The draft config was not touched in any arm, which is the control that matters:
**draft p50 was 7,368 / 7,384 / 6,820 ms** across A / B / C. Whatever moved, it
was the review's own config and not the weather.

The control arm also reproduces the earlier standalone run almost exactly —
median total 31.2 s against 31.3 s, $0.72 against $0.74 — so the measurement
is stable across sittings.

## 3. What moved

| | A (shipped) | B | **C (chosen)** |
|---|---|---|---|
| **review call, p50** | **21,548 ms** | 6,432 ms | **5,840 ms** |
| total, p50 | 31,181 ms | 15,376 ms | **13,060 ms** |
| **total, p90** | **61,515 ms** | 24,377 ms | **24,277 ms** |
| total, mean | 31,196 ms | 16,473 ms | **14,366 ms** |
| output tokens, 20 situations | 62,494 | 34,127 | **29,666** |
| cost, 20 situations | $0.72 | $0.46 | **$0.40** |
| guard retries | 4 of 20 | **8 of 20** | 4 of 20 |

**The tail is the part to care about.** A student's worst case goes from
**61.5 s to 24.3 s**. The median halves; the ninetieth percentile falls by
two thirds.

## 4. What did not move: quality

Graded blind by `scripts/draft-reply-grader.ts`, pinned model and prompt sha,
one call per email, no knowledge of which arm it came from.

| | A | B | **C** |
|---|---|---|---|
| emails that ask, would reply | 14 of 14 | 13 of 14 | **14 of 14** |
| off-putting | 0 | 0 | **0** |
| `reads_machine_written` | 0 | 0 | **0** |

And on the voice metrics the review exists to fix:

| | A | B | **C** |
|---|---|---|---|
| contractions per email, after review | 3.10 | 3.20 | **3.10** |
| **emails shipping with no contraction at all** | **4** | 2 | **0** |
| canned courtesy lines | 0 | 1 | 1 |
| words per email | 138.2 | 139.9 | 141.4 |

C is the arm that leaves **no** email reading robotic — the number D56 names as
the one to watch, since a contraction *count* turned out to be a proxy that has
decoupled from the outcome. A's thinking did not buy a better-sounding email; on
this measure it produced four worse ones.

## 5. Why C and not B

B fixes more of the pipeline's own-facts findings — **18 → 5**, against A's
19 → 10 and C's 18 → 9 — which is the one number that favours it. Against that,
B costs a reply (13 of 14), **doubles the guard's retries** (8 of 20 against 4),
and is slower than C because of those retries. Its own mean, 16.5 s, sits above
its median, 15.4 s, for exactly that reason.

C keeps the control's reply rate, the control's retry rate and the control's
own-facts result, and is the fastest and cheapest of the three.

**The 18 → 5 is the one thing in this report worth a confirmation run.** At
n=20, a findings count moving 10 → 5 is suggestive and not settled, and if B's
advantage is real then `effort: medium, thinking: disabled` is worth another
look. Nothing else here is close enough to the noise to need it.

## 6. What this does not say

- **n = 20, one sitting, one account.** The three arms share their conditions,
  which is what makes them comparable with each other; none of them is a
  service-level characterisation.
- The grader's `ask` bucket is **14 emails**. A one-reply difference between
  arms is at the edge of what that can resolve, which is why C was chosen on
  latency, retries and the voice floor rather than on 14 versus 13.
- This is the **free plan's** review path. Nothing here was measured on Opus.
- The 20 situations are `draft-live-eval.ts`'s own `PICKS` (17 full, 3 sparse).

## 7. The transferable part

**A config that was never measured sat in the hot path for a month, and the
rig the project trusted could not see it.** The CLI has no `effort` and no
`thinking`, so every latency number before 12 October was blind to the single
biggest lever in the pipeline — and the CLI's *total* was close enough to right
that nobody went looking. $1.58 and one sitting settled it.

The companion lesson is in D54: a measurement rig that is right about the
aggregate can be wrong about every component, and a total is not a check on
its parts.

---

# Addendum, 13 October 2026: arm B settled, and the answer is "keep what shipped"

§5 above left one claim open — arm B (`effort: medium`, thinking off) cleared
more of the pipeline's own-facts findings than the chosen arm C (`effort: low`,
thinking off), but cost a reply and doubled the guard's retries, and at n=20
that was suggestive rather than settled. Re-measured on today's code, with a
fresh control in the same sitting because the prompt has moved since.

Runs: `scripts/audit-probe/review-config-armb-2026-10-13/`.

| | C — `low` + off **(shipped)** | B — `medium` + off |
|---|---|---|
| own-facts findings cleared | 23 → 15 (**35%**) | 19 → 8 (**58%**) |
| review edit applied | 16 of 20 | **19 of 20** |
| guard retries | **7** of 20 | **5** of 20 |
| review call, p50 | **6,353 ms** | 6,620 ms |
| median total | 15.1 s | **14.5 s** |
| cost per 20 | $0.43 | $0.43 |
| **emails that ask, would reply** | **14 of 14** | **13 of 14** |
| off-putting / machine-written | 0 / 0 | 0 / 0 |

**The retry objection was wrong.** Arm B doubled retries in the October 12 run
(8 against 4); today it *halved* them (5 against 7). That half of §5's argument
does not survive, and should not be quoted again.

**The one-reply gap repeats, but not on the same email.** B was 13 of 14 both
times. On 12 October the emails it lost were 650 (`keep_in_touch`) and 651
(`close_loop_referrer`); today the only ask-bucket difference is 825
(`second_conversation`), and B *gained* 656 (`redirect_sequence`) while C lost
it. A gap that reproduces in aggregate but moves between emails is the shape of
a one-email noise floor, not a deficit — consistent with the floor this project
has measured twice elsewhere (21 of 58 metrics on a re-run; one of 16 sparse
emails flipping on a prompt it could not see).

## The decision: no change

Arm B is better on three metrics that held up and indistinguishable on the
fourth. It is still not being taken, for one reason: **the reply rate is this
project's declared single metric**, B does not win it, and B's advantage is on
`issuesPost` — which the draft-pipeline handoff note §9 records as having a noise band of ±4 and
being "unusable at this n". Trading the declared metric for a demoted proxy, on
20 scenarios, is the wrong way round.

**What would change the answer:** the same two arms at n≈60, where a one-email
reply difference stops being noise and a findings difference of 8 against 11
starts being real. That is about $1.30 of API time, and it is the only open
question left on the review's configuration.

## Replication, same day: arm B's advantage does not reproduce

The addendum above closed on "the same two arms at n≈60 would settle it". What
was affordable was a replication at n=20, which for "is this real" is the more
useful of the two. Run 2 is in `review-config-armb-2026-10-13/run2/`.

| | own-facts findings cleared | guard retries | median total | drafted |
|---|---|---|---|---|
| run 1 — C (`low` + off, shipped) | 23 → 15 (**35%**) | 7 of 20 | 15.1 s | 20/20 |
| run 1 — B (`medium` + off) | 19 → 8 (**58%**) | 5 of 20 | 14.5 s | 20/20 |
| run 2 — C | 21 → 15 (**29%**) | 5 of 20 | 14.1 s | 20/20 |
| run 2 — B | 16 → 11 (31%) | 7 of 20 | 15.8 s | **18/20 — VOID** |

**Arm B's run 2 is formally void.** Two of its twenty scenarios errored, and
the draft-pipeline handoff note §9's rule is explicit: `errored > 0` means the run is not
comparable, discard it. The errors were not a config problem —

> 400 invalid_request_error: Your credit balance is too low to access the
> Anthropic API.

— the account ran out of credit mid-run. Recorded because it is the reason this
line of work stops here, not because it says anything about arm B.

**What the valid data says.** Two clean C runs, 35% and 29% cleared, which agree
with each other. One clean B run, 58%. A single high number against two
consistent ones is unreplicated, and the retry count — the other half of the
original argument — **flipped between runs on both arms** (C 7 then 5, B 5 then
7), which is what noise at n=20 looks like.

**The decision is unchanged and now better supported: keep `low`.** Arm B's
58% was one run. The reply rate, which is this project's declared metric, never
favoured it. Nothing further should be spent on this without a reason to expect
a different answer.
