import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { firms } from "@/db/schema";
import {
  classifyDomain,
  registrableDomain,
  sameRegistrableDomain,
} from "@/lib/company-domains";
import {
  duplicateRecords,
  resolveIdentity,
  scoreCandidate,
  type CandidateCompany,
  type FirmIdentityInput,
  type Resolution,
} from "@/lib/company-identity";
import { countPeopleAt, identifyCompanyCandidates } from "@/lib/crustdata-client";

/**
 * Resolving a firm to a verified company record, and refusing to proceed
 * without one.
 *
 * The service half of lib/company-identity: that module is pure arithmetic
 * over candidates, this one fetches them, writes the verdict, and is what the
 * rest of the app asks "may I search this firm's people yet".
 *
 * Deliberately a service module rather than logic inside a server action, so
 * an HTTP route can be added later without moving any of it.
 */

/** How long to wait before asking again after each rate-limited lookup. */
const RATE_LIMIT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];

/** The lookup could not be completed. NOT the same as "this firm is not in
 *  the provider's index", and must never be persisted as `unresolved`. */
export class CompanyResolutionUnavailableError extends Error {
  readonly code = "COMPANY_RESOLUTION_UNAVAILABLE" as const;
  constructor(public readonly failure: string) {
    super("Contacts are temporarily unavailable. Please try again.");
  }
}

/**
 * We looked, and we could not tell which company this firm is.
 *
 * A settled answer, not a wait: the message must not imply that something is
 * still in progress. The first version of this said "We're confirming X's
 * information before generating contacts", which described a background step
 * that did not exist - nothing was confirming anything, and the student was
 * left watching a sentence that would never resolve.
 */
export class CompanyIdentityRequiredError extends Error {
  readonly code = "COMPANY_IDENTITY_REQUIRED" as const;
  constructor(
    public readonly firmName: string,
    /** below_threshold | ambiguous | no_candidates | all_disqualified | ... */
    public readonly reason: string,
  ) {
    super(
      reason === "ambiguous"
        ? `We found more than one company matching ${firmName} and can't tell them apart yet, so we haven't generated contacts.`
        : `We couldn't confirm which company ${firmName} is, so we haven't generated contacts.`,
    );
  }
}

export type FirmIdentity = {
  firmId: string;
  name: string;
  status: "verified" | "unresolved";
  crustdataCompanyId: number | null;
  linkedinUrl: string | null;
  verifiedDomain: string | null;
  confidence: number | null;
  checkedAt: Date | null;
};

const IDENTITY_COLUMNS = {
  id: true,
  name: true,
  slug: true,
  website: true,
  aliases: true,
  identityStatus: true,
  identityConfidence: true,
  identityCheckedAt: true,
  crustdataCompanyId: true,
  linkedinUrl: true,
  verifiedDomain: true,
} as const;

async function getFirmIdentity(firmId: string): Promise<FirmIdentity | null> {
  const db = await getDb();
  const row = await db.query.firms.findFirst({
    where: eq(firms.id, firmId),
    columns: IDENTITY_COLUMNS,
  });
  if (!row) return null;
  return {
    firmId: row.id,
    name: row.name,
    status: row.identityStatus === "verified" ? "verified" : "unresolved",
    crustdataCompanyId: row.crustdataCompanyId,
    linkedinUrl: row.linkedinUrl,
    verifiedDomain: row.verifiedDomain,
    confidence: row.identityConfidence,
    checkedAt: row.identityCheckedAt,
  };
}

/**
 * How long a failed resolution is trusted before it is worth asking again.
 *
 * Only ever applies to a verdict we actually reached - a provider that said
 * "no match" or gave two indistinguishable candidates will almost certainly
 * say the same thing thirty seconds later. A TRANSPORT failure writes nothing
 * at all, so a rate limit never lands in this window and the next click
 * retries immediately.
 */
const UNRESOLVED_RETRY_MS = 30 * 60 * 1000;

/**
 * The firm's verified identity, resolving it right now if that is what it
 * takes.
 *
 * This is the piece that was missing, and its absence is the whole bug:
 * The identity gate on contact generation checked a column that nothing
 * ever populated. Every firm sat at the migration's `unresolved` default with
 * `identityCheckedAt` null - never even attempted - so the button was
 * permanently blocked for all 22,573 of them, and the only verified row in the
 * database was the one firm resolved by hand during testing.
 *
 * Resolution is per-firm and on demand by design. Nothing waits on a sweep of
 * the directory: the student clicked one firm, so that is the firm we resolve,
 * and the original request continues in the same flow.
 *
 * Costs nothing. `/company/identify` bills zero credits (verified against
 * x-credits-used), so the worst case is one free lookup and a clear refusal.
 */
