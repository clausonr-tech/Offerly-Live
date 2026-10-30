/**
 * How close another student is to this one, as an equally-weighted score.
 *
 * Deliberately NOT `rankBySimilarity` in people.ts, which the Connect
 * directory uses. That one is a pile of additive weights - school 40, grad
 * year 20, then 15 per shared sector and 10 per shared firm with no ceiling -
 * so its number is unbounded and one factor can swamp the rest: a member
 * sharing four sectors out-scores a classmate at the same school before
 * anything else is even considered. Useful for ordering a filtered list,
 * meaningless as a displayed number, and not what "Meet Peers" needs.
 *
 * Here every factor is normalised to 0..1 first and then averaged, so each one
 * carries exactly the same weight as every other and the result is a real
 * percentage. Sharing all three of your target firms with someone counts the
 * same as going to their school, which is the stated intent.
 *
 * Pure, and free of the database client on purpose - it takes the rows
 * people.ts already loads, so a test can exercise the maths directly.
 */

import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import type { DirectoryMember, SimilarityProfile } from "@/lib/people";

type PeerFactorKey = "topFirms" | "school" | "sectors" | "gradYear" | "locations" | "niches";

type PeerFactor = {
  key: PeerFactorKey;
  label: string;
  /** 0..1. Every factor is normalised before it is averaged. */
  score: number;
  /** Whether the VIEWER has the data to be compared on this factor at all. */
  applicable: boolean;
  /** Chip text, when this factor actually found something in common. */
  reason: string | null;
};

export type PeerMatch = {
  /** 0..100 - the mean of every applicable factor, rounded. */
  score: number;
  factors: PeerFactor[];
  /** The factors that fired, strongest first, ready to render as chips. */
  reasons: string[];
};

export type RankedPeer = DirectoryMember & { peerMatch: PeerMatch };

/** Names arrive from different queries on both sides (`getTopFirmNames` for
 *  the viewer, `getTopFirmsFor` for everyone else) and schools from a crest
 *  lookup that may fall back to free text, so compare on a normalised key
 *  rather than trusting the two paths to agree on spacing and case. */
