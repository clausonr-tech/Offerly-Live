// What the market pages and the server share: plain types and constants, with
// no server code, so client components can import them.

export type Range = "1D" | "5D" | "1M" | "6M" | "1Y" | "5Y";
export const RANGES: Range[] = ["1D", "5D", "1M", "6M", "1Y", "5Y"];
export const DAILY_RANGES: Range[] = ["5D", "1M", "6M", "1Y", "5Y"];

export type Source = "US Treasury" | "ECB" | "FRED";
export type Format = "price" | "yield" | "fx" | "index" | "spread" | "pct" | "thousands";

export type Item = {
  id: string;
  name: string;
  /** A second line: the ETF behind an index, what a series measures. */
  detail?: string;
  value: number;
  /** In the item's own unit - dollars, points, or percentage points for a yield. */
  change: number | null;
  changePct: number | null;
  format: Format;
  source: Source;
  /** ISO time for a live price, YYYY-MM-DD for a daily or monthly number. */
  asOf: string;
  ranges: Range[];
};
