import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDashboard } from "@/lib/market-data/board";

/**
 * The Markets view's numbers, for the page to refresh itself. Signed-in
 * students only; takes no input. One copy is shared by everyone for 30 seconds
 * (src/lib/market-data/board.ts), so however many have the page open, the
 * sources see a handful of requests a minute.
 */
export async function GET() {
  if (!(await getSessionUser())) return new NextResponse(null, { status: 401 });
  return NextResponse.json(await getDashboard(), { headers: { "Cache-Control": "private, max-age=15" } });
}
