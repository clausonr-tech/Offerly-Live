"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import TradingViewSingleTicker from "./TradingViewSingleTicker";
import TradingViewWidget from "./TradingViewWidget";

// An exchange-board treatment for the top of Finance News, with the briefing
// below it. Compact by default; Expand spreads it across the page, its rows in
// columns, for a student who wants the wider view (the owner's call on
// 5 October 2026: an option, not the default). The choice is remembered in
// this browser. The rows are ours, so they use Offerly's type; live
// prices, changes and charts remain TradingView's licensed widgets. A row is
// closed until the student asks for it, keeping the page header small; the
// company clicked opens its chart at the top of the board, above the rows.
// The Wall Street tab leads with the student's own top firms that trade
// publicly (lib/market-data/firm-tickers.ts), then the standard six.

type Group = { key: string; title: string } & (
  | { kind: "symbols"; symbols: [label: string, symbol: string][] }
  | { kind: "movers" }
);

const GROUPS: Group[] = [
  {
    key: "markets",
    title: "Markets",
    kind: "symbols",
    symbols: [
      ["S&P 500", "AMEX:SPY"],
      ["Nasdaq 100", "NASDAQ:QQQ"],
      ["Dow Jones", "AMEX:DIA"],
      ["Russell 2000", "AMEX:IWM"],
    ],
  },
  {
    key: "tech",
    title: "Big tech",
    kind: "symbols",
    symbols: [
      ["Apple", "NASDAQ:AAPL"],
      ["Microsoft", "NASDAQ:MSFT"],
      ["Nvidia", "NASDAQ:NVDA"],
      ["Alphabet", "NASDAQ:GOOGL"],
      ["Amazon", "NASDAQ:AMZN"],
      ["Meta", "NASDAQ:META"],
      ["Tesla", "NASDAQ:TSLA"],
    ],
  },
  {
    key: "banks",
    title: "Wall Street",
    kind: "symbols",
    symbols: [
      ["JPMorgan", "NYSE:JPM"],
      ["Goldman Sachs", "NYSE:GS"],
      ["Morgan Stanley", "NYSE:MS"],
      ["Bank of America", "NYSE:BAC"],
      ["Blackstone", "NYSE:BX"],
      ["KKR", "NYSE:KKR"],
    ],
  },
  { key: "movers", title: "Movers", kind: "movers" },
];

const DATE_RANGES = ["1d|1", "5d|5", "1m|30", "6m|120", "12m|1D", "60m|1W"];

function ticker(symbol: string) {
  return symbol.split(":").at(-1) ?? symbol;
}

function chartConfig(label: string, symbol: string) {
  return {
    symbols: [[label, `${symbol}|1D`]],
    chartOnly: false,
    dateRanges: DATE_RANGES,
    changeMode: "price-and-percent",
    chartType: "area",
    showVolume: false,
    showMA: false,
    hideDateRanges: false,
    hideMarketStatus: true,
    hideSymbolLogo: false,
    scalePosition: "right",
    scaleMode: "Normal",
    valuesTracking: "1",
    lineWidth: 2,
    fontSize: "10",
    headerFontSize: "small",
  };
}

/** Wall Street with the student's firms first, no symbol twice. */
function groupsFor(yourFirms: [string, string][]): Group[] {
  if (yourFirms.length === 0) return GROUPS;
  return GROUPS.map((g) => {
    if (g.key !== "banks" || g.kind !== "symbols") return g;
    const mine = new Set(yourFirms.map(([, s]) => s));
    return { ...g, symbols: [...yourFirms, ...g.symbols.filter(([, s]) => !mine.has(s))] };
  });
}

const WIDE_KEY = "offerly.marketBoard.wide";
const WIDE_EVENT = "offerly:market-board-wide";

// Where the choice lives when the browser won't store it (a private window),
// so the button still works for the visit.
let wideInMemory = false;

function readWide(): boolean {
  try {
    const stored = localStorage.getItem(WIDE_KEY);
    return stored === null ? wideInMemory : stored === "1";
  } catch {
    return wideInMemory;
  }
}

