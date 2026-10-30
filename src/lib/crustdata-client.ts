import "server-only";

import type { ContactSearchQuery } from "@/lib/contact-sourcing-agent";
import { providerCityName } from "@/lib/city-spelling";
import type { ReturnedContact } from "@/lib/contact-similarity";
import type { CandidateCompany } from "@/lib/company-identity";
import type { EmploymentEvidence, EmploymentRecord } from "@/lib/employment";
import type { Tier } from "@/lib/contact-tiers";
import type { AffinitySignal } from "@/lib/contact-pool";
import { AFFINITY_TIER, affinityQuery } from "@/lib/contact-search-provider";

/**
 * The Crustdata people search, and the translation either side of it.
 *
 * Our payload is flat and says what we want. Theirs is a recursive condition
 * tree over field paths. This module is the only place that knows both, so
 * swapping providers means rewriting this file and nothing else.
 *
 * WHAT THEIR FILTERS CANNOT DO, which shapes everything below: there is no
 * field path for clubs, activities or interests, and no such data comes back
 * on a profile either. So those signals cannot be filters. They go into the
 * free-text `search.query`, where they influence WHICH people are returned,
 * and they are simply absent from the comparison afterwards.
 *
 * Current location is deliberately NOT mapped to hometown. They are different
 * facts, and "Both from San Francisco" is a lie when it means someone works
 * there now.
 */

const ENDPOINT = "https://api.crustdata.com/person/search";
const IDENTIFY_ENDPOINT = "https://api.crustdata.com/company/identify";
const ENRICH_ENDPOINT = "https://api.crustdata.com/person/contact/enrich";
const API_VERSION = "2025-11-01";

export class CrustdataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CrustdataError";
  }
}

type Condition = { field: string; type: string; value: unknown };
type Group = { op: "and" | "or"; conditions: (Condition | Group)[] };

const FIELD = {
  currentCompany: "experience.employment_details.current.company_name",
  currentTitle: "experience.employment_details.current.title",
  school: "education.schools.school",
  location: "basic_profile.location.raw",
  businessEmailVerified: "experience.employment_details.current.business_email_verified",
  currentDomain: "experience.employment_details.current.company_website_domain",
  // The provider's own id for the employer, and the PLURAL domain list. Both
  // beat currentDomain, for the reason spelled out on resolveCompany below.
  currentCompanyId: "experience.employment_details.current.company_id",
  currentDomains: "experience.employment_details.current.company_domains",
  gradEndYear: "education.schools.end_year",
  city: "basic_profile.location.city",
  seniority: "experience.employment_details.current.seniority_level",
  yearsExperience: "years_of_experience_raw",
} as const;

/**
 * Our seniority vocabulary, in theirs.
 *
 * Their ladder, read off the API by sending a bogus value and letting the
 * error enumerate it: "Entry Level", "Entry Level Manager", "Senior",
 * "Experienced Manager", "Director", "Vice President", "CXO",
 * "Owner / Partner", "Strategic", "In Training".
 *
 * Banking titles do not map cleanly onto a generic corporate ladder - an
 * "associate" at a bank is nobody's manager - so this maps by WHO REPLIES
 * rather than by rank: the first two rungs are the people close enough to a
 * student to answer them.
 */
const SENIORITY_TO_PROVIDER: Record<string, string> = {
  analyst: "Entry Level",
  associate: "Senior",
  senior_associate: "Senior",
  consultant: "Senior",
  manager: "Experienced Manager",
  principal: "Director",
  portfolio_manager: "Director",
  vice_president: "Vice President",
  partner: "Owner / Partner",
};

/**
 * The levels a "mid" rung adds above the seat's own, in our vocabulary. The
 * next step up from analyst and associate, before a rung drops the seniority
 * filter altogether.
 */
const MID_SENIORITY = ["manager", "principal", "vice_president"];

/** How long a rate-limited people search waits before each retry. */
const SEARCH_RATE_LIMIT_BACKOFF_MS = [2_000, 5_000, 10_000];

/** The most people one search asks for. The ladder never needs more. */
const MAX_OVER_REQUEST = 60;

/** "contains all these words, any order" - the right operator for a name. */
const CONTAINS = "(.)";

function anyOf(field: string, values: string[]): Group | Condition | null {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return { field, type: CONTAINS, value: clean[0] };
  return { op: "or", conditions: clean.map((value) => ({ field, type: CONTAINS, value })) };
}

/**
 * Our search, in their shape.
 *
 * Exported separately from the call so the mapping can be tested - and read -
 * without spending a credit.
 */
/** Who the provider thinks a firm is: their id for it, and every domain it files under. */
export type CompanyIdentity = { companyId: number | null; domains: string[] };

/**
 * In-process, for the life of the server. The answer is a fact about a large
 * public company, it changes on the order of never, and the lookup is free -
 * so this exists to avoid a redundant round trip, not to avoid a bill.
 */
const identityCache = new Map<string, CompanyIdentity>();

/**
 * Recruiting front-ends that get stored in `website` instead of the employer's
 * own domain. `careers.db.com` is Deutsche Bank's careers site; the company
 * the provider knows is `db.com`.
 */
const CAREERS_HOSTS = /^(careers|jobs|apply|recruiting|talent|hire|join|work|emea-careers)\./i;

