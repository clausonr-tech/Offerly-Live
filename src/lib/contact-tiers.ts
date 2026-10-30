/**
 * Accumulating contacts across progressively looser searches.
 *
 * Replaces `searchPeopleWidening`, which had two faults that only show up
 * together. It DISCARDED earlier tiers - `last` was overwritten by whichever
 * rung answered most recently, so four good alumni found at tier one were
 * thrown away the moment tier two ran. And it asked every rung for the full
 * five plus the exclusion list regardless of how many were already in hand,
 * which is a paid call for people there was no room to accept.
 *
 * Here each tier keeps what came before, asks only for the slots still open,
 * and stops the instant they are filled.
 *
 * Pure: the caller supplies a `search` function, so the whole ladder can be
 * driven offline from fixtures with no network anywhere near it.
 */

import { hasCompleteUnambiguousName } from "@/lib/contact-email-gate";
import { confirmEmployment, isAdmissibleContact, type EmploymentEvidence, type SelectedFirmIdentity } from "@/lib/employment";

export const MAX_CONTACTS = 5;

/**
 * One rung. `drop` names the PREFERENCE being relaxed - never the employer,
 * which is why `company` appears nowhere in the union: the selected firm is a
 * constraint, not a preference, and no tier may reach it.
 */
type TierRelaxation = "none" | "city" | "gradYear" | "school" | "title" | "role";

export type Tier = {
  label: string;
  drop: TierRelaxation[];
  /**
   * Narrows the school to its business school's names ("The Wharton School")
   * instead of all of the university's. A priority, not a requirement: the
   * university-wide rungs follow, so a Penn alum who never went to Wharton is
   * still a same-school match before anyone from another school. Skipped at
   * no cost for a school with no business-school names.
   */
  businessSchoolOnly?: boolean;
  /**
   * How far up the firm this rung reaches. Absent is the seat's own junior
   * levels (analyst, associate). Widened bottom to top - "mid" adds managers,
   * principals and VPs, "any" drops the filter, MDs and partners included -
   * so a senior person fills a slot only when no junior one is left. Separate
   * rungs because the provider filters on seniority but never returns it, so
   * a single wide search could not be put in order afterwards.
   */
  seniority?: "mid" | "any";
  /**
   * Sends the query's keywords as the provider's free-text search. No ladder
   * rung sets this: free text narrows rather than ranks (an Evercore run that
   * found five people without it found none with it). Only the separate
   * affinity searches use it - see AFFINITY_TIER in lib/contact-search-provider.
   */
  keywords?: boolean;
};

/**
 * The ladder, tightest first.
 *
 * Role is relaxed LAST and is new here. The old ladder only ever dropped
 * school, city and grad year, so the title and seniority filters survived
 * every rung - which is why a Private Equity search at a small firm returned
 * nothing at all: almost nobody at a lower-middle-market shop has "Private
 * Equity" in their title, and no amount of widening the school could fix that.
 */
export const DEFAULT_TIERS: Tier[] = [
  { label: "same business school, same city", drop: [], businessSchoolOnly: true },
  { label: "same business school, any city or graduation year", drop: ["city", "gradYear"], businessSchoolOnly: true },
  { label: "same school, same city", drop: [] },
  { label: "same school, any city", drop: ["city"] },
  { label: "same school, any city or graduation year", drop: ["city", "gradYear"] },
  // Up the firm, bottom to top, still at the student's school and in the seat.
  { label: "same school, up to vice president", drop: ["city", "gradYear"], seniority: "mid" },
  { label: "same school, any seniority", drop: ["city", "gradYear"], seniority: "any" },
  // The school outranks the seat. A Penn alum at Blackstone whose title does
  // not say "Private Equity" - most of them: 268 there, 30 with the words - is
  // a better first email than a stranger whose title does. So the role is
  // loosened here, still at the student's school, before any other school.
  { label: "same school, any junior seat", drop: ["city", "gradYear", "title"] },
  // The widest search of the school: every alum at the firm, any role, any
  // seniority. When it comes back short, the school is confirmed to have run
  // out - the only thing that lets the ladder move on to other schools.
  { label: "same school, any role at the firm", drop: ["city", "gradYear", "role"], seniority: "any" },
  { label: "any school, same city", drop: ["school", "gradYear"] },
  { label: "anyone in the seat", drop: ["school", "gradYear", "city"] },
  { label: "anyone in the seat, up to vice president", drop: ["school", "gradYear", "city"], seniority: "mid" },
  { label: "anyone in the seat, any seniority", drop: ["school", "gradYear", "city"], seniority: "any" },
  { label: "any related finance role at the firm", drop: ["school", "gradYear", "city", "role"] },
];

