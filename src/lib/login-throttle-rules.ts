// When to stop accepting password guesses. Pure, so the rule is tested on its
// own (scripts/test/login-throttle.test.ts); lib/login-throttle.ts applies it.
//
// Limits for the attacks there are, in 15-minute windows:
//   - one account, many guesses from one machine: 5 failures for that email
//     from that IP
//   - one account, guesses from many machines: 50 failures for the email
//     from anywhere
//   - one machine, many accounts: 30 failures from an IP
// The first is per machine, not per account, so a stranger cannot lock
// someone out of their own account with five wrong passwords - they only
// lock themselves out. When the IP is unknown there is nothing to pair with,
// and the email alone gets the tight limit, as before.
// A successful sign-in clears that email's count - someone who fat-fingers
// their password twice and then gets it right starts fresh.

export const WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_MAX_FAILURES = 5;
const EMAIL_ANYWHERE_MAX_FAILURES = 50;
export const IP_MAX_FAILURES = 30;

export type Attempt = { at: Date; success: boolean };

export type ThrottleVerdict = { ok: true } | { ok: false; retryAfterMinutes: number };

/** Failures inside the window, after the last success in it. */
function recentFailures(attempts: Attempt[], now: Date): Date[] {
  const since = now.getTime() - WINDOW_MS;
  const inWindow = attempts.filter((a) => a.at.getTime() > since).sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastSuccess = inWindow.map((a) => a.success).lastIndexOf(true);
  return inWindow.slice(lastSuccess + 1).filter((a) => !a.success).map((a) => a.at);
}

function lockedFor(failures: Date[], max: number, now: Date): number | null {
  if (failures.length < max) return null;
  // Unlocks when the failure that tipped it over leaves the window.
  const tipping = failures[failures.length - max];
  const ms = tipping.getTime() + WINDOW_MS - now.getTime();
  return ms > 0 ? Math.max(1, Math.ceil(ms / 60_000)) : null;
}

/**
 * `sameMachine` is this email's attempts from this IP. Given, the tight limit
 * applies to it and the email as a whole gets the looser one; omitted (the IP
 * is unknown), the email gets the tight limit.
 */
export function throttleVerdict(byEmail: Attempt[], byIp: Attempt[], now: Date = new Date(), sameMachine?: Attempt[]): ThrottleVerdict {
  const email = sameMachine
    ? Math.max(
        lockedFor(recentFailures(sameMachine, now), EMAIL_MAX_FAILURES, now) ?? 0,
        lockedFor(recentFailures(byEmail, now), EMAIL_ANYWHERE_MAX_FAILURES, now) ?? 0,
      ) || null
    : lockedFor(recentFailures(byEmail, now), EMAIL_MAX_FAILURES, now);
  // The IP limit counts every failure from it, successes on other accounts do not clear it.
  const ipFailures = byIp.filter((a) => !a.success && a.at.getTime() > now.getTime() - WINDOW_MS).map((a) => a.at).sort((a, b) => a.getTime() - b.getTime());
  const ip = lockedFor(ipFailures, IP_MAX_FAILURES, now);
  const wait = Math.max(email ?? 0, ip ?? 0);
  return wait > 0 ? { ok: false, retryAfterMinutes: wait } : { ok: true };
}

export function throttleMessage(minutes: number): string {
  return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`;
}
