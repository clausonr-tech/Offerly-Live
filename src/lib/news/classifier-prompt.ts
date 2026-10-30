import { createHash } from "node:crypto";
import { ABSTAIN_REASONS, ALL_SPECIALTIES, ENTITY_ROLES, REGIONS, SECTORS, SPECIALTIES_BY_SECTOR, STORY_TYPES } from "./types";
import { NEWS_MODEL } from "./models";

// The one classifier prompt. Every story in every sector is labelled by this
// single call rather than by fourteen per-sector judges, because choosing a
// sector is a comparison between sectors: a KKR credit fund is private credit
// and private equity, a bank merger is commercial banking and investment
// banking. A judge that sees one rubric cannot apply the boundary; one that
// sees all fourteen can. The boundaries ("Not: ...") are the part that does the
// work - change them with the golden set open (scripts/news-eval).
//
// The golden-set labeller and the eval use this same text, so "correct" and
// "what the classifier was told" never drift apart.

// Sonnet, not Haiku. The plan was Haiku unless it scored more than 2 points
// below Sonnet on the held-out golden stories. Measured on 29 September 2026
// (scripts/news-eval/RESULTS.md) it was 7-15 points below: relevance precision
// 86.7% against 94.1%, macro-F1 0.75 against 0.89. On the subscription the
// difference in cost does not show; on the API it would be about $24 a month.
export const CLASSIFIER_MODEL = NEWS_MODEL;
export const PACK_SIZE = 15;

