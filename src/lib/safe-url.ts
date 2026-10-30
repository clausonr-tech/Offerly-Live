// Shared http(s)-only URL guard.
//
// Lived as a private helper in u/[id]/page.tsx for the LinkedIn field; the
// community feed needs the same guard for poster-supplied links, and a second
// copy is how the two drift apart. Anything not plainly http(s) is dropped
// rather than sanitised - `javascript:` and `data:` hrefs are the entire
// reason this exists, and there is no legitimate link it turns away.
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a value is one of OUR OWN paths, and only that.
 *
 * `//evil.example/x` is a protocol-relative URL to somebody else's site, not
 * a path on ours, and is the reason this is not a `startsWith("/")`. Testing
 * for `//` alone was not enough either (security review, 10 October 2026):
 *
 *   - the WHATWG URL parser treats `\` exactly like `/` for a special scheme,
 *     so `/\evil.example/x` in an href navigates to evil.example;
 *   - it STRIPS tab, CR and LF from anywhere in a URL before parsing, so
 *     `/<TAB>/evil.example` is parsed as `//evil.example` - a value that
 *     contains no `//` at all until the browser removes a character from it.
 *
 * So the second character has to be neither slash, and a control character
 * anywhere is refused outright rather than reasoned about: nothing in a path
 * we emit has one, and the whole class of "the parser sees a different string
 * than the check did" goes with it.
 */
function inAppPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  // C0, DEL and C1. JS `trim` removes none of them; URL parsing removes some
  // of them and keeps others, which is the gap being closed.
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * An href, for a value that may legitimately be one of OUR OWN paths.
 *
 * Some stored link columns hold either an external page or an in-app route -
 * `firm_recruiting_events.event_url` is the firm's RSVP page for a crawled
 * row and `/api/firm-events/<id>/open` for a firm-posted one - so a plain
 * external-URL check would drop half of them.
 *
 * Kept as the name the read boundary grew up with; `externalHref` below is
 * the same policy and the one new code should reach for.
 */
export function safeLinkUrl(raw: string | null | undefined): string | undefined {
  return externalHref(raw);
}

/**
 * Hosts that are not somewhere a student's browser should be sent.
 *
 * `safeHttpUrl` answers "is this a web link". This answers the separate
 * question the crawler needs: "is this a web link to a PUBLIC site". A careers
 * page we do not control supplies these strings, and `http://127.0.0.1:9200/`
 * and `http://169.254.169.254/latest/meta-data/` are both perfectly good
 * http URLs.
 *
 * Address ranges are NOT re-implemented here - lib/monitoring/safe-fetch.ts
 * owns that, with the IANA table and the DNS pinning, and is the thing to use
 * when something is about to be FETCHED. This is the cheap syntactic cousin
 * for values that are about to be STORED or RENDERED, where there is no
 * network round trip to spend and no name to resolve.
 */
const PRIVATE_SUFFIX = /\.(local|localhost|internal|localdomain|home\.arpa|onion)$/i;

/** The ports a job board or a firm's site lives on. Same list as
 *  safe-fetch's WEB_PORTS, kept separately because this file is imported by
 *  client components and that one is server-only. */
const WEB_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/**
 * An http(s) URL on a host a student can be sent to, or null.
 *
 * THE WRITE AND RENDER RULE for anything a crawler or a third-party provider
 * produced. Four things are refused beyond `safeHttpUrl`'s scheme check:
 *
 *   - CREDENTIALS IN THE URL. `https://greenhouse.io@attacker.example/x`
 *     reads as Greenhouse and goes to attacker.example. There is no honest
 *     job board that needs userinfo, and it exists in the wild only to make a
 *     link look like somewhere it is not.
 *   - A BARE ADDRESS. 127.0.0.1, 169.254.169.254, a bracketed v6 literal: a
 *     real careers page has a name.
 *   - A SINGLE-LABEL OR PRIVATE-SUFFIX NAME. `localhost`, `intranet`,
 *     `jenkins.internal` - reachable from inside, meaningless to a student.
 *   - AN ODD PORT. A board does not live on 22 or 6379, and restricting to
 *     the web ports removes a whole class of internal-service probing.
 *
 * WHAT THIS IS NOT
 * ----------------
 * A SYNTACTIC filter. It judges the SHAPE of a name and cannot see where that
 * name resolves, so it is not a claim that the address is public: the
 * wildcard-DNS services exist precisely to defeat a shape test, and
 * `127.0.0.1.nip.io`, `127-0-0-1.sslip.io` and `localtest.me` all resolve to
 * loopback while passing every test here (the all-digit-label rule below
 * catches the first shape and nothing catches the other two). Anything about
 * to be FETCHED must go through lib/monitoring/safe-fetch.ts, which resolves
 * the name and checks the addresses inside the lookup the socket uses. This is
 * the cheap cousin for values about to be STORED or RENDERED, where there is
 * no round trip to spend (security review, 10 October 2026).
 *
 * Returns the normalised URL so the stored value is the one that was judged.
 */
