/**
 * The link that puts a student in front of an application form.
 *
 * Measured on 21 September 2026: 861 of 879 published postings had
 * `application_url` byte-identical to `source_url`, so "Apply" dropped the
 * student on the job advert and left them to find the button. The cause is
 * not the promotion path, which carries the value through correctly - it is
 * that most connectors set both fields from the same string:
 *
 *   greenhouse.ts   applicationUrl: job.absolute_url    (= listingUrl)
 *   workday.ts      applicationUrl: listingUrl
 *   generic.ts      applicationUrl: url                 (= listingUrl)
 *
 * Two of them already do the right thing - lever.ts uses `p.applyUrl` and
 * ashby.ts uses `job.applyUrl` when the API hands one over. That is the rule
 * this module generalises: prefer what the source states, and only fall back
 * to deriving one from the URL's shape.
 *
 * WHY DERIVING IS SAFE HERE
 * -------------------------
 * Guessing a URL is normally a bad idea, and it is tolerable in this one
 * case because a guess is never trusted on its own: every derived candidate
 * is fetched before it is stored (scripts/fix-apply-urls.ts), and one that
 * does not resolve is discarded in favour of the listing URL. So a pattern
 * that is wrong for some tenant costs a redirect check, not a broken link.
 *
 * WHERE THERE IS NOTHING TO DERIVE
 * --------------------------------
 * On Workday, iCIMS and Greenhouse the form is rendered ON the advert - there
 * is no deeper page to reach. Greenhouse at least names the anchor, so the
 * student lands on the form rather than the top of the page; the other two
 * are left alone deliberately. A connector with nothing better to offer
 * returns the listing URL, which is the honest answer, not a failure.
 *
 * WORKDAY, AND WHY IT IS NOT HERE
 * -------------------------------
 * Appending /apply to a Workday job url was tried and measured: it answers
 * 200 and then REDIRECTS STRAIGHT BACK to the advert. Following one to the
 * end lands on .../job/London/XMLNAME-2027-Summer-Analyst with no /apply in
 * sight. Storing it would have recorded 117 "repairs" that move nobody a
 * step closer to a form. A rule that cannot be shown to help is worse than
 * no rule, because it spends the reader's trust.
 *
 * TalentLink was checked the same way and passes for the opposite reason:
 * the final url is .../opp/22099/apply?instant=apply and the page it returns
 * differs from the advert (37,492 bytes against 41,749). The server does the
 * work; the parameter is real.
 */

import { publicHttpUrl } from "@/lib/safe-url";

export type ApplyCandidate = {
  /** The URL to try. */
  url: string;
  /** Which board's rule produced it - carried so the fixer can report per-ATS hit rates. */
  ats: string;
};

type Rule = {
  ats: string;
  /** Matches the LISTING url. */
  test: RegExp;
  build: (url: URL) => string | null;
};

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * Ordered, and specific before general.
 *
 * Each rule says how confident it is, because the confidence decides how much
 * the verification step is doing: a documented path that simply needs
 * appending, versus a shape that is common across tenants but not promised
 * anywhere.
 */