/**
 * The employer's own domain, given whatever we happen to have stored.
 *
 * Strips a recruiting front-end prefix, lowercases, and drops `www.` and any
 * scheme or path that came along. Everything else is left exactly as it is:
 * this is not a general-purpose "get the apex domain" function, and it must
 * not become one.
 *
 * The guard matters more than the rule. An earlier version of this stripped
 * prefixes unconditionally and turned `search.jobs.barclays` into `barclays` -
 * not a domain at all, and it silently matched nothing. So a prefix is only
 * removed when what survives still looks like a hostname: at least one dot,
 * and a final label of two or more letters. `jobs.barclays` keeps its prefix
 * and goes to the provider intact, where a failed lookup falls back to the
 * firm's name rather than to a string that cannot match anything.
 */
export function employerDomain(raw: string | null | undefined): string {
  let host = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .replace(/^www\./, "");
  if (!host) return "";

  if (CAREERS_HOSTS.test(host)) {
    const stripped = host.replace(CAREERS_HOSTS, "");
    if (stripped.includes(".") && /\.[a-z]{2,}$/.test(stripped)) host = stripped;
  }
  return host;
}

/**
 * A firm name reduced to the part worth comparing: lowercase, no punctuation,
 * no legal suffix. "J.P. Morgan Securities LLC" and "JP Morgan Securities"
 * both become "jpmorgansecurities", so a provider record can be checked
 * against the name we asked for without demanding they be typed identically.
 */
