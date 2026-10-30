import "server-only";

// The official, end-of-day market sources, each the publisher of its number:
//
//   US Treasury  daily par yield curve rates (home.treasury.gov) - no key
//   ECB          euro reference exchange rates (data-api.ecb.europa.eu) - no key
//   FRED         the St. Louis Fed's database: the dollar index, oil, credit
//                spreads, economic releases - needs FRED_API_KEY (free);
//                FRED_API_URL points at another host (a local mock)
//
// All publish once a day, so each response is kept for an hour.

export type Point = { date: string; value: number };

const HOUR = 3_600_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** One shared, hour-old-at-most copy of a slow source, however many students ask. */
export function cached<T>(key: string, load: () => Promise<T>, ttl = HOUR): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OfferlyNews/1.0)", Accept: "text/csv,application/json,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.text();
}

/** "09/29/2026" -> "2026-09-29". */
function isoFromUs(d: string): string | null {
  const m = d.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// ------------------------------------------------------------ US Treasury

export type CurveDay = { date: string; rates: Record<string, number> };
/** The maturities the page shows, in order, as Treasury heads them. */
export const MATURITIES = ["1 Mo", "3 Mo", "6 Mo", "1 Yr", "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr"] as const;

export function parseTreasuryCsv(csv: string): CurveDay[] {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const cols = splitCsvLine(header);
  return rows
    .map((line) => {
      const cells = splitCsvLine(line);
      const date = isoFromUs(cells[0] ?? "");
      if (!date) return null;
      const rates: Record<string, number> = {};
      cols.forEach((c, i) => {
        const v = Number.parseFloat(cells[i] ?? "");
        if (i > 0 && Number.isFinite(v)) rates[c] = v;
      });
      return { date, rates };
    })
    .filter((d): d is CurveDay => Boolean(d))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Treasury's daily yield curve for this year and the `years` before it, oldest first. */
export function treasuryCurve(years = 1, now: Date = new Date()): Promise<CurveDay[]> {
  const thisYear = now.getUTCFullYear();
  return cached(`treasury:${thisYear}:${years}`, async () => {
    const all = await Promise.all(
      Array.from({ length: years + 1 }, (_, i) => thisYear - years + i).map((y) =>
        getText(
          `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`,
        )
          .then(parseTreasuryCsv)
          .catch(() => [] as CurveDay[]),
      ),
    );
    return all.flat().sort((a, b) => a.date.localeCompare(b.date));
  });
}

// ------------------------------------------------------------ ECB

export const FX_PAIRS = [
  { id: "EURUSD", name: "Euro", label: "EUR/USD" },
  { id: "USDJPY", name: "Japanese yen", label: "USD/JPY" },
  { id: "GBPUSD", name: "British pound", label: "GBP/USD" },
  { id: "USDCNY", name: "Chinese yuan", label: "USD/CNY" },
] as const;
export type FxId = (typeof FX_PAIRS)[number]["id"];

/**
 * The ECB publishes each currency against the euro; the dollar pairs traders
 * quote follow from two of them (USD/JPY = JPY per euro / USD per euro).
 */
export function fxFromEcbCsv(csv: string): Record<FxId, Point[]> {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const cols = splitCsvLine(header);
  const ci = cols.indexOf("CURRENCY");
  const ti = cols.indexOf("TIME_PERIOD");
  const vi = cols.indexOf("OBS_VALUE");
  const perEuro = new Map<string, Record<string, number>>();
  for (const line of rows) {
    const c = splitCsvLine(line);
    const v = Number.parseFloat(c[vi] ?? "");
    if (!c[ti] || !Number.isFinite(v)) continue;
    perEuro.set(c[ti], { ...(perEuro.get(c[ti]) ?? {}), [c[ci]]: v });
  }
  const out: Record<FxId, Point[]> = { EURUSD: [], USDJPY: [], GBPUSD: [], USDCNY: [] };
  for (const [date, r] of [...perEuro].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!r.USD) continue;
    out.EURUSD.push({ date, value: r.USD });
    if (r.JPY) out.USDJPY.push({ date, value: r.JPY / r.USD });
    if (r.GBP) out.GBPUSD.push({ date, value: r.USD / r.GBP });
    if (r.CNY) out.USDCNY.push({ date, value: r.CNY / r.USD });
  }
  return out;
}

/** ECB reference rates since `start`, as dollar pairs. */
export function ecbFx(start: Date): Promise<Record<FxId, Point[]>> {
  const from = start.toISOString().slice(0, 10);
  return cached(`ecb:${from}`, async () =>
    fxFromEcbCsv(await getText(`https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY+GBP+CNY.EUR.SP00.A?startPeriod=${from}&format=csvdata`)),
  );
}

// ------------------------------------------------------------ FRED

export function fredConfigured(): boolean {
  return Boolean(process.env.FRED_API_KEY?.trim());
}

/**
 * The FRED series the page uses, with what students know each as - all of
 * them US-government statistics (the Fed, BLS, BEA, EIA), which FRED's terms
 * let an app show. Never a series FRED marks as a third party's copyright:
 * the ICE BofA credit spreads were taken out for that reason.
 */
export const FRED_SERIES = {
  DTWEXBGS: { name: "US dollar index (broad)", unit: "index" },
  DCOILWTICO: { name: "WTI crude oil", unit: "$/barrel" },
  DCOILBRENTEU: { name: "Brent crude oil", unit: "$/barrel" },
  DFEDTARU: { name: "Fed funds target (upper)", unit: "%" },
  UNRATE: { name: "Unemployment rate", unit: "%" },
  CPIAUCSL: { name: "Consumer prices (CPI)", unit: "index" },
  PAYEMS: { name: "Nonfarm payrolls", unit: "thousands" },
  A191RL1Q225SBEA: { name: "Real GDP growth (annualized)", unit: "%" },
} as const;
export type FredId = keyof typeof FRED_SERIES;

async function fred<T>(path: string, opts: { timeoutMs?: number; attempts?: number } = {}): Promise<T> {
  const key = process.env.FRED_API_KEY?.trim();
  if (!key) throw new Error("FRED is not configured");
  const attempts = opts.attempts ?? 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fredOnce<T>(path, key, opts.timeoutMs);
    } catch (err) {
      if (attempt >= attempts) throw err;
    }
  }
}

