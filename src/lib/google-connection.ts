import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailConnections } from "@/db/schema";
import { refreshAccessToken } from "./google-oauth";
import { ensureOfferlyCalendar } from "./google-calendar";
import { isSealed, openToken, sealToken } from "./token-crypto";

type Connection = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  offerlyCalendarId?: string | null;
};

// A student can connect more than one Google account (e.g. personal + a
// school/club address) so the Schedule shows every calendar they care about.
// Ordered oldest-first: the first one connected is treated as "primary" for
// actions that only make sense against a single account (writing new events
// to Google Calendar).
//
// Tokens are sealed at rest (lib/token-crypto); every row leaves here with
// them opened, and a row still holding plain tokens from before sealing is
// sealed on the way past.
export async function getEmailConnections(userId: string) {
  const db = await getDb();
  const rows = await db.query.emailConnections.findMany({
    where: eq(emailConnections.userId, userId),
    orderBy: [asc(emailConnections.connectedAt)],
  });
  const plain = rows.filter((r) => !isSealed(r.accessToken) || (r.refreshToken && !isSealed(r.refreshToken)));
  for (const r of plain) {
    const accessToken = sealToken(r.accessToken);
    if (!isSealed(accessToken)) break; // no key here: nothing to seal with
    await db
      .update(emailConnections)
      .set({ accessToken, refreshToken: sealToken(r.refreshToken) })
      .where(eq(emailConnections.id, r.id));
  }
  return rows.map((r) => ({ ...r, accessToken: openToken(r.accessToken), refreshToken: openToken(r.refreshToken) }));
}

export async function getPrimaryEmailConnection(userId: string) {
  const [primary] = await getEmailConnections(userId);
  return primary ?? null;
}

// Returns a valid access token for a stored Google connection, refreshing
// and persisting it first if it's expired (or about to be).
export async function getValidAccessToken(connection: Connection): Promise<string> {
  const expiringSoon = connection.expiresAt
    ? connection.expiresAt.getTime() < Date.now() + 60_000
    : false;
  if (!expiringSoon || !connection.refreshToken) {
    return connection.accessToken;
  }

  const tokens = await refreshAccessToken(connection.refreshToken);
  const db = await getDb();
  await db
    .update(emailConnections)
    .set({
      accessToken: sealToken(tokens.access_token),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    })
    .where(eq(emailConnections.id, connection.id));

  return tokens.access_token;
}

// Everything Offerly writes to Google goes onto a calendar Offerly created and
// owns, never the student's primary one. This resolves that calendar for the
// account we write through - refreshing the token, creating the calendar on
// first use, and caching its id back onto the connection.
//
// Returns null when the student hasn't connected Google at all, which is the
// normal case and not an error: callers fall back to saving locally only.
export async function getCalendarWriteTarget(
  userId: string,
): Promise<{ accessToken: string; calendarId: string } | null> {
  const connection = await getPrimaryEmailConnection(userId);
  if (!connection) return null;

  const accessToken = await getValidAccessToken(connection);
  const calendarId = await ensureOfferlyCalendar(accessToken, connection.offerlyCalendarId ?? null);

  if (calendarId !== connection.offerlyCalendarId) {
    const db = await getDb();
    await db
      .update(emailConnections)
      .set({ offerlyCalendarId: calendarId })
      .where(eq(emailConnections.id, connection.id));
  }

  return { accessToken, calendarId };
}

/**
 * Tells Google to cancel a connection's grant, so the stored tokens stop
 * working even if a copy of them survives somewhere. Called when a student
 * disconnects an account or deletes theirs. Best effort: Google being down
 * must not stop anyone leaving, and the row is deleted either way.
 */
export async function revokeGoogleGrant(connection: { accessToken: string; refreshToken: string | null }): Promise<void> {
  // Revoking the refresh token revokes the whole grant; the access token is
  // the fallback for a connection that never had one.
  const token = connection.refreshToken ?? connection.accessToken;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("[google] revoking a grant failed", err);
  }
}

/** Revokes every Google grant a student holds (see revokeGoogleGrant). */
export async function revokeAllGoogleGrants(userId: string): Promise<void> {
  const connections = await getEmailConnections(userId).catch(() => []);
  await Promise.all(connections.map((c) => revokeGoogleGrant(c)));
}
