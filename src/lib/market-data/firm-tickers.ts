// Which firms on Offerly trade publicly, and under what symbol - so the
// market board's Wall Street tab can chart a student's own top firms.
//
// Keyed by the firm's website as the firms table stores it (a root domain,
// the same key the logos use), mapped to a TradingView symbol: a US listing,
// or the US-listed shares (ADR) of a foreign bank. Only firms whose listing is
// certain are here; a private firm (Centerview, Citadel, Bain Capital) or one
// missing from the list is simply not charted. Add firms as students pick them.

const FIRM_TICKERS: Record<string, string> = {
  // Bulge-bracket and large banks
  "goldmansachs.com": "NYSE:GS",
  "morganstanley.com": "NYSE:MS",
  "jpmorgan.com": "NYSE:JPM",
  "jpmorganchase.com": "NYSE:JPM",
  "bankofamerica.com": "NYSE:BAC",
  "citigroup.com": "NYSE:C",
  "citibank.com": "NYSE:C",
  "wellsfargo.com": "NYSE:WFC",
  "db.com": "NYSE:DB",
  "careers.db.com": "NYSE:DB",
  "home.barclays": "NYSE:BCS",
  "ubs.com": "NYSE:UBS",
  "rbccm.com": "NYSE:RY",
  "tdsecurities.com": "NYSE:TD",
  "bmo.com": "NYSE:BMO",
  "hsbc.com": "NYSE:HSBC",
  "mizuhogroup.com": "NYSE:MFG",
  "nomura.com": "NYSE:NMR",
  "truist.com": "NYSE:TFC",
  "truistsecurities.com": "NYSE:TFC",
  "pnc.com": "NYSE:PNC",
  "usbank.com": "NYSE:USB",
  "citizensbank.com": "NYSE:CFG",
  "capitalone.com": "NYSE:COF",
  "americanexpress.com": "NYSE:AXP",
  "statestreet.com": "NYSE:STT",
  "bny.com": "NYSE:BK",
  "northerntrust.com": "NASDAQ:NTRS",
  // Advisory and middle market
  "evercore.com": "NYSE:EVR",
  "lazard.com": "NYSE:LAZ",
  "pjtpartners.com": "NYSE:PJT",
  "moelis.com": "NYSE:MC",
  "pwpartners.com": "NASDAQ:PWP",
  "hl.com": "NYSE:HLI",
  "jefferies.com": "NYSE:JEF",
  "pipersandler.com": "NYSE:PIPR",
  "raymondjames.com": "NYSE:RJF",
  "stifel.com": "NYSE:SF",
  "oppenheimer.com": "NYSE:OPY",
  // Private equity, credit and asset management
  "blackstone.com": "NYSE:BX",
  "kkr.com": "NYSE:KKR",
  "apollo.com": "NYSE:APO",
  "carlyle.com": "NASDAQ:CG",
  "ares.com": "NYSE:ARES",
  "tpg.com": "NASDAQ:TPG",
  "blueowl.com": "NYSE:OWL",
  "brookfield.com": "NYSE:BN",
  "hamiltonlane.com": "NASDAQ:HLNE",
  "stepstonegroup.com": "NASDAQ:STEP",
  "blackrock.com": "NYSE:BLK",
  "ameriprise.com": "NYSE:AMP",
  "schwab.com": "NYSE:SCHW",
  "lplfinancial.com": "NASDAQ:LPLA",
  "interactivebrokers.com": "NASDAQ:IBKR",
  "robinhood.com": "NASDAQ:HOOD",
  // Exchanges, data and ratings
  "cmegroup.com": "NASDAQ:CME",
  "ice.com": "NYSE:ICE",
  "nasdaq.com": "NASDAQ:NDAQ",
  "spglobal.com": "NYSE:SPGI",
  "moodys.com": "NYSE:MCO",
  "msci.com": "NYSE:MSCI",
  "tradeweb.com": "NASDAQ:TW",
  // Consulting
  "accenture.com": "NYSE:ACN",
};

/** A firm's TradingView symbol from its website, or null when it is private or not listed here. */
export function tickerForWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  const host = website.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return Object.hasOwn(FIRM_TICKERS, host) ? FIRM_TICKERS[host] : null;
}