export function comparableName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(inc|llc|llp|ltd|limited|plc|lp|corp|corporation|co|company|group|holdings|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a provider record's name is the name we asked about.
 *
 * Containment alone is not enough, and the failure is not hypothetical: asked
 * for "Qzxwv Nonexistent Partners" the provider offered Partners Group, and
 * "partners" is a substring of the nonsense name, so a plain `includes` call
 * accepted it. The length ratio is what rejects that - eight characters
 * standing in for twenty-four is not the same firm - while still accepting
 * the differences that are only spelling: "Deutsche Bank" for
 * "Deutsche Bank (US)", "Moelis & Company" for "Moelis".
 */
export function namesAgree(got: string, wanted: string): boolean {
  if (!got || !wanted) return false;
  if (got === wanted) return true;
  if (!got.includes(wanted) && !wanted.includes(got)) return false;
  const shorter = Math.min(got.length, wanted.length);
  const longer = Math.max(got.length, wanted.length);
  return shorter / longer >= 0.7;
}

/** "10001+" / "1001-5000" -> 10001 / 1001. Unparseable ranges sort last. */
function headcountFloor(range: string | null | undefined): number {
  const m = /(\d+)/.exec(range ?? "");
  return m ? Number(m[1]) : -1;
}

/**
 * Ask the provider who a firm actually is, before searching for its people.
 *
 * `/company/identify` costs NOTHING - verified against the x-credits-used
 * header, which comes back 0. That is what makes this worth doing on every
 * search rather than storing a column we would have to keep in step.
 *
 * BY DOMAIN, not by name, and that distinction is the whole point. Name
 * lookups are badly behaved on exactly the firms we care about: asking for
 * "Citigroup" returns an entity called Citigroup whose domains are
 * google.com and gmail.com, and a second called "Citigroup CIB" - neither of
 * them the bank. The same query answered differently between two calls
 * minutes apart. Asking for the domain citigroup.com returns, every time,
 * the real Citi: id 680980, 10001+ employees, filed under citigroup.com,
 * citibank.com and citiglobalwealth.com.
 *
 * The name is kept only as a fallback for firms we hold no domain for, and
 * there the largest employer wins, because that is the tie-break that picks
 * a bank over a two-person consultancy sharing its name.
 *
 * Returns null on any failure. A search with the old single-domain filter is
 * a far better outcome than no search at all, so nothing here may throw.
 */
export async function resolveCompany(
  name: string,
  domainHint: string | null,
): Promise<CompanyIdentity | null> {
  const domain = employerDomain(domainHint);
  const key = domain || `name:${name.trim().toLowerCase()}`;
  const cached = identityCache.get(key);
  if (cached) return cached;

  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) return null;

  type Basic = {
    name?: string;
    crustdata_company_id?: number;
    primary_domain?: string;
    all_domains?: string[];
    employee_count_range?: string;
  };
  type Match = { confidence_score?: number; company_data?: { basic_info?: Basic } };

  const ask = async (body: Record<string, unknown>): Promise<Match[]> => {
    const res = await fetch(IDENTIFY_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      // Bounded, like the search and enrich calls below.
      //
      // This was missing when the lookup was added, and it is the difference
      // between a slow provider and a page that never comes back: the search
      // cannot start until this resolves, so an unbounded fetch here hangs
      // the whole "Generate contacts" action with no error and no timeout.
      // Shorter than the 30s the search gets - identify is a single indexed
      // lookup, and if it has not answered in ten seconds the right move is
      // to fall back to the stored domain and get on with the search.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const payload: unknown = await res.json();
    const entries = Array.isArray(payload) ? payload : [];
    return ((entries[0] as { matches?: Match[] } | undefined)?.matches ?? []) as Match[];
  };

  try {
    // Domain first. One unambiguous answer when we have one.
    let matches = domain ? await ask({ domains: [domain] }) : [];
    let byName = false;
    if (!matches.length) {
      matches = await ask({ names: [name] });
      byName = true;
    }

    const parsed = matches
      .map((m) => {
        const info = m.company_data?.basic_info ?? {};
        const domains = [
          ...new Set([...(info.all_domains ?? []), info.primary_domain].filter(Boolean)),
        ] as string[];
        return {
          providerName: info.name ?? "",
          confidence: m.confidence_score ?? 0,
          headcount: headcountFloor(info.employee_count_range),
          companyId: info.crustdata_company_id ?? null,
          domains,
        };
      })
      .filter((m) => m.companyId != null || m.domains.length > 0);

    if (!parsed.length) return null;

    // A domain lookup is already unambiguous, so take its first match.
    //
    // A name lookup is not, and it will answer even when it has nothing
    // sensible to offer: asked for a firm that does not exist, it returned an
    // Australian disability-services provider. Searching that company's staff
    // is worse than not searching at all, because it looks like it worked.
    // So a name match has to earn it - the name the provider came back with
    // must actually be the name we asked about - and among those that do, the
    // largest employer wins, which is the tie-break that picks a bank over a
    // two-person consultancy sharing its name.
    let chosen: (typeof parsed)[number] | undefined;
    if (byName) {
      const wanted = comparableName(name);
      const plausible = parsed.filter((m) => namesAgree(comparableName(m.providerName), wanted));
      if (!plausible.length) return null;
      chosen = plausible.reduce((best, m) => (m.headcount > best.headcount ? m : best), plausible[0]);
    } else {
      chosen = parsed[0];
    }

    const identity: CompanyIdentity = { companyId: chosen.companyId, domains: chosen.domains };
    identityCache.set(key, identity);
    return identity;
  } catch {
    return null;
  }
}

export function toCrustdataRequest(
  query: ContactSearchQuery,
  /** From resolveCompany. Absent falls back to the single stored domain. */
  identity?: CompanyIdentity | null,
): Record<string, unknown> {
  const conditions: (Condition | Group)[] = [];

  // --- the firm -----------------------------------------------------------
  // Three ways to say "works here", best first.
  //
  // 1. The provider's own company id. Exact, and immune to the problem below.
  // 2. Every domain they file under, matched as a set.
  // 3. The single domain we have stored - the old behaviour, kept as a
  //    fallback for when the free identify lookup returns nothing.
  //
  // Why this changed: one firm is not one domain. Citi's people are split
  // across citigroup.com, citibank.com and citiglobalwealth.com; Goldman's
  // across goldmansachs.com, gs.com, marcus.com and gsselect.com. Filtering
  // on the single stored domain silently searched a fraction of the firm -
  // Citi ran dry after four contacts, because the rest were filed under a
  // domain we never asked about. JPMorgan and Morgan Stanley have exactly one
  // domain each, which is why they never showed the symptom.
  //
  // A name match is the last resort on purpose: it also finds people who
  // merely typed the firm's name in their own job title.
  if (identity?.companyId != null) {
    conditions.push({ field: FIELD.currentCompanyId, type: "=", value: identity.companyId });
  } else if (identity && identity.domains.length > 0) {
    conditions.push({ field: FIELD.currentDomains, type: "in", value: identity.domains });
  } else {
    conditions.push(
      query.employer.domain
        ? { field: FIELD.currentDomain, type: "=", value: query.employer.domain }
        : { field: FIELD.currentCompany, type: CONTAINS, value: query.employer.name },
    );
  }

  // --- the person ---------------------------------------------------------
  const titles = anyOf(FIELD.currentTitle, query.person.titleAnyOf);
  if (titles) conditions.push(titles);

  const levels = [
    ...new Set(
      query.person.seniorityLevels
        .map((s) => SENIORITY_TO_PROVIDER[s])
        .filter((v): v is string => !!v),
    ),
  ];
  if (levels.length) conditions.push({ field: FIELD.seniority, type: "in", value: levels });

  if (query.person.maxYearsExperience > 0) {
    conditions.push({
      field: FIELD.yearsExperience,
      type: "=<",
      value: query.person.maxYearsExperience,
    });
  }

  // --- education ----------------------------------------------------------
  // Exact, and any one of the school's names. Not CONTAINS: every word of
  // "University of Pennsylvania" also appears in "Indiana University of
  // Pennsylvania". `=` ignores case (their reference).
  const schoolNames = [...new Set((query.education.school?.names ?? []).map((n) => n.trim()).filter(Boolean))];
  if (schoolNames.length === 1) {
    conditions.push({ field: FIELD.school, type: "=", value: schoolNames[0] });
  } else if (schoolNames.length > 1) {
    conditions.push({
      op: "or",
      conditions: schoolNames.map((value) => ({ field: FIELD.school, type: "=", value })),
    });
  }

  // No field-of-study filter. The student's major only ever ranked people -
  // as a filter it required "Finance" on a profile, and most Wharton alumni
  // list Economics: at Blackstone it alone cut 7 Penn alumni to 2. The major
  // still ranks (lib/contact-similarity), it just never excludes anyone.

  if (query.education.graduatedOnOrAfter) {
    conditions.push({
      field: FIELD.gradEndYear,
      type: "=>",
      value: query.education.graduatedOnOrAfter,
    });
  }

  // --- where they are -----------------------------------------------------
  // Their vocabulary, not our chip labels - "New York City" matches nobody.
  const cities = anyOf(FIELD.city, query.location.cities.map(providerCityName));
  if (cities) conditions.push(cities);

  // Ask for the people we already have, plus the ones we are about to drop,
  // so a student who has saved contacts still gets a full set back.
  //
  // Enough to reach past EVERYONE excluded, not a multiple of the limit: the
  // ladder reads "fewer came back than asked for" as "this rung has run out",
  // and that is what confirms a student's school has no more alumni before
  // any other school is tried. A cap of limit x 3 made a rung look dry
  // whenever more than ten people were excluded.
  const overRequest = Math.min(
    query.limit + query.exclude.linkedinUrls.length + query.exclude.names.length,
    MAX_OVER_REQUEST,
  );

  return {
    filters: { op: "and", conditions },
    // Clubs, interests, coverage, hometown. None of these has a filter field
    // and both title and description return zero for coverage, so they rank
    // rather than exclude.
    ...(query.keywords.length
      ? { search: { query: query.keywords.join(" "), mode: "hybrid" } }
      : {}),
    limit: overRequest,
  };
}

type CrustdataProfile = {
  crustdata_person_id?: number;
  basic_profile?: {
    name?: string;
    headline?: string;
    current_title?: string;
    location?: { raw?: string; city?: string };
  };
  contact?: { has_business_email?: boolean };
  education?: {
    schools?: {
      school?: string;
      degree?: string;
      end_year?: number;
      location?: { city?: string };
    }[];
  };
  experience?: {
    employment_details?: {
      /**
       * OBSERVED against the live API on 2026-09-22, one /person/search with
       * limit 1. Previously these paths were inferred from the filter
       * constants this client sends, on the reasoning that a screener API's
       * filters mirror the document being filtered.
       *
       * THAT REASONING WAS WRONG, and this is the record of it. The filter
       * `experience.employment_details.current.company_id` is accepted and
       * works - it matched 3,494 Evercore employees - but the response
       * carries the identifier as `crustdata_company_id`, and the website as
       * a singular `company_website`. Nothing confirmed employment, so
       * generation would have returned nobody for every firm until the
       * parser was corrected.
       *
       * Fields stay optional because the provider may change again, and the
       * employment check FAILS CLOSED when the identifier is absent - which
       * is the only reason the mistake cost nothing worse than zero results.
       */
      current?: {
        name?: string;
        title?: string;
        /** OBSERVED. The identifier the response actually carries. */
        crustdata_company_id?: number | null;
        /** Never observed; the filter grammar uses this spelling. */
        company_id?: number;
        /** Singular, and what the live response carries. Diagnostic only. */
        company_website?: string;
        /** Never observed. Kept because a provider rename would land here. */
        company_domains?: string[];
        start_date?: string;
        end_date?: string | null;
      }[];
      past?: {
        name?: string;
        title?: string;
        crustdata_company_id?: number | null;
        company_id?: number;
        company_website?: string;
        company_domains?: string[];
        start_date?: string;
        end_date?: string | null;
      }[];
    };
  };
  social_handles?: { professional_network_identifier?: { profile_url?: string } };
};

/** A contact as we hold them: the comparison shape, plus what we need to save one. */
export type SourcedContact = ReturnedContact & {
  crustdataPersonId: number | null;
  linkedinUrl: string | null;
  headline: string | null;
  currentCompany: string | null;
  currentLocation: string | null;
  hasBusinessEmail: boolean;
  /**
   * The employer identifiers, kept so employment can be CHECKED rather than
   * assumed from the fact that the search filtered on a company id. Discarding
   * these is what left `employmentConfirmed` as a hardcoded true.
   */
  employment: EmploymentEvidence;
};

export function fromCrustdataProfile(profile: CrustdataProfile): SourcedContact {
  const basic = profile.basic_profile ?? {};
  const employment = profile.experience?.employment_details ?? {};

  const asRecords = (rows: NonNullable<typeof employment.current>): EmploymentRecord[] =>
    (rows ?? []).map((e) => ({
      companyId: e.crustdata_company_id ?? e.company_id ?? null,
      name: e.name?.trim() ?? null,
      title: e.title ?? null,
      domains: e.company_domains ?? (e.company_website ? [e.company_website] : null),
      startDate: e.start_date ?? null,
      endDate: e.end_date ?? null,
    }));

  return {
    employment: {
      current: asRecords(employment.current ?? []),
      past: asRecords(employment.past ?? []),
      headline: basic.headline ?? null,
    },
    name: basic.name?.trim() || "Unknown",
    title: basic.current_title ?? employment.current?.[0]?.title ?? null,
    // Every school, not just the first: a student's match is often the second
    // degree on the page.
    schools: (profile.education?.schools ?? [])
      .map((s) => s.school?.trim())
      .filter((s): s is string => !!s),
    // Their most recent graduation. The single best similarity signal after
    // the school itself: someone two years ahead remembers the recruiting
    // cycle the student is in; someone twelve years ahead does not.
    gradYear:
      (profile.education?.schools ?? [])
        .map((s) => s.end_year)
        .filter((y): y is number => typeof y === "number" && y > 1950)
        .sort((a, b) => b - a)[0] ?? null,
    // Where they studied, which is often not where they work now.
    schoolCities: (profile.education?.schools ?? [])
      .map((s) => s.location?.city?.trim())
      .filter((c): c is string => !!c),
    currentCity: basic.location?.city ?? null,
    previousCompanies: (employment.past ?? [])
      .map((e) => e.name?.trim())
      .filter((e): e is string => !!e),
    // Their profiles carry none of these. Left undefined rather than empty so
    // the comparison reports "not known" rather than "nothing in common".
    clubs: null,
    interests: null,
    hometown: null,
    // Not parsed from the education records today, so unknown - never a
    // "different major" (see the signal audit in lib/contact-pool).
    major: null,

    crustdataPersonId: profile.crustdata_person_id ?? null,
    linkedinUrl: profile.social_handles?.professional_network_identifier?.profile_url ?? null,
    headline: basic.headline ?? null,
    currentCompany: employment.current?.[0]?.name ?? null,
    currentLocation: basic.location?.raw ?? null,
    hasBusinessEmail: !!profile.contact?.has_business_email,
  };
}

type SearchResult = {
  contacts: SourcedContact[];
  /** Straight off the X-Credits-Used response header. What this actually cost. */
  creditsUsed: number;
  totalCount: number;
};


async function searchPeople(query: ContactSearchQuery): Promise<SearchResult> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new CrustdataError("CRUSTDATA_API_KEY is not set.");

  // The verified company when the run has one; otherwise a lookup (free), which
  // decides which of the three employer filters gets used.
  const identity: CompanyIdentity | null =
    query.employer.companyId != null
      ? { companyId: query.employer.companyId, domains: [employerDomain(query.employer.domain)].filter(Boolean) }
      : await resolveCompany(query.employer.name, query.employer.domain);
  const body = toCrustdataRequest(query, identity);

  // A rate limit is waited out before it is reported: measured, a people
  // search in a busy minute came back 429 and the student saw "rate limited"
  // for a firm that answered normally seconds later.
  let response!: Response;
  for (const waitMs of [0, ...SEARCH_RATE_LIMIT_BACKOFF_MS]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "x-api-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new CrustdataError(
        err instanceof Error && err.name === "TimeoutError"
          ? "The contact search timed out."
          : "Could not reach the contact search.",
      );
    }
    if (response.status !== 429) break;
  }

  // Read the meter before anything else can throw: a failed request may still
  // have been billed, and we would rather record that than lose it.
  const creditsUsed = Number(response.headers.get("x-credits-used") ?? 0) || 0;

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new CrustdataError(
      response.status === 429
        ? "Contact search is rate limited right now. Try again in a minute."
        : `Contact search failed (${response.status}). ${detail.slice(0, 200)}`,
      response.status,
    );
  }

  const payload = (await response.json()) as { profiles?: CrustdataProfile[]; total_count?: number };
  const all = (payload.profiles ?? []).map(fromCrustdataProfile);

  // Exclusion is done here rather than in the filters: their schema has no
  // documented "not this profile URL" path, and over-requesting above leaves
  // enough headroom to still return a full set.
  const excludedUrls = new Set(query.exclude.linkedinUrls);
  const excludedNames = new Set(query.exclude.names.map((n) => n.toLowerCase()));

  const contacts = all
    .filter((c) => !(c.linkedinUrl && excludedUrls.has(c.linkedinUrl)))
    .filter((c) => !excludedNames.has(c.name.toLowerCase()))
    .slice(0, query.limit);

  return { contacts, creditsUsed, totalCount: payload.total_count ?? contacts.length };
}


