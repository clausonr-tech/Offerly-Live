# Prompt: build Offerly's interview question bank

Paste everything below the line into the other Claude session. It is written for
Claude Code working in this repository (it writes files into
`question-bank-draft/`), and it is built to run across many turns: it keeps a
progress file, so when a turn ends you can just say "continue".

---

You are writing an original interview question bank for Offerly, an app that
helps undergraduates prepare for finance recruiting. Students practise with these
questions in timed rounds: they type an answer (graded by an AI against the
"expected points") or pick from four options. The bank will hold several thousand
questions across 14 sectors and their specialties.

## 1. The originality rule - read this first, it overrides everything else

Every question, every answer point and every multiple-choice option must be
**written by you, from your own understanding of finance**. The previous bank
was removed because it contained copyrighted material. This one must not.

- **Concepts are free; wording is not.** It is fine, and expected, to test the
  standard concepts every interviewer tests (how depreciation flows through the
  statements, why you discount unlevered cash flow at WACC). It is not fine to
  reproduce or closely paraphrase how any published source phrases the question,
  its numbers, its scenario, or its model answer.
- **Do not draw from, reconstruct, or imitate specific sources**, including but
  not limited to: Breaking Into Wall Street, Wall Street Prep, Wall Street Oasis
  guides, Mergers & Inquisitions, Vault or Firsthand guides, Training The
  Street, Rosenbaum & Pearl's *Investment Banking*, *Case in Point*, *Case
  Interview Secrets*, *Heard on the Street*, *A Practical Guide to Quantitative
  Finance Interviews*, CFA/CAIA/FRM curriculum text, Glassdoor or forum
  interview reports, university career-centre packets, and any "400 questions"
  style list. Never name or cite a source in the output.
- **Invent your own specifics.** Use fresh numbers, fictional companies
  described by what they do ("a regional HVAC distributor with $80M of EBITDA"),
  and your own scenarios. Do not name real firms, real people or real deals in a
  question. Do not use well-known published brainteasers or market-sizing
  setups; write new ones.
- **Write the answer points in your own words**, as concepts rather than a
  model answer copied from anywhere.
- **Self-check every batch.** Before saving, reread each question and ask: "Is
  this wording, scenario or set of numbers something I would recognise from a
  specific published guide or list?" If yes, or if you are unsure, rewrite it
  with a new scenario and new numbers until the answer is clearly no.
- **Nothing time-sensitive.** No questions whose answer depends on current
  market levels, current rates or recent news. They go stale and can't be
  graded.
- **Professional language only.** No profanity, slurs or demeaning content,
  including in fictional scenarios. The app rejects them.

## 2. What to cover

Cover everything a firm in each sector and specialty could reasonably ask an
undergraduate or recent-graduate candidate: technicals and behaviorals, from
first-round screens to superday. "Everything" means breadth across every topic
below, and depth at every difficulty, not a pile of near-duplicates.

### Difficulty levels (the app calls them Beginner / Intermediate / Advanced)

- `foundational`: definitions and single-step reasoning a prepared sophomore
  should get right.
- `intermediate`: multi-step reasoning, simple arithmetic, "walk me through".
  What most first-round technical questions look like.
- `advanced`: edge cases, interactions between concepts, harder arithmetic,
  judgement calls. What separates candidates at a superday.

### Sectors and specialties - use these keys and strings EXACTLY

The app matches on these strings character for character. Do not rename,
abbreviate or add to them.

| Sector key | Specialties |
|---|---|
| `investment_banking` | M&A Advisory · Leveraged Finance · Equity Capital Markets (ECM) · Debt Capital Markets (DCM) · Restructuring · TMT Coverage · Healthcare Coverage · Energy & Power Coverage · Consumer & Retail Coverage · Financial Institutions (FIG) Coverage · Industrials Coverage · Real Estate Coverage · Media & Telecom · Natural Resources |
| `private_equity` | Buyout / LBO · Distressed / Special Situations · Infrastructure · Secondaries · Fund of Funds |
| `venture_capital` | Seed & Early Stage · Growth Stage · Growth Equity · Corporate Venture Capital |
| `private_credit` | Direct Lending · Mezzanine & Structured Credit · Distressed & Special Situations Credit · Asset-Based Lending |
| `real_estate` | Real Estate Private Equity · REIT Investing · Real Estate Investment Banking · Real Estate Debt / Lending · Real Estate Development · Real Estate Brokerage |
| `hedge_fund` | Long/Short Equity · Global Macro · Quantitative / Systematic · Credit & Distressed · Event-Driven / Merger Arb · Multi-Strategy · Commodities Trading |
| `sales_trading` | Equities Trading · Fixed Income Trading · FX Trading · Commodities Trading · Derivatives / Structured Products · Electronic / Algo Trading |
| `asset_wealth_management` | Public Equities AM · Fixed Income AM · Multi-Asset / Allocation · Private Wealth Management · Institutional Client Coverage |
| `commercial_banking` | Corporate & Middle-Market Lending · Credit Analysis & Underwriting · Treasury & Cash Management · Commercial Real Estate Lending |
| `insurance` | Underwriting · Actuarial · Insurance Investment Management · Reinsurance |
| `fintech` | Payments · Digital Lending · Wealthtech & Brokerage · Crypto & Digital Assets |
| `market_infrastructure` | Exchanges & Trading Venues · Clearing & Settlement · Market Data & Indices · Custody & Securities Services |
| `consulting` | Strategy Consulting · Management Consulting (generalist) · Operations & Performance Improvement · Restructuring & Turnaround · Deals / Transaction Services · Economic & Financial Consulting · Actuarial & Risk Consulting · Technology & Digital Consulting |
| `other_finance` | Corporate Finance / FP&A · Corporate Development · Treasury · Credit Ratings & Research |

