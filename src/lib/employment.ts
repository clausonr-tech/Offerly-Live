/**
 * Whether a person actually works at the firm whose page they are shown on.
 *
 * This replaces a boolean that was hardcoded `true`. The search filters on the
 * verified company id, so everyone it returns is a current employee "by
 * construction" - and that reasoning is exactly what let
 * `vikram.jolly@greenhill.com` look plausible. A filter is a statement about
 * the query, not a property we checked on the record in front of us, and the
 * two come apart whenever the provider's own data is stale.
 *
 * FAILS CLOSED. Anything short of a stable identifier matching the selected
 * firm is `unconfirmed`, and an unconfirmed contact is dropped entirely rather
 * than shown without an email.
 *
 * What may NOT establish employment, however tempting: headline text, a
 * company-name substring, an email domain, a job title, a model's opinion, a
 * default, or the absence of an end date. Every one of those is either
 * free text the person wrote themselves or an inference from something that
 * has already been observed to be stale.
 *
 * Pure. No network, no database.
 */

import { normaliseHost } from "@/lib/company-domains";

/** What the provider tells us about one employment record. */
export type EmploymentRecord = {
  /** The provider's stable id for the employer. The only thing that confirms. */
  companyId?: number | null;
  /** Free text. Kept for diagnosis; never evidence. */
  name?: string | null;
  title?: string | null;
  /** The employer's site, normalised. DIAGNOSTIC ONLY - see the parser. It
   *  confirms no employment and approves no email domain. */
  domains?: string[] | null;
  /** ISO-ish date strings when present. Absence proves nothing either way. */
  startDate?: string | null;
  endDate?: string | null;
};

export type EmploymentEvidence = {
  current: EmploymentRecord[];
  past: EmploymentRecord[];
  /** Free text from the profile. Diagnostic only. */
  headline?: string | null;
};

export type SelectedFirmIdentity = {
  crustdataCompanyId: number | null;
  /**
   * Company ids explicitly mapped as the same employer - a parent whose
   * subsidiary the provider files separately, say.
   *
   * EXPLICIT only. A parent, an acquirer or a similarly-named firm never
   * qualifies by being one: key.com alone covers KeyCorp, KeyBank AND Cain
   * Brothers in the directory, and treating those as interchangeable would
   * put a Cain Brothers banker on KeyBank's roster.
   */
  equivalentCompanyIds?: number[];
};

type EmploymentStatus = "current" | "incoming" | "unconfirmed";

export type EmploymentVerdict = {
  status: EmploymentStatus;
  /** Which rule decided it, for the run log. */
  basis:
    | "company_id"
    | "equivalent_company_id"
    | "future_start_company_id"
    | "no_company_id_on_record"
    | "company_id_mismatch"
    | "only_past_employment"
    | "no_employment_records"
    | "no_selected_firm_id";
  /** The matching record, when there is one. */
  matched: EmploymentRecord | null;
};

/** A start date in the future means they have not begun yet. */
function startsInFuture(record: EmploymentRecord, now: Date): boolean {
  if (!record.startDate) return false;
  const start = new Date(record.startDate);
  return !Number.isNaN(start.getTime()) && start.getTime() > now.getTime();
}

function idMatches(record: EmploymentRecord, firm: SelectedFirmIdentity): "exact" | "equivalent" | null {
  if (record.companyId == null) return null;
  if (firm.crustdataCompanyId != null && record.companyId === firm.crustdataCompanyId) return "exact";
  if ((firm.equivalentCompanyIds ?? []).includes(record.companyId)) return "equivalent";
  return null;
}

/**
 * The verdict.
 *
 * `incoming` is deliberately its own status rather than a flavour of current.
 * The directory is full of "Incoming 2027 Investment Banking Summer Analyst"
 * profiles, and they are genuinely useful to a student - but they do not have
 * a work address yet, and calling them current employees would mean deriving
 * one from the firm's pattern for someone who has never had a mailbox there.
 */
export function confirmEmployment(
  evidence: EmploymentEvidence,
  firm: SelectedFirmIdentity,
  now: Date = new Date(),
): EmploymentVerdict {
  // Without an id for the selected firm there is nothing stable to compare
  // against, and every weaker comparison is one this function exists to refuse.
  if (firm.crustdataCompanyId == null && !(firm.equivalentCompanyIds ?? []).length) {
    return { status: "unconfirmed", basis: "no_selected_firm_id", matched: null };
  }

  const current = evidence.current ?? [];
  const past = evidence.past ?? [];

  if (!current.length && !past.length) {
    return { status: "unconfirmed", basis: "no_employment_records", matched: null };
  }

  // A record with no company id cannot confirm anything, however well its
  // name reads. Tracked separately so the run log can distinguish "the
  // provider did not give us ids" from "the ids disagreed" - the first is a
  // gap in the response shape, the second is a stale profile.
  let sawRecordWithoutId = false;

  for (const record of current) {
    const match = idMatches(record, firm);
    if (!match) {
      if (record.companyId == null) sawRecordWithoutId = true;
      continue;
    }
    if (startsInFuture(record, now)) {
      return { status: "incoming", basis: "future_start_company_id", matched: record };
    }
    return {
      status: "current",
      basis: match === "exact" ? "company_id" : "equivalent_company_id",
      matched: record,
    };
  }

  // Only in PAST employment. This is the Vikram Jolly shape: the firm is real
  // on the profile, just not where they are now.
  for (const record of past) {
    if (idMatches(record, firm)) {
      return { status: "unconfirmed", basis: "only_past_employment", matched: record };
    }
    if (record.companyId == null) sawRecordWithoutId = true;
  }

  return {
    status: "unconfirmed",
    basis: sawRecordWithoutId ? "no_company_id_on_record" : "company_id_mismatch",
    matched: null,
  };
}