/**
 * Work email addresses for people we have already found.
 *
 * Separate call, separate charge: search returns who someone is, this returns
 * how to reach them. One credit per person MATCHED - an identifier that finds
 * nothing is free - so this is batched into a single request.
 *
 * Asks for `contact.business_emails` and nothing else. The base profile and
 * the personal-contact fields each cost more, and we already have the profile.
 */
export type EnrichedEmail = {
  email: string;
  /** Their word for it: "deliverable", "unknown", "invalid". */
  status: string | null;
  /**
   * Every address the provider holds for the person, in their order. A
   * profile often carries the old employer's mailbox beside the current one -
   * Brookfield's run got prosek.com and colliers.com - so the caller picks the
   * one on the firm's own domain, not simply the first deliverable.
   */
  all: { email: string; status: string | null }[];
};

export async function enrichBusinessEmails(
  linkedinUrls: string[],
): Promise<{ emails: Map<string, EnrichedEmail>; creditsUsed: number }> {
  const urls = [...new Set(linkedinUrls.filter(Boolean))];
  if (!urls.length) return { emails: new Map(), creditsUsed: 0 };

  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new CrustdataError("CRUSTDATA_API_KEY is not set.");

  let response: Response;
  try {
    response = await fetch(ENRICH_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        professional_network_profile_urls: urls,
        fields: ["contact.business_emails"],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CrustdataError("Could not reach the email lookup.");
  }

  const creditsUsed = Number(response.headers.get("x-credits-used") ?? 0) || 0;

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new CrustdataError(
      `Email lookup failed (${response.status}). ${detail.slice(0, 200)}`,
      response.status,
    );
  }

  type EnrichRow = {
    matched_on?: string;
    matches?: {
      confidence_score?: number;
      person_data?: { contact?: { business_emails?: { email?: string; status?: string }[] } };
    }[];
  };

  const rows = (await response.json()) as EnrichRow[];
  const emails = new Map<string, EnrichedEmail>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row.matched_on) continue;
    const best = row.matches?.[0]?.person_data?.contact?.business_emails ?? [];
    // Deliverable first. An address that bounces is worse than none: it costs
    // the student a send and teaches them nothing.
    const chosen = best.find((e) => e.status === "deliverable") ?? best[0];
    // The status travels with it. A firm whose mail server refuses to confirm
    // (goldmansachs.com does) returns "unknown", and a student is entitled to
    // know that before they write to someone they want to impress.
    if (chosen?.email) {
      emails.set(row.matched_on, {
        email: chosen.email,
        status: chosen.status ?? null,
        all: best
          .filter((e): e is { email: string; status?: string } => !!e.email)
          .map((e) => ({ email: e.email, status: e.status ?? null })),
      });
    }
  }

  return { emails, creditsUsed };
}

