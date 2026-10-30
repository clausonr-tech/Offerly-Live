"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Format, Item, Range } from "@/lib/market-data/types";

// One chart of one series - price, yield, rate or reading - with the 1D to
// 5Y ranges the series has, loaded on demand from /api/markets/history. The
// headline number is always the row's own (the latest trade, or the last
// release), so the chart and the list beside it agree. Hovering or dragging
// across it reads off any point. Shared by the market strip on the digest and
// the Markets view.

// ------------------------------------------------------------ formatting

export function digits(format: Format, id: string): number {
  if (format === "fx") return id === "USDJPY" ? 2 : 4;
  if (format === "thousands") return 0;
  return 2;
}

export function formatValue(format: Format, value: number, id = ""): string {
  const n = value.toLocaleString("en-US", { minimumFractionDigits: digits(format, id), maximumFractionDigits: digits(format, id) });
  if (format === "yield" || format === "spread" || format === "pct") return `${n}%`;
  if (format === "thousands") return `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`;
  return n;
}

export const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");

/**
 * A change the way traders say it - basis points for a yield, points for a
 * rate, percent for a price - rounded first, so a change too small to show
 * reads as 0 with no sign rather than "−0.0". `dir` is the rounded direction,
 * for the arrow and colour.
 */
export function formatChange(format: Format, change: number | null, changePct: number | null, id = ""): { text: string; dir: number } | null {
  if (change === null || format === "thousands") return null;
  const say = (n: number, text: string) => ({ text: `${sign(n)}${text}`, dir: Math.sign(n) });
  if (format === "yield" || format === "spread") {
    const bp = Math.round(change * 100);
    return say(bp, `${Math.abs(bp)} bp`);
  }
  if (format === "pct") {
    const pts = Math.round(change * 10) / 10;
    return say(pts, `${Math.abs(pts).toFixed(1)} pts`);
  }
  if (changePct === null) {
    const d = digits(format, id);
    const r = Number(change.toFixed(d));
    return say(r, Math.abs(r).toFixed(d));
  }
  const pct = Number(changePct.toFixed(2));
  return say(pct, `${Math.abs(pct).toFixed(2)}%`);
}

export const tone = (n: number | null | undefined) => (!n ? "text-warmgray-500" : n > 0 ? "text-emerald-700" : "text-red-600");

export function asOfLabel(item: Pick<Item, "asOf" | "source">): string {
  if (item.asOf.includes("T")) {
    return `${item.source} · ${new Date(item.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`;
  }
  const d = new Date(`${item.asOf}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${item.source} · ${d}`;
}

// ------------------------------------------------------------ the chart

type HistoryPoint = { t: string; v: number };

/** A date on the chart's bottom axis, as fine as its range needs: an hour, a weekday, a day, a month, a year. */
function axisLabel(t: string, range: Range): string {
  const d = new Date(t.includes("T") ? t : `${t}T12:00:00Z`);
  const zone = t.includes("T") ? "America/New_York" : "UTC";
  if (range === "1D") return d.toLocaleTimeString("en-US", { hour: "numeric", timeZone: zone });
  if (range === "5D") return d.toLocaleDateString("en-US", { weekday: "short", timeZone: zone });
  if (range === "1M" || range === "6M") return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });
  if (range === "1Y") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: zone });
  return d.toLocaleDateString("en-US", { year: "numeric", timeZone: zone });
}

/**
 * `bare` draws it without its own card, for the top of a card that also holds
 * the rows it charts (MarketsDashboard's Section), and a little shorter.
 */