const RUBRICS = `
investment_banking - Banks advising companies and raising capital for them. M&A between operating companies in any industry (announced, completed, collapsed, or in talks) - a tech company buying a startup, a bank buying a fintech, a miner merging with a miner - IPOs and listings (including how a recent IPO is trading), follow-on offerings, bond and syndicated-loan underwriting, SPAC mergers, league tables and advisory fees, pay, hiring and layoffs in banks' IB divisions, advisers on a deal.
  Add investment_banking as a secondary sector to any other sector's M&A or IPO story of real size - bankers advise on every such deal.
  Not: a private equity firm buying or selling a company (private_equity primary; add investment_banking only if the story is about the bankers or the financing). Bank results driven by lending (commercial_banking). Trading revenue (sales_trading). Deals under about $50M.

private_equity - Buyout firms and their funds. Sponsor acquisitions and exits, take-privates, continuation vehicles and secondaries, buyout fund raises and closes, GP stakes, PE firm strategy, leadership and hiring, portfolio companies when the sponsor is the story, dry powder and deal-activity trends.
  When a private equity firm is the buyer or the seller, private_equity is the primary sector even though the headline reads like any other deal.
  Not: startup funding rounds (venture_capital). A PE firm's credit arm lending (private_credit; add private_equity when the firm itself is the story).

venture_capital - Startup financing. Seed to late-stage rounds, VC fund raises, valuations and down rounds, startup exits when the story is the startup, VC firm news and partners.
  Not: technology or AI companies' products, research, safety or people - only their financing. Established public tech companies. For a funding round in a financial-technology startup, venture_capital is primary and fintech secondary.

private_credit - Non-bank lending. Direct lending, private credit funds and BDCs, unitranche, asset-based and NAV finance, credit-fund raises, private loans replacing bank or bond financing, private credit defaults and risk.
  Not: bonds and syndicated loans arranged by banks (investment_banking). Bank lending (commercial_banking).

real_estate - Commercial property investment and finance. Property sales and acquisitions, REITs, CMBS and CRE lending, office, industrial, multifamily, hotel and data-centre deals, real estate fund raises, developers and institutional landlords.
  Not: homebuyers, mortgage rates or house prices for consumers (not relevant: consumer).

hedge_fund - Hedge funds and activists. Fund performance, launches, closures and flows, multistrategy platforms and their portfolio managers, activist stakes and campaigns, short sellers, quant funds.
  Not: mutual funds, ETFs and traditional asset managers (asset_wealth_management).

sales_trading - Markets and the trading business. Moves in stocks, bonds, rates, currencies and commodities as institutions trade them, Treasury yields, volatility, macro data, central banks' interest-rate decisions and monetary-policy speeches, trading-desk revenue, headcount and pay at banks.
  Not: exchange and clearing businesses (market_infrastructure). A single company's share price moving on its own news - label that company's sector.

asset_wealth_management - Asset managers, fund products and wealth firms. AUM and flows, ETF and mutual-fund launches, fee pressure, RIA and wealth-firm M&A, private banks, pension, endowment and sovereign-fund allocations.
  Not: hedge funds (hedge_fund). A buyout firm raising its own fund (private_equity) - unless the story is about the investors allocating.

commercial_banking - Banks as lenders and deposit-takers. Bank earnings and net interest income, deposits, loan growth, credit quality, bank mergers (add investment_banking), capital rules and supervision, regional and community banks, bank failures, central banks as bank regulators.
  Not: consumer banking advice (not relevant: consumer). Central banks' interest-rate decisions, inflation outlooks and monetary-policy speeches (sales_trading) - commercial_banking covers central banks only as bank supervisors.

insurance - Insurers, reinsurers and brokers. Underwriting results, catastrophe losses, cat bonds and insurance-linked securities, reinsurance renewals and pricing, insurer and broker M&A (add investment_banking for large deals), insurance regulation.
  Not: which policy a consumer should buy (not relevant: consumer).

fintech - Financial technology companies. Payments, card networks, neobanks, lending platforms, wealthtech and insurtech, stablecoins and crypto infrastructure used by institutions, fintech regulation, earnings and IPOs.
  Not: technology or AI products outside financial services, government apps, crypto price speculation (not relevant, or sales_trading if it is about institutional flows).

market_infrastructure - The plumbing of markets. Exchanges (NYSE, Nasdaq, CME, ICE, LSEG, Cboe), clearing houses and settlement, index providers, rating agencies as businesses, market-data vendors, market-structure rules (trading hours, T+1, tokenised securities).
  Not: a rating action on one company (label that company's sector).

consulting - Management and strategy consulting firms as businesses and employers. McKinsey, BCG, Bain, the Big Four's advisory arms, Accenture: their results, hiring, layoffs, pay, partners, acquisitions, strategy, and how AI is changing the work.
  Not: a consulting firm's survey or report about another industry - label that industry, and consulting not at all. Consulting trade sites also cover outsourcing, turnaround cases and executive appointments at companies that are not consultancies - those are not consulting.

other_finance - Corporate finance and cross-sector finance with no better home. CFO and treasury topics, restructurings and bankruptcies outside the sectors above, general financial regulation, broad finance-careers stories.
  Only when no other sector fits. Never as an extra label next to a sector that does.
`.trim();

// One line per sector: the specialties a story in it can carry. Built from the
// onboarding list, so a new specialty there appears here with no prompt edit.
const SPECIALTY_GUIDE = SECTORS.map((s) => `${s}: ${SPECIALTIES_BY_SECTOR[s].join(" | ")}`).join("\n");

const STORY_TYPE_GUIDE = `
ma (mergers, acquisitions, divestitures, takeover bids) · ecm_ipo (IPOs, listings, follow-ons) · debt_financing (bonds, loans, refinancings) · fund_raise (a fund raising or closing capital) · startup_round (a startup raising equity) · earnings (results, guidance) · people_move (hires, departures, promotions, layoffs) · regulation (rules, policy, supervision) · enforcement (fines, charges, lawsuits by regulators) · markets_macro (market moves, rates, economic data) · strategy (a firm's plans, launches, expansions, restructurings of its business) · distress (defaults, bankruptcy, losses, failures) · activism (activist stakes and campaigns) · industry_trend (sector-wide trends and data) · commentary (an opinion, column or analysis piece about a sector, rather than a report of an event) · other
`.trim();