/**
 * Every candidate the provider offers for a firm, with the fields the
 * resolver scores on - as opposed to resolveCompany above, which picks one
 * and returns only an id and domains.
 *
 * Kept separate rather than widening resolveCompany, because the two answer
 * different questions. resolveCompany is the hot path inside a search: it
 * wants one answer, cached, and it falls back to a stored domain rather than
 * failing. This is the resolution pass: it wants EVERY candidate so the
 * scoring in lib/company-identity can compare them and decline when two are
 * too close to call.
 *
 * The extra fields come free. `/company/identify` bills zero (verified
 * against x-credits-used) and already returns professional_network_url,
 * industries, company_type and year_founded in the same payload the old
 * parser was reading five keys out of.
 *
 * Never throws: an unreachable provider is an unresolved firm, not an outage.
 */
export type IdentifyFailure = "rate_limited" | "auth" | "permission" | "server" | "network";

export async function identifyCompanyCandidates(
  name: string,
  domainHint: string | null,
): Promise<{
  candidates: CandidateCompany[];
  lookedUpBy: "domain" | "name" | "none";
  /**
   * Set when the lookup could not be completed, as opposed to completing and
   * finding nobody. The distinction is the whole point: an empty array from a
   * 429 looks exactly like an empty array from a firm the provider has never
   * heard of, and the caller would persist "unresolved" and disable that
   * firm's button forever on the strength of a transient error. Measured -
   * resolving thirty firms in a row returns 429 partway through.
   */
  failure: IdentifyFailure | null;
}> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) return { candidates: [], lookedUpBy: "none", failure: "auth" };

  const domain = employerDomain(domainHint);

  type Basic = {
    name?: string;
    crustdata_company_id?: number;
    primary_domain?: string;
    all_domains?: string[];
    professional_network_url?: string;
    industries?: string[];
    employee_count_range?: string;
  };
  type Match = { confidence_score?: number; company_data?: { basic_info?: Basic } };

  let failure: IdentifyFailure | null = null;

  const ask = async (body: Record<string, unknown>): Promise<Match[]> => {
    try {
      const res = await fetch(IDENTIFY_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "x-api-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        failure =
          res.status === 429
            ? "rate_limited"
            : res.status === 401
              ? "auth"
              : res.status === 403
                ? "permission"
                : res.status >= 500
                  ? "server"
                  : null;
        return [];
      }
      const payload: unknown = await res.json();
      const entries = Array.isArray(payload) ? payload : [];
      return ((entries[0] as { matches?: Match[] } | undefined)?.matches ?? []) as Match[];
    } catch {
      failure = "network";
      return [];
    }
  };

  const shape = (matches: Match[]): CandidateCompany[] =>
    matches
      .map((m) => {
        const info = m.company_data?.basic_info ?? {};
        const domains = [
          ...new Set([...(info.all_domains ?? []), info.primary_domain].filter(Boolean)),
        ] as string[];
        const floor = headcountFloor(info.employee_count_range);
        return {
          companyId: info.crustdata_company_id ?? null,
          name: info.name ?? "",
          domains,
          primaryDomain: info.primary_domain ?? null,
          linkedinUrl: info.professional_network_url ?? null,
          industries: info.industries ?? [],
          headcountFloor: floor >= 0 ? floor : null,
        };
      })
      .filter((c) => c.companyId != null || c.domains.length > 0);

  // Domain first when we hold a usable one; the name lookup is the fallback
  // the resolver scores far more sceptically.
  if (domain) {
    const byDomain = shape(await ask({ domains: [domain] }));
    if (byDomain.length) return { candidates: byDomain, lookedUpBy: "domain", failure: null };
    // A failed domain lookup must not silently become a name lookup: the name
    // route is scored far more sceptically, so falling through on a 429 would
    // quietly downgrade a firm we could have resolved properly.
    if (failure) return { candidates: [], lookedUpBy: "none", failure };
  }
  const byName = shape(await ask({ names: [name] }));
  return {
    candidates: byName,
    lookedUpBy: byName.length ? "name" : "none",
    failure: byName.length ? null : failure,
  };
}

