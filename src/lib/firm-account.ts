// The rules for firm accounts, with no database and no network, so every one
// of them can be tested on its own. lib/firm-auth.ts applies them.
//
// THE PROBLEM THESE SOLVE. A firm account can post to every student who
// matches the firm, so it has to belong to someone who works there:
//
//   1. The address must be at a domain that belongs to the firm - never a
//      personal or a school address - and the inbox is proved with a code at
//      sign-up. After that, firm accounts sign in with a password, like
//      students; a forgotten one is reset with another code to the inbox.
//   2. A person approves every account: Offerly approves the first one at a
//      firm (the owner), and the owner approves - and removes - everyone
//      after. Removing someone signs them out everywhere at once. This is what
//      keeps out a person who has left the firm.
//   3. Sessions are short (FIRM_SESSION_DAYS), so a signed-in laptop does not
//      keep access for months.

import { classifyDomain, isEducationalDomain, isFreemailDomain, registrableDomain } from "@/lib/company-domains";

/** The same password rule as a student account (lib/validation signupSchema). Null when it passes. */
export function checkFirmPassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 200) return "Password can be up to 200 characters.";
  return null;
}

/** How long a firm session lasts. Students get 30 days; firms get two weeks. */
export const FIRM_SESSION_DAYS = 14;
export const FIRM_SESSION_TTL_MS = FIRM_SESSION_DAYS * 24 * 60 * 60 * 1000;

export const FIRM_CODE_TTL_MINUTES = 15;
export const FIRM_CODE_MAX_ATTEMPTS = 5;
/** Codes one address may be sent per hour, so the form cannot flood an inbox. */
export const FIRM_CODES_PER_HOUR = 5;

/**
 * Codes one CALLER may have sent per hour, across every address.
 *
 * The per-address limit above is the tight one, but it is keyed on the
 * DESTINATION, which is whatever the form was given - so on its own it bounds
 * what one inbox receives and nothing at all about what one machine can do.
 * One anonymous caller could walk a list of addresses, five codes each, and
 * send Offerly-branded mail all day (and, at sign-up, mint an account per
 * address it controls). This is the matching per-requester bound.
 *
 * Both numbers are deliberately loose enough for the real shapes: a firm
 * onboarding a handful of recruiters from one office, and - the reason the
 * student number is far higher - a campus signing up together behind one
 * NAT address. Neither is a guessing limit; code guesses are bounded per
 * address by FIRM_CODE_MAX_ATTEMPTS and by lib/login-throttle.
 */
export const FIRM_CODES_PER_CALLER_PER_HOUR = 20;
export const STUDENT_CODES_PER_CALLER_PER_HOUR = 50;

export type FirmDomainSource = {
  id: string;
  name: string;
  website: string | null;
  verifiedDomain: string | null;
  approvedEmailDomains: string[] | null;
  isDemo?: boolean;
};

/**
 * ONE address, parsed once - the only way an address enters the app.
 *
 * Two things are decided from a typed address: which firm it belongs to, and
 * who receives the code that proves the inbox. They have to be the same
 * parse, and they were not. The firm was taken from the text after the LAST
 * '@' and run through a URL host normaliser (normaliseHost), which strips a
 * scheme, user-info, a ':port' and everything from the first '/', '?' or '#'.
 * The whole typed string, meanwhile, went to the mail provider verbatim. So
 * `someone@realfirm.com#.attacker.example` was judged to be at realfirm.com
 * while the mail - the code itself - was addressed to a domain the attacker
 * controls, and `me@personal.example, anyone@realfirm.com` was attributed by
 * its last segment. A lenient parse deciding WHO YOU ARE and a different,
 * stricter one deciding WHERE THE PROOF GOES is the bug; one parse for both
 * is the fix.
 *
 * So: exactly one '@', a mailbox-grammar local part, and a domain of
 * letter-digit-hyphen labels with a real TLD. Nothing with a delimiter that
 * any two parsers could disagree about survives, and what comes back is the
 * canonical string to attribute, to mail and to store - all three the same.
 *
 * Deliberately NOT the full RFC 5321 grammar: quoted local parts
 * (`"a@b"@firm.com`), address literals (`a@[10.0.0.1]`), source routes
 * (`@a:b@c`) and bang paths are all legal somewhere and all exist only as
 * parser-disagreement shapes here, so they are refused rather than
 * interpreted. Non-ASCII is allowed through, since an internationalised
 * address at a real firm is a person we must not lock out.
 */
