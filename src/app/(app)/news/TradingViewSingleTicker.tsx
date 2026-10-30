"use client";

import { createElement, useEffect } from "react";

const SCRIPT_ID = "tradingview-single-ticker-script";
const SCRIPT_SRC = "https://widgets.tradingview-widget.com/w/en/tv-single-ticker.js";

/**
 * TradingView's compact, licensed live quote. It supplies the current price
 * and daily change (including red/green direction) while the surrounding
 * board remains Offerly UI.
 */
export default function TradingViewSingleTicker({ symbol }: { symbol: string }) {
  useEffect(() => {
    if (document.getElementById(SCRIPT_ID)) return;
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.type = "module";
    script.src = SCRIPT_SRC;
    document.head.appendChild(script);
  }, []);

  return createElement("tv-single-ticker", {
    symbol,
    theme: "dark",
    transparent: true,
    "hide-market-status": true,
    style: { display: "block", width: "100%", height: "57px" },
  });
}
