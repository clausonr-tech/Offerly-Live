/**
 * Reading Form ADV Part 1A, and turning it into a domain index.
 *
 * Pure. No filesystem, no network, no `server-only` - so the ingest script,
 * the runtime lookup and the test suite all read the SAME parser rather than
 * three copies of it that drift. `domainOf` was previously duplicated
 * verbatim in two files, which is exactly the shape of bug this module
 * exists to prevent: the join is BY DOMAIN, so two normalisers that disagree
 * by one character silently un-size a firm.
 *
 * Everything here is driven by fixtures in scripts/test/fixtures, which are
 * committed. Nothing in this module needs the 22,000-firm extract to be
 * tested, and nothing in it may be tested only against that extract.
 */

export type FirmSize = {
  crd: string | null;
  name: string;
  employees: number | null;
  /** Whole dollars. ZERO IS A REAL ANSWER - a pure advisory firm manages
   *  nothing, and reading that as "unknown" would float it over a size floor
   *  it should fail. */
  aum: number | null;
  state: string | null;
};

export type AdvFirm = FirmSize & { domain: string | null };

export type AdvFile = { generatedAt: string; feed: string; firms: AdvFirm[] };

/** Host only, lowercased, no `www.` - the normalisation BOTH sides of the
 *  match go through, so "HTTP://WWW.EXAMPLE.COM/" and "https://example.com"
 *  agree. The single copy; do not inline another. */
export function domainOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let value = rawUrl.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Hosts that are somebody's PRESENCE, not their website.
 *
 * Form ADV Item 1.I asks for website addresses and filers list social media
 * alongside their own domain - so the first <WebAddr> in a block is often not
 * the firm at all. Measured on the real feed: Blackstone Real Estate Advisors
 * came back as apple.co, Blue Owl Real Estate as linkedin.com, StepStone Group
 * Real Estate as vimeo.com, TPG Real Estate as instagram.com.
 *
 * Left unfixed this is worse than a missing website. Every firm whose first
 * entry is linkedin.com collapses onto one key, so the domain index silently
 * maps a shared social host to whichever firm happened to be parsed first -
 * and any directory row pointing there would be sized as that firm.
 */
export const NOT_A_FIRM_SITE: ReadonlySet<string> = new Set([
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "soundcloud.com",
  "tiktok.com",
  "apple.co",
  "apps.apple.com",
  "itunes.apple.com",
  "play.google.com",
  "medium.com",
  "substack.com",
  "linktr.ee",
  "crunchbase.com",
  "bloomberg.com",
  "sec.gov",
  "adviserinfo.sec.gov",
  "brokercheck.finra.org",
  "wikipedia.org",
  "google.com",
  "sites.google.com",
  // Podcast and content platforms - the same problem as social media, found
  // the same way: Blackstone Real Estate Advisors files blackstone.podbean.com
  // and FS REIT Advisor files open.spotify.com as their "website".
  "podbean.com",
  "spotify.com",
  "buzzsprout.com",
  "libsyn.com",
  "anchor.fm",
  "qq.com",
  "weixin.qq.com",
  "issuu.com",
  "slideshare.net",
]);

/**
 * Whether a host is a platform rather than a firm.
 *
 * Subdomains count: `ch.linkedin.com` is the Swiss LinkedIn, not a Swiss
 * firm, and it is in the directory today because nothing checked.
 */
export function isNotAFirmSite(domain: string | null): boolean {
  if (!domain) return false;
  if (NOT_A_FIRM_SITE.has(domain)) return true;
  return [...NOT_A_FIRM_SITE].some((host) => domain.endsWith(`.${host}`));
}

/**
 * The firm's own website: the first listed address that is not a social or
 * directory host. Null when every address a filer gave is somebody else's
 * platform, which is a real and common answer for small advisers.
 *
 * NOTE what this deliberately does NOT reject: a careers subdomain, an ATS
 * host, or a shared parent-company domain. All three are legitimate answers
 * to "what is your website" and Form ADV is not where that distinction gets
 * made - `classifyDomain` in lib/company-domains.ts is, at the point an
 * email domain is about to be trusted. Rejecting them here would lose the
 * firm's SIZE as well, which is the only thing this file is for.
 */