const RULES: Rule[] = [
  {
    /**
     * TalentLink, and the largest single win here.
     *
     * `?instant=apply` is TalentLink's own parameter for opening a vacancy
     * ON the application step instead of the advert. Some tenants already
     * emit it and some do not, from the same crawler: of 356 active tal.net
     * postings on 21 September 2026, 68 carried it and 288 did not - every
     * one of the 125 shared bank-board listings, all 87 Morgan Stanley and
     * all 39 Nomura among the latter. The ones that have it are the proof
     * the parameter is right; the rest simply never got it.
     */
    ats: "talentlink",
    test: /(^|\.)tal\.net$/i,
    build: (u) => {
      if (!/\/opp\//.test(u.pathname)) return null; // a board, not a vacancy
      if (u.searchParams.get("instant") === "apply") return null; // already there
      const out = new URL(u.toString());
      out.searchParams.set("instant", "apply");
      return out.toString();
    },
  },
  {
    // jobs.lever.co/acme/<uuid> -> /apply. Lever's own "Apply for this job"
    // button. The API usually supplies applyUrl outright, so this is the
    // fallback for listings that came from a scrape rather than the feed.
    ats: "lever",
    test: /(^|\.)lever\.co$/i,
    build: (u) => (/^\/[^/]+\/[^/]+$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/apply` : null),
  },
  {
    // jobs.ashbyhq.com/acme/<uuid> -> /application.
    ats: "ashby",
    test: /(^|\.)ashbyhq\.com$/i,
    build: (u) =>
      /^\/[^/]+\/[^/]+$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/application` : null,
  },
  {
    // apply.workable.com/acme/j/<ID>/ -> /apply/
    ats: "workable",
    test: /(^|\.)workable\.com$/i,
    build: (u) => (/^\/[^/]+\/j\/[^/]+\/?$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/apply/` : null),
  },
  {
    // acme.breezy.hr/p/<id> -> /apply
    ats: "breezy",
    test: /(^|\.)breezy\.hr$/i,
    build: (u) => (/^\/p\/[^/]+\/?$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/apply` : null),
  },
  {
    // acme.recruitee.com/o/<slug> -> /c/new, Recruitee's application step.
    ats: "recruitee",
    test: /(^|\.)recruitee\.com$/i,
    build: (u) => (/^\/o\/[^/]+\/?$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/c/new` : null),
  },
  {
    // jobs.jobvite.com/acme/job/<id> -> /apply
    ats: "jobvite",
    test: /(^|\.)jobvite\.com$/i,
    build: (u) =>
      /^\/[^/]+\/job\/[^/]+\/?$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}/apply` : null,
  },
  {
    // The form is on the advert; #app is Greenhouse's own anchor for it, so
    // this only saves the student a scroll. Deliberately not treated as a
    // different page - see the header.
    ats: "greenhouse",
    test: /(^|\.)greenhouse\.io$/i,
    build: (u) => (/^\/[^/]+\/jobs\/[^/]+\/?$/.test(u.pathname) ? `${u.origin}${stripTrailingSlash(u.pathname)}#app` : null),
  },
];

/**
 * A URL worth trying INSTEAD of the advert, or null when there is none.
 *
 * Null is a real answer and the common one: most boards put the form on the
 * advert, and inventing a path for them would make the link worse.
 */
export function deriveApplyUrl(listingUrl: string | null | undefined): ApplyCandidate | null {
  if (!listingUrl) return null;

  // Policed before anything is derived FROM it: every rule below builds its
  // candidate on `url.origin`, so a listing URL on loopback, a bare address
  // or an odd port would hand that origin straight to the derived apply link.
  const policed = publicHttpUrl(listingUrl);
  if (!policed) return null;

  let url: URL;
  try {
    url = new URL(policed);
  } catch {
    return null; // not a URL we can reason about; the caller keeps what it had
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A listing url that already carries a fragment or an apply segment has
  // been handled by someone who knew more than this file does.
  if (/\/apply|\/application(\/|$)|\/c\/new/i.test(url.pathname)) return null;

  for (const rule of RULES) {
    if (!rule.test.test(url.hostname)) continue;
    const built = rule.build(url);
    return built ? { url: built, ats: rule.ats } : null;
  }
  return null;
}

/**
 * What to store as a listing's application URL.
 *
 * The source's own answer wins whenever it HAS one - a connector that reports
 * an applicationUrl different from the listing url learned it from the feed,
 * and a derived guess must never override that. Only when the two are equal,
 * which is the connector saying "I have nothing better", is a candidate
 * derived. The listing url remains the floor: this never returns null and
 * never returns nothing.
 */
export function preferApplyUrl(listing: { applicationUrl?: string | null; listingUrl: string }): string {
  // A STATED url only wins if it is one we would send a student to. The
  // connectors read this field out of scraped JSON-LD and anchor hrefs
  // (generic.ts), so "the source stated it" is not the same as "the source is
  // trustworthy": `javascript:`, `data:`, a scheme-less string or a loopback
  // address are all things a defaced careers page can state. Falling back to
  // the listing url is the existing floor and loses nothing - a student still
  // lands on the advert.
  const stated = publicHttpUrl(listing.applicationUrl);
  if (stated && stated !== publicHttpUrl(listing.listingUrl)) return stated;
  return deriveApplyUrl(listing.listingUrl)?.url ?? listing.listingUrl;
}
