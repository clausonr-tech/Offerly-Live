# Offerly Question Bank - Progress

Resume rule: when told "continue", read this file, run `python validate.py` on finished files, and pick up at the first file not marked DONE.

## Targets (brief's section 3 scaled ~22% to reach 8,000+)
- Universal behavioral: 184 (23 per category x 8)
- Each General file: 111 technical (37 per difficulty) + 37 behavioral
- Each specialty file: 57 technical (19 per difficulty) + 18 behavioral
- Total: 184 + 14 x 148 + 79 x 75 = **8,181**

## Workflow per file
1. Write in batches with `qb.add_technical` / `qb.add_behavioral` (re-running a batch skips existing prompts).
2. Originality self-check on every batch (brief section 1).
3. `python validate.py <file>`, then a full correctness re-read of every answer and every piece of arithmetic.
4. After a whole sector is done: second review pass across the sector, then `python validate.py` on the whole bank.

Status: TODO / IN PROGRESS / DONE (reviewed)

Sector reviews completed: investment_banking (2 fixes); private_equity (3 fixes); venture_capital (3 fixes); private_credit (1 fix, plus 2 duplicate-option repairs); real_estate (3 fixes); hedge_fund (1 fix); sales_trading (1 fix); asset_wealth_management (0 fixes); commercial_banking (1 fix, plus FIG-overlap rewrite of 22 questions); insurance (2 fixes); fintech (1 fix); market_infrastructure (0 fixes); consulting (2 fixes); other_finance (1 fix)

## Files

