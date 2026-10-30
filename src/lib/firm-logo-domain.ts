/**
 * Which host a firm's logo belongs to.
 *
 * One definition shared by the logo component, /api/crest and
 * scripts/find-firm-logos.ts, so the domain the harvester looked up is the
 * domain the page asks for.
 */

/**
 * Careers sites are not the firm.
 *
 * `website` was collected to link students to job postings, so a fifth of the
 * curated firms carry a value like `careers.bankofamerica.com` or
 * `jobs.citi.com`. Those hosts have their own favicons - often a generic ATS
 * mark, often nothing - so the logo is wrong or missing through no fault of
 * the sources.
 *
 * Only prefixes that are unambiguously a careers host are stripped. Nothing
 * here guesses at a different company: `jpmorganchase.com` is left alone even
 * though `jpmorgan.com` is the better answer, because that is a judgement
 * about corporate structure and belongs in the firm data.
 */
const CAREERS_PREFIXES = [
  "careers.",
  "jobs.",
  "job.",
  "search.jobs.",
  "apply.",
  "campus.",
  "recruiting.",
  "talent.",
  "students.",
  "university.",
  "join.",
  "work.",
  "early.",
];

/**
 * Hosts that belong to somebody else entirely.
 *
 * Thirteen SEC filings give a LinkedIn page as the firm's website and three a
 * Facebook page, and every logo service answers those with LinkedIn's or
 * Facebook's own mark - the firm shown as a social network. Site builders and
 * applicant-tracking systems are the same problem one step removed. For these
 * there is no logo to find, and the letter tile is the honest answer.
 */
const NOT_THE_FIRM = new Set([
  "linkedin.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "google.com",
  "sites.google.com",
  "wixsite.com",
  "squarespace.com",
  "wordpress.com",
  "godaddysites.com",
  "weebly.com",
  "myworkdayjobs.com",
  "greenhouse.io",
  "lever.co",
  "icims.com",
  "taleo.net",
  "smartrecruiters.com",
  "bamboohr.com",
  "adp.com",
  "sec.gov",
  "finra.org",
  "brokercheck.finra.org",
  "adviserinfo.sec.gov",
]);

/** Second-level labels that are a public suffix, not a company: co.uk, com.au. */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ltd", "plc", "or", "ne"]);

/** The part of a host a company actually registers: `careers.gs.com` -> `gs.com`, `x.co.uk` stays. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const take = tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(sld) ? 3 : 2;
  return parts.slice(-take).join(".");
}

/**
 * The host to look a firm's logo up by, or "" when its website cannot have
 * one (a social profile, a site builder, nothing filed).
 */
export function logoDomain(raw: string | null | undefined): string {
  let d = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    // Trailing punctuation from hand-entered data ("example.com," in an SEC
    // filing): a domain can only end in a letter or digit, so this never eats
    // part of a real one.
    .replace(/[^a-z0-9]+$/, "")
    .replace(/^www\./, "");
  for (const prefix of CAREERS_PREFIXES) {
    if (!d.startsWith(prefix)) continue;
    const rest = d.slice(prefix.length);
    // Only if what is left is still a domain. "search.jobs.barclays" strips to
    // the bare label "barclays", which is not a host - and asking a logo
    // service for a bare word returns SOMEBODY's logo, just not this firm's.
    if (rest.includes(".")) d = rest;
    break;
  }
  if (!d.includes(".")) return "";
  if (NOT_THE_FIRM.has(d) || NOT_THE_FIRM.has(registrableDomain(d))) return "";
  return d;
}