/**
 * How many people currently list this company as their employer - and, given
 * a school's exact names, how many of them went there.
 *
 * One limit-1 search: the provider bills per profile returned (0.03 at limit
 * 1, measured), and total_count comes back regardless. Used to tell a firm's
 * real company record from a duplicate page nobody lists - see
 * lib/company-identity duplicateRecords. Null on any failure, which the caller
 * must read as "unknown", never as zero.
 */
export async function countPeopleAt(
  companyId: number,
  schoolNames: string[] = [],
): Promise<{ count: number | null; creditsUsed: number }> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) return { count: null, creditsUsed: 0 };
  const conditions: (Condition | Group)[] = [{ field: FIELD.currentCompanyId, type: "=", value: companyId }];
  const names = [...new Set(schoolNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length) {
    conditions.push({ op: "or", conditions: names.map((value) => ({ field: FIELD.school, type: "=", value })) });
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filters: { op: "and", conditions }, limit: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    const creditsUsed = Number(response.headers.get("x-credits-used") ?? 0) || 0;
    if (!response.ok) return { count: null, creditsUsed };
    const payload = (await response.json()) as { total_count?: number };
    return { count: typeof payload.total_count === "number" ? payload.total_count : null, creditsUsed };
  } catch {
    return { count: null, creditsUsed: 0 };
  }
}

/**
 * A student's OWN LinkedIn profile, for filling in their Offerly profile.
 *
 * The student gave us this address; the provider already holds the profile,
 * so nothing is scraped. One credit a call (measured) - the caller makes it
 * once, when the student saves the link, never on a page load. Null on any
 * failure: autofill is a convenience and must never block saving the link.
 */
export type LinkedInProfile = {
  headline: string | null;
  /** The profile's "About" section, as the student wrote it. */
  summary: string | null;
  education: { school: string; fieldOfStudy: string | null; endYear: number | null }[];
};