| # | File | Target | Status |
|---|---|---|---|
| 0 | _universal/behavioral.json | 184 B | DONE (reviewed) |
| 1 | investment_banking/_general.json | 111 T + 37 B | DONE (reviewed) |
| 2 | investment_banking/m-a-advisory.json | 57 T + 18 B | DONE (reviewed) |
| 3 | investment_banking/leveraged-finance.json | 57 T + 18 B | DONE (reviewed) |
| 4 | investment_banking/equity-capital-markets-ecm.json | 57 T + 18 B | DONE (reviewed) |
| 5 | investment_banking/debt-capital-markets-dcm.json | 57 T + 18 B | DONE (reviewed) |
| 6 | investment_banking/restructuring.json | 57 T + 18 B | DONE (reviewed) |
| 7 | investment_banking/tmt-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 8 | investment_banking/healthcare-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 9 | investment_banking/energy-power-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 10 | investment_banking/consumer-retail-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 11 | investment_banking/financial-institutions-fig-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 12 | investment_banking/industrials-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 13 | investment_banking/real-estate-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 14 | investment_banking/media-telecom.json | 57 T + 18 B | DONE (reviewed) |
| 15 | investment_banking/natural-resources.json | 57 T + 18 B | DONE (reviewed) |
| 16 | private_equity/_general.json | 111 T + 37 B | DONE (reviewed) |
| 17 | private_equity/buyout-lbo.json | 57 T + 18 B | DONE (reviewed) |
| 18 | private_equity/distressed-special-situations.json | 57 T + 18 B | DONE (reviewed) |
| 19 | private_equity/infrastructure.json | 57 T + 18 B | DONE (reviewed) |
| 20 | private_equity/secondaries.json | 57 T + 18 B | DONE (reviewed) |
| 21 | private_equity/fund-of-funds.json | 57 T + 18 B | DONE (reviewed) |
| 22 | venture_capital/_general.json | 111 T + 37 B | DONE (reviewed) |
| 23 | venture_capital/seed-early-stage.json | 57 T + 18 B | DONE (reviewed) |
| 24 | venture_capital/growth-stage.json | 57 T + 18 B | DONE (reviewed) |
| 25 | venture_capital/growth-equity.json | 57 T + 18 B | DONE (reviewed) |
| 26 | venture_capital/corporate-venture-capital.json | 57 T + 18 B | DONE (reviewed) |
| 27 | private_credit/_general.json | 111 T + 37 B | DONE (reviewed) |
| 28 | private_credit/direct-lending.json | 57 T + 18 B | DONE (reviewed) |
| 29 | private_credit/mezzanine-structured-credit.json | 57 T + 18 B | DONE (reviewed) |
| 30 | private_credit/distressed-special-situations-credit.json | 57 T + 18 B | DONE (reviewed) |
| 31 | private_credit/asset-based-lending.json | 57 T + 18 B | DONE (reviewed) |
| 32 | real_estate/_general.json | 111 T + 37 B | DONE (reviewed) |
| 33 | real_estate/real-estate-private-equity.json | 57 T + 18 B | DONE (reviewed) |
| 34 | real_estate/reit-investing.json | 57 T + 18 B | DONE (reviewed) |
| 35 | real_estate/real-estate-investment-banking.json | 57 T + 18 B | DONE (reviewed) |
| 36 | real_estate/real-estate-debt-lending.json | 57 T + 18 B | DONE (reviewed) |
| 37 | real_estate/real-estate-development.json | 57 T + 18 B | DONE (reviewed) |
| 38 | real_estate/real-estate-brokerage.json | 57 T + 18 B | DONE (reviewed) |
| 39 | hedge_fund/_general.json | 111 T + 37 B | DONE (reviewed) |
| 40 | hedge_fund/long-short-equity.json | 57 T + 18 B | DONE (reviewed) |
| 41 | hedge_fund/global-macro.json | 57 T + 18 B | DONE (reviewed) |
| 42 | hedge_fund/quantitative-systematic.json | 57 T + 18 B | DONE (reviewed) |
| 43 | hedge_fund/credit-distressed.json | 57 T + 18 B | DONE (reviewed) |
| 44 | hedge_fund/event-driven-merger-arb.json | 57 T + 18 B | DONE (reviewed) |
| 45 | hedge_fund/multi-strategy.json | 57 T + 18 B | DONE (reviewed) |
| 46 | hedge_fund/commodities-trading.json | 57 T + 18 B | DONE (reviewed) |
| 47 | sales_trading/_general.json | 111 T + 37 B | DONE (reviewed) |
| 48 | sales_trading/equities-trading.json | 57 T + 18 B | DONE (reviewed) |
| 49 | sales_trading/fixed-income-trading.json | 57 T + 18 B | DONE (reviewed) |
| 50 | sales_trading/fx-trading.json | 57 T + 18 B | DONE (reviewed) |
| 51 | sales_trading/commodities-trading.json | 57 T + 18 B | DONE (reviewed) |
| 52 | sales_trading/derivatives-structured-products.json | 57 T + 18 B | DONE (reviewed) |
| 53 | sales_trading/electronic-algo-trading.json | 57 T + 18 B | DONE (reviewed) |
| 54 | asset_wealth_management/_general.json | 111 T + 37 B | DONE (reviewed) |
| 55 | asset_wealth_management/public-equities-am.json | 57 T + 18 B | DONE (reviewed) |
| 56 | asset_wealth_management/fixed-income-am.json | 57 T + 18 B | DONE (reviewed) |
| 57 | asset_wealth_management/multi-asset-allocation.json | 57 T + 18 B | DONE (reviewed) |
| 58 | asset_wealth_management/private-wealth-management.json | 57 T + 18 B | DONE (reviewed) |
| 59 | asset_wealth_management/institutional-client-coverage.json | 57 T + 18 B | DONE (reviewed) |
| 60 | commercial_banking/_general.json | 111 T + 37 B | DONE (reviewed) |
| 61 | commercial_banking/corporate-middle-market-lending.json | 57 T + 18 B | DONE (reviewed) |
| 62 | commercial_banking/credit-analysis-underwriting.json | 57 T + 18 B | DONE (reviewed) |
| 63 | commercial_banking/treasury-cash-management.json | 57 T + 18 B | DONE (reviewed) |
| 64 | commercial_banking/commercial-real-estate-lending.json | 57 T + 18 B | DONE (reviewed) |
| 65 | insurance/_general.json | 111 T + 37 B | DONE (reviewed) |
| 66 | insurance/underwriting.json | 57 T + 18 B | DONE (reviewed) |
| 67 | insurance/actuarial.json | 57 T + 18 B | DONE (reviewed) |
| 68 | insurance/insurance-investment-management.json | 57 T + 18 B | DONE (reviewed) |
| 69 | insurance/reinsurance.json | 57 T + 18 B | DONE (reviewed) |
| 70 | fintech/_general.json | 111 T + 37 B | DONE (reviewed) |
| 71 | fintech/payments.json | 57 T + 18 B | DONE (reviewed) |
| 72 | fintech/digital-lending.json | 57 T + 18 B | DONE (reviewed) |
| 73 | fintech/wealthtech-brokerage.json | 57 T + 18 B | DONE (reviewed) |
| 74 | fintech/crypto-digital-assets.json | 57 T + 18 B | DONE (reviewed) |
| 75 | market_infrastructure/_general.json | 111 T + 37 B | DONE (reviewed) |
| 76 | market_infrastructure/exchanges-trading-venues.json | 57 T + 18 B | DONE (reviewed) |
| 77 | market_infrastructure/clearing-settlement.json | 57 T + 18 B | DONE (reviewed) |
| 78 | market_infrastructure/market-data-indices.json | 57 T + 18 B | DONE (reviewed) |
| 79 | market_infrastructure/custody-securities-services.json | 57 T + 18 B | DONE (reviewed) |
| 80 | consulting/_general.json | 111 T + 37 B | DONE (reviewed) |
| 81 | consulting/strategy-consulting.json | 57 T + 18 B | DONE (reviewed) |
| 82 | consulting/management-consulting-generalist.json | 57 T + 18 B | DONE (reviewed) |
| 83 | consulting/operations-performance-improvement.json | 57 T + 18 B | DONE (reviewed) |
| 84 | consulting/restructuring-turnaround.json | 57 T + 18 B | DONE (reviewed) |
| 85 | consulting/deals-transaction-services.json | 57 T + 18 B | DONE (reviewed) |
| 86 | consulting/economic-financial-consulting.json | 57 T + 18 B | DONE (reviewed) |
| 87 | consulting/actuarial-risk-consulting.json | 57 T + 18 B | DONE (reviewed) |
| 88 | consulting/technology-digital-consulting.json | 57 T + 18 B | DONE (reviewed) |
| 89 | other_finance/_general.json | 111 T + 37 B | DONE (reviewed) |
| 90 | other_finance/corporate-finance-fp-a.json | 57 T + 18 B | DONE (reviewed) |
| 91 | other_finance/corporate-development.json | 57 T + 18 B | DONE (reviewed) |
| 92 | other_finance/treasury.json | 57 T + 18 B | DONE (reviewed) |
| 93 | other_finance/credit-ratings-research.json | 57 T + 18 B | DONE (reviewed) |

