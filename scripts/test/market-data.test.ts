// The Markets view's sources and rules: reading each official file the way
// its publisher writes it, which series the history route will fetch, when
// the wrap is due, and what a wrap bullet must cite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fxFromEcbCsv, parseTreasuryCsv } from "../../src/lib/market-data/official";
import { marketOpen } from "../../src/lib/market-data/clock";
import { chartable } from "../../src/lib/market-data/board";
import { dueSlot, validateWrapBullet } from "../../src/lib/news/market-wrap";

test("Treasury's yield curve file is read by maturity, oldest day first", () => {
  const csv = `Date,"1 Mo","2 Yr","10 Yr","30 Yr"\n09/29/2026,4.04,4.89,5.26,5.59\n09/28/2026,4.04,4.92,5.24,N/A`;
  assert.deepEqual(parseTreasuryCsv(csv), [
    { date: "2026-09-28", rates: { "1 Mo": 4.04, "2 Yr": 4.92, "10 Yr": 5.24 } },
    { date: "2026-09-29", rates: { "1 Mo": 4.04, "2 Yr": 4.89, "10 Yr": 5.26, "30 Yr": 5.59 } },
  ]);
});

test("the ECB's rates against the euro become the dollar pairs traders quote", () => {
  const csv = [
    "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-29,1.1355",
    "EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,2026-09-29,178.41",
    "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-09-29,0.85720",
    "EXR.D.CNY.EUR.SP00.A,D,CNY,EUR,SP00,A,2026-09-29,7.6117",
  ].join("\n");
  const fx = fxFromEcbCsv(csv);
  assert.equal(fx.EURUSD[0].value, 1.1355);
  assert.equal(fx.USDJPY[0].value.toFixed(2), "157.12", "yen per dollar = yen per euro / dollars per euro");
  assert.equal(fx.GBPUSD[0].value.toFixed(4), "1.3247", "dollars per pound = dollars per euro / pounds per euro");
  assert.equal(fx.USDCNY[0].value.toFixed(4), "6.7034");
});

test("the history route fetches only what the Markets view shows", () => {
  for (const id of ["UST10Y", "SPREAD2S10S", "EURUSD", "DCOILWTICO", "DTWEXBGS", "CPIYOY"]) assert.ok(chartable(id), id);
  // No stock prices, the VIX or ICE's credit spreads: none of them may be shown (licensing, 30 September 2026).
  for (const id of ["SPY", "NVDA", "VIX", "BAMLH0A0HYM2", "BAMLC0A0CM", "GME", "../etc", "DGS10", "", "spy"]) assert.equal(chartable(id), false, id);
});

test("the wrap is due after 10:30 and 16:30 New York time on weekdays", () => {
  assert.equal(dueSlot(new Date("2026-09-29T14:29:00Z")), null, "10:29am EDT");
  assert.deepEqual(dueSlot(new Date("2026-09-29T14:30:00Z")), { slot: "open", date: "2026-09-29" });
  assert.deepEqual(dueSlot(new Date("2026-09-29T20:31:00Z")), { slot: "close", date: "2026-09-29" });
  assert.equal(dueSlot(new Date("2026-10-03T20:31:00Z")), null, "Saturday");
});

test("a wrap bullet states only numbers it cites, and gives a reason only with a story", () => {
  const data = new Map([["d1", "S&P 500 (via SPY): 569.32, down 0.33%, live at 3:59 PM ET, source Alpaca (IEX)"]]);
  const stories = new Map([["s1", { ref: "s1", title: "Stocks slip as consumer confidence falls", description: "Consumer confidence fell to its lowest since 2014.", link: "https://example.com/a", publisher: "Barron's" }]]);
  assert.ok(validateWrapBullet({ text: "The S&P 500 fell 0.33%.", data: ["d1"], stories: [] }, data, stories));
  assert.equal(validateWrapBullet({ text: "The S&P 500 fell 0.4%.", data: ["d1"], stories: [] }, data, stories), null, "0.4 is not what the data says");
  assert.equal(validateWrapBullet({ text: "The S&P 500 fell 0.33% amid rate fears.", data: ["d1"], stories: [] }, data, stories), null, "a reason with no story");
  const withStory = validateWrapBullet({ text: "The S&P 500 fell 0.33% as consumer confidence hit its lowest since 2014.", data: ["d1"], stories: ["s1"] }, data, stories);
  assert.deepEqual(withStory?.sources, [{ title: "Stocks slip as consumer confidence falls", link: "https://example.com/a", publisher: "Barron's" }]);
  assert.equal(validateWrapBullet({ text: "Stocks fell.", data: [], stories: [] }, data, stories), null, "cites nothing");
});

test("the market is open 9:30 to 4pm New York time on weekdays, whatever the clock's time zone", () => {
  assert.equal(marketOpen(new Date("2026-09-30T13:29:00Z")), false, "9:29am EDT");
  assert.equal(marketOpen(new Date("2026-09-30T13:30:00Z")), true, "9:30am EDT");
  assert.equal(marketOpen(new Date("2026-09-30T19:59:00Z")), true, "3:59pm EDT");
  assert.equal(marketOpen(new Date("2026-09-30T20:00:00Z")), false, "4pm EDT");
  assert.equal(marketOpen(new Date("2026-10-03T15:00:00Z")), false, "a Saturday");
  assert.equal(marketOpen(new Date("2026-12-01T14:45:00Z")), true, "9:45am EST, after the clocks change");
});

import { KEY_RELEASES } from "../../src/lib/market-data/official";

test("the release calendar never lists FRED's daily 'FOMC Press Release' as a rate decision", () => {
  assert.equal(Object.hasOwn(KEY_RELEASES, "FOMC Press Release"), false);
  assert.equal(KEY_RELEASES["Employment Situation"], "Jobs report");
});

import { tickerForWebsite } from "../../src/lib/market-data/firm-tickers";

test("a student's top firm is charted by its listing, found from its website; private firms are not", () => {
  assert.equal(tickerForWebsite("evercore.com"), "NYSE:EVR");
  assert.equal(tickerForWebsite("https://www.pwpartners.com/"), "NASDAQ:PWP", "scheme, www and path are ignored");
  assert.equal(tickerForWebsite("careers.db.com"), "NYSE:DB", "stored as the firms table stores it");
  assert.equal(tickerForWebsite("centerviewpartners.com"), null, "private");
  assert.equal(tickerForWebsite("constructor"), null, "own keys only");
  assert.equal(tickerForWebsite(null), null);
});
