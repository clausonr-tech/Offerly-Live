import "server-only";

/**
 * Is this host the vendor, or a subdomain of it?
 *
 * WHY THIS IS A FILE
 * ------------------
 * Because the same mistake has now been made eight times in this repository,
 * and writing it correctly in one place is the only version of the fix that
 * stays fixed.
 *
 * The mistake is `hostname.endsWith("greenhouse.io")`. It is true for
 * `evilgreenhouse.io`, and `greenhouse.io.attacker.net` slips past a naive
 * check too. Found on 19 September in greenhouse.ts, workday.ts and
 * talentlink.ts, and then in five more places in board-url.ts - Workday,
 * Greenhouse, TalentLink, Lever and Avature.
 *
 * It is not a cosmetic bug. The host check decides which parser claims a URL,
 * and the parsers then take a path segment as a board token: Greenhouse read
 * the first segment of `evilgreenhouse.io/acme` as a board id and queried the
 * REAL Greenhouse API with it, returning another company's postings filed
 * under this firm. board-url.ts is worse again, because it REWRITES the URL -
 * `evillever.co/whatever` normalised to `jobs.lever.co/whatever`, turning a
 * lookalike domain into a real board address chosen by whoever owned the
 * lookalike.
 *
 * The newer connectors each grew their own correct check with its own comment
 * explaining the trap. That is three copies of one rule, which is two too
 * many.
 */
export function isHostOrSubdomainOf(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const suffix = domain.toLowerCase().replace(/^\.|\.$/g, "");
  if (!host || !suffix) return false;
  // The dot boundary is the whole point: `evilgreenhouse.io` ends with
  // `greenhouse.io` and is not a subdomain of it.
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** The first matching vendor domain, or null. Convenience for call sites that
 *  test several vendors in a row. */
export function vendorFor(hostname: string, domains: readonly string[]): string | null {
  return domains.find((d) => isHostOrSubdomainOf(hostname, d)) ?? null;
}