export function pickFirmWebsite(block: string): string | null {
  const addresses = [...block.matchAll(/<WebAddr>([^<]+)<\/WebAddr>/g)].map((m) => m[1]);
  for (const address of addresses) {
    const domain = domainOf(address);
    if (!domain) continue;
    if (isNotAFirmSite(domain)) continue;
    return address;
  }
  return null;
}

/**
 * The five XML entities, decoded.
 *
 * The feed is XML, so "Cain Brothers & Company, LLC" is filed as
 * "Cain Brothers &amp; Company, LLC" - and reading attributes with a regex
 * skips the step an XML parser would have done. Found by the committed
 * fixture: the firm was in the file under a name no human would search for.
 *
 * Names are display and audit only - the join is by domain - so this changes
 * nothing about which firm matches which, only what it is called.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Last, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/g, "&");
}

function attr(block: string, tag: string, name: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(block);
  return match ? decodeEntities(match[1]) : null;
}

function intAttr(block: string, tag: string, name: string): number | null {
  const raw = attr(block, tag, name);
  if (raw === null || raw === "") return null;
  const value = Number(raw.replace(/[^0-9-]/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function parseFirmBlock(block: string): AdvFirm | null {
  const name = attr(block, "Info", "BusNm") ?? attr(block, "Info", "LegalNm");
  if (!name) return null;

  const website = pickFirmWebsite(block);

  return {
    crd: attr(block, "Info", "FirmCrdNb"),
    name,
    domain: domainOf(website),
    state: attr(block, "MainAddr", "State"),
    // Item 5A: total employees.
    employees: intAttr(block, "Item5A", "TtlEmp"),
    /**
     * Item 5F Q5F2C: total regulatory assets under management, in whole
     * dollars. Not Q5F2A (discretionary) or Q5F2B (non-discretionary) alone -
     * C is their sum and the number everyone means by "AUM".
     *
     * Zero is a real answer here and must not become null: a pure advisory
     * firm that manages nothing is small, and treating that as "unknown"
     * would let it through a size floor it should fail.
     */
    aum: intAttr(block, "Item5F", "Q5F2C"),
  };
}

/**
 * Every firm in a feed document.
 *
 * Split rather than parse: this is attribute-only XML with one repeated
 * element, and adding an XML parser dependency to read six attributes would
 * be the larger change.
 */
export function parseFirmBlocks(xml: string): AdvFirm[] {
  const firms: AdvFirm[] = [];
  for (const chunk of xml.split("<Firm>")) {
    const end = chunk.indexOf("</Firm>");
    if (end === -1) continue;
    const firm = parseFirmBlock(chunk.slice(0, end));
    if (firm) firms.push(firm);
  }
  return firms;
}

/**
 * Domain -> size.
 *
 * FIRST WRITER WINS, deliberately and consistently with the ingest script.
 * Two firms sharing a domain is not an error in the feed - KeyCorp, KeyBank
 * and Cain Brothers all file key.com - so there is no correct single answer
 * and the only thing that matters is that the runtime lookup and the ingest
 * report agree on which one they picked. A "last wins" index would size a
 * directory row differently depending on feed ordering.
 *
 * Returns the collisions too, so an audit can say how many there were rather
 * than having to re-derive them.
 */
export function indexByDomain(firms: readonly AdvFirm[]): {
  index: Map<string, FirmSize>;
  collisions: { domain: string; kept: string; dropped: string }[];
} {
  const index = new Map<string, FirmSize>();
  const collisions: { domain: string; kept: string; dropped: string }[] = [];
  for (const firm of firms) {
    if (!firm.domain) continue;
    const held = index.get(firm.domain);
    if (held) {
      collisions.push({ domain: firm.domain, kept: held.name, dropped: firm.name });
      continue;
    }
    index.set(firm.domain, {
      crd: firm.crd,
      name: firm.name,
      employees: firm.employees,
      aum: firm.aum,
      state: firm.state,
    });
  }
  return { index, collisions };
}

/** The lookup itself, against any index. The runtime wrapper in form-adv.ts
 *  is this function plus a cached file read. */
export function sizeIn(
  index: ReadonlyMap<string, FirmSize>,
  website: string | null | undefined,
): FirmSize | null {
  const domain = domainOf(website);
  if (!domain) return null;
  return index.get(domain) ?? null;
}