function key(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Shared items as a fraction of the SMALLER list.
 *
 * Not Jaccard. A student with three target firms who shares all three with
 * someone tracking twelve has everything in common from where they are
 * standing, and Jaccard would score that 0.25 purely because the other person
 * is casting a wider net. Dividing by the smaller list asks "how much of the
 * shorter list is shared", which is the question a student is actually asking.
 */
function overlap(a: string[], b: string[]): { ratio: number; shared: string[] } {
  if (a.length === 0 || b.length === 0) return { ratio: 0, shared: [] };
  const bKeys = new Set(b.map(key));
  const shared = a.filter((item) => bKeys.has(key(item)));
  return { ratio: shared.length / Math.min(a.length, b.length), shared };
}

/** Same year is a full match; one year apart is half. A junior and a senior
 *  are recruiting on adjacent cycles and still have plenty to say to each
 *  other, which a strict equality test throws away entirely. */
function gradYearCloseness(a: number, b: number): number {
  const gap = Math.abs(a - b);
  if (gap === 0) return 1;
  if (gap === 1) return 0.5;
  return 0;
}

function label(category: string): string {
  return CATEGORY_LABELS[category as FirmProgramCategory] ?? category;
}

/** Joins up to two names and counts the rest, so a chip stays one short line
 *  in a narrow rail: "Goldman Sachs, Evercore +2". */
function nameList(names: string[]): string {
  const [first, second, ...rest] = names;
  const head = second ? `${first}, ${second}` : first;
  return rest.length ? `${head} +${rest.length}` : head;
}

/**
 * Scores one member against the viewer.
 *
 * `applicable` is what keeps the number honest. A viewer who has never set a
 * target city cannot be compared on cities, and counting that as a zero would
 * drag every single person on the platform down by the same sixth - making
 * everyone look like a weak match because of a blank on the VIEWER's own
 * profile. So unscoreable factors are excluded from the average rather than
 * scored zero, and the weighting stays equal across whatever remains.
 */
export function scorePeerMatch(viewer: SimilarityProfile, member: DirectoryMember): PeerMatch {
  const firms = overlap(viewer.topFirms, member.topFirms);
  const sectors = overlap(viewer.preferredCategories, member.preferredCategories);
  const locations = overlap(viewer.targetLocations, member.targetLocations);
  const niches = overlap(viewer.nicheInterests, member.nicheInterests);

  const sameSchool = Boolean(
    viewer.schoolName && member.schoolName && key(viewer.schoolName) === key(member.schoolName),
  );
  const yearScore =
    viewer.gradYear && member.gradYear ? gradYearCloseness(viewer.gradYear, member.gradYear) : 0;

  const factors: PeerFactor[] = [
    {
      key: "topFirms",
      label: "Target firms",
      score: firms.ratio,
      applicable: viewer.topFirms.length > 0,
      reason: firms.shared.length ? `Also targeting ${nameList(firms.shared)}` : null,
    },
    {
      key: "school",
      label: "School",
      score: sameSchool ? 1 : 0,
      applicable: Boolean(viewer.schoolName),
      reason: sameSchool ? `Also at ${member.schoolName}` : null,
    },
    {
      key: "sectors",
      label: "Sectors",
      score: sectors.ratio,
      applicable: viewer.preferredCategories.length > 0,
      reason: sectors.shared.length ? `Into ${nameList(sectors.shared.map(label))}` : null,
    },
    {
      key: "gradYear",
      label: "Grad year",
      score: yearScore,
      applicable: Boolean(viewer.gradYear),
      reason:
        yearScore === 1
          ? `Class of ${member.gradYear}`
          : yearScore > 0
            ? `Graduating ${member.gradYear}`
            : null,
    },
    {
      key: "locations",
      label: "Cities",
      score: locations.ratio,
      applicable: viewer.targetLocations.length > 0,
      reason: locations.shared.length ? `Both want ${nameList(locations.shared)}` : null,
    },
    {
      key: "niches",
      label: "Interests",
      score: niches.ratio,
      applicable: viewer.nicheInterests.length > 0,
      reason: niches.shared.length ? `Shared interest in ${nameList(niches.shared)}` : null,
    },
  ];

  const scoreable = factors.filter((f) => f.applicable);
  const score = scoreable.length
    ? Math.round((scoreable.reduce((sum, f) => sum + f.score, 0) / scoreable.length) * 100)
    : 0;

  const reasons = factors
    .filter((f) => f.reason && f.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((f) => f.reason as string);

  return { score, factors, reasons };
}

/**
 * Every member scored and ordered, closest first.
 *
 * Ties break on name rather than being left to the input order, so the rail
 * does not reshuffle between renders - the same stability rule
 * `rankBySimilarity` follows, and it matters more here because this list is
 * short enough that a student will notice two people swapping places.
 */
export function rankPeerMatches(
  viewer: SimilarityProfile,
  members: DirectoryMember[],
): RankedPeer[] {
  return members
    .map((member) => ({ ...member, peerMatch: scorePeerMatch(viewer, member) }))
    .sort((a, b) => b.peerMatch.score - a.peerMatch.score || a.name.localeCompare(b.name));
}

/** Whether the viewer's own profile carries enough to compare anyone on.
 *  An empty profile scores everybody 0, and the rail should say why rather
 *  than present a list of zeroes as if they were findings. */
export function hasScoreableProfile(viewer: SimilarityProfile): boolean {
  return (
    viewer.topFirms.length > 0 ||
    Boolean(viewer.schoolName) ||
    viewer.preferredCategories.length > 0 ||
    Boolean(viewer.gradYear) ||
    viewer.targetLocations.length > 0 ||
    viewer.nicheInterests.length > 0
  );
}
