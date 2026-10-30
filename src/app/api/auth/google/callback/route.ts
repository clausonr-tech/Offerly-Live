import { sealToken } from "@/lib/token-crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailConnections } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { exchangeCodeForTokens, fetchGoogleUserEmail } from "@/lib/google-oauth";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("google_oauth_state")?.value;
  cookieStore.delete("google_oauth_state");

  if (error) {
    return NextResponse.redirect(new URL(`/profile/connections?google_error=${encodeURIComponent(error)}`, request.url));
  }
  if (!code || !state || state !== expectedState) {
    return NextResponse.redirect(new URL("/profile/connections?google_error=invalid_state", request.url));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const email = await fetchGoogleUserEmail(tokens.access_token);

    const userId = await getCurrentUserId();
    const db = await getDb();

    // Reconnecting the same account updates its tokens in place instead of
    // creating a duplicate row; a different account gets its own row, so a
    // student can have several Google accounts connected at once.
    const existing = email
      ? await db.query.emailConnections.findFirst({
          where: and(eq(emailConnections.userId, userId), eq(emailConnections.email, email)),
        })
      : null;

    if (existing) {
      await db
        .update(emailConnections)
        .set({
          accessToken: sealToken(tokens.access_token),
          // Kept as stored (sealed or not) when Google sends no new one.
          refreshToken: tokens.refresh_token ? sealToken(tokens.refresh_token) : existing.refreshToken,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        })
        .where(eq(emailConnections.id, existing.id));
    } else {
      await db.insert(emailConnections).values({
        userId,
        provider: "google",
        email,
        accessToken: sealToken(tokens.access_token),
        refreshToken: sealToken(tokens.refresh_token ?? null),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      });
    }

    return NextResponse.redirect(new URL("/profile/connections?google_connected=1", request.url));
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    return NextResponse.redirect(new URL("/profile/connections?google_error=exchange_failed", request.url));
  }
}