export async function ensureVerifiedIdentity(
  firmId: string,
  /** The searching student's school names, for choosing between duplicate
   *  company records by alumni. The choice is saved on the firm and used for
   *  everyone after. */
  opts: { schoolNames?: string[] } = {},
): Promise<FirmIdentity> {
  const existing = await getFirmIdentity(firmId);
  if (!existing) throw new CompanyIdentityRequiredError("this firm", "no_firm");
  if (existing.status === "verified" && existing.crustdataCompanyId != null) return existing;

  // A verdict we already reached, recently. Not re-asked.
  if (existing.checkedAt && Date.now() - existing.checkedAt.getTime() < UNRESOLVED_RETRY_MS) {
    throw new CompanyIdentityRequiredError(existing.name, "cached_unresolved");
  }

  // Throws CompanyResolutionUnavailableError on a transport failure, which is
  // deliberately NOT the same error as "we could not identify this firm".
  const outcome = await resolveFirmIdentity(firmId, opts);

  if (outcome.status !== "verified") {
    throw new CompanyIdentityRequiredError(existing.name, outcome.reason ?? "unresolved");
  }

  const resolved = await getFirmIdentity(firmId);
  if (!resolved || resolved.crustdataCompanyId == null) {
    // Resolution said verified but the row does not carry an id - a write that
    // did not land. Surfaced as transient rather than as a settled refusal.
    throw new CompanyResolutionUnavailableError("persist_failed");
  }
  return resolved;
}

type ResolutionOutcome = {
  firmId: string;
  status: "verified" | "unresolved";
  reason: string | null;
  confidence: number;
  signals: string[];
  conflict: boolean;
  lookedUpBy: "domain" | "name" | "none";
  /** Set only when verified. */
  companyId: number | null;
};

/**
 * Resolve one firm and persist the verdict.
 *
 * Writes on BOTH outcomes. `identityCheckedAt` moves every time so a failure
 * can be cached for a retry window instead of re-asking the provider on every
 * sweep; `verifiedAt` only moves on success, so the two together say "we
 * looked, and here is when it last actually worked".
 *
 * The stored `website` is never written to, ever. It is source data.
 */
