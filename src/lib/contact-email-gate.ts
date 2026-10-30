/**
 * Whether an address may be shown to a student as someone's work email at the
 * firm they are looking at.
 *
 * "The provider returned it" is not the question. The provider returned
 * `vikram.jolly@greenhill.com` for a contact displayed on EVERCORE's page,
 * marked deliverable, and it was shown - because the old rule read the
 * provider's status and nothing else. Deliverable is a statement about a
 * mailbox, not about which company that mailbox belongs to. Writing to it
 * reaches a bank the student is not applying to, from a page that told them
 * it was Evercore.
 *
 * So relevance is checked FIRST and separately from deliverability, and both
 * have to pass. Pure - no network, no database.
 */

import {
  isEducationalDomain,
  isFreemailDomain,
  normaliseHost,
  registrableDomain,
} from "@/lib/company-domains";
import { applyPattern, detectPattern, PATTERN_DERIVE_MIN_SAMPLES, type PatternShape } from "@/lib/email-patterns";

/** What the student is shown, and what it means. */
export type ContactEmailConfidence = "verified" | "catch_all" | "predicted" | "unavailable";

/** The provider's own word, preserved verbatim rather than collapsed. */
export type ProviderEmailStatus = "deliverable" | "catch_all" | "unknown" | "invalid" | null;

export type EmailRejectionReason =
  | "DOMAIN_MISMATCH"
  | "INVALID"
  | "UNKNOWN_DELIVERABILITY"
  | "PERSONAL_DOMAIN"
  | "EDUCATIONAL_DOMAIN"
  | "PREVIOUS_EMPLOYER"
  | "UNAPPROVED_FIRM_DOMAIN"
  | "EMPLOYMENT_UNCONFIRMED"
  | "NO_EMAIL_RETURNED";

/**
 * The domains that count as this firm's own.
 *
 * `approvedAliases` is an explicit list, never inferred. A parent company, an
 * acquirer, a subsidiary or a similarly-named firm does not qualify by being
 * any of those things - the audit found `key.com` shared by KeyCorp, KeyBank
 * AND Cain Brothers, and treating that as one mail domain would put a
 * student's email to a Cain Brothers banker on KeyBank's assumption.
 *
 * Aliases exist because real firms do run more than one: the directory holds
 * eight Barclays contacts at `@barclays.com` while the SEC filing says
 * `home.barclays`, and five JPMorgan contacts at `@jpmorganchase.com` against
 * a stored `jpmorgan.com`. Those are the same employer; `greenhill.com` on an
 * Evercore contact is not.
 */
export type FirmEmailDomains = {
  primaryDomain: string | null;
  approvedAliases: string[];
};

/**
 * The domain part of an address, or null.
 *
 * Strict on purpose. Exactly one `@`, something either side, and the result
 * normalised as a host - so `evercore.com.attacker.com` parses to
 * `evercore.com.attacker.com` and is then compared whole. Nothing here does a
 * substring test, which is the only way that address could ever pass.
 */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const parts = String(email).trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  return normaliseHost(domain);
}

/** Exact registrable-domain membership of the firm's approved set. */
export function isApprovedFirmEmailDomain(input: {
  email: string | null | undefined;
  verifiedDomain: string | null;
  approvedAliases?: string[];
}): boolean {
  const domain = emailDomainOf(input.email);
  if (!domain) return false;

  const approved = [input.verifiedDomain, ...(input.approvedAliases ?? [])]
    .map((d) => registrableDomain(d))
    .filter((d): d is string => Boolean(d));
  if (!approved.length) return false;

  const registrable = registrableDomain(domain);
  // Equality on the registrable domain, so `mail.evercore.com` counts and
  // `evercore.com.attacker.com` (registrable: attacker.com) does not.
  return Boolean(registrable && approved.includes(registrable));
}

/** Bridges FirmEmailDomains (primaryDomain) to the checker's spec-shaped
 *  argument (verifiedDomain). One place, because spreading the former into
 *  the latter silently drops the domain and fails every address open. */
function approvedFor(email: string | null | undefined, firm: FirmEmailDomains): boolean {
  return isApprovedFirmEmailDomain({
    email,
    verifiedDomain: firm.primaryDomain,
    approvedAliases: firm.approvedAliases,
  });
}

