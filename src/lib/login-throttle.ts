import "server-only";
import { isIP } from "node:net";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { loginAttempts } from "@/db/schema";
import { throttleMessage, throttleVerdict, WINDOW_MS, type Attempt } from "@/lib/login-throttle-rules";

// Slows down password guessing on the student and firm sign-in forms. The
// rule is in lib/login-throttle-rules.ts.
//
// Stored in login_attempts (migration 0019). Until that table exists - or if
// the database is briefly unreachable - it falls back to a count kept in this
// server's memory, so sign-in never breaks because of the limiter.

const memory = new Map<string, Attempt[]>();

function remember(key: string, a: Attempt) {
  const list = (memory.get(key) ?? []).filter((x) => x.at.getTime() > Date.now() - WINDOW_MS);
  list.push(a);
  memory.set(key, list);
}

/**
 * An address, or null - and nothing else ever becomes a limiter subject.
 *
 * Whatever header the value came from, it is a string the proxy was supposed
 * to set and a client may have sent, so it is checked against node:net's
 * isIP() before anyone keys a stored row on it. Without that check an
 * arbitrary header string - a novel, a lookalike of someone else's address -
 * was written into rate_events.subject and login_attempts.ip as if it were an
 * address, and an attacker could pick a new one per request and never be
 * counted twice. Null means exactly "no address resolved", which every caller
 * already handles as "no per-IP limit".
 *
 * The small amount of tidying before the check is there so a REAL address in
 * a shape proxies legitimately use is not thrown away (losing the per-IP limit
 * for that caller): brackets around a v6 literal, and the ':port' some proxies
 * append to a v4 one. v6 is lowercased so one address is one subject.
 */
function parseIp(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (isIP(value)) return value;
  // "[2001:db8::1]" or "[2001:db8::1]:443" - the brackets exist to separate
  // the address from the port, so what is inside them is the address.
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed && isIP(bracketed[1])) return bracketed[1];
  // "203.0.113.7:51234". Only ever v4: a bare v6 address is all colons, so
  // splitting one on the last colon would mangle it rather than deport it.
  const ported = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (ported && isIP(ported[1]) === 4) return ported[1];
  return null;
}

/**
 * The caller's IP, from the header the host's proxy sets, given that request's
 * headers. Null when none of them holds an address.
 *
 * CLIENT_IP_HEADER names it when the host is known - "x-vercel-forwarded-for"
 * on Vercel, "cf-connecting-ip" behind Cloudflare, "fly-client-ip" on Fly -
 * and then ONLY that header is read, since a header the proxy does not set
 * is whatever the client sent. Unset, x-real-ip is tried, then the first
 * x-forwarded-for entry. The per-IP limit is a second line either way: the
 * per-account limits do not depend on it.
 *
 * Taken as an argument so a route handler can resolve from the request it was
 * handed (app/api/crest), which is the same set of headers requestIp() reads
 * out of the ambient store.
 */
let warnedAboutIpHeader = false;

/**
 * The caller's address, or null when there is no address we are willing to
 * believe.
 *
 * CLIENT_IP_HEADER names the one header the host's proxy is known to
 * OVERWRITE - "x-vercel-forwarded-for" on Vercel, "cf-connecting-ip" behind
 * Cloudflare. When it is set, only that header is read.
 *
 * When it is NOT set, in production, this returns null rather than falling
 * back to x-real-ip or x-forwarded-for. Those are whatever the client sent
 * unless something upstream replaces them, and a guessable address is worse
 * than no address: with no address there is simply no per-IP limit, but with a
 * forged one an attacker can put a VICTIM's address in the header and spend
 * that victim's budget - turning a rate limit into a way to lock someone else
 * out. The audit left "confirm CLIENT_IP_HEADER is set" as a deployment fact
 * nobody could check from the code; this makes the code stop depending on the
 * answer, and say so once in the log.
 *
 * Outside production the fallback stays, because local development has no
 * proxy and nothing to spoof.
 */
export function clientIpFrom(h: { get(name: string): string | null }): string | null {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configured) return parseIp(h.get(configured)?.split(",")[0]);

  if (process.env.NODE_ENV === "production") {
    if (!warnedAboutIpHeader) {
      warnedAboutIpHeader = true;
      console.error(
        "[login-throttle] CLIENT_IP_HEADER is not set, so per-IP limits are OFF: " +
          "x-real-ip and x-forwarded-for are client-settable and would let one caller " +
          'spend another\'s budget. Set it to the header this host overwrites (on Vercel, "x-vercel-forwarded-for").',
      );
    }
    return null;
  }

  return parseIp((h.get("x-real-ip") ?? h.get("x-forwarded-for"))?.split(",")[0]);
}

/** The caller's IP for the request in progress. Null outside a request. */
export async function requestIp(): Promise<string | null> {
  try {
    return clientIpFrom(await headers());
  } catch {
    return null;
  }
}