## Topic checklists


### Investment Banking (`investment_banking`)
- **General:** Accounting and the three statements; statement linkages; enterprise vs equity value; valuation methods (comps, precedents, DCF); DCF mechanics; WACC and cost of capital; terminal value; M&A (accretion/dilution, synergies, purchase accounting, deal structures); LBO basics; capital markets basics; market sizing and brainteasers
- **M&A Advisory:** Sell-side vs buy-side process; accretion/dilution; synergies; purchase price allocation and goodwill; stock vs asset deals; cash vs stock consideration; exchange ratios; contribution analysis; earnouts; fairness opinions
- **Leveraged Finance:** Leverage and coverage metrics; term loan B vs high yield; maintenance vs incurrence covenants; debt capacity; pricing (spread, OID, floors); LBO financing structures; ratings; call protection; flex terms
- **Equity Capital Markets (ECM):** IPO process; bookbuilding and pricing; greenshoe; follow-on offerings; convertibles; block trades; lock-ups; dilution and use of proceeds; IPO discount; direct listings and SPACs
- **Debt Capital Markets (DCM):** Bond price and yield; spreads; credit ratings; IG vs HY issuance; new issue concession; call features; duration; liability management (tenders, exchanges); swaps
- **Restructuring:** Chapter 11 vs Chapter 7; DIP financing; absolute priority rule; plan of reorganization and classes; distressed valuation; recovery waterfall; distressed exchanges; 363 sales; 13-week cash flow; covenant breaches
- **TMT Coverage:** SaaS metrics (ARR, NRR, rule of 40); recurring revenue valuation; stock-based comp; deferred revenue; hardware vs software margins; semiconductor cyclicality; network effects; capitalized software
- **Healthcare Coverage:** Pipeline valuation (risk-adjusted NPV); patent cliffs; payer mix; reimbursement; medical devices; healthcare services metrics; biotech cash burn; regulatory approval stages; CROs
- **Energy & Power Coverage:** Upstream/midstream/downstream; reserves (PV-10, 1P/2P); EBITDAX; NAV valuation; commodity hedging; power generation and PPAs; regulated utility rate base; renewables tax credits; commodity sensitivity
- **Consumer & Retail Coverage:** Same-store sales; inventory turnover; gross margin drivers; unit/store economics; brand value; e-commerce vs physical retail; seasonal working capital; lease accounting; franchising
- **Financial Institutions (FIG) Coverage:** Bank valuation (P/BV, P/TBV, P/E); net interest margin; loan loss provisions; regulatory capital (CET1); why DCF doesn't fit banks; dividend discount model; insurer metrics; asset manager AUM economics; ROE vs cost of equity
- **Industrials Coverage:** Cyclicality; backlog and book-to-bill; capex intensity; aerospace and defense contracts; EBITDA vs EBIT for asset-heavy firms; pension liabilities; working capital; aftermarket revenue; maintenance vs growth capex
- **Real Estate Coverage:** NOI and cap rates; FFO/AFFO; NAV; REIT structure and distribution rules; property types; leverage metrics; sale-leasebacks; limits of EBITDA; development pipelines
- **Media & Telecom:** Subscriber metrics (ARPU, churn); content amortization; spectrum and tower economics; capex intensity; EBITDA minus capex; advertising cyclicality; licensing; cable/fiber economics; sum-of-the-parts
- **Natural Resources:** Reserves vs resources; NAV with commodity price decks; all-in sustaining cost; depletion; commodity sensitivity; royalties and streaming; EV/resource metrics; capex cycles; jurisdiction risk

