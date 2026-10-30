/**
 * A fake Crustdata, installed at the same boundary as the network block.
 *
 * Replaces global `fetch`, so the REAL client code runs: its request bodies,
 * its credit-header reading, its error handling and its profile mapping are
 * all exercised. A module mock would have skipped every one of them, and the
 * bug this pipeline shipped last time lived in exactly that kind of seam.
 *
 * ANY URL it does not recognise still throws, loudly, with the same message
 * the no-network guard uses. Escaping to the real API is not a thing this can
 * do by accident: there is no key, no host allowance, and no default branch
 * that lets a request through.
 */

import { LIVE_CALL_MESSAGE } from "./no-network";

export const IDENTIFY_URL = "https://api.crustdata.com/company/identify";
export const SEARCH_URL = "https://api.crustdata.com/person/search";
/** How the fake records a person search filtered on business_email_verified = true. */
export const VERIFIED_EMAIL_SEARCH = `${SEARCH_URL}#business_email_verified`;
export const ENRICH_URL = "https://api.crustdata.com/person/contact/enrich";

/** A profile in the shape person/search returns. */
export type FakeProfile = {
  crustdata_person_id?: number;
  basic_profile?: {
    name?: string;
    headline?: string;
    current_title?: string;
    location?: { city?: string; raw?: string };
  };
  education?: { schools?: { school?: string; end_year?: number; location?: { city?: string } }[] };
  experience?: {
    employment_details?: {
      current?: { name?: string; title?: string; company_id?: number; start_date?: string }[];
      past?: { name?: string; title?: string; company_id?: number; end_date?: string }[];
    };
  };
  contact?: { has_business_email?: boolean };
  social_handles?: { professional_network_identifier?: { profile_url?: string } };
};

export type FakeCrustdata = {
  /** One entry per outbound request, in order. */
  calls: { url: string; body: unknown }[];
  countOf: (url: string) => number;
  /** Total credits the fake reported across every response. */
  creditsBilled: number;
  /**
   * Add pages for later searches - e.g. between two clicks. Pages are a
   * queue, so a test can say "the next click finds this person" without
   * counting how many rungs the ladder walks first.
   */
  enqueueSearchPages: (...pages: FakeProfile[][]) => void;
  restore: () => void;
};

export type FakeOptions = {
  /** Pages of search results, consumed one per person/search call. */
  searchPages?: FakeProfile[][];
  /**
   * Pages for searches filtered on business_email_verified = true - the email
   * anchor and the hidden pattern probe's first ask. A separate queue because
   * the real provider answers those from a different population; empty by
   * default, which is what most firms' data looks like.
   */
  verifiedEmailPages?: FakeProfile[][];
  /** Credits the fake reports per search call. Default 1. */
  searchCredits?: number;
  /** linkedin url -> the address enrichment returns for them. */
  emails?: Record<string, { email: string; status: string }>;
  enrichCredits?: number;
  /** Answer this many company lookups with 429 before answering normally. */
  identifyRateLimited?: number;
  /** Make the next search throw a provider error instead of answering. */
  failSearchWith?: number;
  /** Called on each search, before answering - to interleave concurrency. */
  onSearch?: () => Promise<void> | void;
};

function json(body: unknown, credits: number, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-credits-used": String(credits) },
  });
}