/**
 * Starts one attempt: records it as a failure FIRST, then decides whether it
 * may go ahead, counting the attempts written before it. Recording before
 * deciding is what makes a parallel burst count: each request's row is
 * visible to the ones after it, where checking first let a burst all pass the
 * check before any of them had been written down. A refused attempt is
 * removed again, so hammering a locked account does not extend the lock.
 * Call `finish(true)` on success, which clears the account's count.
 */
export async function beginLoginAttempt(
  emailRaw: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ blocked: string | null; finish: (success: boolean) => Promise<void> }> {
  const email = emailRaw.trim().toLowerCase();
  try {
    const db = await getDb();
    const [mine] = await db.insert(loginAttempts).values({ email, ip, success: false, createdAt: now }).returning();
    const since = new Date(now.getTime() - WINDOW_MS);
    const rows = await db
      .select({ id: loginAttempts.id, email: loginAttempts.email, ip: loginAttempts.ip, success: loginAttempts.success, at: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(and(gte(loginAttempts.createdAt, since), ip ? or(eq(loginAttempts.email, email), eq(loginAttempts.ip, ip)) : eq(loginAttempts.email, email)));
    // Only the attempts made before this one, in (time, id) order - so of a
    // burst, the first ones in line go ahead and the rest are refused, rather
    // than every request counting every other and all of them being refused.
    const before = (r: { id: string; at: Date }) =>
      r.at.getTime() < mine.createdAt.getTime() || (r.at.getTime() === mine.createdAt.getTime() && r.id < mine.id);
    const others = rows.filter((r) => r.id !== mine.id && before(r));
    const verdict = throttleVerdict(
      others.filter((r) => r.email === email),
      ip ? others.filter((r) => r.ip === ip) : [],
      now,
      ip ? others.filter((r) => r.email === email && r.ip === ip) : undefined,
    );
    // Keep the table to a day of history.
    if (Math.random() < 0.05) {
      await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
    }
    if (!verdict.ok) {
      await db.delete(loginAttempts).where(eq(loginAttempts.id, mine.id));
      return { blocked: throttleMessage(verdict.retryAfterMinutes), finish: async () => {} };
    }
    return {
      blocked: null,
      finish: async (success) => {
        if (success) await db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, mine.id));
      },
    };
  } catch {
    // No table yet, or the database is briefly unreachable: this server's
    // memory. Counted as a failure now, like the table row, and a success
    // added on finish(true) - callers never report a failure themselves.
    const verdict = throttleVerdict(
      memory.get(`e:${email}`) ?? [],
      ip ? (memory.get(`i:${ip}`) ?? []) : [],
      now,
      ip ? (memory.get(`p:${email}|${ip}`) ?? []) : undefined,
    );
    if (!verdict.ok) return { blocked: throttleMessage(verdict.retryAfterMinutes), finish: async () => {} };
    const note = (success: boolean) => {
      remember(`e:${email}`, { at: new Date(), success });
      if (ip) remember(`i:${ip}`, { at: new Date(), success });
      if (ip) remember(`p:${email}|${ip}`, { at: new Date(), success });
    };
    note(false);
    return {
      blocked: null,
      finish: async (success) => {
        if (success) note(true);
      },
    };
  }
}

/** Null when this attempt may go ahead, or the message to show when it may not. */
export async function loginBlocked(emailRaw: string, ip: string | null, now: Date = new Date()): Promise<string | null> {
  const email = emailRaw.trim().toLowerCase();
  let byEmail: Attempt[];
  let byIp: Attempt[];
  let pair: Attempt[] | undefined;
  try {
    const db = await getDb();
    const since = new Date(now.getTime() - WINDOW_MS);
    const rows = await db
      .select({ email: loginAttempts.email, ip: loginAttempts.ip, success: loginAttempts.success, at: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(and(gte(loginAttempts.createdAt, since), ip ? or(eq(loginAttempts.email, email), eq(loginAttempts.ip, ip)) : eq(loginAttempts.email, email)));
    byEmail = rows.filter((r) => r.email === email);
    byIp = ip ? rows.filter((r) => r.ip === ip) : [];
    pair = ip ? rows.filter((r) => r.email === email && r.ip === ip) : undefined;
  } catch {
    byEmail = memory.get(`e:${email}`) ?? [];
    byIp = ip ? (memory.get(`i:${ip}`) ?? []) : [];
    pair = ip ? (memory.get(`p:${email}|${ip}`) ?? []) : undefined;
  }
  const verdict = throttleVerdict(byEmail, byIp, now, pair);
  return verdict.ok ? null : throttleMessage(verdict.retryAfterMinutes);
}

/** Records one attempt. Never throws. */
export async function recordLoginAttempt(emailRaw: string, ip: string | null, success: boolean, now: Date = new Date()): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  try {
    const db = await getDb();
    await db.insert(loginAttempts).values({ email, ip, success, createdAt: now });
    // Keep the table to a day of history.
    if (Math.random() < 0.05) {
      await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
    }
  } catch {
    remember(`e:${email}`, { at: now, success });
    if (ip) remember(`i:${ip}`, { at: now, success });
    if (ip) remember(`p:${email}|${ip}`, { at: now, success });
  }
}