/** The minimum a candidate must carry to be identified at all. */
export type TierCandidate = {
  crustdataPersonId?: number | null;
  linkedinUrl?: string | null;
  name: string;
  title?: string | null;
  employment: EmploymentEvidence;
  /** Provider flag for a withheld profile. */
  redacted?: boolean;
  /** Every school on the profile, as the provider wrote it. */
  schools?: string[] | null;
};

type RejectionReason =
  | "EMPLOYMENT_UNCONFIRMED"
  | "INCOMING_NOT_REQUESTED"
  | "REDACTED"
  | "NO_STABLE_IDENTIFIER"
  | "DUPLICATE"
  | "EXCLUDED"
  /** Returned by a same-school rung without any of the school's names. */
  | "WRONG_SCHOOL"
  /** "Simran S." - no surname to build an address from, so no email. */
  | "INCOMPLETE_NAME";

export type Accepted<T extends TierCandidate> = {
  contact: T;
  employmentStatus: "current" | "incoming";
};

export type ValidationOutcome<T extends TierCandidate> = {
  accepted: Accepted<T>[];
  rejected: { contact: T; reason: RejectionReason }[];
};

/** How many slots are still open. Never negative. */
export function remainingSlots(acceptedCount: number, max: number = MAX_CONTACTS): number {
  return Math.max(0, max - acceptedCount);
}

/**
 * A person's identity, most stable first.
 *
 * Provider id, then canonical profile URL, then a normalised name - and the
 * name is a LAST resort on purpose. Two different people genuinely share one,
 * so deduplicating on it alone drops a real contact; the batch that saved
 * "Tena Broyles" twice under two different profile URLs is the mirror failure,
 * where only the name would have caught it.
 */
export function identityKeys(c: TierCandidate): string[] {
  // The MOST stable identifier available, and only that one.
  //
  // Returning every key and matching on any of them looks safer and is not:
  // two different people who happen to share a name then collide on the name
  // key and one of them is silently dropped, even though the provider gave
  // each a distinct person id. A shared name is not evidence of a shared
  // person; a shared id is.
  //
  // The name survives only as a last resort, for a candidate carrying neither
  // an id nor a resolvable profile URL - and such a candidate is refused
  // upstream anyway, so in practice it never decides anything here. The
  // same-name-different-URL duplicate that this does NOT catch is caught in
  // the save path instead, which refuses a second row with the same name at
  // the same firm.
  if (c.crustdataPersonId != null) return [`id:${c.crustdataPersonId}`];
  const url = canonicalProfileUrl(c.linkedinUrl);
  if (url) return [`url:${url}`];
  const name = c.name?.trim().toLowerCase().replace(/\s+/g, " ");
  return name ? [`name:${name}`] : [];
}

/** Strips scheme, host casing, locale prefix, trailing slash and query. */
export function canonicalProfileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url)
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .match(/linkedin\.com\/in\/([^/]+)/);
  return m ? `linkedin.com/in/${decodeURIComponent(m[1])}` : null;
}

/**
 * Validate and deduplicate one tier's results against what is already held.
 *
 * `seen` is mutated as candidates are accepted, so a duplicate WITHIN this
 * tier is caught as well as one across tiers - the distinction that let the
 * same person be saved twice from a single batch.
 */
export function validateAndDeduplicate<T extends TierCandidate>(
  results: T[],
  options: {
    firm: SelectedFirmIdentity;
    includeIncoming: boolean;
    /** Keys already accepted or deliberately excluded (an explicit refresh). */
    seen: Set<string>;
    excluded?: Set<string>;
    now?: Date;
    /**
     * Lower-cased exact names of the student's school. When set, a candidate
     * must list one of them - the review that keeps another school out of a
     * same-school rung whatever the provider returns.
     */
    requireSchool?: Set<string>;
    /** Turn away anyone whose surname is only an initial. */
    requireCompleteName?: boolean;
  },
): ValidationOutcome<T> {
  const accepted: Accepted<T>[] = [];
  const rejected: { contact: T; reason: RejectionReason }[] = [];

  for (const contact of results) {
    if (contact.redacted) {
      rejected.push({ contact, reason: "REDACTED" });
      continue;
    }

    const keys = identityKeys(contact);
    // A person with neither a provider id nor a resolvable profile URL cannot
    // be deduplicated reliably on later runs, so they are not accepted at all.
    const stable = keys.some((k) => k.startsWith("id:") || k.startsWith("url:"));
    if (!stable) {
      rejected.push({ contact, reason: "NO_STABLE_IDENTIFIER" });
      continue;
    }

    if (options.excluded && keys.some((k) => options.excluded!.has(k))) {
      rejected.push({ contact, reason: "EXCLUDED" });
      continue;
    }
    if (keys.some((k) => options.seen.has(k))) {
      rejected.push({ contact, reason: "DUPLICATE" });
      continue;
    }

    // Every contact must be emailable. A profile that hides its surname
    // ("Simran S.") cannot take the firm's pattern, and the provider rarely
    // holds an address for it - so it would reach the student with none.
    if (options.requireCompleteName && !hasCompleteUnambiguousName(contact.name)) {
      rejected.push({ contact, reason: "INCOMPLETE_NAME" });
      continue;
    }

    if (
      options.requireSchool &&
      !(contact.schools ?? []).some((s) => options.requireSchool!.has(s.trim().toLowerCase()))
    ) {
      rejected.push({ contact, reason: "WRONG_SCHOOL" });
      continue;
    }

    const verdict = confirmEmployment(contact.employment, options.firm, options.now);
    if (!isAdmissibleContact(verdict, { includeIncoming: options.includeIncoming })) {
      rejected.push({
        contact,
        reason: verdict.status === "incoming" ? "INCOMING_NOT_REQUESTED" : "EMPLOYMENT_UNCONFIRMED",
      });
      continue;
    }

    for (const k of keys) options.seen.add(k);
    accepted.push({ contact, employmentStatus: verdict.status as "current" | "incoming" });
  }

  return { accepted, rejected };
}