export function installFakeCrustdata(options: FakeOptions = {}): FakeCrustdata {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CRUSTDATA_API_KEY;

  // The client refuses to call without one. Obviously not a real key, and it
  // never leaves this process - the fetch below never touches a socket.
  process.env.CRUSTDATA_API_KEY = "offline-test-key-not-a-credential";

  const state: FakeCrustdata = {
    calls: [],
    countOf: (url) => state.calls.filter((c) => c.url === url).length,
    creditsBilled: 0,
    enqueueSearchPages: (...pages) => {
      pending.push(...pages);
    },
    restore: () => {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.CRUSTDATA_API_KEY;
      else process.env.CRUSTDATA_API_KEY = previousKey;
    },
  };

  const pending: FakeProfile[][] = [...(options.searchPages ?? [])];
  const pendingVerified: FakeProfile[][] = [...(options.verifiedEmailPages ?? [])];
  const asksVerifiedEmail = (body: unknown) =>
    JSON.stringify(body ?? "").includes('"experience.employment_details.current.business_email_verified","type":"=","value":true');

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    // Recorded under its own name, so countOf(SEARCH_URL) still means "people
    // searches for the contacts" and a test can count these separately.
    const verifiedAsk = url === SEARCH_URL && asksVerifiedEmail(body);
    state.calls.push({ url: verifiedAsk ? VERIFIED_EMAIL_SEARCH : url, body });

    if (verifiedAsk) {
      const credits = options.searchCredits ?? 1;
      state.creditsBilled += credits;
      const page = pendingVerified.shift() ?? [];
      return json({ profiles: page, total_count: page.length }, credits);
    }

    if (url === IDENTIFY_URL && (options.identifyRateLimited ?? 0) > 0) {
      options.identifyRateLimited!--;
      return json({ error: "rate limited" }, 0, 429);
    }

    if (url === IDENTIFY_URL) {
      // Bills zero, as measured against the real x-credits-used header.
      return json(
        [
          {
            matches: [
              {
                confidence_score: 0.99,
                company_data: {
                  basic_info: {
                    name: "Evercore Inc.",
                    crustdata_company_id: 682795,
                    primary_domain: "evercore.com",
                    all_domains: ["evercore.com"],
                    employee_count_range: "1001-5000",
                  },
                },
              },
            ],
          },
        ],
        0,
      );
    }

    if (url === SEARCH_URL) {
      await options.onSearch?.();
      if (options.failSearchWith) {
        return json({ error: "provider said no" }, 0, options.failSearchWith);
      }
      const credits = options.searchCredits ?? 1;
      state.creditsBilled += credits;
      const page = pending.shift() ?? [];
      return json({ profiles: page, total_count: page.length }, credits);
    }

    if (url === ENRICH_URL) {
      const asked: string[] =
        (body as { professional_network_profile_urls?: string[] })?.professional_network_profile_urls ?? [];
      const rows = asked.map((u) => {
        const hit = options.emails?.[u];
        return hit
          ? {
              matched_on: u,
              matches: [
                { confidence_score: 1, person_data: { contact: { business_emails: [hit] } } },
              ],
            }
          : { matched_on: null };
      });
      const credits = (options.enrichCredits ?? 1) * rows.filter((r) => r.matched_on).length;
      state.creditsBilled += credits;
      return json(rows, credits);
    }

    throw new Error(`${LIVE_CALL_MESSAGE}: ${url}`);
  }) as typeof fetch;

  return state;
}

/** A search profile with sensible defaults, current at the given company. */
export function fakeProfile(over: {
  name: string;
  companyId: number;
  personId?: number;
  title?: string;
  school?: string;
  gradYear?: number;
  city?: string;
  linkedin?: string;
  pastCompanyId?: number;
  startDate?: string;
}): FakeProfile {
  const slug = over.name.toLowerCase().replace(/[^a-z]+/g, "-");
  return {
    crustdata_person_id: over.personId ?? Math.abs(hash(over.name)),
    basic_profile: {
      name: over.name,
      headline: over.title ?? "Analyst",
      current_title: over.title ?? "Analyst",
      location: { city: over.city ?? "New York City", raw: over.city ?? "New York City" },
    },
    education: {
      schools: [
        {
          school: over.school ?? "University of Southern California",
          end_year: over.gradYear ?? 2024,
          location: { city: "Los Angeles" },
        },
      ],
    },
    experience: {
      employment_details: {
        current: over.pastCompanyId
          ? []
          : [
              {
                name: "Evercore",
                title: over.title ?? "Analyst",
                company_id: over.companyId,
                start_date: over.startDate ?? "2023-07-01",
              },
            ],
        past: over.pastCompanyId
          ? [{ name: "Evercore", company_id: over.pastCompanyId, end_date: "2024-01-01" }]
          : [],
      },
    },
    contact: { has_business_email: true },
    social_handles: {
      professional_network_identifier: {
        profile_url: over.linkedin ?? `https://www.linkedin.com/in/${slug}`,
      },
    },
  };
}

function hash(value: string): number {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
