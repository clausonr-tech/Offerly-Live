import type { Sector, SourceSeed } from "./types";

// The reviewed starting registry. `npm run news:sources -- seed` upserts these
// into news_sources as approved; the weekly scout adds candidates there as
// "proposed", and only a person approves one (`news:sources -- approve <id>`).
//
// Every RSS URL below was fetched on 28-29 September 2026, parsed, and had
// published within the previous week. The bar for a source is the one the old
// allowlist in finance-news.ts set: reporting a student could cite in a coffee
// chat with a professional in that sector.
//
// A trade source lists the sectors it is trusted for, and its stories can only
// reach those tabs - a source does not need to cover every sector, just one
// well. A major lists none: it is trusted on any finance topic, and the
// classifier decides which tab a story belongs on.

// PHOTOS. A source shows its feed photos only when `photos: true`; every other
// card gets the publisher's masthead tile. Decided on 29 September 2026 by a
// vision review of 5 current feed images from each of the 27 sources that ship
// them (134 images): a source passed only when every sampled image was a real
// photograph, stock photo or chart - no AI imagery and no concept illustration.
// Claims Journal, Risk & Insurance, InvestmentNews and Traders Magazine had
// AI-generated images in the sample; Barron's, MarketWatch, DealBook, The Real
// Deal, Crunchbase, Insurance Journal, Markets Media and PYMNTS run concept
// illustrations or 3D renders. A second review the same day, of all 145 images
// a full collection stored, found no AI images but six concept composites or
// staged concept stock shots, all from Alternative Credit Investor,
// WealthManagement.com and CFO Dive - so those three were switched off too.
// Re-check with scripts/news-eval before flipping one on. Images that pass
// are still checked for AI metadata at ingest.
//
// Since 30 September 2026 every other source's photos can reach a card too,
// but only through the photo step (photos.ts): each photo is measured, checked
// against the publisher's defaults and logos, and looked at by the vision
// check (vision.ts), which turns down AI images, concept shots, logos and ads.
// `photos: true` now means "vetted by a person, so the vision check is skipped".

