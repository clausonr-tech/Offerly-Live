# News classifier: eval history

`npm run news:eval` scores a labeller against a golden set. Two golden sets
exist, and the second is the one that counts now:

- **golden-2.jsonl** (current): 500 stories collected on 29 September 2026.
  - 20 from regulators, 260 from trade and newsroom feeds, 220 from the majors.
  - Labelled by a strong model under the current rules, which include
    `speculative`, and opinion and consumer news allowed when they are about a
    sector.
  - Each story also carries a `qualityOk` verdict.
  - Tuned on the first 300 (`chunk-1..3`), reported on the other 200.
- **golden.jsonl** (older): 628 stories from 28-29 September, labelled before
  those rule changes. It is kept for history; its opinion and consumer labels
  are now out of date.

## The 500-story test (29 September 2026)

### Classifier alone, on the 200 held-out stories

| Classifier | Relevance precision | Relevance recall | Macro-F1 | Confident labels: precision / macro-F1 |
|---|---|---|---|---|
| Haiku, prompt v3 | 78.5% | 89.6% | 0.70 | 82.6% / 0.71 |
| Haiku, prompt v4 | 86.7% | 92.5% | 0.75 | 88.7% / 0.80 |
| **Sonnet, prompt v4 (shipped)** | **94.1%** | **90.6%** | **0.89** | **100% / 0.98 - passes every bar** |

The plan was to ship Haiku only if it came within 2 points of Sonnet. It did
not, so `CLASSIFIER_MODEL` is `claude-sonnet-5-5`.

**v3 to v4 changes:**
- Central-bank rate decisions go to Sales & Trading, not Commercial Banking.
- Vendor partnerships and product launches are promo.
- Products, hires and share moves of non-finance companies are not_finance.
- When a PE firm is the buyer or seller, private equity is primary.
- A tighter definition of worthiness 1.

### End to end: what the tabs actually show

`npm run news:eval -- audit --golden scripts/news-eval/golden-2.jsonl` reads
all 15 tabs from a test database loaded with the Sonnet labels. Of the 201
cards shown:

| Measure | Result |
|---|---|
| Real finance news | 98.5% |
| Judged good quality | 95.5% |
| On the right tab | 96.5% (98.6% on confident gold) |
| Wrong cards | 7 |

The seven wrong cards:
- 2 speculative pieces
- 1 vague central-bank speech
- 4 sector mix-ups

**Recall.** Of the 91 important stories (worthiness 3-4, confident gold), 69
reached a tab. Of the other 22:
- 20 passed every filter and ranked below the tab's 24-card limit (Sales &
  Trading alone had 51 events).
- 2 were trade stories outside their source's sectors.

So the filters themselves kept 89 of 91.

### Photos

- **Per-source rule.** A vision review of 134 sampled feed images found AI
  imagery at Claims Journal, Risk & Insurance, InvestmentNews and Traders
  Magazine, and concept illustrations at eight other sources. Only 12 sources
  passed.
- **Second review.** All 145 images a full collection stored were reviewed.
  None were AI-generated, but 6 were concept composites or staged concept
  stock, all from Alternative Credit Investor, WealthManagement.com and CFO
  Dive. Those three were switched off, which leaves 9 photo sources.
- **Metadata check.** One false positive surfaced: a real photo whose caption
  named DALL-E. The check now reads only the fields that record which tool made
  the file (tested).

### Confirmed through the real CLI (29 September 2026)

After the CLI was signed in, `npm run news:eval -- classifier --golden
scripts/news-eval/golden-2.jsonl` ran Sonnet through the production code path
on all 500 stories, which confirmed the proxy numbers. One change followed.

| Run | Relevance precision | Relevance recall | Macro-F1 | IB precision | Confident: precision / recall / macro-F1 |
|---|---|---|---|---|---|
| With the IB-in-code rule | 94.3% | 91.2% | 0.846 | 70.6% | 99.4% / 98.8% / 0.929 |
| **Rule removed (shipped)** | **94.4%** | **92.3%** | **0.850** | **87.5%** | **99.4% / 98.2% / 0.936** |

**Why the rule went.** The rule put every M&A or IPO story on the investment
banking tab. It was added because Haiku ignored that instruction. Sonnet
follows the prompt, so the rule only over-labelled.

**Cost.** Notional cost for the 500 stories was $0.59-0.97 per run, in line
with the ~$1.55/day estimate at full volume.

**Still under the bar on confident labels:**
- Investment banking precision: 83.9% (bar 88%).
- A handful of sectors with too few examples to judge.

## Earlier runs (golden.jsonl, older rules)

| Version | Relevance precision (held-out) | Relevance recall (held-out) | Macro-F1 (held-out) |
|---|---|---|---|
| Old keyword rules (finance-news.ts) | 78.0% (all) | 21.2% (all) | 0.13 (all) |
| Prompt v1, Haiku | 89.3% | 93.8% | 0.73 |
| Prompt v2, Haiku | 92.1% | 95.0% | 0.74 |
| Prompt v2 + investment banking rule in code | 92.1% | 95.0% | 0.75 |

## Caveat

The rows above the "Confirmed through the real CLI" section are proxy runs:
the production prompt ran on Haiku and Sonnet as session subagents, before the
CLI was signed in. The real-path numbers agree with them.
