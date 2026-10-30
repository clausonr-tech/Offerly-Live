// Where the Apply and RSVP links on a firm's posts may send a student. Pure,
// so the rules are tested (scripts/test/firm-links.test.ts); the two redirect
// routes under /api apply them.
//
// Only an http(s) page or a mailto: ever leaves Offerly. A stored row that
// somehow holds javascript:, data: or a relative path is refused - the
// redirect routes are open to anyone with a link, and must never become a way
// to run script or bounce a student somewhere the firm did not choose.

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The Apply button: the application page, else an email to the posting's contact, else nowhere. */
export function applyDestination(applicationUrl: string | null | undefined, recruiterEmail: string | null | undefined): string | null {
  const url = httpUrl(applicationUrl);
  if (url) return url;
  const email = recruiterEmail?.trim();
  if (email && EMAIL_RE.test(email)) return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
  return null;
}

/** An event's link: the firm's RSVP page, else the firm's own page on Offerly. */
export function eventDestination(rsvpUrl: string | null | undefined, firmSlug: string): string {
  return httpUrl(rsvpUrl) ?? `/discovery/firm/${encodeURIComponent(firmSlug)}`;
}

/** A posting or event id as the routes accept it. Anything else is not looked up at all. */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