Each sector also has a **General** file (`specialty: null`) for questions any
desk in that sector asks. A question belongs in a specialty file only if it
would feel out of place in most of the sector's other specialties.

### Topic checklists

These are the **minimum** topic areas for each sector's General file. Before
writing a specialty file, write your own checklist of that specialty's topics
(for example, Restructuring: bankruptcy process, Chapter 11 vs Chapter 7, DIP
financing, absolute priority, distressed valuation, covenants, recovery
analysis) and cover all of it.

- **Investment banking:** accounting and the three statements, statement
  linkages, enterprise vs equity value, valuation methods (comps, precedents,
  DCF), DCF mechanics, WACC and cost of capital, terminal value, M&A
  (accretion/dilution, synergies, purchase accounting, deal structures), LBO
  basics, capital markets basics, market sizing and brainteasers.
- **Private equity:** LBO mechanics and paper LBOs, returns (IRR, MOIC,
  drivers), debt structures and capacity, value creation, diligence, deal
  structuring, fund economics (fees, carry, waterfalls), exits, portfolio
  company operations, investment judgement ("would you invest in...").
- **Venture capital:** startup metrics (CAC, LTV, burn, runway, retention,
  cohorts), valuation of early companies, term sheets (pre/post-money,
  liquidation preferences, anti-dilution, option pools), cap tables and
  dilution, market sizing, fund math (power law, reserves, ownership), sourcing
  and judging founders.
- **Private credit:** credit analysis, leverage and coverage ratios, covenants,
  loan structures (unitranche, first/second lien), pricing and fees, downside
  and recovery analysis, documentation terms, portfolio monitoring.
- **Real estate:** NOI, cap rates, cash-on-cash, IRR, underwriting a property,
  debt (LTV, DSCR, debt yield), development budgets and returns, property types,
  leases, REIT metrics (FFO, AFFO, NAV), waterfalls.
- **Hedge fund:** stock pitches (long and short), valuation, catalysts, risk
  management and position sizing, shorting mechanics, portfolio construction,
  strategy-specific reasoning, macro reasoning without current data.
- **Sales & trading:** market structure, bonds (price/yield, duration,
  convexity, curve), rates, FX, equities, options and Greeks, futures and
  forwards, risk, trade ideas, mental maths, probability and brainteasers.
- **Asset & wealth management:** portfolio theory, asset allocation, fund
  products (mutual funds, ETFs, alternatives), fixed income and equity
  investing, risk and return measures, client needs and suitability, tax and
  planning basics, performance attribution.
- **Commercial banking:** credit analysis (the five Cs), financial statement
  analysis for lenders, loan structures, collateral, covenants, cash flow
  lending vs asset-based lending, bank balance sheet and net interest margin,
  risk rating, treasury products.
- **Insurance:** how insurers make money (underwriting and investment income),
  combined ratio and loss ratios, reserves, pricing risk, reinsurance, float,
  regulation and capital basics, insurer valuation, catastrophe risk.
- **Fintech:** business models and unit economics, payments flows
  (interchange, networks, acquirers), lending risk and underwriting with data,
  regulation basics, product and growth metrics, crypto and blockchain basics.
- **Market infrastructure:** how exchanges earn revenue, trade lifecycle,
  clearing and settlement, central counterparties and margin, market data and
  indices, custody, operational risk, market structure and liquidity.
- **Consulting:** case structure and frameworks built from scratch,
  profitability, market sizing, market entry, pricing, M&A cases, operations,
  growth strategy, chart and data interpretation, case maths, synthesis and
  recommendations.
- **Corporate & other finance:** corporate finance fundamentals, budgeting and
  forecasting, variance analysis, capital budgeting (NPV, IRR, payback),
  capital structure, working capital, corporate development and M&A from the
  buyer side, treasury (liquidity, hedging), credit ratings methodology.

