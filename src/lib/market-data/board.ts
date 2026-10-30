import "server-only";
import { marketOpen } from "./clock";
import { FRED_SERIES, FX_PAIRS, MATURITIES, ecbFx, fredConfigured, fredSeries, keyReleases, treasuryCurve, type FredId, type Point, type Release } from "./official";

// The official half of the Markets view on Finance News: rates, currencies,
// oil and the economy, each from the public source that publishes it (see
// official.ts) - numbers the app may show its students. Every item carries its
// source and the date its number is from, and the page shows both.
//
// Stock and fund prices are not here. The free feeds that carry them do not
// allow showing them to other people (Alpaca's terms; Cboe's for the VIX), so
// the page shows them through TradingView's widgets, which TradingView
// licenses for other sites (news/TradingViewWidget.tsx), and the AI writers
// take stock moves only from the stories they cite. The ICE BofA credit
// spreads on FRED are licensed for internal use only, so they are left out
// too (30 September 2026).

export { RANGES, type Format, type Item, type Range, type Source } from "./types";
import { DAILY_RANGES, type Format, type Item, type Range, type Source } from "./types";

export type Group = { title: string; items: Item[]; note?: string };
export type CurveLine = { label: string; date: string; rates: (number | null)[] };

export type Dashboard = {
  open: boolean;
  generatedAt: string;
  bonds: { groups: Group[]; curve: { maturities: string[]; lines: CurveLine[] } | null };
  currencies: { groups: Group[] };
  commodities: { groups: Group[] };
  calendar: { upcoming: Release[]; latest: Item[] } | null;
  /** Sources that could not be reached this time, so the page can say so rather than go quiet. */
  missing: Source[];
};

// ------------------------------------------------------------ what is shown

const TREASURY_TENORS = [
  { id: "UST2Y", col: "2 Yr", name: "2-year Treasury yield" },
  { id: "UST10Y", col: "10 Yr", name: "10-year Treasury yield" },
  { id: "UST30Y", col: "30 Yr", name: "30-year Treasury yield" },
] as const;

/** Every id the history route may be asked for - nothing else is fetched on a student's behalf. */
export function chartable(id: string): boolean {
  return (
    TREASURY_TENORS.some((t) => t.id === id) ||
    id === "SPREAD2S10S" ||
    FX_PAIRS.some((p) => p.id === id) ||
    // Own keys only: `in` would also accept "constructor", "toString" and the like.
    Object.hasOwn(FRED_SERIES, id) ||
    id === "CPIYOY"
  );
}

// ------------------------------------------------------------ building it

const DAY = 86_400_000;
const lastTwo = (pts: Point[]) => [pts.at(-2), pts.at(-1)] as const;

function dailyItem(id: string, name: string, pts: Point[], format: Format, source: Source, detail?: string): Item | null {
  const [prev, last] = lastTwo(pts);
  if (!last) return null;
  const change = prev ? last.value - prev.value : null;
  return { id, name, detail, value: last.value, change, changePct: prev && change !== null && prev.value ? (change / prev.value) * 100 : null, format, source, asOf: last.date, ranges: DAILY_RANGES };
}