type TierRun = {
  tier: string;
  requested: number;
  returned: number;
  accepted: number;
  rejected: Record<string, number>;
};

export type AccumulationResult<T extends TierCandidate> = {
  contacts: Accepted<T>[];
  tiers: TierRun[];
  /** True when the ladder ran out before the slots filled. */
  partial: boolean;
  /**
   * Set when the ladder stopped at the student's school rather than move on
   * to other schools, because it could not confirm the school had run out -
   * the rule is that another school's contact is never shown while the
   * student's own might still have more.
   */
  stoppedAtSchool: boolean;
  /** Set when the next search would have passed the spending limit. */
  stoppedByBudget?: boolean;
};

/** How many times one rung may be asked again for the people it rejected. */
const MAX_RUNG_REPEATS = 5;

/**
 * Walk the ladder, keeping everything valid and asking only for what is left.
 */
export async function accumulateAcrossTiers<T extends TierCandidate>(options: {
  tiers: Tier[];
  firm: SelectedFirmIdentity;
  includeIncoming: boolean;
  max?: number;
  /**
   * Stop widening once this many are held, even below `max`. The pool asks
   * the first rung for a full pool's worth but only walks further down the
   * ladder while it cannot yet fill the final five. Defaults to `max` - the
   * ladder's behavior before the pool existed.
   */
  enough?: number;
  excluded?: Set<string>;
  now?: Date;
  /**
   * The student's school, as its exact names. Every rung that keeps the
   * school admits only people who list one of them; a rung that comes back
   * full with some rejected is asked again (it reaches new people, because
   * the search excludes everyone already returned); and no rung that drops
   * the school runs until the student's school is confirmed to have run out.
   */
  schoolNames?: string[];
  /** Asked before every search: may this one be paid for? No means the
   *  ladder stops where it is - the generation's spending limit. */
  canAfford?: (limit: number) => boolean;
  /** Only people with a full name, who can be given an email - see validateAndDeduplicate. */
  requireCompleteName?: boolean;
  search: (tier: Tier, limit: number) => Promise<T[]>;
}): Promise<AccumulationResult<T>> {
  const max = options.max ?? MAX_CONTACTS;
  const contacts: Accepted<T>[] = [];
  const seen = new Set<string>();
  const tiers: TierRun[] = [];
  const school = options.schoolNames?.length
    ? new Set(options.schoolNames.map((n) => n.trim().toLowerCase()))
    : null;
  // Confirmed = a same-school rung asked for more people than it could find.
  let schoolRanOut = !school;

  const enough = Math.min(options.enough ?? max, max);
  for (const tier of options.tiers) {
    if (contacts.length >= enough) break;
    const keepsSchool = !tier.drop.includes("school");
    if (!keepsSchool && !schoolRanOut) {
      if (remainingSlots(contacts.length, max) > 0) {
        return { contacts, tiers, partial: true, stoppedAtSchool: true };
      }
      break;
    }

    for (let attempt = 0; attempt <= MAX_RUNG_REPEATS; attempt++) {
      const remaining = remainingSlots(contacts.length, max);
      if (remaining === 0) break;
      if (options.canAfford && !options.canAfford(remaining)) {
        return { contacts, tiers, partial: contacts.length < max, stoppedAtSchool: false, stoppedByBudget: true };
      }

      const results = await options.search(tier, remaining);

      const { accepted, rejected } = validateAndDeduplicate(results, {
        firm: options.firm,
        includeIncoming: options.includeIncoming,
        seen,
        excluded: options.excluded,
        now: options.now,
        requireSchool: keepsSchool && school ? school : undefined,
        requireCompleteName: options.requireCompleteName,
      });

      // slice, not push-all: a provider that ignores the limit and returns
      // twenty must not be able to overfill the set.
      const room = remainingSlots(contacts.length, max);
      contacts.push(...accepted.slice(0, room));

      const counts: Record<string, number> = {};
      for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
      tiers.push({
        tier: attempt ? `${tier.label} (repeat ${attempt})` : tier.label,
        requested: remaining,
        returned: results.length,
        accepted: Math.min(accepted.length, room),
        rejected: counts,
      });

      // Fewer than asked for: this rung has nobody left. For the widest
      // same-school rung, that is the confirmation other schools wait on.
      const ranDry = results.length < remaining;
      if (ranDry && keepsSchool && tier.drop.includes("role")) schoolRanOut = true;
      if (ranDry || rejected.length === 0) break;
    }
  }

  return { contacts, tiers, partial: contacts.length < max, stoppedAtSchool: false };
}

