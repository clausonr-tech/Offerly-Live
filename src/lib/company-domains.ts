/**
 * Which domains may stand as evidence about a company, and which may not.
 *
 * Two separate jobs, and they are not the same question:
 *
 *   - Is this domain USABLE as company identity or email evidence?
 *   - Do two domains refer to the same organisation?
 *
 * Both answered on the REGISTRABLE domain (eTLD+1), never on the raw host,
 * because the audit found the exact failure a raw-host blocklist produces:
 * scripts/ingest-form-adv.ts already blocks "linkedin.com" by exact match, and
 * thirteen firms still arrived carrying `ch.linkedin.com`, `br.linkedin.com`
 * and `ca.linkedin.com`. The country subdomain walked straight past a list
 * that only knew the bare host.
 *
 * Matching on eTLD+1 fixes the mirror-image bug at the same time. The old
 * substring test for ATS hosts flagged "Greenhouse Funds Lllp"
 * (greenhousefunds.com) and "Greenhouse Wealth Management" as applicant
 * tracking systems, because their names contain the word. greenhousefunds.com
 * and greenhouse.io are simply different registrable domains, so an exact
 * comparison never confuses them.
 *
 * Pure, no network, no database - so the rules can be tested directly.
 */

/**
 * Suffixes that are themselves public, where the registrable domain is one
 * label deeper than the last dot.
 *
 * Not the full Public Suffix List, deliberately: that is a 15,000-line
 * dependency that changes monthly, and this list only has to cover the shapes
 * a finance directory actually contains. Anything missing degrades to
 * "last two labels", which is correct for .com/.io/.net and for brand TLDs
 * like `home.barclays` - the case the audit says must keep working.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.cn", "com.tw",
  "co.in", "co.za", "co.nz", "co.kr", "co.il",
  "com.tr", "com.my", "com.ph", "com.vn", "com.sa", "com.eg",
  "org.nz", "govt.nz", "ac.nz",
  "edu.sg", "gov.sg", "org.sg",
]);

/** Lowercased host with scheme, credentials, port, path and `www.` removed. */
export function normaliseHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return null;

  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");

  // A bare label is not a domain. The audit found none, and one would be a
  // parsing accident rather than a firm's website.
  if (!host.includes(".") || /\s/.test(host)) return null;
  return host;
}

/** eTLD+1. `careers.db.com` -> `db.com`; `home.barclays` -> `home.barclays`. */
export function registrableDomain(value: string | null | undefined): string | null {
  const host = normaliseHost(value);
  if (!host) return null;

  const labels = host.split(".");
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join(".");
  // A brand TLD like `.barclays` has no public suffix below it, so the last
  // two labels ARE the registrable domain and home.barclays survives intact.
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Same organisation, by registrable domain. Never a substring comparison. */
export function sameRegistrableDomain(a: string | null, b: string | null): boolean {
  const x = registrableDomain(a);
  const y = registrableDomain(b);
  return Boolean(x && y && x === y);
}

/** Somebody's presence, not their website. Matched on eTLD+1. */
const SOCIAL = new Set([
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "fb.com",
  "instagram.com", "youtube.com", "youtu.be", "vimeo.com", "soundcloud.com",
  "tiktok.com", "medium.com", "substack.com", "apple.co", "apple.com",
  // Lumesse TalentLink. Evercore's provider record files tal.net alongside
  // evercore.com, and taking it as the corporate domain would have seeded
  // every Evercore email pattern from an applicant tracking system.

  // google.com earns its place from the real failure this guards against:
  // asked for "Citigroup" by name, the provider returned an entity called
  // Citigroup whose domains were google.com and gmail.com. Without the search
  // engine itself on the list, that candidate kept one "usable" domain and
  // survived disqualification.
  "google.com", "play.google.com", "bing.com", "yahoo.com",
  "crunchbase.com", "wikipedia.org", "bloomberg.com", "pitchbook.com",
]);

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com",
  "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "protonmail.com", "proton.me", "gmx.com", "mail.com", "zoho.com",
]);

