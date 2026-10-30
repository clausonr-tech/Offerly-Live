import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { getTrackedKeys } from "@/lib/discovery-matches";
import {
  getExpectedPostings,
  getRelevantPostings,
  scorePosting,
  targetProgramYear,
} from "@/lib/internship-postings";
import { internshipYearFor } from "@/lib/internship-year";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_TIMELINE,
  CATEGORY_TIMELINE_TRACKS,
  timelineLead,
  timelineNowMarker,
  type FirmProgramCategory,
} from "@/lib/firm-metadata";
import InternshipBrowser from "../../InternshipBrowser";
import RecruitingTimeline from "../RecruitingTimeline";
import ExpectedPostings from "../../ExpectedPostings";
import EmptyState from "@/components/EmptyState";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

// One industry's internships. The sibling page at ../ is the same idea for
// firms — an industry card on Discovery opens whichever of the two matches the
// tab the student was on.
export default async function CategoryInternshipsPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category: rawCategory } = await params;
  if (!CATEGORIES.includes(rawCategory as FirmProgramCategory)) notFound();
  const category = rawCategory as FirmProgramCategory;

  const user = await getCurrentUser();
  const programYear = user.gradYear ? targetProgramYear(user.gradYear) : null;

  // Deliberately NOT passing preferredCategories: this page is the student
  // asking for one specific industry, which outranks the sector preferences
  // they gave at onboarding. Filtering by both would let an industry card
  // promising N postings open onto fewer.
  const [eligible, expectedAll] = await Promise.all([
    getRelevantPostings({
      gradYear: user.gradYear,
      // Cycle still applies - the industry the student clicked widens the
      // sector filter, not the years they are eligible for.
      internshipYear: internshipYearFor(user),
      preferredCategories: null,
      includeDemo: user.isDemo,
    }),
    // Last cycle's roles not posted for this one yet, labelled as expected
    // (lib/expected-postings) - never mixed into the list above.
    getExpectedPostings({
      gradYear: user.gradYear,
      internshipYear: internshipYearFor(user),
      preferredCategories: [category],
      includeDemo: user.isDemo,
    }),
  ]);
  const expected = expectedAll.filter((e) => e.categories.includes(category));

  const postings = eligible
    .filter((p) => p.categories.includes(category))
    .map((p) => ({ ...p, ...scorePosting(p, user) }));

  return (
    // Full width, matching the combined browser. At max-w-3xl the three-column
    // posting grid had ~230px columns, which wrapped a role title over seven
    // lines and pushed the tags onto a second row - the same cards that read
    // cleanly at the shell's own width.
    <div>
      <Link href="/discovery/internships" className="text-sm text-warmgray-500 hover:underline">
        ← Internships
      </Link>

      <h1 className="mt-3 text-2xl font-semibold text-brand-900">
        {CATEGORY_LABELS[category]} internships
      </h1>
      <p className="mt-1.5 text-sm text-warmgray-600">{CATEGORY_DESCRIPTIONS[category]}</p>

      {/* The two views of one industry are one click apart in both directions,
          so a student who wanted firms and landed on postings isn't stuck. */}
      <Link
        href={`/discovery/${category}`}
        className="mt-3 inline-block text-sm text-accent-500 hover:underline"
      >
        Firms in {CATEGORY_LABELS[category]} →
      </Link>

      {/* The same timeline the firms view carries, for this industry. When a
          student is looking at postings, "am I early or late for this?" is the
          question the list itself cannot answer - the deadline on a row only
          means something against the cycle around it. */}
      <div className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-brand-900">Recruiting timeline</h2>
        <div className="rounded-lg border border-brand-100 bg-white p-5">
          <p className="text-sm font-semibold text-brand-900">
            {CATEGORY_TIMELINE[category].summary}
          </p>
          <RecruitingTimeline
            tracks={CATEGORY_TIMELINE_TRACKS[category]}
            now={timelineNowMarker(programYear, new Date(), timelineLead(CATEGORY_TIMELINE_TRACKS[category]))}
          />
        </div>
      </div>

      <div className="mt-8">
        {!programYear ? (
          <p className="text-sm text-warmgray-500">
            Add your graduation year in your profile to see postings for your recruiting
            cycle.
          </p>
        ) : postings.length === 0 ? (
          <EmptyState>
            No summer {programYear} {CATEGORY_LABELS[category]} postings yet. Most firms
            haven&apos;t opened this cycle — check back as the crawler picks them up
            {expected.length > 0 ? ", and see below for the roles expected to open." : "."}
          </EmptyState>
        ) : (
          <InternshipBrowser
            trackedKeys={await getTrackedKeys(user.id)}
            postings={postings}
            industries={[{ value: category, label: CATEGORY_LABELS[category] }]}
            programYear={programYear}
            lockedIndustry
            heading={`Summer ${programYear} postings`}
          />
        )}
        {programYear && <ExpectedPostings roles={expected} programYear={internshipYearFor(user) ?? programYear} />}
      </div>
    </div>
  );
}