const MAILBOX_LOCAL = /^[a-z0-9¡-￿'#$&*+=?^_`{|}~-]+(?:\.[a-z0-9¡-￿'#$&*+=?^_`{|}~-]+)*$/;
const MAILBOX_DOMAIN_LABEL = /^[a-z0-9¡-￿](?:[a-z0-9¡-￿-]*[a-z0-9¡-￿])?$/;
const MAILBOX_TLD = /^[a-z¡-￿]{2,}$/;

export type Mailbox = { email: string; local: string; domain: string };

/** The canonical form of a single address, or null when it is not one. */
export function parseMailbox(raw: string | null | undefined): Mailbox | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 254) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !MAILBOX_LOCAL.test(local)) return null;
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => l.length <= 63 && MAILBOX_DOMAIN_LABEL.test(l))) return null;
  if (!MAILBOX_TLD.test(labels[labels.length - 1])) return null;
  return { email: `${local}@${domain}`, local, domain };
}

/**
 * Providers that deliver `a.b@` and `ab@` to ONE inbox, so for metering the
 * dots in a local part are not part of the address. The value is the name that
 * stands for the whole family.
 *
 * Deliberately a SHORT list, and conservative on purpose: being wrong in this
 * direction merges two real people's budgets. At nearly every mail host -
 * Outlook, Yahoo, iCloud, Fastmail, and every corporate Exchange a firm
 * account uses - `a.b@` and `ab@` are two different mailboxes, and stripping
 * dots there would let one person's requests exhaust a colleague's.
 *
 *   gmail.com, googlemail.com - Google documents that it ignores dots in the
 *     local part, and googlemail.com is its own alias for the same mailboxes,
 *     so both names and every dotting of one local part are one destination.
 *
 * Nothing goes on this list because a provider MIGHT behave this way; it goes
 * on because the provider says it does.
 */
const DOT_BLIND_DOMAINS: Record<string, string> = {
  "gmail.com": "gmail.com",
  "googlemail.com": "gmail.com",
};

/**
 * The one INBOX a typed address delivers to - for METERING ONLY.
 *
 * A per-destination limit keyed on the address as typed does not bound a
 * destination. `victim+1@gmail.com` through `victim+50@gmail.com` are fifty
 * different strings and one inbox, as are `v.ictim@gmail.com` and
 * `victim@gmail.com`, so a form holding five-codes-an-hour per address would
 * happily put fifty real codes in one person's inbox - and the reasoning that
 * the same bound caps how many codes can be LIVE for one mailbox (firm-auth
 * chargeCodeQuota, consumeCode) rests on it holding. So the meter's subject is
 * the destination, not the spelling: lowercased by parseMailbox, everything
 * from the first '+' dropped, and dots dropped in the local part only for the
 * providers above.
 *
 * ONLY the meter. What is mailed to, stored on users.email, and matched at
 * sign-in stays exactly what the person typed - two colleagues really can be
 * `a.b@` and `ab@` at a host that tells them apart, and an address canonical
 * form is not a credential.
 *
 * '+' stripping is unconditional because sub-addressing is the one convention
 * every major provider implements, and at a host that does not, `a+b@` is not
 * a deliverable address at all - so merging its budget costs nobody anything.
 */
export function canonicalMailbox(raw: string | null | undefined): string | null {
  const mailbox = parseMailbox(raw);
  if (!mailbox) return null;
  const family = DOT_BLIND_DOMAINS[mailbox.domain];
  const domain = family ?? mailbox.domain;
  const tag = mailbox.local.indexOf("+");
  let local = tag >= 0 ? mailbox.local.slice(0, tag) : mailbox.local;
  if (family) local = local.split(".").join("");
  // A local part that is nothing BUT a tag ('+only@host') leaves nothing to
  // key on; the parsed address is still one destination, so meter on that
  // rather than on the bare domain, which would be every mailbox at the host.
  return local ? `${local}@${domain}` : mailbox.email;
}

/**
 * The registrable domain of an email address, or null when it has none.
 * Parsed by parseMailbox, so this is the SAME reading of the string that the
 * code is mailed to - see the note above.
 */