export async function buildDashboard(now: Date = new Date()): Promise<Dashboard> {
  const missing = new Set<Source>();
  const soft = <T>(source: Source, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((err) => {
      console.error(`[markets] ${source}: ${err instanceof Error ? err.message : err}`);
      missing.add(source);
      return fallback;
    });

  const [curve, fx, fredData, releases] = await Promise.all([
    soft("US Treasury", treasuryCurve(1, now), []),
    soft("ECB", ecbFx(new Date(now.getTime() - 20 * DAY)), { EURUSD: [], USDJPY: [], GBPUSD: [], USDCNY: [] }),
    fredConfigured()
      ? soft(
          "FRED",
          // Each series on its own: one slow series leaves just its row out,
          // not every FRED number on the page.
          Promise.all(
            (Object.keys(FRED_SERIES) as FredId[]).map(async (id) => {
              try {
                return [id, await fredSeries(id, new Date(now.getTime() - 800 * DAY))] as const;
              } catch (err) {
                console.error(`[markets] FRED ${id}: ${err instanceof Error ? err.message : err}`);
                missing.add("FRED");
                return [id, [] as Point[]] as const;
              }
            }),
          ).then((pairs) => Object.fromEntries(pairs) as Record<FredId, Point[]>),
          null,
        )
      : Promise.resolve(null),
    fredConfigured() ? soft("FRED", keyReleases(now, new Date(now.getTime() + 10 * DAY)), []) : Promise.resolve([] as Release[]),
  ]);
  const nonEmpty = (groups: Group[]) => groups.filter((g) => g.items.length > 0);

  // Bonds and rates
  const tenor = (col: string) => curve.map((d) => (d.rates[col] !== undefined ? { date: d.date, value: d.rates[col] } : null)).filter((p): p is Point => Boolean(p));
  const yields = TREASURY_TENORS.map((t) => dailyItem(t.id, t.name, tenor(t.col), "yield", "US Treasury")).filter((i): i is Item => Boolean(i));
  const spreadPts = curve
    .filter((d) => d.rates["10 Yr"] !== undefined && d.rates["2 Yr"] !== undefined)
    .map((d) => ({ date: d.date, value: d.rates["10 Yr"] - d.rates["2 Yr"] }));
  const spread = dailyItem("SPREAD2S10S", "10-year minus 2-year", spreadPts, "spread", "US Treasury", "the yield curve's slope; below zero it is 'inverted'");
  const fedTarget = fredData ? dailyItem("DFEDTARU", "Fed funds target (upper)", fredData.DFEDTARU, "yield", "FRED", "the Federal Reserve's policy rate") : null;
  const curveLines = (() => {
    const last = curve.at(-1);
    if (!last) return null;
    const on = (daysAgo: number) => [...curve].reverse().find((d) => d.date <= new Date(new Date(last.date).getTime() - daysAgo * DAY).toISOString().slice(0, 10));
    const line = (label: string, d: (typeof curve)[number] | undefined): CurveLine | null => (d ? { label, date: d.date, rates: MATURITIES.map((m) => d.rates[m] ?? null) } : null);
    return { maturities: [...MATURITIES], lines: [line("Latest", last), line("1 month ago", on(30)), line("1 year ago", on(365))].filter((l): l is CurveLine => Boolean(l)) };
  })();
  const bonds = {
    groups: nonEmpty([
      { title: "Treasury yields", items: [...yields, ...(spread ? [spread] : []), ...(fedTarget ? [fedTarget] : [])], note: "Official closing yields, published by the Treasury each evening." },
    ]),
    curve: curveLines,
  };

  // Currencies
  const fxItems = FX_PAIRS.map((p) => dailyItem(p.id, p.label, fx[p.id], "fx", "ECB", p.name)).filter((i): i is Item => Boolean(i));
  const dollar = fredData ? dailyItem("DTWEXBGS", "US dollar index", fredData.DTWEXBGS, "index", "FRED", "against a broad basket of currencies") : null;
  const currencies = {
    groups: nonEmpty([{ title: "Currencies", items: [...fxItems, ...(dollar ? [dollar] : [])], note: "ECB reference rates, set each day at 2:15pm Frankfurt time; the dollar index from the Federal Reserve." }]),
  };

  // Commodities
  const oil = fredData
    ? (["DCOILWTICO", "DCOILBRENTEU"] as FredId[]).map((id) => dailyItem(id, FRED_SERIES[id].name, fredData[id], "price", "FRED", "$ per barrel, daily spot")).filter((i): i is Item => Boolean(i))
    : [];
  const commodities = { groups: nonEmpty([{ title: "Oil benchmarks", items: oil, note: "Official daily spot prices from the US Energy Information Administration, a few days behind." }]) };

  // The economy: this week's releases and the latest readings.
  let calendar: Dashboard["calendar"] = null;
  if (fredData) {
    const cpi = fredData.CPIAUCSL;
    const cpiYoy: Point[] = cpi.slice(12).map((p, i) => ({ date: p.date, value: ((p.value - cpi[i].value) / cpi[i].value) * 100 }));
    const payrollChanges: Point[] = fredData.PAYEMS.slice(1).map((p, i) => ({ date: p.date, value: p.value - fredData.PAYEMS[i].value }));
    const monthly = (item: Item | null) => (item ? { ...item, ranges: ["1Y", "5Y"] as Range[] } : null);
    calendar = {
      upcoming: releases,
      latest: [
        monthly(dailyItem("CPIYOY", "Inflation (CPI, year on year)", cpiYoy, "pct", "FRED")),
        monthly(dailyItem("UNRATE", "Unemployment rate", fredData.UNRATE, "pct", "FRED")),
        monthly(dailyItem("PAYEMS", "Jobs added last month", payrollChanges, "thousands", "FRED", "nonfarm payrolls")),
        monthly(dailyItem("A191RL1Q225SBEA", "GDP growth", fredData.A191RL1Q225SBEA, "pct", "FRED", "last quarter, annualized")),
      ].filter((i): i is Item => Boolean(i)),
    };
  }

  if (!fredConfigured()) missing.add("FRED");
  return { open: marketOpen(now), generatedAt: now.toISOString(), bonds, currencies, commodities, calendar, missing: [...missing] };
}

let cached: { at: number; board: Dashboard } | null = null;
let inFlight: Promise<Dashboard> | null = null;
const CACHE_MS = 30_000;

/** The dashboard, at most 30 seconds old, shared by everyone. */
export async function getDashboard(now: Date = new Date()): Promise<Dashboard> {
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.board;
  inFlight ??= buildDashboard(now)
    .then((board) => ((cached = { at: Date.now(), board }), board))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// ------------------------------------------------------------ history

const RANGE_DAYS: Record<Range, number> = { "1D": 4, "5D": 9, "1M": 31, "6M": 183, "1Y": 366, "5Y": 5 * 366 };

export type HistoryPoint = { t: string; v: number };

/** One chart's points. Throws for an id that is not on the page. */
export async function history(id: string, range: Range, now: Date = new Date()): Promise<HistoryPoint[]> {
  if (!chartable(id)) throw new Error("unknown series");
  const start = new Date(now.getTime() - RANGE_DAYS[range] * DAY);
  const since = start.toISOString().slice(0, 10);
  const fromPoints = (pts: Point[]) => {
    const kept = pts.filter((p) => p.date >= since).map((p) => ({ t: p.date, v: p.value }));
    // 5D of a daily series is its last five values, whatever the calendar says.
    return range === "5D" ? pts.slice(-5).map((p) => ({ t: p.date, v: p.value })) : kept;
  };

  const tenor = TREASURY_TENORS.find((t) => t.id === id);
  if (tenor || id === "SPREAD2S10S") {
    const years = Math.ceil(RANGE_DAYS[range] / 365);
    const curve = await treasuryCurve(years, now);
    return fromPoints(
      curve
        .map((d) =>
          tenor
            ? d.rates[tenor.col] !== undefined
              ? { date: d.date, value: d.rates[tenor.col] }
              : null
            : d.rates["10 Yr"] !== undefined && d.rates["2 Yr"] !== undefined
              ? { date: d.date, value: d.rates["10 Yr"] - d.rates["2 Yr"] }
              : null,
        )
        .filter((p): p is Point => Boolean(p)),
    );
  }
  const pair = FX_PAIRS.find((p) => p.id === id);
  if (pair) return fromPoints((await ecbFx(start))[pair.id]);
  if (id === "CPIYOY") {
    const cpi = await fredSeries("CPIAUCSL", new Date(start.getTime() - 400 * DAY));
    return fromPoints(cpi.slice(12).map((p, i) => ({ date: p.date, value: ((p.value - cpi[i].value) / cpi[i].value) * 100 })));
  }
  if (id === "PAYEMS") {
    const p = await fredSeries("PAYEMS", new Date(start.getTime() - 40 * DAY));
    return fromPoints(p.slice(1).map((x, i) => ({ date: x.date, value: x.value - p[i].value })));
  }
  if (!Object.hasOwn(FRED_SERIES, id)) throw new Error("unknown series");
  return fromPoints(await fredSeries(id as FredId, start));
}

// ------------------------------------------------------------ for the writers

// The dashboard as numbered lines an AI writer can cite - the "How markets
// moved" wrap and the daily briefing's markets bullets - each with its value,
// its change, the date it is from and its source. Official numbers only: a
// stock or index move reaches those writers through the stories they cite.

function fmt(i: Item): string {
  // Quoted as traders quote them: four decimals for the euro and pound, two for the yen.
  const v = i.format === "fx" && i.id !== "USDJPY" ? i.value.toFixed(4) : i.value.toFixed(2);
  const unit = i.format === "yield" || i.format === "spread" || i.format === "pct" ? "%" : "";
  const chg =
    i.change === null
      ? ""
      : i.format === "yield" || i.format === "spread"
        ? `, ${i.change >= 0 ? "up" : "down"} ${Math.abs(Math.round(i.change * 100))} basis points`
        : i.changePct !== null
          ? `, ${i.changePct >= 0 ? "up" : "down"} ${Math.abs(i.changePct).toFixed(2)}%`
          : "";
  const when = `on ${new Date(`${i.asOf}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}`;
  return `${i.name}${i.detail ? ` (${i.detail})` : ""}: ${v}${unit}${chg}, ${when}, source ${i.source}`;
}

/** The dashboard as numbered lines the model can cite. */
export function dataLines(d: Dashboard): { id: string; text: string }[] {
  const items = [...d.bonds.groups, ...d.currencies.groups, ...d.commodities.groups].flatMap((g) => g.items);
  const lines = items.map((i, n) => ({ id: `d${n + 1}`, text: fmt(i) }));
  for (const r of d.calendar?.latest ?? []) lines.push({ id: `d${lines.length + 1}`, text: fmt(r) });
  for (const r of d.calendar?.upcoming ?? []) lines.push({ id: `d${lines.length + 1}`, text: `Scheduled release: ${r.name} on ${r.date}` });
  return lines;
}