export default function MarketChart({ item, bare }: { item: Item; bare?: boolean }) {
  const [range, setRange] = useState<Range>(item.ranges.includes("1M") ? "1M" : item.ranges[0]);
  // What was loaded, and for which range: a range switch shows "Loading"
  // until its own answer arrives, without resetting state inside the effect.
  const [loaded, setLoaded] = useState<{ key: string; points: HistoryPoint[] | null; failed: boolean } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const titleId = useId();
  const key = `${item.id}:${range}`;
  const points = loaded?.key === key ? loaded.points : null;
  const failed = loaded?.key === key && loaded.failed;

  useEffect(() => {
    let live = true;
    fetch(`/api/markets/history?id=${encodeURIComponent(item.id)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { points: HistoryPoint[] }) => live && setLoaded({ key: `${item.id}:${range}`, points: d.points, failed: false }))
      .catch(() => live && setLoaded({ key: `${item.id}:${range}`, points: null, failed: true }));
    return () => {
      live = false;
    };
  }, [item.id, range]);

  const W = 600;
  const H = 200;
  const geo = useMemo(() => {
    if (!points || points.length < 2) return null;
    const vs = points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    const lo = min - pad;
    const hi = max + pad;
    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    // Four values up the side, from the lowest point to the highest.
    const ticks = max === min ? [min] : [0, 1, 2, 3].map((k) => min + ((max - min) * k) / 3);
    // Up to five dates along the bottom, evenly spaced, none repeated.
    const n = points.length;
    const picks = [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4)))];
    const seen = new Set<string>();
    const dates = picks
      .map((i) => ({ i, label: axisLabel(points[i].t, range) }))
      .filter((d) => (seen.has(d.label) ? false : (seen.add(d.label), true)));
    return { x, y, min, max, ticks, dates, path: points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ") };
  }, [points, range]);

  // Measured to the number in the row, so the chart and the list agree: the
  // latest trade for a live price, the last release for a daily one.
  const first = points?.[0];
  const last = points?.length ? { t: points[points.length - 1].t, v: item.value } : undefined;
  const up = first && last ? last.v >= first.v : true;
  const over =
    first && last
      ? item.format === "yield" || item.format === "spread" || item.format === "pct"
        ? `${sign(last.v - first.v)}${Math.abs(item.format === "pct" ? last.v - first.v : Math.round((last.v - first.v) * 100)).toFixed(item.format === "pct" ? 1 : 0)}${item.format === "pct" ? " pts" : " bp"}`
        : item.format === "thousands"
          ? null
          : `${sign(last.v - first.v)}${Math.abs(((last.v - first.v) / first.v) * 100).toFixed(2)}%`
      : null;
  const shown = hover !== null && points ? points[hover] : null;
  const when = (t: string) =>
    t.includes("T") && (range === "1D" || range === "5D")
      ? new Date(t).toLocaleString("en-US", { weekday: range === "5D" ? "short" : undefined, hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"
      : new Date(t.includes("T") ? t : `${t}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: range === "5Y" || range === "1Y" ? "numeric" : undefined, timeZone: "UTC" });

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points || !svg.current) return;
    const box = svg.current.getBoundingClientRect();
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - box.left) / box.width) * (points.length - 1)))));
  };

  return (
    <div className={bare ? "p-4" : "rounded-lg border border-brand-100 bg-white p-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p id={titleId} className="truncate text-sm font-semibold text-brand-900">
            {item.name}
          </p>
          <p className="text-2xl font-semibold tabular-nums text-brand-900">{shown ? formatValue(item.format, shown.v, item.id) : formatValue(item.format, item.value, item.id)}</p>
          <p className="text-xs text-warmgray-500">
            {shown ? when(shown.t) : asOfLabel(item)}
            {over && hover === null && (
              <>
                {" · "}
                <span className={`font-medium ${up ? "text-emerald-700" : "text-red-600"}`}>
                  {over} over {range}
                </span>
              </>
            )}
          </p>
        </div>
        <div role="group" aria-label="Chart range" className="flex rounded-md border border-brand-100 p-0.5">
          {item.ranges.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={`rounded px-2 py-1 text-xs font-medium ${r === range ? "bg-brand-900 text-white" : "text-warmgray-600 hover:bg-brand-50"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {/* The plot, with its values up the right and its dates along the
          bottom. The line is drawn to fit the box, so the labels are text laid
          over it rather than drawn in it - stretched text would warp. */}
      <div className={`relative mt-3 pb-5 pr-14 ${bare ? "h-40" : "h-48"}`}>
        {geo ? (
          <>
            <svg
              ref={svg}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              role="img"
              aria-labelledby={titleId}
              className={`h-full w-full touch-none overflow-visible ${up ? "text-emerald-600" : "text-red-500"}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {geo.ticks.map((t) => (
                <line key={t} x1={0} x2={W} y1={geo.y(t)} y2={geo.y(t)} stroke="#e5e7eb" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
              <path d={`${geo.path} L${W},${H} L0,${H} Z`} fill="currentColor" opacity="0.08" />
              <path d={geo.path} fill="none" stroke="currentColor" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              {hover !== null && points && (
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={0} y2={H} stroke="#94a3b8" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />
              )}
            </svg>
            <div aria-hidden className="pointer-events-none absolute bottom-5 right-0 top-0 w-14">
              {geo.ticks.map((t) => (
                <span key={t} className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-warmgray-500" style={{ top: `${(geo.y(t) / H) * 100}%` }}>
                  {formatValue(item.format, t, item.id)}
                </span>
              ))}
            </div>
            <div aria-hidden className="pointer-events-none absolute bottom-0 left-0 right-14 h-4">
              {geo.dates.map(({ i, label }, n) => (
                <span
                  key={i}
                  className={`absolute top-0 whitespace-nowrap text-[10px] text-warmgray-500 ${n === 0 ? "" : n === geo.dates.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
                  style={{ left: `${(geo.x(i) / W) * 100}%` }}
                >
                  {label}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-warmgray-500">{failed ? "Couldn't load this chart. Try another range." : points ? "Not enough data for this range." : "Loading…"}</div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-warmgray-500">
        {item.detail ? `${item.detail}. ` : ""}Source: {item.source}.
      </p>
    </div>
  );
}