export type EmailDecision =
  | {
      usable: true;
      address: string;
      confidence: "verified" | "catch_all";
      source: "crustdata";
    }
  | { usable: false; reason: EmailRejectionReason; address: string | null };

/**
 * One enriched address, judged.
 *
 * Order matters: relevance before deliverability. An `@greenhill.com` address
 * is rejected as DOMAIN_MISMATCH whatever its status, rather than being
 * accepted because the provider happened to confirm the mailbox.
 */
export function decideEnrichedEmail(input: {
  email: string | null | undefined;
  providerStatus: ProviderEmailStatus;
  firm: FirmEmailDomains;
  /** The provider says this person's CURRENT employer is the selected firm. */
  employmentConfirmed: boolean;
  /** Firms the person used to work at, to name the reason precisely. */
  previousCompanies?: string[];
}): EmailDecision {
  const address = input.email ? String(input.email).trim().toLowerCase() : null;
  if (!address) return { usable: false, reason: "NO_EMAIL_RETURNED", address: null };

  const domain = emailDomainOf(address);
  if (!domain) return { usable: false, reason: "DOMAIN_MISMATCH", address };

  if (!input.employmentConfirmed) {
    return { usable: false, reason: "EMPLOYMENT_UNCONFIRMED", address };
  }

  // Named before the generic mismatch, because "this is their old employer's
  // address" is the diagnosis and DOMAIN_MISMATCH is only the symptom.
  if (isFreemailDomain(domain)) return { usable: false, reason: "PERSONAL_DOMAIN", address };
  if (isEducationalDomain(domain)) return { usable: false, reason: "EDUCATIONAL_DOMAIN", address };

  if (!approvedFor(address, input.firm)) {
    const previous = (input.previousCompanies ?? []).map((c) => c.toLowerCase());
    const stem = registrableDomain(domain)?.split(".")[0] ?? "";
    const looksPrevious = stem.length > 2 && previous.some((c) => c.replace(/[^a-z0-9]/g, "").includes(stem));
    return {
      usable: false,
      reason: looksPrevious ? "PREVIOUS_EMPLOYER" : "DOMAIN_MISMATCH",
      address,
    };
  }

  switch (input.providerStatus) {
    case "deliverable":
      return { usable: true, address, confidence: "verified", source: "crustdata" };
    case "catch_all":
      return { usable: true, address, confidence: "catch_all", source: "crustdata" };
    case "invalid":
      return { usable: false, reason: "INVALID", address };
    default:
      // `unknown` and a missing status are the same thing: the provider did
      // not confirm the mailbox. On an approved domain it is still not shown.
      return { usable: false, reason: "UNKNOWN_DELIVERABILITY", address };
  }
}

/**
 * Whether an address may become evidence for the firm's email pattern.
 *
 * Deliberately stricter than "usable". A catch-all address proves the domain
 * accepts mail, not that this person's mailbox is spelled the way we read it,
 * so it may be shown and still not teach us anything. And a predicted address
 * can never be evidence: inferring a pattern from an address the pattern
 * itself produced is circular, and would let one bad seed harden into a
 * confirmed rule.
 */
export function canSeedPattern(input: {
  email: string | null | undefined;
  providerStatus: ProviderEmailStatus;
  firm: FirmEmailDomains;
  employmentConfirmed: boolean;
  /** Where the address came from. Only the provider's own may seed. */
  source: "crustdata" | "pattern_inference" | null;
}): boolean {
  if (input.source !== "crustdata") return false;
  if (input.providerStatus !== "deliverable") return false;
  if (!input.employmentConfirmed) return false;
  return approvedFor(input.email, input.firm);
}

/**
 * Whether an address may teach the firm's email SHAPE - looser than
 * canSeedPattern, which also demands the mailbox be confirmed.
 *
 * A shape is a fact about how the firm spells addresses, not about one
 * mailbox. `nayantara.menon@brookfield.com` came back "unknown" because
 * Brookfield's server will not confirm mailboxes - but it is on the firm's own
 * approved domain and it is exactly first.last of her name, which is all a
 * shape is. So: approved domain, not invalid, and the name must spell the
 * local part (detectPattern), which is what keeps an alias like
 * `nmenon2@...` or a team inbox from teaching anything. The address itself is
 * still never SHOWN unless it passed decideEnrichedEmail.
 */