export async function fetchLinkedInProfile(
  profileUrl: string,
): Promise<{ profile: LinkedInProfile | null; creditsUsed: number }> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) return { profile: null, creditsUsed: 0 };
  try {
    const response = await fetch("https://api.crustdata.com/person/enrich", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ professional_network_profile_urls: [profileUrl], fields: ["basic_profile", "education"] }),
      signal: AbortSignal.timeout(20_000),
    });
    const creditsUsed = Number(response.headers.get("x-credits-used") ?? 0) || 0;
    if (!response.ok) return { profile: null, creditsUsed };
    type Person = {
      basic_profile?: { headline?: string; summary?: string };
      education?: { schools?: { school?: string; field_of_study?: string; end_year?: number }[] };
    };
    type Row = Person & { matches?: { person_data?: Person }[] };
    const payload = (await response.json()) as Row[] | Row;
    const row = Array.isArray(payload) ? payload[0] : payload;
    // Nested under matches[].person_data, or the person itself - both seen.
    const person = row?.matches?.[0]?.person_data ?? (row?.basic_profile || row?.education ? row : undefined);
    if (!person) return { profile: null, creditsUsed };
    return {
      creditsUsed,
      profile: {
        headline: person.basic_profile?.headline?.trim() || null,
        summary: person.basic_profile?.summary?.trim() || null,
        education: (person.education?.schools ?? [])
          .filter((s) => s.school?.trim())
          .map((s) => ({
            school: s.school!.trim(),
            fieldOfStudy: s.field_of_study?.trim() || null,
            endYear: typeof s.end_year === "number" ? s.end_year : null,
          })),
      },
    };
  } catch {
    return { profile: null, creditsUsed: 0 };
  }
}

/**
 * One of the student's schoolmates at the firm whose current work email the
 * provider has VERIFIED - the person to enrich first when the firm's pattern
 * is not yet known.
 *
 * `business_email_verified` is the field that means it. Measured at
 * Blackstone: all three people with it true enriched to a deliverable
 * @blackstone.com address; of three without it, one did (the others were
 * portfolio-company executives with their own companies' mail). The response
 * flag `contact.has_business_email` is NOT this and is useless - false for all
 * fifteen USC alumni at Brookfield, several of whom had brookfield.com mail -
 * and the provider refuses it as a filter anyway.
 *
 * Exact school names, like every same-school rung; none given means anyone.
 */
export async function searchVerifiedEmailSchoolmate(
  companyId: number,
  schoolNames: string[],
  exclude: string[],
): Promise<{ contact: SourcedContact | null; creditsUsed: number }> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new CrustdataError("CRUSTDATA_API_KEY is not set.");
  const excluded = new Set(exclude);
  const conditions: (Condition | Group)[] = [
    { field: FIELD.currentCompanyId, type: "=", value: companyId },
    { field: FIELD.businessEmailVerified, type: "=", value: true },
  ];
  const names = [...new Set(schoolNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length) {
    conditions.push({ op: "or", conditions: names.map((value) => ({ field: FIELD.school, type: "=", value })) });
  }
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-api-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filters: { op: "and", conditions },
      limit: Math.min(1 + excluded.size, MAX_OVER_REQUEST),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const creditsUsed = Number(response.headers.get("x-credits-used") ?? 0) || 0;
  if (!response.ok) throw new CrustdataError(`Verified-email search failed (${response.status}).`, response.status);
  const payload = (await response.json()) as { profiles?: CrustdataProfile[] };
  const contact =
    (payload.profiles ?? [])
      .map(fromCrustdataProfile)
      .find((c) => c.linkedinUrl && !excluded.has(c.linkedinUrl)) ?? null;
  return { contact, creditsUsed };
}

/**
 * More people at the firm, for learning its email pattern - never shown.
 *
 * Asks first for people the provider says have a VERIFIED work email, so each
 * address bought is likely to be one; if the provider rejects that filter, it
 * asks for anyone at the firm. `exclude` keeps it from returning the same
 * people twice.
 */
export async function searchPeopleForPatternProbe(
  companyId: number,
  exclude: string[],
  limit: number,
): Promise<{ contacts: SourcedContact[]; creditsUsed: number }> {
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new CrustdataError("CRUSTDATA_API_KEY is not set.");
  const excluded = new Set(exclude);
  const ask = async (withVerifiedEmail: boolean) => {
    const conditions: (Condition | Group)[] = [{ field: FIELD.currentCompanyId, type: "=", value: companyId }];
    if (withVerifiedEmail) conditions.push({ field: FIELD.businessEmailVerified, type: "=", value: true });
    return fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filters: { op: "and", conditions },
        limit: Math.min(limit + excluded.size, MAX_OVER_REQUEST),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  };
  let creditsUsed = 0;
  const page = async (withVerifiedEmail: boolean) => {
    const response = await ask(withVerifiedEmail);
    creditsUsed += Number(response.headers.get("x-credits-used") ?? 0) || 0;
    if (response.status === 400 && withVerifiedEmail) return null;
    if (!response.ok) throw new CrustdataError(`Pattern search failed (${response.status}).`, response.status);
    const payload = (await response.json()) as { profiles?: CrustdataProfile[] };
    return (payload.profiles ?? [])
      .map(fromCrustdataProfile)
      .filter((c) => c.linkedinUrl && !excluded.has(c.linkedinUrl))
      .slice(0, limit);
  };
  // The verified-email filter is a preference, not a requirement. Measured at
  // Brookfield: all 15 USC alumni there carry has_business_email = false,
  // yet enrichment returned brookfield.com addresses for several - so an
  // empty filtered page means "the flag is not kept here", not "nobody has
  // an address". Asked again without it.
  const filtered = await page(true);
  const contacts = filtered?.length ? filtered : ((await page(false)) ?? []);
  return { contacts, creditsUsed };
}

