import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { RANGES, chartable, history, type Range } from "@/lib/market-data/board";

/**
 * One chart's history for the Markets view: ?id=UST10Y&range=1M. Signed-in
 * students only, and only the official series the page shows (chartable) - so
 * it is neither an open data feed nor a way to make the server fetch anything
 * else. Takes an id and a fixed range; no words.
 */
export async function GET(request: Request) {
  if (!(await getSessionUser())) return new NextResponse(null, { status: 401 });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const range = url.searchParams.get("range") as Range;
  if (!RANGES.includes(range) || !chartable(id)) return new NextResponse(null, { status: 400 });
  try {
    const points = await history(id, range);
    return NextResponse.json({ id, range, points }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (err) {
    console.error(`[markets] history ${id} ${range}: ${err instanceof Error ? err.message : err}`);
    return new NextResponse(null, { status: 502 });
  }
}