function writeWide(next: boolean) {
  wideInMemory = next;
  try {
    localStorage.setItem(WIDE_KEY, next ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(WIDE_EVENT));
}

function subscribeWide(onChange: () => void) {
  window.addEventListener(WIDE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(WIDE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export default function MarketBoard({ yourFirms = [] }: { yourFirms?: [label: string, symbol: string][] }) {
  const GROUPS = groupsFor(yourFirms);
  const [active, setActive] = useState(GROUPS[0].key);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Wide or compact, remembered in this browser. The server renders compact,
  // so the first paint always matches; a remembered "wide" applies on hydrate.
  const wide = useSyncExternalStore(subscribeWide, readWide, () => false);
  const toggleWide = () => writeWide(!wide);
  const tabs = useRef<HTMLDivElement>(null);
  const group = GROUPS.find((g) => g.key === active) ?? GROUPS[0];

  const chooseGroup = (key: string) => {
    setActive(key);
    setExpanded(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = GROUPS.findIndex((g) => g.key === active);
    const next = GROUPS[(i + (e.key === "ArrowRight" ? 1 : GROUPS.length - 1)) % GROUPS.length];
    chooseGroup(next.key);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-group="${next.key}"]`)?.focus();
  };

  return (
    <section
      aria-label="Current market movement"
      // Read by .news-split (globals.css) to stack the page's split once the
      // board is spread across it.
      data-wide={wide ? "true" : "false"}
      className={`overflow-hidden rounded-xl border border-[#24496f] bg-[#071b35] shadow-[0_10px_28px_-18px_rgba(7,27,53,0.8)] ${
        wide ? "w-full" : "w-full max-w-[30rem]"
      }`}
    >
      <div className="flex rounded-t-xl border-b border-white/10">
      <div
        ref={tabs}
        role="tablist"
        aria-label="Market board category"
        onKeyDown={onKey}
        className="grid flex-1 grid-cols-4"
      >
        {GROUPS.map((g) => {
          const on = g.key === active;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              data-group={g.key}
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => chooseGroup(g.key)}
              className={`min-w-0 border-r border-white/10 px-1 py-2.5 text-[10px] font-semibold first:rounded-tl-xl focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#cbc1fa] sm:text-[11px] ${
                on ? "bg-[#173c63] text-white" : "text-[#9eb3c9] hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              {g.title}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={toggleWide}
        aria-pressed={wide}
        aria-label={wide ? "Shrink the market board" : "Expand the market board across the page"}
        title={wide ? "Shrink" : "Expand across the page"}
        className="flex shrink-0 items-center justify-center rounded-tr-xl px-3 text-[#9eb3c9] hover:bg-white/[0.06] hover:text-white focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#cbc1fa]"
      >
        {wide ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
      </button>
      </div>

      <div key={group.key} role="tabpanel" aria-label={group.title} className="market-rise">
        {group.kind === "movers" ? (
          <div className="bg-[#071b35] p-1">
            <TradingViewWidget
              kind="hotlists"
              height={440}
              title="Today's biggest market movers"
              theme="dark"
              // No chart of its own: at this size it left room for one row of
              // the list; the list is what Movers is for.
              config={{ exchange: "US", dateRange: "1D", showChart: false, showSymbolLogo: true, showFloatingTooltip: false }}
            />
          </div>
        ) : (
          // Expanded, the rows flow into columns so a wide board isn't four
          // long, mostly empty lines. One px gaps on a white/10 ground draw
          // the dividers between cells in any column count.
          <div className="pb-1.5">
            {(() => {
              // The clicked company's chart, at the top of the board.
              const chosen = group.symbols.find(([, s]) => s === expanded);
              if (!chosen) return null;
              const [label, symbol] = chosen;
              return (
                <div key={symbol} id={`market-${group.key}-chart`} role="region" aria-label={`${label} price movement`} className="market-rise bg-[#071b35] p-1">
                  <TradingViewWidget
                    kind="symbol-overview"
                    config={chartConfig(label, symbol)}
                    height={wide ? 340 : 250}
                    title={`${label}: price and movement chart`}
                    theme="dark"
                  />
                </div>
              );
            })()}
            <div className={`grid gap-px bg-white/10 ${wide ? "sm:grid-cols-2 xl:grid-cols-4" : ""}`}>
            {group.symbols.map(([label, symbol]) => {
              const open = expanded === symbol;
              const panelId = `market-${group.key}-chart`;
              return (
                <div key={symbol} className={open ? "bg-[#173c63]/60" : "bg-[#071b35]"}>
                  <button
                    type="button"
                    aria-label={`${label} (${ticker(symbol)}), show price movement chart`}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setExpanded(open ? null : symbol)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 text-left hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#cbc1fa]"
                  >
                    <span className="pointer-events-none min-w-0 overflow-hidden" aria-hidden>
                      <TradingViewSingleTicker symbol={symbol} />
                    </span>
                    <ChevronDown
                      size={14}
                      aria-hidden
                      className={`text-[#91a9c2] transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                </div>
              );
            })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