/**
 * One tier's query: the plan with that tier's PREFERENCES relaxed.
 *
 * The employer is untouched by construction - `employer` is copied straight
 * through and no branch below can reach it. That is the constraint the spec
 * calls mandatory, and making it unreachable is stronger than remembering not
 * to relax it.
 *
 * `role` is the rung the old ladder never had. It relaxes title and seniority,
 * which is what a firm like Teleo needs: its people are "Partner" and
 * "Principal", and no widening of school or city will ever make them match a
 * title filter looking for "Private Equity".
 */
export function relaxQueryForTier(query: ContactSearchQuery, tier: Tier): ContactSearchQuery {
  const drop = new Set(tier.drop);
  return {
    ...query,
    employer: query.employer,
    person: drop.has("role")
      ? {
          ...query.person,
          titleAnyOf: [],
          seniorityLevels: [],
          maxYearsExperience: tier.seniority === "any" ? 0 : query.person.maxYearsExperience,
        }
      : {
          ...query.person,
          titleAnyOf: drop.has("title") ? [] : query.person.titleAnyOf,
          seniorityLevels:
            tier.seniority === "any"
              ? []
              : tier.seniority === "mid"
                ? [...new Set([...query.person.seniorityLevels, ...MID_SENIORITY])]
                : query.person.seniorityLevels,
          // An MD has more than twenty years behind them; the cap would keep
          // out exactly the people an "any seniority" rung exists to reach.
          maxYearsExperience: tier.seniority === "any" ? 0 : query.person.maxYearsExperience,
        },
    education: {
      ...query.education,
      school: drop.has("school")
        ? null
        : tier.businessSchoolOnly && query.education.school
          ? { ...query.education.school, names: query.education.school.businessNames }
          : query.education.school,
      graduatedOnOrAfter: drop.has("gradYear") ? null : query.education.graduatedOnOrAfter,
    },
    location: { cities: drop.has("city") ? [] : query.location.cities },
    // Free text only on a rung built for it (Tier.keywords) - in practice the
    // affinity searches (lib/contact-search-provider AFFINITY_TIER). Everywhere
    // else it stays off: the hybrid search narrows the result set rather than
    // ranking it - the only difference between an Evercore run that found five
    // people and one that found none.
    keywords: tier.keywords ? query.keywords : [],
  };
}

/**
 * Search one tier, asking for exactly the slots still open.
 *
 * Returns the provider's people unfiltered; validation, employment and
 * deduplication are the caller's, so this stays a thin transport layer that a
 * test can replace wholesale.
 */
export async function searchPeopleForTier(
  query: ContactSearchQuery,
  tier: Tier,
  limit: number,
): Promise<{ contacts: SourcedContact[]; creditsUsed: number; totalCount: number }> {
  // A business-school rung for a school with no business-school names would
  // search with no school at all - "anyone in the seat" before any alumnus.
  if (tier.businessSchoolOnly && !query.education.school?.businessNames.length) {
    return { contacts: [], creditsUsed: 0, totalCount: 0 };
  }
  // A free-text rung with no text would be an unfiltered search - skip it at
  // no cost.
  if (tier.keywords && !query.keywords.length) {
    return { contacts: [], creditsUsed: 0, totalCount: 0 };
  }
  return searchPeople({ ...relaxQueryForTier(query, tier), limit });
}

/**
 * The ladder's search, excluding everyone an earlier rung already returned.
 *
 * Without this, the rungs overlap and waste themselves: every Wharton alum is
 * also filed under "University of Pennsylvania", so the university-wide rung
 * asked for two people, got the same two the Wharton rung had already kept,
 * dropped them as duplicates - and the ladder moved on to other schools while
 * Penn alumni outside Wharton were never reached. Measured on Blackstone, KKR
 * and Apollo: "got 2, kept 0" on every university-wide rung.
 *
 * Excluded people are over-requested and dropped by searchPeople, so each
 * rung reaches past them to people it has not seen.
 */
/**
 * One affinity search: the plan narrowed by one student signal's spellings
 * (lib/contact-pool). It excludes only the student's existing contacts, not
 * the people already in the pool - someone the baseline found turning up here
 * too is exactly the hint the pool records.
 */
export async function searchPeopleForAffinity(
  query: ContactSearchQuery,
  signal: AffinitySignal,
  limit: number,
): Promise<{ contacts: SourcedContact[]; creditsUsed: number; totalCount: number }> {
  return searchPeopleForTier(affinityQuery(query, signal, limit), AFFINITY_TIER, limit);
}

export function searchTiersExcludingSeen(
  query: ContactSearchQuery,
  search: typeof searchPeopleForTier = searchPeopleForTier,
): ((tier: Tier, limit: number) => ReturnType<typeof searchPeopleForTier>) & {
  /** Profiles the next search will ask for - and be billed for. */
  plannedResults: (limit: number) => number;
} {
  const urls = new Set(query.exclude.linkedinUrls);
  const names = new Set(query.exclude.names);
  const run = async (tier: Tier, limit: number) => {
    const page = await search(
      { ...query, exclude: { linkedinUrls: [...urls], names: [...names] } },
      tier,
      limit,
    );
    for (const c of page.contacts) {
      if (c.linkedinUrl) urls.add(c.linkedinUrl);
      else names.add(c.name);
    }
    return page;
  };
  return Object.assign(run, {
    plannedResults: (limit: number) => Math.min(limit + urls.size + names.size, MAX_OVER_REQUEST),
  });
}

/** Measured: a person search bills per profile returned - 0.03 at limit 1, 0.15 at 5, 0.45 at 15. */
export const SEARCH_CREDITS_PER_RESULT = 0.03;
/** Measured: one enrichment, one credit - even when the address is another company's. */
export const ENRICH_CREDITS = 1;