const TRADE: SourceSeed[] = [
  // Insurance - the sector the old feed left with zero stories.
  { id: "artemis", name: "Artemis", domain: "artemis.bm", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://www.artemis.bm/feed/", region: "global" },
  { id: "reinsurance-news", name: "Reinsurance News", domain: "reinsurancene.ws", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://www.reinsurancene.ws/feed/", region: "global" },
  { id: "insurance-journal", name: "Insurance Journal", domain: "insurancejournal.com", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://insurancejournal.com/feed/", region: "us" },
  { id: "claims-journal", name: "Claims Journal", domain: "claimsjournal.com", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://claimsjournal.com/feed/", region: "us" },
  { id: "carrier-management", name: "Carrier Management", domain: "carriermanagement.com", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://carriermanagement.com/feed/", region: "us" },
  { id: "risk-and-insurance", name: "Risk & Insurance", domain: "riskandinsurance.com", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://riskandinsurance.com/feed/", region: "us" },

  // Real estate
  { id: "the-real-deal", name: "The Real Deal", domain: "therealdeal.com", tier: "trade", sectors: ["real_estate"], kind: "rss", url: "https://therealdeal.com/new-york/feed/", region: "us" },
  { id: "bisnow", name: "Bisnow", domain: "bisnow.com", tier: "trade", sectors: ["real_estate"], kind: "rss", url: "https://bisnow.com/feed/", region: "us", photos: true },
  { id: "commercial-observer", name: "Commercial Observer", domain: "commercialobserver.com", tier: "trade", sectors: ["real_estate", "private_credit"], kind: "rss", url: "https://commercialobserver.com/feed/", region: "us", photos: true },
  { id: "yieldpro", name: "YieldPro", domain: "yieldpro.com", tier: "trade", sectors: ["real_estate"], kind: "rss", url: "https://yieldpro.com/feed/", region: "us" },
  { id: "rejournals", name: "REjournals", domain: "rejournals.com", tier: "trade", sectors: ["real_estate"], kind: "rss", url: "https://rejournals.com/feed/", region: "us" },

  // Private equity and private credit
  { id: "pe-hub", name: "PE Hub", domain: "pehub.com", tier: "trade", sectors: ["private_equity", "venture_capital"], kind: "rss", url: "https://www.pehub.com/feed/", region: "us" },
  { id: "private-equity-wire", name: "Private Equity Wire", domain: "privateequitywire.co.uk", tier: "trade", sectors: ["private_equity", "private_credit"], kind: "rss", url: "https://privateequitywire.co.uk/feed/", region: "uk" },
  { id: "pe-international", name: "Private Equity International", domain: "privateequityinternational.com", tier: "trade", sectors: ["private_equity"], kind: "rss", url: "https://www.privateequityinternational.com/feed/", region: "global", paywall: true },
  { id: "buyouts-insider", name: "Buyouts", domain: "buyoutsinsider.com", tier: "trade", sectors: ["private_equity"], kind: "rss", url: "https://www.buyoutsinsider.com/feed/", region: "us", paywall: true },
  { id: "altassets", name: "AltAssets", domain: "altassets.net", tier: "trade", sectors: ["private_equity", "venture_capital"], kind: "rss", url: "https://www.altassets.net/feed", region: "global" },
  // Added 30 September 2026 from the first scout run (see scripts/news-scout.ts).
  // Its feed answers automated requests with 403 (as its sister site Connect CRE's does), so it comes in through Google.
  { id: "connectmoney", name: "ConnectMoney", domain: "connectmoney.com", tier: "trade", sectors: ["real_estate", "private_equity"], kind: "google_site", url: "site:connectmoney.com when:3d", region: "us" },
  { id: "alternative-credit-investor", name: "Alternative Credit Investor", domain: "alternativecreditinvestor.com", tier: "trade", sectors: ["private_credit"], kind: "rss", url: "https://alternativecreditinvestor.com/feed/", region: "uk" },

  // Venture capital
  { id: "techcrunch", name: "TechCrunch", domain: "techcrunch.com", tier: "trade", sectors: ["venture_capital", "fintech"], kind: "rss", url: "https://techcrunch.com/feed/", region: "us" },
  { id: "crunchbase-news", name: "Crunchbase News", domain: "news.crunchbase.com", tier: "trade", sectors: ["venture_capital"], kind: "rss", url: "https://news.crunchbase.com/feed/", region: "us" },
  { id: "venture-capital-journal", name: "Venture Capital Journal", domain: "venturecapitaljournal.com", tier: "trade", sectors: ["venture_capital"], kind: "rss", url: "https://www.venturecapitaljournal.com/feed/", region: "us", paywall: true },
  { id: "ventureburn", name: "Ventureburn", domain: "ventureburn.com", tier: "trade", sectors: ["venture_capital"], kind: "rss", url: "https://ventureburn.com/feed/", region: "global", notes: "Added from the 30 September 2026 scout run on a trial basis: a smaller outlet, 60% relevant." },
  { id: "sifted", name: "Sifted", domain: "sifted.eu", tier: "trade", sectors: ["venture_capital", "fintech"], kind: "rss", url: "https://sifted.eu/feed/", region: "europe" },

  // Asset and wealth management
  { id: "investmentnews", name: "InvestmentNews", domain: "investmentnews.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://investmentnews.com/rss", region: "us" },
  { id: "wealthmanagement", name: "WealthManagement.com", domain: "wealthmanagement.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://wealthmanagement.com/rss.xml", region: "us" },
  { id: "planadviser", name: "PlanAdviser", domain: "planadviser.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://planadviser.com/feed/", region: "us" },
  { id: "advisorhub", name: "AdvisorHub", domain: "advisorhub.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://advisorhub.com/feed/", region: "us" },

  // Fintech and banking
  { id: "payments-dive", name: "Payments Dive", domain: "paymentsdive.com", tier: "trade", sectors: ["fintech"], kind: "rss", url: "https://www.paymentsdive.com/feeds/news/", region: "us", photos: true },
  { id: "pymnts", name: "PYMNTS", domain: "pymnts.com", tier: "trade", sectors: ["fintech"], kind: "rss", url: "https://www.pymnts.com/feed/", region: "us" },
  { id: "fintech-global", name: "FinTech Global", domain: "fintech.global", tier: "trade", sectors: ["fintech"], kind: "rss", url: "https://fintech.global/feed/", region: "global" },
  { id: "fintech-times", name: "The Fintech Times", domain: "thefintechtimes.com", tier: "trade", sectors: ["fintech"], kind: "rss", url: "https://thefintechtimes.com/feed/", region: "global", photos: true },
  { id: "american-banker", name: "American Banker", domain: "americanbanker.com", tier: "trade", sectors: ["commercial_banking", "fintech"], kind: "rss", url: "https://americanbanker.com/rss", region: "us", paywall: true, photos: true },
  { id: "banking-dive", name: "Banking Dive", domain: "bankingdive.com", tier: "trade", sectors: ["commercial_banking"], kind: "rss", url: "https://www.bankingdive.com/feeds/news/", region: "us", photos: true },

  // Hedge funds, trading and market infrastructure
  { id: "hedgeweek", name: "Hedgeweek", domain: "hedgeweek.com", tier: "trade", sectors: ["hedge_fund"], kind: "rss", url: "https://hedgeweek.com/feed/", region: "global" },
  { id: "markets-media", name: "Markets Media", domain: "marketsmedia.com", tier: "trade", sectors: ["sales_trading", "market_infrastructure"], kind: "rss", url: "https://www.marketsmedia.com/feed/", region: "global" },
  { id: "traders-magazine", name: "Traders Magazine", domain: "tradersmagazine.com", tier: "trade", sectors: ["sales_trading", "market_infrastructure"], kind: "rss", url: "https://www.tradersmagazine.com/feed/", region: "us" },

  // Consulting - one publisher's four regional desks.
  { id: "consultancy-uk", name: "Consultancy.uk", domain: "consultancy.uk", tier: "trade", sectors: ["consulting"], kind: "rss", url: "https://www.consultancy.uk/rss/consultancy_rssfeed.xml", region: "uk" },
  { id: "consultancy-eu", name: "Consultancy.eu", domain: "consultancy.eu", tier: "trade", sectors: ["consulting"], kind: "rss", url: "https://www.consultancy.eu/rss/consultancy_rssfeed.xml", region: "europe" },
  { id: "consulting-us", name: "Consulting.us", domain: "consulting.us", tier: "trade", sectors: ["consulting"], kind: "rss", url: "https://www.consulting.us/rss/consultancy_rssfeed.xml", region: "us" },
  { id: "consultancy-au", name: "Consultancy.com.au", domain: "consultancy.com.au", tier: "trade", sectors: ["consulting"], kind: "rss", url: "https://www.consultancy.com.au/rss/consultancy_rssfeed.xml", region: "asia" },

  // Corporate finance
  { id: "cfo-dive", name: "CFO Dive", domain: "cfodive.com", tier: "trade", sectors: ["other_finance"], kind: "rss", url: "https://www.cfodive.com/feeds/news/", region: "us" },
];

// National newsrooms with a public feed. They carry plenty that is not
// finance (Semafor covers everything), which is the classifier's job to drop.
// Business Insider was dropped on 30 September 2026: 3 of 34 stories in three
// days were finance news, so it mostly spent model calls on lifestyle and tech.
const MAJOR_RSS: SourceSeed[] = [
  { id: "barrons", name: "Barron's", domain: "barrons.com", tier: "major", sectors: [], kind: "rss", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", region: "us", paywall: true },
  { id: "marketwatch", name: "MarketWatch", domain: "marketwatch.com", tier: "major", sectors: [], kind: "rss", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", region: "us" },
  { id: "cnbc-finance", name: "CNBC", domain: "cnbc.com", tier: "major", sectors: [], kind: "rss", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", region: "us" },
  { id: "cnbc-business", name: "CNBC", domain: "cnbc.com", tier: "major", sectors: [], kind: "rss", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", region: "us" },
  { id: "fortune", name: "Fortune", domain: "fortune.com", tier: "major", sectors: [], kind: "rss", url: "https://fortune.com/feed/", region: "us", photos: true },
  { id: "semafor", name: "Semafor", domain: "semafor.com", tier: "major", sectors: [], kind: "rss", url: "https://semafor.com/rss.xml", region: "global", photos: true },
  // Singapore's main business daily - the Asia coverage the "all regions" decision asked for. From the first scout run.
  { id: "business-times-sg", name: "The Business Times", domain: "businesstimes.com.sg", tier: "major", sectors: [], kind: "rss", url: "https://businesstimes.com.sg/rss.xml", region: "asia" },
  { id: "dealbook", name: "DealBook", domain: "nytimes.com", tier: "major", sectors: [], kind: "rss", url: "https://dealbook.nytimes.com/feed/", region: "us", paywall: true },
];

/**
 * The majors with no public feed of their own. Google News, searched one sector
 * at a time and limited to these sites, is how their headlines arrive: no photo
 * and no summary, but the reporting most worth citing. A result from any other
 * publisher is dropped at ingest, whatever Google returns.
 */
export const GOOGLE_MAJOR_SITES = [
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "apnews.com",
  "nytimes.com",
  "cnbc.com",
];

// The words a story in each sector actually uses in its headline.
// Three or four terms each, no more. Measured 29 September 2026: with five
// quoted alternatives Google ignores `when:3d` and returns years-old results
// (2 of 100 fresh for commercial banking); cut to three, 21 of 22 were.
const GOOGLE_SECTOR_TERMS: Record<Sector, string> = {
  investment_banking: '"investment bank" OR "M&A" OR IPO OR dealmaking',
  private_equity: '"private equity" OR buyout OR "take-private"',
  venture_capital: '"venture capital" OR "funding round" OR "Series B"',
  private_credit: '"private credit" OR "direct lending" OR "leveraged loan"',
  real_estate: '"commercial real estate" OR REIT OR "office tower"',
  hedge_fund: '"hedge fund" OR "activist investor" OR "short seller"',
  sales_trading: '"bond market" OR "Treasury yields" OR "trading revenue"',
  asset_wealth_management: '"asset manager" OR "wealth management" OR ETF',
  // Broadened 30 September 2026: the narrow version returned 12 stories in
  // three days and 1 was banking news. This one returns ~100 with roughly one
  // in five on banks (Commerzbank, HSBC, Monzo, consumer lending); the
  // classifier drops the rest. Tighter mixes tested worse: Google reads
  // unquoted words loosely, so "takeover" or "profit" pull in every sector.
  commercial_banking: 'banks lending OR deposits OR "loan growth"',
  insurance: 'insurer OR reinsurance OR reinsurer',
  fintech: 'fintech OR neobank OR stablecoin',
  market_infrastructure: '"stock exchange" OR "clearing house" OR "rating agency"',
  // Narrowed 30 September 2026: bare firm names caught every story that cites a
  // consultancy's research (102 stories, 10 relevant). The firms' full names
  // find news ABOUT them; consulting's real coverage is the consultancy trade press.
  consulting: '"McKinsey & Co" OR "Bain & Co" OR "Boston Consulting Group"',
  other_finance: '"Federal Reserve" OR "chapter 11" OR "capital markets"',
};

export function googleQueryFor(sector: Sector): string {
  const sites = GOOGLE_MAJOR_SITES.map((d) => `site:${d}`).join(" OR ");
  return `(${GOOGLE_SECTOR_TERMS[sector]}) (${sites}) when:3d`;
}

const GOOGLE: SourceSeed[] = (Object.keys(GOOGLE_SECTOR_TERMS) as Sector[]).map((sector) => ({
  id: `google-majors-${sector.replace(/_/g, "-")}`,
  name: "Google News (major newsrooms)",
  domain: "news.google.com",
  tier: "major",
  sectors: [],
  kind: "google_site",
  url: googleQueryFor(sector),
  region: "global",
  notes: `Searches the majors for ${sector} stories.`,
}));

// Regulators' own releases. A primary source is trusted for the sectors it
// regulates. FDIC and FINRA publish no working feed at the time of writing,
// and the FCA's feed carries no dates, so its stories cannot be kept fresh.
// The CFPB was dropped on 30 September 2026: its feed had not updated in 47 days.
const REGULATORS: SourceSeed[] = [
  { id: "federal-reserve", name: "Federal Reserve", domain: "federalreserve.gov", tier: "primary", sectors: ["commercial_banking", "sales_trading", "other_finance"], kind: "regulator", url: "https://www.federalreserve.gov/feeds/press_all.xml", region: "us" },
  { id: "sec-press", name: "SEC", domain: "sec.gov", tier: "primary", sectors: ["market_infrastructure", "asset_wealth_management", "hedge_fund", "investment_banking", "private_equity"], kind: "regulator", url: "https://www.sec.gov/news/pressreleases.rss", region: "us" },
  { id: "occ", name: "OCC", domain: "occ.gov", tier: "primary", sectors: ["commercial_banking"], kind: "regulator", url: "https://www.occ.gov/rss/occ_news.xml", region: "us" },
  { id: "cftc", name: "CFTC", domain: "cftc.gov", tier: "primary", sectors: ["market_infrastructure", "sales_trading"], kind: "regulator", url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml", region: "us" },
  { id: "bank-of-england", name: "Bank of England", domain: "bankofengland.co.uk", tier: "primary", sectors: ["commercial_banking", "sales_trading", "insurance"], kind: "regulator", url: "https://www.bankofengland.co.uk/rss/news", region: "uk" },
  { id: "ecb", name: "European Central Bank", domain: "ecb.europa.eu", tier: "primary", sectors: ["commercial_banking", "sales_trading"], kind: "regulator", url: "https://www.ecb.europa.eu/rss/press.html", region: "europe" },
];

/**
 * SEC filings, handled entirely in code (src/lib/news/edgar.ts): the form type
 * is the story type, so no model reads them. Needs NEWS_SEC_CONTACT - the SEC
 * refuses automated requests that do not name a contact address.
 */
const EDGAR: SourceSeed[] = [
  { id: "edgar-s1", name: "SEC EDGAR", domain: "sec.gov", tier: "primary", sectors: ["investment_banking"], kind: "edgar", url: "S-1", region: "us", notes: "IPO registrations." },
  { id: "edgar-f1", name: "SEC EDGAR", domain: "sec.gov", tier: "primary", sectors: ["investment_banking"], kind: "edgar", url: "F-1", region: "us", notes: "Foreign issuer IPO registrations." },
  { id: "edgar-13d", name: "SEC EDGAR", domain: "sec.gov", tier: "primary", sectors: ["hedge_fund"], kind: "edgar", url: "SCHEDULE 13D", region: "us", notes: "Activist stakes; only filers on the known-activist list become stories." },
];


// Added 30 September 2026 from the wider scout run (credibility check on).
// Most of these publish no feed a machine can find - they come in through a
// Google News search limited to their own site (kind "google_site"), and
// ingest accepts only that site's stories from it.
const SCOUTED: SourceSeed[] = [
  // Insurance
  { id: "the-insurer", name: "The Insurer", domain: "theinsurer.com", tier: "trade", sectors: ["insurance"], kind: "google_site", url: "site:theinsurer.com when:3d", region: "global", paywall: true },
  { id: "insurance-business", name: "Insurance Business", domain: "insurancebusinessmag.com", tier: "trade", sectors: ["insurance"], kind: "google_site", url: "site:insurancebusinessmag.com when:3d", region: "global" },
  { id: "business-insurance", name: "Business Insurance", domain: "businessinsurance.com", tier: "trade", sectors: ["insurance"], kind: "rss", url: "https://www.businessinsurance.com/feed/", region: "us" },
  // Fintech, banking technology and crypto infrastructure
  { id: "fintech-futures", name: "FinTech Futures", domain: "fintechfutures.com", tier: "trade", sectors: ["fintech", "commercial_banking"], kind: "google_site", url: "site:fintechfutures.com when:3d", region: "global" },
  // Crypto reporting stays on the Fintech tab only - it is where the digital-assets specialty lives.
  { id: "the-block", name: "The Block", domain: "theblock.co", tier: "trade", sectors: ["fintech"], kind: "rss", url: "https://theblock.co/feed/", region: "global" },
  // Careers across the banks and funds - the most student-relevant trade press there is.
  { id: "efinancialcareers", name: "eFinancialCareers", domain: "efinancialcareers.com", tier: "trade", sectors: ["investment_banking", "sales_trading", "hedge_fund"], kind: "google_site", url: "site:efinancialcareers.com/news when:3d", region: "global", notes: "News section only: the whole site returned 95 stories in three days, nearly all job ads, and 10 were news (30 September 2026)." },
  // Trading and market structure
  { id: "the-trade", name: "The TRADE", domain: "thetradenews.com", tier: "trade", sectors: ["sales_trading", "market_infrastructure"], kind: "google_site", url: "site:thetradenews.com when:3d", region: "global" },
  // Asset and wealth management
  { id: "citywire", name: "Citywire", domain: "citywire.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "google_site", url: "site:citywire.com when:3d", region: "global" },
  { id: "pensions-investments", name: "Pensions & Investments", domain: "pionline.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "google_site", url: "site:pionline.com when:3d", region: "us", paywall: true },
  { id: "pwm", name: "PWM", domain: "pwmnet.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "google_site", url: "site:pwmnet.com when:3d", region: "global", paywall: true },
  { id: "family-wealth-report", name: "Family Wealth Report", domain: "familywealthreport.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "google_site", url: "site:familywealthreport.com when:3d", region: "global" },
  { id: "daily-upside", name: "The Daily Upside", domain: "thedailyupside.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://www.thedailyupside.com/feed/", region: "us" },
  { id: "asia-asset", name: "Asia Asset Management", domain: "asiaasset.com", tier: "trade", sectors: ["asset_wealth_management"], kind: "rss", url: "https://www.asiaasset.com/feed/", region: "asia" },
  { id: "alternatives-watch", name: "Alternatives Watch", domain: "alternativeswatch.com", tier: "trade", sectors: ["asset_wealth_management", "private_equity", "real_estate"], kind: "google_site", url: "site:alternativeswatch.com when:3d", region: "us" },
  // Private credit and infrastructure
  { id: "private-debt-investor", name: "Private Debt Investor", domain: "privatedebtinvestor.com", tier: "trade", sectors: ["private_credit"], kind: "google_site", url: "site:privatedebtinvestor.com when:3d", region: "global", paywall: true },
  { id: "infrastructure-investor", name: "Infrastructure Investor", domain: "infrastructureinvestor.com", tier: "trade", sectors: ["private_equity"], kind: "google_site", url: "site:infrastructureinvestor.com when:3d", region: "global", paywall: true },
  // Venture capital
  { id: "calcalist-tech", name: "Calcalist Tech", domain: "calcalistech.com", tier: "trade", sectors: ["venture_capital"], kind: "google_site", url: "site:calcalistech.com when:3d", region: "global" },
  // Corporate finance
  { id: "cfo-com", name: "CFO.com", domain: "cfo.com", tier: "trade", sectors: ["other_finance"], kind: "rss", url: "https://www.cfo.com/feeds/news/", region: "us" },
  // Local business journals: real estate deals only - the rest is too local to be finance news.
  { id: "business-journals", name: "The Business Journals", domain: "bizjournals.com", tier: "trade", sectors: ["real_estate"], kind: "google_site", url: "site:bizjournals.com when:3d", region: "us", paywall: true },
  // National business newsrooms outside the US - the "all regions" decision.
  { id: "livemint", name: "Mint", domain: "livemint.com", tier: "major", sectors: [], kind: "google_site", url: "site:livemint.com when:3d", region: "asia" },
  { id: "business-today-in", name: "Business Today", domain: "businesstoday.in", tier: "major", sectors: [], kind: "rss", url: "https://businesstoday.in/feed/", region: "asia" },
  { id: "capital-brief", name: "Capital Brief", domain: "capitalbrief.com", tier: "major", sectors: [], kind: "rss", url: "https://www.capitalbrief.com/feed/latest.xml", region: "other" },
  // From the thin-sector scout run of 30 September 2026. Financial News is
  // London's banking and asset-management trade paper (93% of its stories
  // relevant, ~60 a week); Consulting Magazine was found by hand after the scout
  // came back empty for consulting - firm deals, practice launches and partner
  // moves, the news a consulting candidate is asked about.
  { id: "fnlondon", name: "Financial News", domain: "fnlondon.com", tier: "trade", sectors: ["investment_banking", "hedge_fund", "asset_wealth_management"], kind: "google_site", url: "site:fnlondon.com when:3d", region: "uk", paywall: true },
  { id: "consulting-magazine", name: "Consulting Magazine", domain: "consultingmag.com", tier: "trade", sectors: ["consulting"], kind: "google_site", url: "site:consultingmag.com when:3d", region: "us" },
];

export const SOURCE_SEEDS: SourceSeed[] = [...TRADE, ...MAJOR_RSS, ...GOOGLE, ...REGULATORS, ...EDGAR, ...SCOUTED];

/**
 * Publishers never to ingest, from the 28 September scout run: aggregators,
 * ticker bait and press-release wires that Google News returns in volume.
 */
export const BLOCKED_DOMAINS = new Set([
  "tradingview.com",
  "marketbeat.com",
  "simplywall.st",
  "pulse2.com",
  "citybiz.co",
  "quiverquant.com",
  "stocktitan.net",
  "marketscreener.com",
  "gurufocus.com",
  "tipranks.com",
  "moomoo.com",
  "investing.com",
  "finance.biggo.com",
  "ad-hoc-news.de",
  "tradersunion.com",
  "kalkine.ca",
  "kalkinemedia.com",
  "stockstory.org",
  "247wallst.com",
  "benzinga.com",
  "seekingalpha.com",
  "zacks.com",
  "insidermonkey.com",
  "fool.com",
  "financialcontent.com",
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
  "accesswire.com",
  "einpresswire.com",
  "openpr.com",
  "streetinsider.com",
  "app.dealroom.co",
]);