/**
 * Signals that, together, suggest two records are one human.
 *
 * Needed because identity alone cannot settle every case. The provider
 * returned "Tena Broyles" twice with different profile URLs, and if the two
 * records also carry different person ids then no stable identifier links
 * them - yet they are plainly one person.
 *
 * The tempting fix is a uniqueness rule on (name, firm). That is wrong, and
 * the tier layer already proved it: two different people called John Smith at
 * one bank are ordinary, and such a rule silently deletes one of them. Losing
 * a real contact is worse than showing a duplicate.
 *
 * So a name match alone NEVER merges. It only opens the question, and several
 * independent fields have to agree before the answer is yes.
 */
export type DuplicateFingerprint = {
  name: string;
  companyId?: number | null;
  title?: string | null;
  location?: string | null;
  schools?: string[] | null;
  gradYear?: number | null;
};

export type DuplicateVerdict = {
  duplicate: boolean;
  /** Which signals agreed, for the review log. */
  agreed: string[];
  basis: "stable_id" | "profile_url" | "fingerprint" | "distinct" | "name_only";
};

const norm = (v: string | null | undefined) =>
  (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Whether `b` is the same person as `a`.
 *
 * Order of authority: a shared stable id settles it; different stable ids
 * settle it the OTHER way (the provider distinguishes them, so we do too); a
 * shared canonical URL settles it; and only with no id on either side do the
 * softer signals get a vote.
 */
export function isProbableDuplicate(
  a: { crustdataPersonId?: number | null; linkedinUrl?: string | null; fingerprint: DuplicateFingerprint },
  b: { crustdataPersonId?: number | null; linkedinUrl?: string | null; fingerprint: DuplicateFingerprint },
  /** How many soft signals beyond the name must agree. */
  minAgreeingSignals = 2,
): DuplicateVerdict {
  if (a.crustdataPersonId != null && b.crustdataPersonId != null) {
    return a.crustdataPersonId === b.crustdataPersonId
      ? { duplicate: true, agreed: ["person_id"], basis: "stable_id" }
      : // DIFFERENT ids mean different people. This is the John Smith rule:
        // the provider has told us they are distinct, and no amount of shared
        // name may overrule it.
        { duplicate: false, agreed: [], basis: "distinct" };
  }

  const urlA = canonicalProfileUrl(a.linkedinUrl);
  const urlB = canonicalProfileUrl(b.linkedinUrl);
  if (urlA && urlB && urlA === urlB) {
    return { duplicate: true, agreed: ["profile_url"], basis: "profile_url" };
  }

  // Neither side carries an id we can compare. Now the soft signals vote, and
  // the name is only the price of entry rather than evidence in itself.
  if (!norm(a.fingerprint.name) || norm(a.fingerprint.name) !== norm(b.fingerprint.name)) {
    return { duplicate: false, agreed: [], basis: "distinct" };
  }

  const agreed: string[] = [];
  const fa = a.fingerprint;
  const fb = b.fingerprint;
  if (fa.companyId != null && fa.companyId === fb.companyId) agreed.push("company_id");
  if (norm(fa.title) && norm(fa.title) === norm(fb.title)) agreed.push("title");
  if (norm(fa.location) && norm(fa.location) === norm(fb.location)) agreed.push("location");
  if (fa.gradYear != null && fa.gradYear === fb.gradYear) agreed.push("grad_year");
  const schoolsA = (fa.schools ?? []).map(norm).filter(Boolean).sort();
  const schoolsB = (fb.schools ?? []).map(norm).filter(Boolean).sort();
  if (schoolsA.length && schoolsA.join("|") === schoolsB.join("|")) agreed.push("schools");

  if (agreed.length >= minAgreeingSignals) {
    return { duplicate: true, agreed, basis: "fingerprint" };
  }
  // A name match with nothing else behind it. Flagged, never enforced.
  return { duplicate: false, agreed, basis: "name_only" };
}
