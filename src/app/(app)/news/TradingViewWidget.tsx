"use client";

import { useEffect, useRef } from "react";

// A TradingView widget, embedded the way TradingView publishes it: their
// script, loaded from their site, draws the chart in a frame of its own.
//
// Why TradingView: stock and fund prices come from exchanges, and the free
// feeds that carry them (Alpaca's, Yahoo's, Cboe's VIX file) do not allow
// showing them to other people. TradingView licenses these widgets for use on
// other sites, free, on one condition - its name and link stay on the widget
// (www.tradingview.com/widget, and its terms of use). So the attribution line
// below is part of the embed, exactly as TradingView ships it, and must not be
// hidden, restyled away or removed.
//
// The widget re-embeds when its kind or configuration changes (a new group on
// the market strip), and clears itself when it unmounts.

export type TradingViewKind = "symbol-overview" | "hotlists" | "stock-heatmap";

export default function TradingViewWidget({
  kind,
  config,
  height,
  title,
  theme = "light",
}: {
  kind: TradingViewKind;
  config: Record<string, unknown>;
  /** CSS height of the widget, attribution line included. */
  height: number;
  /** Names the frame for screen readers. */
  title: string;
  /** Match an enclosing dark market board without changing other embeds. */
  theme?: "light" | "dark";
}) {
  const outer = useRef<HTMLDivElement>(null);
  // autosize: fill the box, whose height is set here - without it the frame is 150px.
  const settings = JSON.stringify({ ...config, locale: "en", colorTheme: theme, isTransparent: true, autosize: true, width: "100%", height: "100%" });

  useEffect(() => {
    const box = outer.current;
    if (!box) return;
    // TradingView's embed, built by hand and handed over whole: its script
    // rewrites the container it sits in (its size, its contents), so none of
    // it is React's to render. The container, the empty __widget div it draws
    // into, the attribution line, then the script reading its settings from
    // its own text - the snippet TradingView publishes.
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    const slot = document.createElement("div");
    slot.className = "tradingview-widget-container__widget";
    const credit = document.createElement("div");
    credit.className = "tradingview-widget-copyright";
    const link = document.createElement("a");
    link.href = "https://www.tradingview.com/";
    link.rel = "noopener nofollow";
    link.target = "_blank";
    link.textContent = "Charts by TradingView";
    credit.appendChild(link);
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${kind}.js`;
    script.text = settings;
    container.append(slot, credit);
    box.replaceChildren(container);
    // Name the frame the script adds, for screen readers.
    const named = new MutationObserver(() => box.querySelector("iframe")?.setAttribute("title", title));
    named.observe(box, { childList: true, subtree: true });
    // The script goes in a tick later: a widget taken away at once (React's
    // double mount in development, a fast click through the tabs) then never
    // starts one - TradingView's script throws if its container is gone
    // before it runs.
    const start = window.setTimeout(() => container.appendChild(script), 0);
    return () => {
      window.clearTimeout(start);
      named.disconnect();
      box.replaceChildren();
    };
  }, [kind, settings, title]);

  return <div ref={outer} className="text-[11px] text-warmgray-500" style={{ height }} />;
}