export function publicHttpUrl(raw: string | null | undefined): string | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const u = new URL(safe);

  if (u.username || u.password) return null;
  if (!WEB_PORTS.has(u.port)) return null;

  // One trailing dot is a fully-qualified name, not a malformed one:
  // `careers.example.com.` and `careers.example.com` are the same host, and
  // every rule below is written for the spelling without it. Normalised onto
  // the URL as well, so the value returned is the value judged.
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".") && !host.endsWith("..")) {
    host = host.slice(0, -1);
    u.hostname = host;
  }

  // A bracketed IPv6 literal, or a dotted quad. Judged by shape, not by
  // range - the range check is safe-fetch's job and needs a resolver.
  if (host.startsWith("[") || /^\d+(\.\d+)*$/.test(host)) return null;
  if (!host.includes(".")) return null;
  if (PRIVATE_SUFFIX.test(host)) return null;
  /**
   * The last label is letters, or an A-label.
   *
   * `host.1` and `example.123` are addresses spelled badly. But an
   * internationalised top-level domain is spelled `xn--p1ai` in a URL - the
   * punycode A-label - and the old letters-only rule turned away every one of
   * them, which drops a legitimate posting on an IDN whole rather than
   * judging it.
   */
  if (!/\.(?:[a-z]{2,}|xn--[a-z0-9-]{1,59})$/i.test(host)) return null;
  /**
   * No label is all digits.
   *
   * `127.0.0.1.nip.io` is a real name on a real TLD that resolves to
   * loopback, and it passes every rule above. A label that is nothing but
   * digits is how an address is smuggled into a name, and no careers host the
   * crawl has met has one. See WHAT THIS IS NOT: this closes one shape, not
   * the class.
   */
  if (host.split(".").some((label) => /^\d+$/.test(label))) return null;

  return u.toString();
}

/**
 * THE READ-BOUNDARY HELPER: a stored string, as an href, or nothing.
 *
 * Every student-facing component that renders a crawled or provider-supplied
 * link calls this one function. It used to be `safeHttpUrl`, which checks the
 * scheme and nothing else - so the render boundary accepted
 * `https://greenhouse.io@attacker.example/x`, `http://10.0.0.5:8080/x`,
 * `http://169.254.169.254/latest/` and `http://jenkins.internal/x`, every one
 * of which the WRITE boundary refuses. Those components describe themselves
 * as the backstop for "a row stored before that rule existed", and those rows
 * are exactly the ones worth stopping, so the backstop now enforces the same
 * rule it backstops (security review, 10 October 2026).
 *
 * One function rather than eleven call sites each re-deriving the policy,
 * because eleven is how the two boundaries drifted apart in the first place.
 * `publicHttpUrl` is client-safe - it owns no address table and resolves no
 * name, see its own comment - so a client component may call this.
 *
 * An in-app path is passed through, because some columns hold one
 * (`/api/firm-events/<id>/open`). Returns undefined rather than null so it
 * can be spread straight into `href`: an <a> with no href is not a link,
 * which is the fallback wanted here.
 */
/**
 * A listing's own address, resolved against the board it was found on.
 *
 * WHY THIS EXISTS. Measured 12 October 2026: 3,488 stored listings carry a
 * `listing_url` like `/careers/job/859023561218` - non-empty, non-null, and
 * useless the moment it leaves the board it came from. All but four come from
 * one connector, `eightfold`, whose API returns `positionUrl` as a path and
 * which passed it straight through. Published, each one is a dead link in
 * front of a student, so `posting-quality.ts` grew an absolute-URL check to
 * withhold them - which withholds the real listing along with the broken
 * address. This is the fix at the source that the gate's comment asks for.
 *
 * Resolution is against the BOARD's URL, which is what a browser does with an
 * href and what the generic connector already gets for free from
 * `anchor.href`.
 *
 * Validated after resolving, not before: `javascript:void(0)` resolves to
 * itself and is not an address anyone can open, and nor is a `mailto:` or a
 * data URI. Those are page furniture - a filter control, a contact link - so
 * they come back null rather than being handed on as a string that merely
 * looks populated. `publicHttpUrl` then applies every rule it already
 * enforces for a URL a student may be sent to.
 */
export function resolvedPublicHttpUrl(
  raw: string | null | undefined,
  base: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A fragment is not an address. `#` resolves to the board index plus a hash:
  // a URL that passes every check below and takes a student to the page they
  // were already looking at.
  if (trimmed.startsWith("#")) return null;

  /**
   * A RELATIVE ADDRESS MAY NOT LEAVE THE BOARD'S OWN HOST.
   *
   * `//evil.example/apply` is protocol-relative, and resolving it against an
   * https base yields `https://evil.example/apply` - well-formed, public, and
   * not this firm's. `/\evil.example/apply` does the same, a trick this very
   * file already documents in `inAppPath` as a 10 October 2026 security-review
   * finding.
   *
   * The harm is at the PUBLISH boundary rather than the fetch one. A crawled
   * `positionUrl` of that shape used to be withheld - `hasPublishableUrls` ran
   * `publicHttpUrl` on the raw relative string and `new URL` threw - so
   * resolving it first is what would turn it into a working external "Apply"
   * link shown to a student under the firm's name.
   *
   * An input that already carries its own scheme may legitimately name another
   * host: an ATS lives on its own domain, which is the normal case for every
   * board this crawler reads. So the rule binds relative inputs only.
   */
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);

  let resolved = trimmed;
  if (base) {
    try {
      const url = new URL(trimmed, base);
      if (!isAbsolute && url.origin !== new URL(base).origin) return null;
      resolved = url.toString();
    } catch {
      // An unparseable pair is not an address. Fall through to the validator
      // with the raw value, which rejects it for the same reason.
      resolved = trimmed;
    }
  } else if (!isAbsolute) {
    // No base and no scheme: nothing to resolve against, so nothing openable.
    return null;
  }
  return publicHttpUrl(resolved);
}

export function externalHref(raw: string | null | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (t.startsWith("/")) return inAppPath(t) ? t : undefined;
  return publicHttpUrl(t) ?? undefined;
}

// Same rule, but tolerant of a poster typing "example.com/apply" with no
// scheme - which is what people actually paste into a form field. Returns null
// for anything that still isn't http(s) after that.
export function normaliseHttpUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  // Only prepend a scheme when there is no scheme at all. Prepending to
  // "javascript:alert(1)" would turn a rejected value into an accepted one.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`;
  return safeHttpUrl(candidate);
}