### Private Equity (`private_equity`)
- **General:** LBO mechanics and paper LBOs; returns (IRR, MOIC, drivers); debt structures and capacity; value creation; diligence; deal structuring; fund economics (fees, carry, waterfalls); exits; portfolio company operations; investment judgement
- **Buyout / LBO:** Paper LBO; returns attribution (EBITDA growth, multiple, deleveraging); debt sizing; sources and uses; management rollover and incentives; buy-and-build; dividend recaps; exit routes; operational value creation; good LBO candidates
- **Distressed / Special Situations:** Loan-to-own; fulcrum security; buying debt at a discount; recovery analysis; Chapter 11 process; credit bidding; rescue financing; structured equity; PIPEs; valuation under distress
- **Infrastructure:** Core / core-plus / value-add; contracted and regulated cash flows; concessions; long-duration returns; inflation linkage; availability payments; project finance leverage; regulatory risk; yield vs growth
- **Secondaries:** LP-led vs GP-led; NAV discounts and premiums; continuation vehicles; pricing a portfolio; unfunded commitments; deferred payments; J-curve mitigation; tender offers; fund-level diligence
- **Fund of Funds:** Manager selection; investment and operational diligence; fee layering; diversification; vintage year; commitment pacing; benchmarks (PME, quartiles); co-investments; J-curve

### Venture Capital (`venture_capital`)
- **General:** Startup metrics (CAC, LTV, burn, runway, retention, cohorts); valuing early companies; term sheets (pre/post-money, liquidation preferences, anti-dilution, option pools); cap tables and dilution; market sizing; fund math (power law, reserves, ownership); sourcing and judging founders
- **Seed & Early Stage:** Founder assessment; TAM; SAFEs and convertible notes (caps, discounts); pre-product signals; pre/post-money; option pool shuffle; burn and runway; product-market fit; ownership targets; power law
- **Growth Stage:** Unit economics at scale; CAC payback; net revenue retention; cohort analysis; burn multiple; revenue multiples; later-round liquidation preferences; pro rata rights; path to profitability; moats
- **Growth Equity:** Minority structures; profitable growth companies; protective provisions; preferred structures; revenue vs EBITDA multiples; secondary components; returns modeling; founder-led companies; contrast with buyout and VC
- **Corporate Venture Capital:** Strategic vs financial returns; alignment with parent; conflicts of interest; commercial agreements; signaling risk; balance sheet investing; governance; M&A pipeline; accounting for minority stakes

