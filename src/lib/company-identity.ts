/**
 * Deciding whether a provider's company record really is one of our firms.
 *
 * The whole point is to be able to say "no". A resolver that always answers
 * produces exactly the failure this replaces: asked for "Citigroup" by name,
 * the provider returns an entity called Citigroup whose domains are
 * google.com and gmail.com, plus a second called "Citigroup CIB", and the two
 * answers differ between calls minutes apart. Searching that company's staff
 * is worse than not searching, because it looks like it worked.
 *
 * So a candidate must EARN acceptance on independent agreeing signals, and
 * anything short of that is `unresolved` - which disables contact generation
 * for the firm rather than guessing a website to make the button work.
 *
 * Pure: no network, no database. The caller fetches candidates and persists
 * the verdict; everything here is arithmetic over data already in hand.
 */

import { classifyDomain, registrableDomain, sameRegistrableDomain } from "@/lib/company-domains";

/** Points per signal. Approved weights - see the resolution rules. */
const SIGNAL_POINTS = {
  /** Our stored SEC website agrees with one of the candidate's domains. */
  domain: 45,
  /** Normalised name or a known alias matches the candidate's name. */
  name: 40,
  /** Our stored LinkedIn company URL matches the candidate's. */
  linkedin: 35,
  /**
   * Headquarters agreement. ALWAYS ZERO, and kept here rather than removed so
   * the gap is visible rather than forgotten: the provider's identify response
   * carries no location field at all. Verified against the live API - name,
   * crustdata_company_id, primary_domain, all_domains, website,
   * professional_network_url, professional_network_id, profile_name,
   * logo_permalink, description, company_type, year_founded,
   * employee_count_range, markets, industries, and nothing about where the
   * company is. `firms.headquarters` therefore has nothing to agree with.
   */
  headquarters: 0,
  /** Candidate's industry taxonomy reads as finance. */
  industry: 10,
  /** Headcount is plausible for a firm of this kind. */
  headcount: 5,
} as const;

/** Total a candidate must reach. */
export const ACCEPT_THRESHOLD = 65;
/** ...and how far clear of the runner-up it must be. */
export const RUNNER_UP_MARGIN = 25;

export type CandidateCompany = {
  companyId: number | null;
  name: string;
  /** Every domain the provider files under this company, which is NOT only
   *  their own: Evercore's record carries tal.net, the Lumesse TalentLink ATS
   *  that hosts their careers site. Order means nothing here. */
  domains: string[];
  /** The one the provider calls primary. This is the corporate domain. */
  primaryDomain: string | null;
  linkedinUrl: string | null;
  industries: string[];
  headcountFloor: number | null;
};

export type FirmIdentityInput = {
  name: string;
  /** The SEC-filed hint. Unverified, and may be stale or a careers host. */
  website: string | null;
  linkedinUrl: string | null;
  aliases?: string[];
};

export type CandidateScore = {
  candidate: CandidateCompany;
  score: number;
  signals: string[];
  /**
   * Our stored domain is usable, the candidate has domains, and they disagree.
   *
   * NOT a disqualifier. The stored value is an unverified SEC self-report and
   * may be stale, subsidiary-specific, misfiled, or a careers host - it must
   * not overrule stronger independent evidence. It costs the domain points and
   * demands corroboration instead.
   */
  conflict: boolean;
  /** Set when the candidate is unusable outright. */
  disqualified: string | null;
};

const FINANCE_WORDS =
  /invest|financ|capital|bank|asset|equity|securit|fund|advis|wealth|credit|insur|venture|private equity|hedge/i;