async function fredOnce<T>(path: string, key: string, timeoutMs?: number): Promise<T> {
  // The override is for a local mock; production always talks to FRED itself, so a leftover setting can never receive the real key.
  const override = process.env.NODE_ENV === "production" ? undefined : process.env.FRED_API_URL;
  const base = (override ?? "https://api.stlouisfed.org").replace(/\/$/, "");
  return JSON.parse(await getText(`${base}/fred/${path}${path.includes("?") ? "&" : "?"}api_key=${key}&file_type=json`, timeoutMs)) as T;
}

/** A FRED series since `start`, oldest first. FRED marks a day with no value "."; those are left out. */
export function fredSeries(id: FredId, start: Date): Promise<Point[]> {
  const from = start.toISOString().slice(0, 10);
  return cached(`fred:${id}:${from}`, async () => {
    const res = await fred<{ observations?: { date: string; value: string }[] }>(`series/observations?series_id=${id}&observation_start=${from}`);
    return (res.observations ?? []).map((o) => ({ date: o.date, value: Number.parseFloat(o.value) })).filter((p) => Number.isFinite(p.value));
  });
}

/** The official releases students are asked about, as FRED names them. */
export const KEY_RELEASES: Record<string, string> = {
  "Consumer Price Index": "Inflation (CPI)",
  "Employment Situation": "Jobs report",
  "Gross Domestic Product": "GDP",
  "Personal Income and Outlays": "PCE inflation and spending",
  "Producer Price Index": "Producer prices (PPI)",
  "Advance Monthly Sales for Retail and Food Services": "Retail sales",
  "Job Openings and Labor Turnover Survey": "Job openings (JOLTS)",
  "U.S. International Trade in Goods and Services": "Trade balance",
  "Unemployment Insurance Weekly Claims Report": "Jobless claims",
  "G.17 Industrial Production and Capacity Utilization": "Industrial production",
  "New Residential Construction": "Housing starts",
  // Not "FOMC Press Release": FRED lists it every day (the Fed's rate is a
  // daily series there), so it read as a rate decision daily. The Fed's
  // meeting dates are not in FRED's release calendar.
};

export type Release = { date: string; name: string; fredName: string };

// The last calendar FRED gave, shown if it stalls. Its release-dates endpoint
// sometimes hangs past 15 seconds and then answers in a third of a second
// (30 September 2026): short tries, a few of them, and yesterday's answer
// rather than none.
let lastReleases: Release[] | null = null;

/** The key official releases between `from` and `to`, soonest first. */
export function keyReleases(from: Date, to: Date): Promise<Release[]> {
  const a = from.toISOString().slice(0, 10);
  const b = to.toISOString().slice(0, 10);
  return cached(`fred:releases:${a}:${b}`, async () => {
    let res: { release_dates?: { release_name: string; date: string }[] };
    try {
      res = await fred(`releases/dates?realtime_start=${a}&realtime_end=${b}&include_release_dates_with_no_data=true&order_by=release_date&sort_order=asc&limit=1000`, {
        timeoutMs: 6_000,
        attempts: 3,
      });
    } catch (err) {
      if (lastReleases) return lastReleases.filter((r) => r.date >= a && r.date <= b);
      throw err;
    }
    const seen = new Set<string>();
    const releases = (res.release_dates ?? [])
      .filter((r) => KEY_RELEASES[r.release_name] && r.date >= a && r.date <= b)
      .map((r) => ({ date: r.date, name: KEY_RELEASES[r.release_name], fredName: r.release_name }))
      .filter((r) => (seen.has(`${r.date}${r.name}`) ? false : (seen.add(`${r.date}${r.name}`), true)));
    lastReleases = releases;
    return releases;
  });
}