### Private Credit (`private_credit`)
- **General:** Credit analysis; leverage and coverage ratios; covenants; loan structures (unitranche, first/second lien); pricing and fees; downside and recovery analysis; documentation terms; portfolio monitoring
- **Direct Lending:** Unitranche; first-lien senior secured; sponsor vs non-sponsor; leverage and coverage; covenants; pricing (spread, OID, fees); EBITDA add-backs; recurring revenue loans; amendments and waivers
- **Mezzanine & Structured Credit:** Subordinated debt; PIK interest; warrants and equity kickers; intercreditor terms; structured and preferred equity; blended returns; CLO basics; tranching
- **Distressed & Special Situations Credit:** Trading debt at a discount; yield to recovery; fulcrum security; restructuring process; DIP loans; rescue financing; liability management transactions; priming; creditor committees
- **Asset-Based Lending:** Borrowing base; advance rates; eligible receivables and inventory; field exams and appraisals; cash dominion; springing covenants; liquidation value; fixed charge coverage; suitable industries

### Real Estate (`real_estate`)
- **General:** NOI; cap rates; cash-on-cash; IRR; underwriting a property; debt (LTV, DSCR, debt yield); development budgets and returns; property types; leases; REIT metrics (FFO, AFFO, NAV); waterfalls
- **Real Estate Private Equity:** Value-add underwriting; levered vs unlevered IRR; equity multiple; cap rate movement; hold period; JV waterfalls and promote; renovation premiums; exit cap; core to opportunistic; debt terms
- **REIT Investing:** FFO/AFFO; NAV premium/discount; payout requirement; REIT sectors; same-store NOI; leverage; cost of capital and external growth; implied cap rate
- **Real Estate Investment Banking:** REIT M&A; take-privates; REIT equity raises; unsecured bonds; NAV-based valuation; sale-leasebacks; portfolio sales; AFFO accretion
- **Real Estate Debt / Lending:** LTV; DSCR; debt yield; loan sizing constraints; fixed vs floating and rate caps; CMBS; bridge loans; mezz and pref equity; recourse vs non-recourse; prepayment and defeasance
- **Real Estate Development:** Budget (land, hard, soft costs); yield on cost; development spread; construction loans; entitlement risk; lease-up; contingency; draw schedules; merchant build vs hold
- **Real Estate Brokerage:** Broker opinion of value; cap rate comps; marketing process; buyer pools; commission structures; tenant vs landlord rep; lease economics (TI, free rent, effective rent); presenting market knowledge

### Hedge Fund (`hedge_fund`)
- **General:** Stock pitches (long and short); valuation; catalysts; risk management and position sizing; shorting mechanics; portfolio construction; strategy-specific reasoning; macro reasoning without current data
- **Long/Short Equity:** Stock pitch; variant perception; catalysts; short thesis; gross/net exposure; position sizing; stop-losses; pair trades; earnings modeling
- **Global Macro:** Central banks and rates; FX drivers; inflation; yield curve trades; carry; asymmetric risk-reward; cross-asset relationships; scenario analysis
- **Quantitative / Systematic:** Regression and overfitting; factor models; backtest pitfalls (look-ahead, survivorship); Sharpe ratio; transaction costs; signal decay; probability; coding approach
- **Credit & Distressed:** Capital structure arbitrage; bonds vs CDS; recovery analysis; covenant analysis; relative value; event catalysts; shorting credit
- **Event-Driven / Merger Arb:** Spread and annualized return; deal break risk; regulatory approval; hedging stock-for-stock deals; collars; spin-offs; activism; tender offers
- **Multi-Strategy:** Pod structure; risk limits; drawdown rules; capital allocation; correlation; beta neutrality; crowding; factor exposure
- **Commodities Trading:** Supply/demand balances; contango and backwardation; storage and carry; crack and spark spreads; seasonality; physical vs financial; roll yield; weather