export function canLearnPattern(input: {
  name: string;
  email: string | null | undefined;
  providerStatus: ProviderEmailStatus;
  firm: FirmEmailDomains;
  employmentConfirmed: boolean;
}): boolean {
  if (!input.email || !input.employmentConfirmed) return false;
  if (input.providerStatus === "invalid") return false;
  if (!approvedFor(input.email, input.firm)) return false;
  return detectPattern(input.name, input.email) !== null;
}

/**
 * Of every address the provider holds for someone, the one to judge: the
 * firm's own domain first (deliverable before not), then whatever the
 * provider would have chosen. A profile that lists the old employer's mailbox
 * beside the current one should be judged on the current one.
 */
export function preferFirmAddress<T extends { email: string; status: string | null }>(
  all: T[],
  firm: FirmEmailDomains,
  fallback: T | null,
): T | null {
  const onFirm = all.filter((e) => approvedFor(e.email, firm));
  return onFirm.find((e) => e.status === "deliverable") ?? onFirm[0] ?? fallback;
}

/**
 * Enough of a name to build an address from.
 *
 * "Joshua O." is not: the surname is an initial, and `first.last` would
 * produce `joshua.o@evercore.com`, which is a guess wearing the costume of a
 * derivation. Anyone whose profile is abbreviated that way gets no email
 * rather than a plausible wrong one.
 */
export function hasCompleteUnambiguousName(name: string | null | undefined): boolean {
  if (!name) return false;
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter((p) => p && !/^\(|\)$/.test(p));
  if (parts.length < 2) return false;

  const last = parts[parts.length - 1].replace(/[.,]/g, "");
  const first = parts[0].replace(/[.,]/g, "");
  // An initial at either end, with or without its full stop.
  if (last.length < 2 || first.length < 2) return false;
  // Letters only. A surname carrying digits or symbols is not safe to build on.
  return /^[\p{L}'’-]+$/u.test(last) && /^[\p{L}'’-]+$/u.test(first);
}

export type ContactEmailResult = {
  email: string | null;
  emailConfidence: ContactEmailConfidence;
  emailDomainRelevant: boolean;
  emailSource: "crustdata" | "pattern_inference" | null;
  /** Internal only. Never rendered. */
  rejection: EmailRejectionReason | null;
  /** The provider's word, kept for diagnosis. Never rendered. */
  providerStatus: ProviderEmailStatus;
  /** The address the provider gave, even when it was rejected. Never rendered. */
  rawProviderEmail: string | null;
};

/**
 * The single decision the rest of the app asks for: what, if anything, do we
 * show as this person's email at this firm.
 *
 * The pattern fallback is reached by EVERY route that fails to produce a
 * usable provider address - a wrong domain, an invalid one, an unknown one, an
 * empty match, or no enrichment at all. They are the same situation from the
 * student's side: we do not have a confirmed address for this person, and we
 * either know the firm's shape well enough to derive one or we say so.
 */
