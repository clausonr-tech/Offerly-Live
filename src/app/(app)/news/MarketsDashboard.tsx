"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Sparkles } from "lucide-react";
import type { CurveLine, Dashboard, Group, Item } from "@/lib/market-data/board";
import MarketChart, { asOfLabel, formatChange, formatValue, tone } from "./MarketChart";
import TradingViewWidget from "./TradingViewWidget";
import type { MarketWrap } from "@/lib/news/market-wrap";
import { externalHref } from "@/lib/safe-url";

// The Markets view: "How markets moved", then stocks, bonds and rates, world
// markets and currencies, commodities, and the economy - each a chart and the
// numbers under it. Clicking a row puts it on its section's chart; the chart
// has 1D to 5Y (a daily series starts at 5D, a monthly one at 1Y). Every row
// says where its number comes from and when, because a live fund price and
// yesterday's official yield are different things. Stock prices come from
// TradingView's licensed widgets; the official numbers refresh every few
// minutes while the page is in view.

// Official numbers change once a day; the stock charts refresh themselves.
const REFRESH_MS = 5 * 60_000;

// ------------------------------------------------------------ the view

export default function MarketsDashboard({ initial }: { initial: Dashboard }) {
  const [board, setBoard] = useState(initial);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/markets/dashboard", { cache: "no-store" });
        if (res.ok && !stopped) setBoard((await res.json()) as Dashboard);
      } catch {
        // The last numbers stay up; each says how old it is.
      }
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return (
    <div className="space-y-8">
      <p className="text-sm text-warmgray-600">
        {board.open ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
            US markets are open. Stock charts update live; official numbers are from their last release.
          </span>
        ) : (
          "US markets are closed. Stock charts show the last trade; official numbers are from their last release."
        )}
      </p>

      <section aria-label="Stocks">
        <h2 className="text-lg font-semibold text-brand-900">Stocks</h2>
        <p className="mb-3 text-sm text-warmgray-500">
          The S&amp;P 500&apos;s companies by sector: each box sized by the company&apos;s value, coloured by today&apos;s move. Hover a box for its numbers.
        </p>
        <div className="rounded-lg border border-brand-100 bg-white p-2">
          <TradingViewWidget
            kind="stock-heatmap"
            height={540}
            title="S&P 500 heatmap by sector"
            config={{ dataSource: "SPX500", grouping: "sector", blockSize: "market_cap_basic", blockColor: "change", hasTopBar: false, isDataSetEnabled: false, isZoomEnabled: false, hasSymbolTooltip: true, isMonoSize: false }}
          />
        </div>
      </section>
      <Section title="Bonds and interest rates" blurb="What the US government pays to borrow, and the Federal Reserve's rate." groups={board.bonds.groups}>
        {board.bonds.curve && <YieldCurve maturities={board.bonds.curve.maturities} lines={board.bonds.curve.lines} />}
      </Section>
      <section aria-label="World markets and currencies" className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-brand-900">World markets and currencies</h2>
          <p className="mb-3 text-sm text-warmgray-500">Stock markets abroad, through the US-listed funds that track them, and what the dollar buys.</p>
          <FundChart title="World markets" symbols={WORLD_FUNDS} />
        </div>
        <Section groups={board.currencies.groups} />
      </section>
      <section aria-label="Commodities" className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-brand-900">Commodities</h2>
          <p className="mb-3 text-sm text-warmgray-500">Energy and metals, through the funds that hold or track them.</p>
          <FundChart title="Commodities" symbols={COMMODITY_FUNDS} />
        </div>
        <Section groups={board.commodities.groups} />
      </section>
      {board.calendar && <Economy calendar={board.calendar} />}

      <Sources />
    </div>
  );
}

const WORLD_FUNDS: [string, string][] = [
  ["Europe (VGK)", "AMEX:VGK"],
  ["United Kingdom (EWU)", "AMEX:EWU"],
  ["Japan (EWJ)", "AMEX:EWJ"],
  ["China (FXI)", "AMEX:FXI"],
  ["India (INDA)", "BATS:INDA"],
  ["Brazil (EWZ)", "AMEX:EWZ"],
  ["Emerging markets (EEM)", "AMEX:EEM"],
];
const COMMODITY_FUNDS: [string, string][] = [
  ["Gold (GLD)", "AMEX:GLD"],
  ["Silver (SLV)", "AMEX:SLV"],
  ["Oil (USO)", "AMEX:USO"],
  ["Natural gas (UNG)", "AMEX:UNG"],
  ["Copper (CPER)", "AMEX:CPER"],
];