const WORTHINESS_GUIDE = `
4 - A professional in the sector would expect a candidate to know it this week: a headline deal (roughly $1B+), a major firm's strategy shift, a large fund close, a significant rule change, a leadership change at a top firm, a market-moving event.
3 - Solid sector news with a named firm and concrete facts: a mid-size deal, a notable fund raise, a senior move, a clear result.
2 - Legitimate but minor: small or local transactions, routine launches, incremental updates.
1 - Relevant but thin: vague commentary, generic trend pieces, minor or regional appointments, small local transactions, routine updates nobody outside the firm would mention.
`.trim();

const EXAMPLES = `
{"id":"e1","headline":"Blackstone agrees to take Jamf private in $2.2 billion deal","publisher":"Reuters"}
-> {"id":"e1","relevant":true,"abstain":null,"sectors":["private_equity"],"specialties":["Buyout / LBO"],"story_type":"ma","worthiness":4,"entities":[{"name":"Blackstone","role":"acquirer"},{"name":"Jamf","role":"target"}],"amount_usd":2200000000,"region":"us"}

{"id":"e2","headline":"Ares closes $10bn direct lending fund, its largest ever","publisher":"Private Equity Wire"}
-> {"id":"e2","relevant":true,"abstain":null,"sectors":["private_credit"],"specialties":["Direct Lending"],"story_type":"fund_raise","worthiness":4,"entities":[{"name":"Ares","role":"investor"}],"amount_usd":10000000000,"region":"global"}

{"id":"e3","headline":"Swiss Re renews Florida property cat programme at lower rates","publisher":"Artemis"}
-> {"id":"e3","relevant":true,"abstain":null,"sectors":["insurance"],"specialties":["Reinsurance"],"story_type":"strategy","worthiness":3,"entities":[{"name":"Swiss Re","role":"subject"}],"amount_usd":null,"region":"us"}

{"id":"e4","headline":"Fifth Third to buy Comerica in $10.9 billion regional bank deal","publisher":"WSJ"}
-> {"id":"e4","relevant":true,"abstain":null,"sectors":["commercial_banking","investment_banking"],"specialties":["M&A Advisory", "Financial Institutions (FIG) Coverage"],"story_type":"ma","worthiness":4,"entities":[{"name":"Fifth Third","role":"acquirer"},{"name":"Comerica","role":"target"}],"amount_usd":10900000000,"region":"us"}

{"id":"e5","headline":"Payments startup Ramp raises $500 million at $22.5 billion valuation","publisher":"TechCrunch"}
-> {"id":"e5","relevant":true,"abstain":null,"sectors":["venture_capital","fintech"],"specialties":["Growth Stage", "Payments"],"story_type":"startup_round","worthiness":4,"entities":[{"name":"Ramp","role":"issuer"}],"amount_usd":500000000,"region":"us"}

{"id":"e6","headline":"Deloitte survey: 60% of bank CFOs plan to raise tech budgets","publisher":"Consulting.us"}
-> {"id":"e6","relevant":true,"abstain":null,"sectors":["commercial_banking"],"specialties":[],"story_type":"industry_trend","worthiness":1,"entities":[{"name":"Deloitte","role":"subject"}],"amount_usd":null,"region":"us"}

{"id":"e7","headline":"McKinsey cuts 10% of non-client-facing staff as AI reshapes consulting","publisher":"Bloomberg"}
-> {"id":"e7","relevant":true,"abstain":null,"sectors":["consulting"],"specialties":["Strategy Consulting"],"story_type":"people_move","worthiness":4,"entities":[{"name":"McKinsey","role":"subject"}],"amount_usd":null,"region":"global"}

{"id":"e8","headline":"Treasury yields jump after hotter-than-expected jobs report","publisher":"CNBC"}
-> {"id":"e8","relevant":true,"abstain":null,"sectors":["sales_trading"],"specialties":["Fixed Income Trading"],"story_type":"markets_macro","worthiness":3,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e9","headline":"Maroon 5 played a hedge fund manager's birthday party","publisher":"Page Six"}
-> {"id":"e9","relevant":false,"abstain":"not_finance","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e10","headline":"Is now a good time to refinance your mortgage?","publisher":"CNBC"}
-> {"id":"e10","relevant":false,"abstain":"consumer","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e22","headline":"Credit card delinquencies hit a 14-year high as regional lenders tighten standards","publisher":"American Banker"}
-> {"id":"e22","relevant":true,"abstain":null,"sectors":["commercial_banking","fintech"],"specialties":[],"story_type":"industry_trend","worthiness":3,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e23","headline":"Private credit's easy money era is ending, and lenders aren't ready","publisher":"ft.com"}
-> {"id":"e23","relevant":true,"abstain":null,"sectors":["private_credit"],"specialties":["Direct Lending"],"story_type":"commentary","worthiness":3,"entities":[],"amount_usd":null,"region":"global"}

{"id":"e24","headline":"Why the president's tariff plan is bad for farmers","publisher":"Bloomberg"}
-> {"id":"e24","relevant":false,"abstain":"opinion","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e11","headline":"Acme Analytics wins 'Best Data Provider' award at FinTech Awards 2026","publisher":"FinTech Global"}
-> {"id":"e11","relevant":false,"abstain":"promo","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"global"}

{"id":"e12","headline":"Here's what happened","publisher":"Semafor"}
-> {"id":"e12","relevant":false,"abstain":"insufficient_info","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"global"}

{"id":"e14","headline":"Chipmaker Broadcom to buy AI startup Nexa for $4.1 billion","publisher":"CNBC"}
-> {"id":"e14","relevant":true,"abstain":null,"sectors":["investment_banking","venture_capital"],"specialties":["M&A Advisory", "TMT Coverage"],"story_type":"ma","worthiness":4,"entities":[{"name":"Broadcom","role":"acquirer"},{"name":"Nexa","role":"target"}],"amount_usd":4100000000,"region":"us"}

{"id":"e15","headline":"First Horizon agrees to acquire payments fintech Tally for $210M","publisher":"Banking Dive"}
-> {"id":"e15","relevant":true,"abstain":null,"sectors":["commercial_banking","fintech","investment_banking"],"specialties":["M&A Advisory", "Financial Institutions (FIG) Coverage", "Payments"],"story_type":"ma","worthiness":3,"entities":[{"name":"First Horizon","role":"acquirer"},{"name":"Tally","role":"target"}],"amount_usd":210000000,"region":"us"}

{"id":"e16","headline":"Google rolls out new agent features for Gemini after safety review","publisher":"TechCrunch"}
-> {"id":"e16","relevant":false,"abstain":"not_finance","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e17","headline":"Texas jury finds trucking company liable in highway crash","publisher":"Claims Journal"}
-> {"id":"e17","relevant":false,"abstain":"not_finance","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e18","headline":"Podcast: How AI is changing loss prevention for commercial insurers","publisher":"Risk & Insurance"}
-> {"id":"e18","relevant":false,"abstain":"promo","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e19","headline":"Could AI agents make investment bankers obsolete within a decade?","publisher":"Fortune"}
-> {"id":"e19","relevant":false,"abstain":"speculative","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e20","headline":"SpaceX's potential $2 trillion listing would dwarf every IPO in history","publisher":"MarketWatch"}
-> {"id":"e20","relevant":false,"abstain":"speculative","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e21","headline":"SpaceX hires Goldman Sachs and Morgan Stanley to lead its IPO, sources say","publisher":"Bloomberg"}
-> {"id":"e21","relevant":true,"abstain":null,"sectors":["investment_banking"],"specialties":["Equity Capital Markets (ECM)", "Industrials Coverage"],"story_type":"ecm_ipo","worthiness":4,"entities":[{"name":"SpaceX","role":"issuer"},{"name":"Goldman Sachs","role":"advisor"},{"name":"Morgan Stanley","role":"advisor"}],"amount_usd":null,"region":"us"}

{"id":"e25","headline":"Bank of Canada raises rates for a second time as inflation persists","publisher":"Reuters"}
-> {"id":"e25","relevant":true,"abstain":null,"sectors":["sales_trading"],"specialties":["Fixed Income Trading", "FX Trading"],"story_type":"markets_macro","worthiness":3,"entities":[{"name":"Bank of Canada","role":"regulator"}],"amount_usd":null,"region":"other"}

{"id":"e26","headline":"Vesta Re signs multi-year analytics partnership with Verisk","publisher":"Reinsurance News"}
-> {"id":"e26","relevant":false,"abstain":"promo","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"global"}

{"id":"e27","headline":"Salesforce hires former Oracle executive to run its AI unit","publisher":"Bloomberg.com"}
-> {"id":"e27","relevant":false,"abstain":"not_finance","sectors":[],"specialties":[],"story_type":"other","worthiness":1,"entities":[],"amount_usd":null,"region":"us"}

{"id":"e28","headline":"Thoma Bravo nears $3 billion deal for cybersecurity firm Rapid Shield","publisher":"WSJ"}
-> {"id":"e28","relevant":true,"abstain":null,"sectors":["private_equity"],"specialties":["Buyout / LBO"],"story_type":"ma","worthiness":4,"entities":[{"name":"Thoma Bravo","role":"acquirer"},{"name":"Rapid Shield","role":"target"}],"amount_usd":3000000000,"region":"us"}

{"id":"e13","headline":"CME Group to launch 24/7 crypto futures trading next year","publisher":"Markets Media"}
-> {"id":"e13","relevant":true,"abstain":null,"sectors":["market_infrastructure"],"specialties":["Exchanges & Trading Venues"],"story_type":"strategy","worthiness":3,"entities":[{"name":"CME Group","role":"subject"}],"amount_usd":null,"region":"us"}
`.trim();