### Behavioral questions

- **Universal file** (`sector: null`): the questions every finance interview
  asks. Cover these categories exactly: `Motivation`, `Fit`, `Teamwork`,
  `Leadership`, `Challenges`, `Integrity`, `Commercial Awareness`, `Curveball`.
- **Sector and specialty files:** behavioral questions specific to that seat
  ("why this specialty and not a coverage group", "why credit over equity",
  "how would you handle a founder who..."). Same category names.

## 3. How many

| File | Technical | Behavioral |
|---|---|---|
| Universal behavioral | - | 150 (at least 15 per category) |
| Each sector's General file | 90 (30 per difficulty) | 30 |
| Each specialty file | 45 (15 per difficulty) | 15 |

That is roughly 6,500 questions. Treat 15 per difficulty as a floor: a practice
round draws 10 at one difficulty, so a specialty with fewer than 10 repeats
itself.

**Spread matters as much as volume.** Within a file, cover every topic on the
checklist before writing a second question on any one of them. No two questions
in the whole bank may test the same thing with only the numbers changed.

## 4. Output format - JSON, one file per sector/specialty

Write files to:

```
question-bank-draft/<sector_key>/_general.json
question-bank-draft/<sector_key>/<specialty-slug>.json
question-bank-draft/_universal/behavioral.json
```

`<specialty-slug>` is the specialty lowercased, with runs of non-alphanumeric
characters turned into single hyphens (`Debt Capital Markets (DCM)` becomes
`debt-capital-markets-dcm`). Each file has exactly this shape:

```json
{
  "sector": "investment_banking",
  "specialty": "Restructuring",
  "technical": [
    {
      "id": "investment_banking.restructuring.t001",
      "topic": "Distressed Valuation",
      "difficulty": "intermediate",
      "prompt": "The question exactly as the interviewer would ask it.",
      "expectedPoints": [
        "A concept a strong answer must contain, in plain words",
        "3 to 6 of these, each one independently checkable"
      ],
      "choices": {
        "answer": "The correct option, short",
        "distractors": ["Wrong option", "Wrong option", "Wrong option"]
      }
    }
  ],
  "behavioral": [
    {
      "id": "investment_banking.restructuring.b001",
      "category": "Motivation",
      "difficulty": "foundational",
      "prompt": "The question exactly as asked.",
      "expectedPoints": [
        "What a good answer contains - not a script, since each student tells their own story"
      ]
    }
  ]
}
```

Field rules:

- `sector`: one of the 14 keys. `null` only in the universal file.
- `specialty`: one of the exact strings in the table, or `null` for General
  and universal files.
- `topic`: a short title-case label ("Accounting", "LBO", "Term Sheets"). Reuse
  the same label for the same topic across files.
- `prompt`: never contains its own answer.
- `expectedPoints`: 3 to 6 items. Concepts, not phrasing, because the grader
  matches on meaning. Include the key numbers when there is arithmetic.
- `choices`: include it when the question has one clearly correct short answer,
  and set it to `null` when it is open-ended ("pitch me a stock", "walk me
  through your resume"). Aim for options on at least two thirds of technical
  questions. Behavioral questions never have options. **Make the wrong options
  as close as the difficulty says:**
  - `foundational`: wrong options are clearly different concepts.
  - `intermediate`: right shape, wrong in one step.
  - `advanced`: near misses a half-prepared candidate would pick, separated by
    one detail.
  All four options should be similar in length and style, so the answer can't
  be spotted by its form.
- `id`: `<sector>.<specialty-slug or general>.t###` / `.b###`, unique across
  the whole bank.

## 5. Process

1. **Plan first.** Create `question-bank-draft/PROGRESS.md` listing every file
   to produce (15 General-plus-universal files and 79 specialty files), each
   with a status. Write each specialty's topic checklist into it before you
   start that file.
2. **One file at a time**, in the order of the table above, starting with the
   universal behavioral file. Write large files in batches (append 15 to 30
   questions at a time) rather than one enormous response.
3. **Validate every file before marking it done:** it parses as JSON; the
   counts meet section 3; every `specialty` string matches the table exactly;
   every id is unique; every `choices` block has exactly three distractors
   that differ from the answer; there are no duplicate or near-duplicate
   prompts, both within the file and against files already finished. A small
   script for this is fine. Keep it in `question-bank-draft/`.
4. **Run the originality self-check** in section 1 on every batch.
5. **Update PROGRESS.md** after each file, so the work can resume exactly where
   it stopped if the session runs out of room. When told "continue", read
   PROGRESS.md and carry on.
6. **Do not edit anything outside `question-bank-draft/`.** Another session will
   import the finished files into the app.

When every file is done, finish with a summary table showing each sector and
specialty, its technical count by difficulty, its behavioral count, and the
share of technical questions that have options.
