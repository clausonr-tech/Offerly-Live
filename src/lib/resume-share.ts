import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { requestIp } from "./login-throttle";
import { rateLimit } from "./rate-limit";

/**
 * The Resume Link: who may open /r/<token>, and for how long.
 *
 * The link is deliberately unauthenticated - a banker who got a cold email
 * opens it without an Offerly account - so the token in the URL is the whole
 * credential. The privacy policy ("Resume Link") promises the student can
 * turn it off, that the old link then stops working, and that they can
 * replace it with a new one. Nothing in the app could do any of that: the
 * column users.resume_share_token had no writer at all, so a token already in
 * the table was permanent, and a link that was forwarded on could not be
 * taken back by any means short of deleting the account.
 *
 * This is the writing half of that promise, plus a ceiling on how long any
 * link lasts:
 *
 *   - revokeResumeShareLink  - "turn it off": the old link stops working now.
 *   - rotateResumeShareLink  - "replace it": a new link, the old one dead.
 *   - resolveResumeShareLink - the route's one entry point, which refuses an
 *                              expired token and bounds how often a link may
 *                              be fetched.
 *
 * A token minted here carries the day it was issued, in the clear, as part of
 * the token: "r1.<day>.<random>". That is what lets a link expire without a
 * new column - there is nowhere else to record when it was handed out, and a
 * date is not a secret (the 192 random bits are). Tokens that predate this
 * file say nothing about themselves, so they are bounded the only way they
 * can be: a sunset date, after which the route explains that the link has
 * expired instead of pretending it never existed.
 */

/** The shortest token worth a lookup. */
const MIN_TOKEN_LENGTH = 16;

/** How long a link minted here is good for. A recruiting season, not forever. */
const TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * When the tokens that predate this file stop working.
 *
 * They cannot be dated, so they all share one end date - far enough out that
 * a resume link pasted into an email this season still opens, and a student
 * who is relying on one is not cut off today. After it, the route says the
 * link expired rather than returning "not found", because a silent 404 reads
 * as "this person does not exist" to whoever was sent the link.
 */
export const LEGACY_TOKEN_SUNSET = new Date("2027-02-01T00:00:00Z");

/**
 * Fetches of one link, per hour, counted TWICE - and who each count is
 * charged to is the point.
 *
 * Both are charged only after the token resolves to a student, so an
 * unauthenticated caller cannot make the app write a rate-limit row by
 * guessing at tokens. They bound what a leaked link can pull out of the
 * database; neither bounds guessing, because a 192-bit token is not guessed.
 *
 *   per VIEWER of this link - the tight one. There was only an owner-scoped
 *     count, on a route that needs no session, so every holder of the link
 *     spent the same 120: anyone it had been forwarded to could burn the hour
 *     and the recruiter it was actually sent to got "opened too many times
 *     just now" - a denial of the student's own link, available to anyone who
 *     had ever seen it. Keyed on (student, viewer) rather than the viewer
 *     alone, so neither can one recruiter's reading of one resume eat their
 *     budget for another student's link.
 *
 *   per OWNER, across every viewer - the ceiling, ten times as high. It is
 *     what still bounds bulk extraction of one student's resume by a swarm,
 *     and it is set far above any real reading of one link so that reaching
 *     it is not something a handful of recruiters can do to each other.
 *
 * A caller whose address does not resolve is charged the viewer bound under
 * one shared name. That is the one case where viewers share a budget, and it
 * is strictly better than what it replaces: it cannot be reached by any caller
 * whose address the host's proxy does resolve, so the recruiter holding the
 * link keeps a budget of their own.
 */
const VIEWS_PER_VIEWER_PER_HOUR = 120;
const VIEWS_PER_OWNER_PER_HOUR = 1200;

export type ResumeShareLink =
  | { status: "ok"; userId: string; storageKey: string; filename: string | null }
  /** No such link, or the student has no resume on file. */
  | { status: "missing" }
  /** The link existed and has run out. */
  | { status: "expired" }
  | { status: "throttled" };

function mintToken(now: Date): string {
  const day = Math.floor(now.getTime() / 86_400_000).toString(36);
  return `r1.${day}.${randomBytes(24).toString("base64url")}`;
}

/**
 * When a token was issued, or null when it does not say.
 *
 * The two dots are what makes the format unmistakable: a random token is hex
 * or base64url, neither of which contains one, so a legacy token can never be
 * mistaken for a dated one and expired early.
 */
export function tokenIssuedAt(token: string): Date | null {
  const match = /^r1\.([0-9a-z]{1,8})\.[A-Za-z0-9_-]{16,}$/.exec(token);
  if (!match) return null;
  const day = parseInt(match[1], 36);
  return Number.isFinite(day) ? new Date(day * 86_400_000) : null;
}

/** Whether a token has run out: by its own date, or by the legacy sunset. */
export function tokenExpired(token: string, now = new Date()): boolean {
  const issued = tokenIssuedAt(token);
  return issued ? now.getTime() > issued.getTime() + TOKEN_LIFETIME_MS : now >= LEGACY_TOKEN_SUNSET;
}

/** Turns the link off. The old URL stops working immediately. */
export async function revokeResumeShareLink(userId: string): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ resumeShareToken: null }).where(eq(users.id, userId));
}

/** A new link, which kills the previous one. Returns the token to show the student. */
export async function rotateResumeShareLink(userId: string, now = new Date()): Promise<string> {
  const token = mintToken(now);
  const db = await getDb();
  await db.update(users).set({ resumeShareToken: token }).where(eq(users.id, userId));
  return token;
}

/**
 * The resume a link points at, or why it serves nothing.
 *
 * `viewer` is the caller's address, resolved by the server from the host's
 * proxy header - never from anything the request can choose. Taken as an
 * argument so a test can name a viewer; left out, it is resolved here.
 */
export async function resolveResumeShareLink(
  token: string,
  now = new Date(),
  viewer?: string | null,
): Promise<ResumeShareLink> {
  if (!token || token.length < MIN_TOKEN_LENGTH) return { status: "missing" };

  const db = await getDb();
  const user = await db.query.users.findFirst({
    where: eq(users.resumeShareToken, token),
    columns: { id: true, resumeStoragePath: true, resumeFilename: true },
  });
  if (!user?.resumeStoragePath) return { status: "missing" };
  if (tokenExpired(token, now)) return { status: "expired" };

  // Composite subjects are joined with ":" and hold no NUL - the column is
  // text. "unknown" is a name no resolved address can collide with, since
  // requestIp returns an address or nothing (lib/login-throttle).
  const ip = viewer === undefined ? await requestIp() : viewer;
  const byViewer = await rateLimit(
    "resume-share:viewer",
    `${user.id}:${ip ?? "unknown"}`,
    VIEWS_PER_VIEWER_PER_HOUR,
    60 * 60 * 1000,
    now,
  );
  if (!byViewer.allowed) return { status: "throttled" };
  // The ceiling, charged only for a fetch the viewer bound allowed, so one
  // viewer running out does not also spend the student's.
  const byOwner = await rateLimit("resume-share", user.id, VIEWS_PER_OWNER_PER_HOUR, 60 * 60 * 1000, now);
  if (!byOwner.allowed) return { status: "throttled" };

  return { status: "ok", userId: user.id, storageKey: user.resumeStoragePath, filename: user.resumeFilename };
}