/** Lowercase, unaccent, drop legal suffixes and punctuation. */
export function comparableCompanyName(value: string): string {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(
      /\b(l\.?l\.?c|l\.?p|l\.?l\.?p|inc|incorporated|corp|corporation|ltd|limited|plc|gmbh|s\.?a\.?r\.?l|s\.?a|s\.?r\.?l|pte|pty|co|company|the|and)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The whole name, plus each side of a slash-joined one. */
function nameAlternates(name: string): string[] {
  const parts = String(name)
    .split("/")
    .map(comparableCompanyName)
    .filter(Boolean);
  const whole = comparableCompanyName(name);
  return [...new Set([whole, ...parts])];
}

/** Same name, allowing one to be a leading-word prefix of the other -
 *  "Teleo Capital" against "Teleo Capital Management". */
function namesAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = a.split(" ");
  const y = b.split(" ");
  const shorter = x.length <= y.length ? x : y;
  const longer = shorter === x ? y : x;
  // Every word of the shorter name, in order, opening the longer one.
  return shorter.length >= 1 && shorter.every((w, i) => longer[i] === w);
}

/** Canonical LinkedIn company slug, so trailing slashes and locale prefixes
 *  do not make two spellings of one URL look different. */
export function linkedinCompanySlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url)
    .toLowerCase()
    .match(/linkedin\.com\/(?:company|school)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function scoreCandidate(
  firm: FirmIdentityInput,
  candidate: CandidateCompany,
): CandidateScore {
  const signals: string[] = [];

  // Hard disqualifiers first. A candidate whose only domains are somebody's
  // social presence or a mailbox provider is not a company record we can use,
  // whatever else agrees - this is the Citigroup/google.com case.
  const usableDomains = candidate.domains.filter((d) => classifyDomain(d).usable);
  if (candidate.domains.length > 0 && usableDomains.length === 0) {
    const why = classifyDomain(candidate.domains[0]);
    return {
      candidate,
      score: 0,
      signals: [],
      conflict: false,
      disqualified: why.usable ? "malformed" : why.reason,
    };
  }
  if (candidate.companyId == null && usableDomains.length === 0) {
    return { candidate, score: 0, signals: [], conflict: false, disqualified: "no_identifier" };
  }

  let score = 0;

  // ---- domain -------------------------------------------------------------
  // Only a domain that passed classifyDomain may be compared. A firm whose
  // stored website is careers.db.com or ch.linkedin.com contributes nothing
  // here and is not treated as conflicting either - an unusable hint is no
  // evidence in either direction.
  const storedUsable = classifyDomain(firm.website).usable ? firm.website : null;
  let conflict = false;
  if (storedUsable && usableDomains.length) {
    if (usableDomains.some((d) => sameRegistrableDomain(d, storedUsable))) {
      score += SIGNAL_POINTS.domain;
      signals.push(`domain ${registrableDomain(storedUsable)}`);
    } else {
      conflict = true;
    }
  }

  // ---- name / alias -------------------------------------------------------
  //
  // The directory joins two brands with a slash where one entity trades under
  // both - "KeyCorp / KeyBank", "TIAA / Nuveen" - and a provider knows only
  // one of them. Each side is tried separately, which is parsing our own name
  // field rather than inventing an alias.
  const ourNames = nameAlternates(firm.name);
  const candidateName = comparableCompanyName(candidate.name);
  const aliasHit = (firm.aliases ?? [])
    .map(comparableCompanyName)
    .some((a) => namesAgree(a, candidateName));
  if (ourNames.some((n) => namesAgree(n, candidateName)) || aliasHit) {
    score += SIGNAL_POINTS.name;
    signals.push("name");
  }

  // ---- linkedin -----------------------------------------------------------
  // Dormant on a first resolution, because firms.linkedin_url starts empty.
  // It earns its weight on RE-resolution, once a verified pass has stored one.
  const ours = linkedinCompanySlug(firm.linkedinUrl);
  const theirs = linkedinCompanySlug(candidate.linkedinUrl);
  if (ours && theirs && ours === theirs) {
    score += SIGNAL_POINTS.linkedin;
    signals.push("linkedin");
  }

  // ---- industry -----------------------------------------------------------
  if (candidate.industries.some((i) => FINANCE_WORDS.test(i))) {
    score += SIGNAL_POINTS.industry;
    signals.push("industry");
  }

  // ---- headcount ----------------------------------------------------------
  if (candidate.headcountFloor != null && candidate.headcountFloor >= 2) {
    score += SIGNAL_POINTS.headcount;
    signals.push("headcount");
  }

  return { candidate, score, signals, conflict, disqualified: null };
}

export type Resolution =
  | {
      status: "verified";
      candidate: CandidateCompany;
      confidence: number;
      signals: string[];
      conflict: boolean;
    }
  | {
      status: "unresolved";
      reason:
        | "no_candidates"
        | "all_disqualified"
        | "below_threshold"
        | "ambiguous"
        | "conflict_uncorroborated";
      confidence: number;
      /** Kept for the review log even when nothing is accepted. */
      best: CandidateScore | null;
    };

/**
 * Breaking a tie between one company's own records.
 *
 * The provider files subsidiaries under the parent's domain as separate
 * companies. Measured on jefferies.com: "Jefferies" (5,001+ staff) and
 * "Jefferies Credit Partners" (51), both scoring 100, because "Jefferies" opens
 * the longer name. key.com does the same with "KeyBank" and "KeyBank
 * Commercial". The margin refused both, so contacts could not be generated
 * for either firm at all.
 *
 * These are not two different companies that might be ours. They are one
 * family on OUR domain, and our name says which member we mean. So a tie
 * breaks only when EVERY tied candidate agrees with our stored domain, and
 * exactly ONE of them carries our name (or an alias) outright rather than
 * extending it. Anything else - two exact names, a tied candidate on another
 * domain, the exact one scoring lower - stays ambiguous.
 */
function sameFamilyExactName(
  firm: FirmIdentityInput,
  live: CandidateScore[],
  topScore: number,
): CandidateScore | null {
  const tied = live.filter((s) => topScore - s.score < RUNNER_UP_MARGIN);
  if (!tied.every((s) => s.signals.some((sig) => sig.startsWith("domain ")))) return null;

  const ours = new Set([
    ...nameAlternates(firm.name),
    ...(firm.aliases ?? []).map(comparableCompanyName).filter(Boolean),
  ]);
  const exact = tied.filter((s) => ours.has(comparableCompanyName(s.candidate.name)));
  if (exact.length !== 1 || exact[0].score !== topScore) return null;
  return exact[0];
}

/**
 * The tied candidates, when they are one company listed twice.
 *
 * The provider carries duplicate LinkedIn pages as separate companies:
 * warburgpincus.com returns two records both named "Warburg Pincus LLC", on
 * the same domain, at the same size - linkedin.com/company/warburg-pincus and
 * .../warburg-pincus-llc. Nothing in the records says which is real, so the
 * resolver refuses, and the firm could not generate contacts at all. What
 * does say is who works there: 1,411 people list the first, 11 the second.
 *
 * Returned only when every tied candidate agrees with our stored domain and
 * they all carry the same name. The caller counts people at each and takes
 * the one they actually list - see lib/company-resolution.
 */
export function duplicateRecords(
  firm: FirmIdentityInput,
  candidates: CandidateCompany[],
): CandidateCompany[] | null {
  const live = candidates
    .map((c) => scoreCandidate(firm, c))
    .filter((s) => !s.disqualified && s.candidate.companyId != null)
    .sort((a, b) => b.score - a.score);
  if (live.length < 2 || live[0].score < ACCEPT_THRESHOLD) return null;
  const tied = live.filter((s) => live[0].score - s.score < RUNNER_UP_MARGIN);
  if (tied.length < 2) return null;
  if (!tied.every((s) => s.signals.some((sig) => sig.startsWith("domain ")))) return null;
  const name = comparableCompanyName(tied[0].candidate.name);
  if (!name || !tied.every((s) => comparableCompanyName(s.candidate.name) === name)) return null;
  return tied.map((s) => s.candidate);
}

/**
 * Pick a candidate, or decline.
 *
 * The ladder in the spec - stored id, stored domain, stored LinkedIn, name
 * search - is about which IDENTIFIER to look the company up by. It is not a
 * licence to take the first thing that comes back: whatever the lookup route,
 * every candidate lands here and has to clear the same bar.
 */
export function resolveIdentity(
  firm: FirmIdentityInput,
  candidates: CandidateCompany[],
): Resolution {
  if (!candidates.length) {
    return { status: "unresolved", reason: "no_candidates", confidence: 0, best: null };
  }

  const scored = candidates
    .map((c) => scoreCandidate(firm, c))
    .sort((a, b) => b.score - a.score);

  const live = scored.filter((s) => !s.disqualified);
  if (!live.length) {
    return { status: "unresolved", reason: "all_disqualified", confidence: 0, best: scored[0] };
  }

  let best = live[0];
  const runnerUp = live[1];

  if (best.score < ACCEPT_THRESHOLD) {
    return {
      status: "unresolved",
      reason: "below_threshold",
      confidence: best.score,
      best,
    };
  }

  if (runnerUp && best.score - runnerUp.score < RUNNER_UP_MARGIN) {
    const parent = sameFamilyExactName(firm, live, best.score);
    if (!parent) {
      return { status: "unresolved", reason: "ambiguous", confidence: best.score, best };
    }
    best = parent;
  }

  // A conflicting stored domain needs a strong name match PLUS one more
  // independent signal before it is accepted over the stored hint.
  if (best.conflict) {
    const hasName = best.signals.includes("name");
    const corroborating = best.signals.filter((s) => s !== "name").length;
    if (!hasName || corroborating < 1) {
      return {
        status: "unresolved",
        reason: "conflict_uncorroborated",
        confidence: best.score,
        best,
      };
    }
  }

  return {
    status: "verified",
    candidate: best.candidate,
    // Clamped: the weights sum to 135 at maximum (45+40+35+10+5), and a
    // "confidence" of 135 on a 0-100 field reads as a bug. The RAW score is
    // what the threshold and the runner-up margin compare, so clamping the
    // reported number changes no decision.
    confidence: Math.min(100, best.score),
    signals: best.signals,
    conflict: best.conflict,
  };
}