async function resolveFirmIdentity(
  firmId: string,
  opts: { schoolNames?: string[] } = {},
): Promise<ResolutionOutcome> {
  const db = await getDb();
  const row = await db.query.firms.findFirst({
    where: eq(firms.id, firmId),
    columns: IDENTITY_COLUMNS,
  });
  if (!row) throw new Error(`No firm ${firmId}`);

  // Only a domain that survives the blocklist is offered to the provider as a
  // lookup key. careers.db.com and ch.linkedin.com resolve to the careers host
  // and to LinkedIn itself, neither of which is the firm.
  const usableHint = classifyDomain(row.website).usable ? row.website : null;

  // A rate limit is waited out, not reported. Measured in a sixteen-run test:
  // every firm not yet resolved failed with "temporarily unavailable" when
  // the student's school had just used the lookup allowance resolving its
  // own names - three firms in a row, each fine a minute later.
  let lookup = await identifyCompanyCandidates(row.name, usableHint);
  for (const waitMs of RATE_LIMIT_BACKOFF_MS) {
    if (lookup.failure !== "rate_limited") break;
    await new Promise((r) => setTimeout(r, waitMs));
    lookup = await identifyCompanyCandidates(row.name, usableHint);
  }
  const { failure } = lookup;
  let { candidates, lookedUpBy } = lookup;

  // Nothing is written on a transport failure. A 429 is not evidence about
  // this company, and recording it as `unresolved` would disable the firm's
  // button on the strength of a rate limit - then cache that verdict.
  // Measured: a run of thirty resolutions is rate-limited partway through.
  if (failure) throw new CompanyResolutionUnavailableError(failure);

  const input: FirmIdentityInput = {
    name: row.name,
    website: row.website,
    linkedinUrl: row.linkedinUrl,
    aliases: row.aliases ?? [],
  };
  let verdict: Resolution = resolveIdentity(input, candidates);

  // The domain lookup answered, but with nothing that is this firm - it
  // returned "Williams Investors Llc" for williamblair.com. Ask by name too,
  // and judge everything together.
  if (verdict.status === "unresolved" && lookedUpBy === "domain") {
    const byName = await identifyCompanyCandidates(row.name, null);
    if (!byName.failure && byName.candidates.length) {
      candidates = [...candidates, ...byName.candidates];
      verdict = resolveIdentity(input, candidates);
      if (verdict.status === "verified") lookedUpBy = "name";
    }
  }

  // One company listed twice: take the record its people actually list.
  if (verdict.status === "unresolved" && verdict.reason === "ambiguous") {
    const duplicates = duplicateRecords(input, candidates);
    if (duplicates) {
      const picked = await pickListedRecord(duplicates, opts.schoolNames ?? []);
      if (picked) {
        const scored = scoreCandidate(input, picked.candidate);
        verdict = {
          status: "verified",
          candidate: picked.candidate,
          confidence: Math.min(100, scored.score),
          signals: [...scored.signals, picked.signal],
          conflict: scored.conflict,
        };
      }
    }
  }
  const now = new Date();

  if (verdict.status === "verified") {
    const c = verdict.candidate;
    // WHICH domain, in order of authority. Taking the first usable one is
    // what stored `tal.net` for Evercore - the Lumesse TalentLink ATS that
    // hosts their careers site, which the provider files under the company
    // alongside evercore.com. An ATS domain as the "verified domain" would
    // then seed every email pattern at the firm.
    //
    //   1. the candidate domain that agrees with our SEC-filed hint
    //   2. the provider's own primary_domain
    //   3. any remaining usable one
    const usable = c.domains.filter((d) => classifyDomain(d).usable);
    const primary =
      usable.find((d) => usableHint && sameRegistrableDomain(d, usableHint)) ??
      (c.primaryDomain && classifyDomain(c.primaryDomain).usable ? c.primaryDomain : null) ??
      usable[0] ??
      null;
    const aliases = [...new Set([...(row.aliases ?? []), c.name].filter(Boolean))];

    await db
      .update(firms)
      .set({
        crustdataCompanyId: c.companyId,
        linkedinUrl: c.linkedinUrl,
        verifiedDomain: primary ? registrableDomain(primary) : null,
        aliases,
        identityConfidence: verdict.confidence,
        identityStatus: "verified",
        identityCheckedAt: now,
        verifiedAt: now,
      })
      .where(eq(firms.id, firmId));

    return {
      firmId,
      status: "verified",
      reason: null,
      confidence: verdict.confidence,
      signals: verdict.signals,
      conflict: verdict.conflict,
      lookedUpBy,
      companyId: c.companyId,
    };
  }

  await db
    .update(firms)
    .set({
      identityStatus: "unresolved",
      identityConfidence: verdict.confidence || null,
      identityCheckedAt: now,
    })
    .where(eq(firms.id, firmId));

  return {
    firmId,
    status: "unresolved",
    reason: verdict.reason,
    confidence: verdict.confidence,
    signals: verdict.best?.signals ?? [],
    conflict: verdict.best?.conflict ?? false,
    lookedUpBy,
    companyId: null,
  };
}

/**
 * Of several records for one company, the one people list as their employer.
 *
 * By the searching student's school first - the alumni they would actually
 * be shown - then by everyone, and only when one record clearly leads: a tie
 * stays unresolved rather than guessing. Measured on Warburg Pincus: 85 Penn
 * alumni and 1,411 employees on one record, 0 and 11 on the other.
 *
 * A count that could not be taken is not zero. It throws the transient error,
 * so nothing is persisted and the next click tries again.
 */
async function pickListedRecord(
  records: CandidateCompany[],
  schoolNames: string[],
): Promise<{ candidate: CandidateCompany; signal: string } | null> {
  const countAll = async (names: string[]) => {
    const counts: number[] = [];
    for (const r of records) {
      const { count } = await countPeopleAt(r.companyId!, names);
      if (count == null) throw new CompanyResolutionUnavailableError("count_failed");
      counts.push(count);
    }
    return counts;
  };
  const leader = (counts: number[]) => {
    const top = Math.max(...counts);
    return top > 0 && counts.filter((c) => c === top).length === 1 ? counts.indexOf(top) : -1;
  };

  if (schoolNames.length) {
    const alumni = await countAll(schoolNames);
    const i = leader(alumni);
    if (i >= 0) return { candidate: records[i], signal: `most alumni (${alumni.join(" vs ")})` };
  }
  const people = await countAll([]);
  const i = leader(people);
  return i >= 0 ? { candidate: records[i], signal: `most employees (${people.join(" vs ")})` } : null;
}