export function resolveContactEmail(input: {
  name: string | null;
  enrichedEmail: string | null | undefined;
  providerStatus: ProviderEmailStatus;
  firm: FirmEmailDomains;
  employmentConfirmed: boolean;
  previousCompanies?: string[];
  /** A pattern only counts once it is CONFIRMED - see canSeedPattern. */
  pattern: { shape: PatternShape; domain: string; sampleCount: number } | null;
}): ContactEmailResult {
  const raw = input.enrichedEmail ? String(input.enrichedEmail).trim().toLowerCase() : null;

  const decision = decideEnrichedEmail({
    email: raw,
    providerStatus: input.providerStatus,
    firm: input.firm,
    employmentConfirmed: input.employmentConfirmed,
    previousCompanies: input.previousCompanies,
  });

  if (decision.usable) {
    return {
      email: decision.address,
      emailConfidence: decision.confidence,
      emailDomainRelevant: true,
      emailSource: "crustdata",
      rejection: null,
      providerStatus: input.providerStatus,
      rawProviderEmail: raw,
    };
  }

  const unavailable = (reason: EmailRejectionReason): ContactEmailResult => ({
    email: null,
    emailConfidence: "unavailable",
    emailDomainRelevant: false,
    emailSource: null,
    rejection: reason,
    providerStatus: input.providerStatus,
    rawProviderEmail: raw,
  });

  // Employment is the one failure the pattern cannot paper over: deriving a
  // firm address for someone we cannot place at the firm manufactures exactly
  // the false association this gate exists to stop.
  //
  // Checked on the FLAG, not on the rejection reason. Found by the fuzzer:
  // decideEnrichedEmail reports NO_EMAIL_RETURNED before it ever looks at
  // employment, so a contact with no enriched address AND no confirmed
  // employment came back reason=NO_EMAIL_RETURNED - and fell straight through
  // to the fallback, which happily built them a PREDICTED @evercore.com
  // address. Reading the reason instead of the fact is what made that
  // reachable.
  if (!input.employmentConfirmed) return unavailable("EMPLOYMENT_UNCONFIRMED");

  const pattern = input.pattern;
  if (!pattern || pattern.sampleCount < PATTERN_DERIVE_MIN_SAMPLES) return unavailable(decision.reason);
  if (!approvedFor(`x@${pattern.domain}`, input.firm)) {
    return unavailable("UNAPPROVED_FIRM_DOMAIN");
  }
  if (!hasCompleteUnambiguousName(input.name)) return unavailable(decision.reason);

  const derived = applyPattern(input.name ?? "", pattern.shape, pattern.domain);
  if (!derived) return unavailable(decision.reason);

  return {
    email: derived,
    emailConfidence: "predicted",
    emailDomainRelevant: true,
    emailSource: "pattern_inference",
    // The reason the provider's own address was not used is still worth
    // keeping: it is how a stale record gets noticed later.
    rejection: decision.reason,
    providerStatus: input.providerStatus,
    rawProviderEmail: raw,
  };
}

/**
 * What to do with a row written before the relevance gate existed.
 *
 * Pure, so the migration can be tested exhaustively without a database and
 * without touching production. The runner's only job is to apply what this
 * returns.
 *
 * Two rules that are easy to get backwards and expensive to get wrong:
 * the raw value is preserved BEFORE the user-facing column is cleared (a
 * quarantine that loses the evidence cannot be diagnosed later), and the
 * mapping never invents certainty - legacy `unverified` collapsed catch-all,
 * unknown AND invalid into one word, so it can only become `unknown`.
 */
export type LegacyEmailDisposition =
  | {
      action: "keep";
      email: string;
      confidence: ContactEmailConfidence | "unknown";
      domainRelevant: boolean;
      source: "crustdata" | "pattern_inference";
      rawProvider: string;
    }
  | {
      action: "quarantine";
      email: null;
      confidence: "unavailable";
      domainRelevant: false;
      source: null;
      rawProvider: string;
      reason: EmailRejectionReason;
    };

export function legacyEmailDisposition(row: {
  email: string | null;
  emailConfidence: string | null;
  /** Already-preserved raw value, when a previous run stored one. */
  emailRawProvider?: string | null;
  firm: FirmEmailDomains;
}): LegacyEmailDisposition | null {
  if (!row.email) return null;
  const rawProvider = row.emailRawProvider ?? row.email;

  if (!approvedFor(row.email, row.firm)) {
    const domain = emailDomainOf(row.email);
    return {
      action: "quarantine",
      email: null,
      confidence: "unavailable",
      domainRelevant: false,
      source: null,
      rawProvider,
      reason: isEducationalDomain(domain)
        ? "EDUCATIONAL_DOMAIN"
        : isFreemailDomain(domain)
          ? "PERSONAL_DOMAIN"
          : "DOMAIN_MISMATCH",
    };
  }

  // confirmed -> verified, inferred -> predicted, unverified -> unknown.
  // `unknown` is NOT renderable, which is the honest outcome: the old word
  // covered addresses the provider had called invalid.
  const confidence =
    row.emailConfidence === "confirmed"
      ? "verified"
      : row.emailConfidence === "inferred"
        ? "predicted"
        : row.emailConfidence === "unverified"
          ? "unknown"
          : ((row.emailConfidence ?? "unknown") as ContactEmailConfidence | "unknown");

  return {
    action: "keep",
    email: row.email,
    confidence,
    domainRelevant: confidence === "verified" || confidence === "catch_all" || confidence === "predicted",
    source: confidence === "predicted" ? "pattern_inference" : "crustdata",
    rawProvider,
  };
}