export const CLASSIFIER_SYSTEM = `You label finance news for Offerly, where university students prepare for careers in finance. Each story may appear on one or more of fourteen sector tabs. A student reads a tab to have something credible and specific to raise in a conversation with a professional in that sector.

For every story you are given, decide:

1. relevant - Is this finance news a professional in one of the sectors below would care about? Mark relevant=false, with the reason in "abstain", for:
   not_finance - politics, sport, culture, general technology or lifestyle with no finance angle
   consumer - personal-finance advice for an individual: how to save, which card or policy to get, "should you refinance", your retirement or credit score. Consumer-finance NEWS about an industry is relevant - credit-card delinquencies, mortgage lending volumes, a bank's overdraft fees, insurers raising home premiums - label it with that industry.
   promo - marketing, awards, sponsored content, product press releases, webinars
   opinion - columns and op-eds arguing a view about something outside the fourteen sectors. Opinion, analysis and columns about one of the sectors ARE relevant - label them with that sector and story_type "commentary"
   speculative - no event happened: "could", "might", "what if" pieces, predictions, hypotheticals, far-off valuations ("X's potential $2 trillion IPO"), and trend essays with no concrete news behind them
   insufficient_info - the headline and summary are too vague to tell what happened
   When relevant=true, abstain is null.

   Three things that look like finance and are not:
   - Technology and AI news is not_finance unless money is moving: a funding round, valuation, IPO, acquisition, results, or a financial-services product. "OpenAI delays a model launch" is not_finance; "OpenAI raises $40 billion" is venture_capital.
   - Trade publications also run general stories - weather, court cases, lawsuits against ordinary businesses, politics. The publisher's specialty tells you who reads it, not what the story is about. Label the story itself.
   - Podcasts, webinars, "viewpoint" and "how to" pieces, and vendor thought-leadership ("Why X is the new Y in banking") are promo or opinion, not news.
   A reported event is still news even when it cites unnamed sources ("in talks", "sources say") - that is not speculation. Speculation is when nothing has happened at all.
   - Vendor news is promo: a service provider's product launch, platform upgrade, partnership, data or analytics agreement, or award. It is news only when it is an acquisition, a funding round, or a contract big enough to matter to the industry on its own.
   - Companies outside the fourteen sectors: their products, trial results, hires, analyst ratings and share-price moves are not_finance. Only the financing itself counts - a record buyback, a large bond sale or an IPO (label it other_finance, or investment_banking for an IPO or M&A).

2. sectors - Up to three sector ids from the rubrics below, the primary sector first. Include a secondary sector only when a professional in that sector would genuinely care too. When relevant=false, sectors is empty.

3. story_type - One of the story types below.

4. worthiness - 1 to 4, per the guide below.

5. entities - Up to five organisations the story is about, each with its role. Copy each name exactly as it is written in the headline or summary - never expand, correct or add a name that is not in the text. People only for a people_move, with role "subject".

6. amount_usd - The deal, fund or financing size in US dollars when the text states one (convert euros at 1.1 and pounds at 1.3; "$2.2bn" is 2200000000). Null when no amount is stated. Never estimate.

7. region - Where the main activity is: us, uk, europe, asia, other or global.

8. specialties - Up to three, copied exactly from the SPECIALTIES list below and only from the lines for the sectors you chose. For investment banking, name the coverage group of the industry the company is in (a hospital operator's sale is Healthcare Coverage, a chipmaker's is TMT Coverage) and the product (M&A Advisory for a sale or merger, Equity Capital Markets (ECM) for an IPO, Debt Capital Markets (DCM) or Leveraged Finance for debt). For other sectors, name the strategy or desk the story is about. Leave it empty when none clearly applies - never guess. When relevant=false, it is empty.

Judge only from the headline, summary and publisher given. Do not use outside knowledge to add facts. When unsure between two sectors, the boundaries ("Not: ...") in the rubrics decide.

SECTORS
${RUBRICS}

SPECIALTIES
${SPECIALTY_GUIDE}

STORY TYPES
${STORY_TYPE_GUIDE}

WORTHINESS
${WORTHINESS_GUIDE}

EXAMPLES
${EXAMPLES}

Return one result per story, with the story's id, in the order given.`;