### Sales & Trading (`sales_trading`)
- **General:** Market structure; bonds (price/yield, duration, convexity, curve); rates; FX; equities; options and Greeks; futures and forwards; risk; trade ideas; mental maths; probability and brainteasers
- **Equities Trading:** Market making; bid-ask; order types; block trades; index rebalances; ETF creation/redemption; short interest; sector rotation
- **Fixed Income Trading:** Bond math; duration and convexity; steepeners/flatteners; credit spreads; repo; swaps basics; relative value; carry and rolldown
- **FX Trading:** Spot vs forward; covered interest parity; carry trade; cross rates; pip math; currency drivers; FX options basics; corporate hedging
- **Commodities Trading:** Futures curve; basis; producer/consumer hedging; storage arbitrage; spreads; physical delivery; seasonality
- **Derivatives / Structured Products:** Option pricing intuition; Greeks; put-call parity; volatility skew; structured notes; barrier options; hedging exotics; variance swaps
- **Electronic / Algo Trading:** Market microstructure; execution algos (VWAP, TWAP, implementation shortfall); latency; market impact; order book dynamics; smart order routing; transaction cost analysis; coding and probability

### Asset & Wealth Management (`asset_wealth_management`)
- **General:** Portfolio theory; asset allocation; fund products (mutual funds, ETFs, alternatives); fixed income and equity investing; risk and return measures; client needs and suitability; tax and planning basics; performance attribution
- **Public Equities AM:** Fundamental research; valuation; benchmarks and tracking error; active share; growth vs value; portfolio construction; sell discipline; ESG integration
- **Fixed Income AM:** Duration management; credit selection; curve positioning; sector allocation; liability-driven investing; municipal bonds; rating migration; liquidity
- **Multi-Asset / Allocation:** Strategic vs tactical allocation; mean-variance optimization; risk parity; rebalancing; correlation regimes; alternatives allocation; glide paths
- **Private Wealth Management:** Client discovery; risk tolerance; suitability; tax-efficient investing; estate planning basics; retirement accounts; concentrated stock; fees
- **Institutional Client Coverage:** Client types (pensions, endowments, sovereign funds); mandates and RFPs; liability matching; reporting; retention; investment consultants; fee structures

### Commercial Banking (`commercial_banking`)
- **General:** Credit analysis (five Cs); financial statement analysis for lenders; loan structures; collateral; covenants; cash flow vs asset-based lending; bank balance sheet and net interest margin; risk rating; treasury products
- **Corporate & Middle-Market Lending:** Revolvers and term loans; relationship banking; cross-sell; leverage and coverage; covenants; loan pricing and RAROC; syndication
- **Credit Analysis & Underwriting:** Five Cs; cash flow analysis; DSCR; sensitivity analysis; risk rating; credit memo; guarantor support; industry risk
- **Treasury & Cash Management:** Payments (ACH, wire); liquidity management; sweeps; lockbox; fraud prevention; value of deposits; receivables/payables solutions
- **Commercial Real Estate Lending:** LTV; DSCR; debt yield; property types; appraisals; construction lending; tenant concentration; recourse

### Insurance (`insurance`)
- **General:** How insurers make money (underwriting and investment income); combined ratio and loss ratios; reserves; pricing risk; reinsurance; float; regulation and capital basics; insurer valuation; catastrophe risk
- **Underwriting:** Risk selection; pricing adequacy; exposure bases; loss ratio; adverse selection; moral hazard; deductibles, limits, exclusions; portfolio mix
- **Actuarial:** Expected loss; frequency and severity; reserving (chain ladder); IBNR; credibility; mortality tables; present value of liabilities; probability
- **Insurance Investment Management:** Asset-liability matching; duration; regulatory capital charges; liquidity; credit quality; yield vs risk; investing float
- **Reinsurance:** Quota share vs excess of loss; treaty vs facultative; cat bonds; attachment points; ceding commission; counterparty risk; catastrophe modeling