/** Fund prices and charts, from TradingView's licensed widget - never a feed the app may not show. */
function FundChart({ title, symbols }: { title: string; symbols: [string, string][] }) {
  return (
    <div className="rounded-lg border border-brand-100 bg-white p-2">
      <TradingViewWidget
        kind="symbol-overview"
        height={420}
        title={`${title}: prices and chart`}
        config={{
          symbols: symbols.map(([label, symbol]) => [label, `${symbol}|1D`]),
          dateRanges: ["1d|1", "5d|5", "1m|30", "6m|120", "12m|1D", "60m|1W"],
          changeMode: "price-and-percent",
          chartType: "area",
          showVolume: false,
          hideMarketStatus: false,
          scalePosition: "right",
          valuesTracking: "1",
          lineWidth: 2,
          fontSize: "10",
          headerFontSize: "medium",
        }}
      />
    </div>
  );
}

/** "How markets moved" - the daily summary at the top of the Markets overview. */
export function MarketsWrap({ wrap }: { wrap: MarketWrap }) {
  const written = new Date(wrap.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return (
    <section aria-label="How markets moved" className="rounded-lg border border-brand-100 bg-white p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-brand-900">
        <Sparkles size={16} aria-hidden className="text-accent-600" />
        How markets moved {wrap.slot === "open" ? "this morning" : "today"}
      </h2>
      <ul className="mt-3 space-y-2.5">
        {wrap.bullets.map((b) => (
          <li key={b.text} className="flex gap-2 text-sm leading-snug text-brand-900">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
            <span>
              {b.text}{" "}
              {b.sources.map((s, i) => {
                // Read-boundary guard - the same feed-supplied citation link
                // the briefing renders on /news. A refused one keeps the
                // publisher's name as plain text; see lib/safe-url.
                const href = externalHref(s.link);
                return href ? (
                  <a key={s.link} href={href} target="_blank" rel="noopener noreferrer" title={s.title} className="whitespace-nowrap text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline">
                    {i > 0 && ", "}
                    {s.publisher}
                  </a>
                ) : (
                  <span key={s.link} title={s.title} className="whitespace-nowrap text-xs text-warmgray-500">
                    {i > 0 && ", "}
                    {s.publisher}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-warmgray-500">
        Written by AI at {written} ET from the numbers on this page and the stories it links. It only gives a reason for a move when a linked story reports one.
      </p>
    </section>
  );
}

// One topic as one card: the selected series charted across the top, its
// rows underneath - click a row to chart it. Anything passed as children (the
// yield curve) follows the card.
function Section({ title, blurb, groups, children }: { title?: string; blurb?: string; groups: Group[]; children?: React.ReactNode }) {
  const items = groups.flatMap((g) => g.items);
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  if (items.length === 0) return null;
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <section aria-label={title ?? groups[0]?.title} className="space-y-4">
      {(title || blurb) && (
        <div>
          {title && <h2 className="text-lg font-semibold text-brand-900">{title}</h2>}
          {blurb && <p className="text-sm text-warmgray-500">{blurb}</p>}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-brand-100 bg-white">
        <MarketChart key={current.id} item={current} bare />
        {groups.map((g) => (
          <div key={g.title} className="border-t border-brand-100">
            <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-accent-600">{g.title}</h3>
            <ul className="divide-y divide-brand-100">
              {g.items.map((i) => (
                <Row key={i.id} item={i} selected={i.id === current.id} onSelect={() => setSelected(i.id)} />
              ))}
            </ul>
            {g.note && <p className="border-t border-brand-100 px-4 py-2 text-[11px] text-warmgray-500">{g.note}</p>}
          </div>
        ))}
      </div>
      {children}
    </section>
  );
}

function Row({ item, selected, onSelect }: { item: Item; selected: boolean; onSelect: () => void }) {
  const change = formatChange(item.format, item.change, item.changePct, item.id);
  const direction = item.format === "thousands" ? item.value : (change?.dir ?? 0);
  const Arrow = !direction ? null : direction > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 ${selected ? "bg-brand-50" : ""}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-brand-900">{item.name}</span>
          <span className="block truncate text-[11px] text-warmgray-500">{[item.detail, asOfLabel(item)].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold tabular-nums text-brand-900">{formatValue(item.format, item.value, item.id)}</span>
          {change && (
            <span className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${tone(direction)}`}>
              {Arrow && <Arrow size={12} aria-hidden />}
              {change.text}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

// ------------------------------------------------------------ charts

const CURVE_COLORS = ["#0f2a4a", "#c08a2c", "#94a3b8"];

// The whole curve on three dates. Drawn in a fixed, short box so it stays
// slim at any width; the percentages and maturities are text laid over it
// (text drawn into a stretched chart would warp).
function YieldCurve({ maturities, lines }: { maturities: string[]; lines: CurveLine[] }) {
  const all = lines.flatMap((l) => l.rates).filter((r): r is number => r !== null);
  if (all.length === 0) return null;
  const W = 1000;
  const H = 100;
  const lo = Math.floor(Math.min(...all) * 4) / 4 - 0.25;
  const hi = Math.ceil(Math.max(...all) * 4) / 4 + 0.25;
  const x = (i: number) => (i / (maturities.length - 1)) * W;
  const y = (v: number) => (1 - (v - lo) / (hi - lo)) * H;
  const ticks = [0, 1, 2, 3].map((k) => lo + 0.25 + ((hi - lo - 0.5) * k) / 3);
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return (
    <figure className="rounded-lg border border-brand-100 bg-white p-4">
      <figcaption className="text-sm font-semibold text-brand-900">The Treasury yield curve</figcaption>
      <p className="text-xs text-warmgray-500">What the government pays to borrow for each length of time. Higher at the long end is normal; lower is an &quot;inverted&quot; curve.</p>
      <div className="relative mt-3 h-44 pb-5 pl-12 pr-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
          role="img"
          aria-label={`Yield curve on ${lines.map((l) => `${l.label.toLowerCase()} (${day(l.date)})`).join(", ")}`}
        >
          {ticks.map((v) => (
            <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {[...lines].reverse().map((l) => {
            const idx = lines.indexOf(l);
            const pts = l.rates.map((r, i) => (r === null ? null : `${x(i).toFixed(1)},${y(r).toFixed(2)}`)).filter(Boolean);
            return (
              <polyline
                key={l.label}
                points={pts.join(" ")}
                fill="none"
                stroke={CURVE_COLORS[idx]}
                strokeWidth={idx === 0 ? 2.25 : 1.5}
                strokeDasharray={idx === 0 ? undefined : "5 4"}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            );
          })}
        </svg>
        <div aria-hidden className="pointer-events-none absolute bottom-5 left-0 top-0 w-11">
          {ticks.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-warmgray-500" style={{ top: `${(y(v) / H) * 100}%` }}>
              {v.toFixed(2)}%
            </span>
          ))}
        </div>
        <div aria-hidden className="pointer-events-none absolute bottom-0 left-12 right-2 h-4">
          {maturities.map((m, i) => (
            <span
              key={m}
              className={`absolute top-0 text-[10px] text-warmgray-500 ${i === 0 ? "" : i === maturities.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: `${(x(i) / W) * 100}%` }}
            >
              {m.replace(" Mo", "m").replace(" Yr", "y")}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-warmgray-600">
        {lines.map((l, i) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-4" style={{ background: CURVE_COLORS[i] }} />
            {l.label} ({day(l.date)})
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-warmgray-500">Source: US Treasury, daily par yield curve rates.</p>
    </figure>
  );
}

function Economy({ calendar }: { calendar: NonNullable<Dashboard["calendar"]> }) {
  return (
    <Section
      title="The economy"
      blurb="The official numbers markets watch."
      groups={[{ title: "Latest readings", items: calendar.latest, note: "From the BLS and BEA, via FRED." }]}
    />
  );
}

/** FRED's required notice, for a page showing its numbers without the full sources box. */
export function FredNotice() {
  return (
    <p className="text-[11px] text-warmgray-500">
      This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.{" "}
      <a href="https://fred.stlouisfed.org/docs/api/terms_of_use.html" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        FRED® API Terms of Use
      </a>
    </p>
  );
}

function Sources() {
  return (
    <section aria-label="Where these numbers come from" className="rounded-lg border border-brand-100 bg-white p-4 text-xs leading-relaxed text-warmgray-600">
      <h2 className="mb-1 text-sm font-semibold text-brand-900">Where these numbers come from</h2>
      <ul className="list-disc space-y-0.5 pl-4">
        <li>Stock and fund prices, charts and the heatmap: TradingView&apos;s widgets. Indexes are shown through the funds that track them.</li>
        <li>Treasury yields and the yield curve: the US Treasury&apos;s daily par yield curve rates.</li>
        <li>Exchange rates: the European Central Bank&apos;s daily reference rates.</li>
        <li>The dollar index, oil, the Fed&apos;s rate and economic data: FRED, the Federal Reserve Bank of St. Louis&apos; database of official statistics.</li>
      </ul>
      {/* FRED's terms of use require this notice and a link to them, shown prominently. */}
      <p className="mt-2">
        This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.{" "}
        <a href="https://fred.stlouisfed.org/docs/api/terms_of_use.html" target="_blank" rel="noopener noreferrer" className="text-brand-900 underline underline-offset-2">
          FRED® API Terms of Use
        </a>
      </p>
    </section>
  );
}