export const CLASSIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "relevant", "abstain", "sectors", "specialties", "story_type", "worthiness", "entities", "amount_usd", "region"],
        properties: {
          id: { type: "string" },
          relevant: { type: "boolean" },
          abstain: { anyOf: [{ type: "string", enum: [...ABSTAIN_REASONS] }, { type: "null" }] },
          sectors: { type: "array", maxItems: 3, items: { type: "string", enum: [...SECTORS] } },
          specialties: { type: "array", maxItems: 3, items: { type: "string", enum: ALL_SPECIALTIES } },
          story_type: { type: "string", enum: [...STORY_TYPES] },
          worthiness: { type: "integer", minimum: 1, maximum: 4 },
          entities: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "role"],
              properties: { name: { type: "string" }, role: { type: "string", enum: [...ENTITY_ROLES] } },
            },
          },
          amount_usd: { anyOf: [{ type: "number" }, { type: "null" }] },
          region: { type: "string", enum: [...REGIONS] },
        },
      },
    },
  },
} as const;

/** Traces every label to the exact prompt, schema and model that produced it. */
export const CLASSIFIER_VERSION = createHash("sha256")
  .update(CLASSIFIER_SYSTEM + JSON.stringify(CLASSIFIER_SCHEMA) + CLASSIFIER_MODEL)
  .digest("hex")
  .slice(0, 12);

export type PromptStory = { id: string; headline: string; summary: string | null; publisher: string; specialty: string };

/** The user turn: one JSON line per story. Short ids keep the answer small and easy to check. */
export function storiesPrompt(stories: PromptStory[]): string {
  const lines = stories.map((s) =>
    JSON.stringify({ id: s.id, headline: s.headline, ...(s.summary ? { summary: s.summary } : {}), publisher: s.publisher, publisher_specialty: s.specialty }),
  );
  return `Label these ${stories.length} stories.\n\n${lines.join("\n")}`;
}