### Fintech (`fintech`)
- **General:** Business models and unit economics; payments flows (interchange, networks, acquirers); data-driven lending risk and underwriting; regulation basics; product and growth metrics; crypto and blockchain basics
- **Payments:** Four-party model; interchange; merchant discount rate; acquirers, processors, networks; chargebacks; take rate; TPV; cross-border payments
- **Digital Lending:** Alternative-data underwriting; loss rates; funding (warehouse lines, forward flow); BNPL economics; vintage curves; regulation; CAC
- **Wealthtech & Brokerage:** Payment for order flow; robo-advisors; AUM fees; interest on client cash; custody; customer acquisition; engagement
- **Crypto & Digital Assets:** Blockchain basics; consensus mechanisms; stablecoins; custody; DeFi; tokenomics; exchange revenue; regulatory and security risk

### Market Infrastructure (`market_infrastructure`)
- **General:** How exchanges earn revenue; trade lifecycle; clearing and settlement; central counterparties and margin; market data and indices; custody; operational risk; market structure and liquidity
- **Exchanges & Trading Venues:** Transaction fees; maker-taker pricing; listings revenue; market data revenue; lit vs dark venues; auctions; network effects
- **Clearing & Settlement:** CCP role; novation; initial vs variation margin; default waterfall; netting; settlement cycles; delivery vs payment
- **Market Data & Indices:** Index construction (cap-weighted, equal-weighted, float-adjusted); rebalancing; licensing; subscription economics; benchmark governance; data quality
- **Custody & Securities Services:** Safekeeping; corporate actions; fund administration; securities lending; fees on assets under custody; operational risk; reconciliation

### Consulting (`consulting`)
- **General:** Case structure and frameworks built from scratch; profitability; market sizing; market entry; pricing; M&A cases; operations; growth strategy; chart and data interpretation; case maths; synthesis and recommendations
- **Strategy Consulting:** Growth strategy; competitive advantage; market entry; portfolio strategy; industry analysis; scenario planning
- **Management Consulting (generalist):** Profitability cases; market sizing; pricing; organization design; customer segmentation; synthesis
- **Operations & Performance Improvement:** Process mapping; bottlenecks and capacity; lean; supply chain; cost reduction; procurement; KPIs
- **Restructuring & Turnaround:** Liquidity assessment; 13-week cash flow; cost takeout; working capital release; stakeholder management; interim management; bankruptcy basics
- **Deals / Transaction Services:** Financial due diligence; quality of earnings; net working capital peg; debt-like items; post-merger integration; carve-outs; commercial due diligence
- **Economic & Financial Consulting:** Damages estimation; antitrust (market definition, HHI); transfer pricing; regression; valuation for litigation; expert witness support
- **Actuarial & Risk Consulting:** Pension valuation; discount rate sensitivity; risk quantification; enterprise risk management; stress testing; model validation
- **Technology & Digital Consulting:** Digital transformation business case; ROI of technology investment; cloud migration; data strategy; build vs buy; implementation risk

### Other Finance (`other_finance`)
- **General:** Corporate finance fundamentals; budgeting and forecasting; variance analysis; capital budgeting (NPV, IRR, payback); capital structure; working capital; buy-side corporate development and M&A; treasury (liquidity, hedging); credit ratings methodology
- **Corporate Finance / FP&A:** Budgeting; forecast drivers; variance analysis; KPIs; rolling forecasts; scenario planning; business partnering
- **Corporate Development:** Buy-side M&A; strategic fit; synergy estimation; integration; build/buy/partner; divestitures; board presentations
- **Treasury:** Cash forecasting and liquidity; FX and interest rate hedging; debt issuance; capital structure; cash repatriation; counterparty risk
- **Credit Ratings & Research:** Rating methodology; business vs financial risk; key ratios; outlooks and watches; notching; sovereign ceilings; rating migration; default studies

## Overlap guards (read before writing later files)
- IB Real Estate Coverage already tests: NOI/cap rate basics, FFO/AFFO calcs, NAV per share, implied cap rate, REIT rules, OP units, sale-leaseback pricing, yield on cost, RevPAR, refinancing gap, accretion via cap-rate vs cost spread. The real_estate sector files must test these from a different angle (deal execution, underwriting, waterfalls, lender sizing) or with a genuinely different skill, not the same calc with new numbers.