export function emailRegistrableDomain(email: string): string | null {
  const mailbox = parseMailbox(email);
  if (!mailbox) return null;
  return registrableDomain(mailbox.domain);
}

export type WorkEmailVerdict =
  | { ok: true; domain: string }
  | { ok: false; reason: "invalid" | "personal" | "school" };

/**
 * Whether an address can belong to a firm at all, before we look for which.
 * Personal providers and school addresses never can: anyone can open one.
 */
export function checkWorkEmail(email: string): WorkEmailVerdict {
  const domain = emailRegistrableDomain(email.trim().toLowerCase());
  if (!domain) return { ok: false, reason: "invalid" };
  if (isFreemailDomain(domain)) return { ok: false, reason: "personal" };
  if (isEducationalDomain(domain)) return { ok: false, reason: "school" };
  return { ok: true, domain };
}

export const WORK_EMAIL_ERRORS: Record<"invalid" | "personal" | "school", string> = {
  invalid: "Enter a valid work email address.",
  personal: "Use your work email at the firm. Personal addresses (Gmail, Outlook and the like) can't be verified.",
  school: "Use your work email at the firm, not a school address.",
};

/**
 * Every domain that counts as this firm's own mail domain.
 *
 * The verified domain and the explicit aliases always count. The SEC-filed
 * website counts only when it is usable company evidence: the audit found
 * rows whose website is a LinkedIn page or a careers site, and taking
 * linkedin.com as a firm's mail domain would let anyone at LinkedIn claim it.
 */
export function firmMailDomains(firm: FirmDomainSource): string[] {
  const out = new Set<string>();
  for (const d of [firm.verifiedDomain, ...(firm.approvedEmailDomains ?? [])]) {
    const r = registrableDomain(d);
    if (r) out.add(r);
  }
  const site = classifyDomain(firm.website);
  if (site.usable) out.add(site.registrable);
  return [...out];
}

/**
 * The firms an email domain belongs to.
 *
 * Several firm rows can share one domain (SEC entities of one brand), so this
 * returns all of them; the caller picks one only when the answer is a single
 * firm, and leaves the choice to Offerly's approval otherwise.
 */
export function firmsForDomain<T extends FirmDomainSource>(domain: string, firms: T[]): T[] {
  return firms.filter((f) => firmMailDomains(f).includes(domain));
}

// ---------- who may do what ----------

export type FirmAccount = {
  id: string;
  accountType: string;
  orgApproved: boolean;
  orgFirmId: string | null;
  firmRole: string | null;
  isDemo?: boolean;
};

/** Signed in as an approved firm account, linked to a firm: may post. */
export function isActiveFirmAccount(user: FirmAccount): boolean {
  return user.accountType === "firm" && user.orgApproved && !!user.orgFirmId;
}

/** An approved firm's owner: may approve and remove teammates. */
export function isFirmOwner(user: FirmAccount): boolean {
  return isActiveFirmAccount(user) && user.firmRole === "owner";
}

/**
 * Whether this account may change a row that belongs to `firmId`.
 * Every write on the portal goes through this, so one firm can never touch
 * another firm's postings, events or people.
 */
export function canManageFirmRow(user: FirmAccount, rowFirmId: string | null | undefined): boolean {
  return isActiveFirmAccount(user) && !!rowFirmId && rowFirmId === user.orgFirmId;
}

/** Whether an owner may approve or remove this teammate. Never themselves. */
export function canManageTeammate(owner: FirmAccount, teammate: FirmAccount): boolean {
  return (
    isFirmOwner(owner) &&
    teammate.id !== owner.id &&
    teammate.accountType === "firm" &&
    teammate.orgFirmId === owner.orgFirmId
  );
}

/**
 * What a newly verified account becomes. The first account at a firm is its
 * owner-to-be and waits for Offerly; later ones are members and wait for the
 * owner. An address that matched no firm waits for Offerly to link one.
 */
export function roleForNewAccount(hasApprovedOwner: boolean): "owner" | "member" {
  return hasApprovedOwner ? "member" : "owner";
}

/** Code-attempt bookkeeping: whether this code can still be tried. */
export function codeIsUsable(
  row: { expiresAt: Date; attempts: number; consumedAt: Date | null },
  now: Date = new Date(),
): boolean {
  return !row.consumedAt && row.attempts < FIRM_CODE_MAX_ATTEMPTS && row.expiresAt.getTime() > now.getTime();
}