/**
 * Provider payload -> evidence. The ONLY place a field name appears.
 *
 * OBSERVED, no longer inferred. A single live /person/search on 2026-09-22
 * settled the shape, and it was not what the filter grammar implied:
 *
 *   experience.employment_details.current[]
 *     crustdata_company_id   number   <- THE identifier
 *     name                   string
 *     title                  string
 *     company_website        string   (singular; there is no company_domains)
 *     start_date             string
 *     end_date               null on current employment
 *     seniority_level, employment_type, position_id, is_default,
 *     professional_network_id, function_category, location.raw,
 *     years_at_company, years_at_company_raw, business_email_verified,
 *     company_status, company_type, company_headcount_latest,
 *     company_headcount_range, company_headquarters_country,
 *     company_hq_location, company_hq_location_address_components[],
 *     company_industries[], company_professional_network_industry,
 *     company_professional_network_profile_url,
 *     company_profile_picture_permalink
 *   experience.employment_details.past[]   same shape
 *
 * THE FILTER AND THE RESPONSE DISAGREE, which is the whole lesson. The query
 * filters on `experience.employment_details.current.company_id` and that
 * works - it returned 3,494 Evercore matches. The response carries the same
 * value under `crustdata_company_id`. Reading the request grammar as if it
 * mirrored the document was wrong, and it cost nothing only because this
 * function fails closed: every contact was rejected as unplaceable rather
 * than admitted unverified.
 *
 * `company_id` and `companyId` are still accepted. They were never observed,
 * but the filter grammar evidences the first and this is the one place a
 * rename would land; keeping them costs nothing and removes a cliff if the
 * provider ever aligns the two.
 *
 * An unrecognised shape still yields no company id, which fails closed.
 */
export function parseEmploymentEvidence(raw: unknown): EmploymentEvidence {
  const profile = (raw ?? {}) as {
    basic_profile?: { headline?: string };
    experience?: { employment_details?: { current?: unknown[]; past?: unknown[] } };
  };
  const details = profile.experience?.employment_details ?? {};

  const record = (value: unknown): EmploymentRecord => {
    const e = (value ?? {}) as Record<string, unknown>;
    const id = e.crustdata_company_id ?? e.company_id ?? e.companyId;

    /**
     * The employer's website, DIAGNOSTIC ONLY.
     *
     * The live response carries `company_website` (singular) rather than the
     * `company_domains` array this once looked for, so the field was always
     * null. Parsing it makes a run log readable - "the id disagreed, and here
     * is the site the profile claims" - and nothing more.
     *
     * It may NEVER confirm employment or approve an email domain. A website
     * on a profile is a string the provider copied from somewhere; the whole
     * reason this module exists is that vikram.jolly@greenhill.com looked
     * plausible from exactly that kind of evidence. `idMatches` reads only
     * `companyId`, and the email gate reads only the firm's verified domain.
     *
     * Malformed values become null rather than a half-parsed host, which is
     * what `normaliseHost` already guarantees.
     */
    const site = typeof e.company_website === "string" ? normaliseHost(e.company_website) : null;
    const domains = Array.isArray(e.company_domains)
      ? (e.company_domains as unknown[]).filter((d): d is string => typeof d === "string")
      : site
        ? [site]
        : null;

    return {
      companyId: typeof id === "number" ? id : null,
      name: typeof e.name === "string" ? e.name.trim() : null,
      title: typeof e.title === "string" ? e.title : null,
      domains: domains?.length ? domains : null,
      startDate: typeof e.start_date === "string" ? e.start_date : null,
      endDate: typeof e.end_date === "string" ? e.end_date : null,
    };
  };

  return {
    current: (details.current ?? []).map(record),
    past: (details.past ?? []).map(record),
    headline: profile.basic_profile?.headline ?? null,
  };
}

/** Alias, so call sites read as parse-then-evaluate. */
export const evaluateEmployment = confirmEmployment;

/** Convenience for the one question most callers ask. */
export function isCurrentEmployee(verdict: EmploymentVerdict): boolean {
  return verdict.status === "current";
}

/**
 * Whether a contact may be shown at all.
 *
 * Incoming employees are admitted only when the product asks for them, and
 * even then they carry their own status - they never become "current".
 */
export function isAdmissibleContact(
  verdict: EmploymentVerdict,
  options: { includeIncoming: boolean },
): boolean {
  if (verdict.status === "current") return true;
  return options.includeIncoming && verdict.status === "incoming";
}
