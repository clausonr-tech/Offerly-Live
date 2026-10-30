import "server-only";
import { randomInt, createHash, timingSafeEqual } from "crypto";
import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { sendEmail } from "@/lib/email";

// There's no single SSO/VPN provider that covers every school, so instead we
// verify the student controls an inbox at the school's own email domain via
// a one-time code. This is the same approach Handshake/College Confidential
// style products use for school-affiliation checks.
//
// The domain is matched against the `schools` allowlist rather than a blocklist
// of personal providers. A blocklist only proves "not gmail" - it can't tell us
// *which* school the student attends, and anyone can register a domain to get
// past it. The allowlist gives us both properties at once.

const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;

// Pulls the domain out of an address. Returns null rather than throwing so
// callers can treat "no domain" the same as "unknown school".
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  // Must look like `something.tld` - rejects "a@b" and trailing-dot oddities.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return domain;
}

// Every domain a lookup should consider, most specific first: for
// "a.wharton.upenn.edu" that's a.wharton.upenn.edu, wharton.upenn.edu,
// upenn.edu. The bare TLD is deliberately excluded - seeding "edu" as a school
// domain would otherwise match every university in the world.
function domainCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

// Resolves an email to the school that owns its domain, or null if the domain
// isn't on the allowlist. Matching is on label boundaries via the candidate
// list above - a plain `endsWith` would let "notupenn.edu" match "upenn.edu".
// When both a school and one of its sub-domains are seeded, the more specific
// (longest) match wins.
export async function resolveSchoolForEmail(email: string) {
  const domain = emailDomain(email);
  if (!domain) return null;

  const candidates = domainCandidates(domain);
  if (candidates.length === 0) return null;

  const db = await getDb();
  const matches = await db
    .select()
    .from(schools)
    .where(inArray(schools.emailDomain, candidates));
  if (matches.length === 0) return null;

  return matches.reduce((best, row) =>
    row.emailDomain.length > best.emailDomain.length ? row : best,
  );
}

export function generateVerificationCode(): string {
  return String(randomInt(100000, 1000000));
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Compares a submitted code against the stored hash without leaking timing
// information, matching how lib/auth verifies passwords and session tokens.
export function codesMatch(submitted: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(submitted), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function codeExpiresAt(): Date {
  return new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
}

// Which provider actually delivers this is `lib/email`'s problem. In local dev
// with nothing configured that's the console driver, which prints the code to
// the dev-server terminal - enough to exercise the whole flow without an
// account anywhere.
export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Your Offerly verification code",
    text:
      `Your verification code is ${code}.\n\n` +
      `It expires in ${CODE_TTL_MINUTES} minutes. If you didn't ask to verify a ` +
      `school email on Offerly, you can ignore this message.`,
  });
}

/**
 * Sent when someone asks to verify an address that is ALREADY verified on
 * another account.
 *
 * The person asking is told only that a code is on its way - whether an
 * address is already verified is a fact about someone else's account, and
 * answering it turned this form into a lookup. The person who actually holds
 * the inbox is the one who hears about it, because they are the one an attempt
 * to take over their address concerns. No code is issued either way.
 */
export async function sendSchoolEmailAlreadyVerified(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Someone tried to verify this school email on Offerly",
    text:
      "Someone - hopefully you - just asked to verify this school email on Offerly, " +
      "but it is already verified on an account.\n\n" +
      "If that was you, sign in to that account; nothing needs doing. If it wasn't, " +
      "nobody has been given access to anything: no code was sent and nothing about " +
      "your account has changed.",
  });
}
