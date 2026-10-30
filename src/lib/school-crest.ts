// A student's school crest, resolved from the school's own mail domain.
//
// There is no crest column and there is no upload: the `schools` allowlist
// already stores the domain the school issues student addresses from, and the
// same favicon service the firm rolodex uses returns a school's real crest for
// that domain at a usable size. So a crest costs no storage, no moderation and
// no upload flow - picking a school IS picking the picture.
//
// Not `server-only`: the resolved domain is handed to a client component, and
// this module holds no database access.

/** Which school to draw for a user, verified affiliation first.
 *
 *  `schoolId` is set only by email verification and `claimedSchoolId` only by
 *  the student picking from a list, so the order here is the trust order. The
 *  distinction is preserved rather than collapsed because a crest on a
 *  verified account is a stronger claim than one on a self-reported account,
 *  and callers may want to say so.
 */
export function resolveSchoolCrest(row: {
  verifiedDomain?: string | null;
  verifiedName?: string | null;
  claimedDomain?: string | null;
  claimedName?: string | null;
}): { domain: string; name: string; verified: boolean } | null {
  if (row.verifiedDomain && row.verifiedName) {
    return { domain: row.verifiedDomain, name: row.verifiedName, verified: true };
  }
  if (row.claimedDomain && row.claimedName) {
    return { domain: row.claimedDomain, name: row.claimedName, verified: false };
  }
  return null;
}

/** Asks for a large source image regardless of display size - the service
 *  returns the site's real logo rather than a 16px favicon when it can, and
 *  only at the larger sizes. */
export function crestUrl(domain: string, size = 256): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