/** Applicant tracking systems. A board is not the firm that posts to it. */
const ATS = new Set([
  "myworkdayjobs.com", "myworkdaysite.com", "workday.com", "wd1.myworkdayjobs.com",
  "greenhouse.io", "boards.greenhouse.io", "lever.co", "icims.com", "taleo.net",
  "avature.net", "workable.com", "smartrecruiters.com", "jobvite.com",
  "bamboohr.com", "ashbyhq.com", "breezy.hr", "recruitee.com", "teamtailor.com",
  "tal.net", "lumesse.com", "eu.lumesse.com",
  "successfactors.com", "oraclecloud.com", "brassring.com", "jobs.net",
  "indeed.com", "glassdoor.com", "ziprecruiter.com", "handshake.com", "joinhandshake.com",
]);

/**
 * Subdomain labels that mean "the recruiting site", not "the company".
 *
 * `careers.db.com` is not Deutsche Bank's corporate domain: nobody's work
 * address is @careers.db.com, and it must never seed an email pattern. Twelve
 * of these are in the directory today.
 *
 * Only ever consulted as a PREFIX. A firm whose registrable domain happens to
 * be `jobs.com` is not a careers page.
 */
const RECRUITING_LABELS = new Set([
  "careers", "career", "jobs", "job", "recruiting", "recruitment", "recruit",
  "apply", "applications", "talent", "hiring", "hire", "workwithus", "joinus",
  "campus", "students", "university",
]);

type DomainRejection =
  | "malformed"
  | "social"
  | "freemail"
  | "ats"
  | "recruiting_subdomain";

export type DomainVerdict =
  | { usable: true; host: string; registrable: string }
  | { usable: false; reason: DomainRejection; host: string | null };

/**
 * Whether a domain may be used as company-identity or email evidence.
 *
 * Rejecting is NOT the same as deleting. The SEC-filed `firms.website` stays
 * exactly as filed - it is source data, and the audit was explicit that it
 * must be preserved. This only decides whether that value is allowed to
 * become evidence.
 */
export function classifyDomain(value: string | null | undefined): DomainVerdict {
  const host = normaliseHost(value);
  if (!host) return { usable: false, reason: "malformed", host: null };

  const registrable = registrableDomain(host);
  if (!registrable) return { usable: false, reason: "malformed", host };

  if (SOCIAL.has(registrable)) return { usable: false, reason: "social", host };
  if (FREEMAIL.has(registrable)) return { usable: false, reason: "freemail", host };
  if (ATS.has(registrable) || ATS.has(host)) return { usable: false, reason: "ats", host };

  // Everything left of the registrable domain. `careers.db.com` -> ["careers"].
  const prefix = host.slice(0, Math.max(0, host.length - registrable.length - 1));
  if (prefix) {
    const labels = prefix.split(".");
    if (labels.some((l) => RECRUITING_LABELS.has(l))) {
      return { usable: false, reason: "recruiting_subdomain", host };
    }
  }

  return { usable: true, host, registrable };
}

export function isUsableCompanyDomain(value: string | null | undefined): boolean {
  return classifyDomain(value).usable;
}

/** A mailbox provider, not an employer. */
export function isFreemailDomain(value: string | null | undefined): boolean {
  const r = registrableDomain(value);
  return Boolean(r && FREEMAIL.has(r));
}

/**
 * A school, not an employer.
 *
 * Suffix-aware rather than an `.edu` equality test: the directory already
 * holds `clausonr@wharton.upenn.edu` filed as a Goldman Sachs business
 * address, and university mail lives under `.ac.uk`, `.edu.au` and
 * `.edu.sg` too.
 */
export function isEducationalDomain(value: string | null | undefined): boolean {
  const host = normaliseHost(value);
  if (!host) return false;
  return /(^|\.)(edu|ac)$/.test(host) || /\.(edu|ac)\.[a-z]{2}$/.test(host) || host.endsWith(".edu");
}
