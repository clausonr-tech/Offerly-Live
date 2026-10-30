import Link from "next/link";
import { notFound } from "next/navigation";
import { searchFirms, getFirmCitiesByState, getFirmStates } from "@/lib/firms";
import { getCurrentUser } from "@/lib/current-user";
import { targetProgramYear } from "@/lib/internship-postings";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_TIMELINE,
  CATEGORY_TIMELINE_TRACKS,
  timelineLead,
  timelineNowMarker,
  type FirmProgramCategory,
} from "@/lib/firm-metadata";
import FirmBrowser from "../FirmBrowser";
import { parseFirmFilters, toSearchFilters } from "../firmFilterParams";
import { FIRM_PAGE_SIZE } from "../firmBrowserConfig";
import RecruitingTimeline from "./RecruitingTimeline";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

export default async function DiscoveryCategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { category: rawCategory } = await params;
  if (!CATEGORIES.includes(rawCategory as FirmProgramCategory)) notFound();
  const category = rawCategory as FirmProgramCategory;

  // First page only. The sector's full list is reachable through the browser's
  // filters and "show more" - loading all of it here is what made asset &
  // wealth management (9,000 firms) slow to open.
  // Same URL-backed filters as the unlocked directory, minus the sector, which
  // this page pins.
  const filters = parseFirmFilters(await searchParams);
  const restoreLimit = Math.max(FIRM_PAGE_SIZE, Math.min(filters.shown, 20 * FIRM_PAGE_SIZE));

  const [firmPage, states, citiesByState, user] = await Promise.all([
    searchFirms({ categories: [category], ...toSearchFilters(filters) }, restoreLimit, 0),
    getFirmStates(),
    getFirmCitiesByState(),
    getCurrentUser(),
  ]);
  const timeline = CATEGORY_TIMELINE[category];

  // Recomputed on every request rather than baked in at build time, which is
  // what keeps the marker honest as the months pass. The page already renders
  // per-request (getCurrentUser reads cookies), so this costs nothing extra.
  const programYear = user.gradYear ? targetProgramYear(user.gradYear) : null;
  const now = timelineNowMarker(programYear, new Date(), timelineLead(CATEGORY_TIMELINE_TRACKS[category]));

  return (
    // Full width, matching the internships view. At max-w-3xl the timeline was
    // squeezed into 768px - it scrolls sideways below 44rem - and the firm grid
    // ran three ~230px columns.
    <div>
      <Link href="/discovery" className="text-sm text-warmgray-500 hover:underline">
        ← Discovery
      </Link>

      <h1 className="mt-3 text-2xl font-semibold text-brand-900">
        {CATEGORY_LABELS[category]}
      </h1>
      <p className="mt-1.5 text-sm text-warmgray-600">{CATEGORY_DESCRIPTIONS[category]}</p>

      {/* The mirror of the "Firms in ..." link on the postings page. The two
          views of one industry are meant to be one click apart in BOTH
          directions - the comment over there already said so, but only the
          postings-to-firms half existed, so a student who opened firms and
          actually wanted openings had to go back out to Discovery. */}
      <Link
        href={`/discovery/${category}/internships`}
        className="mt-3 inline-block text-sm text-accent-500 hover:underline"
      >
        Internships in {CATEGORY_LABELS[category]} →
      </Link>

      <div className="mt-6">
        <h2 className="mb-2 text-base font-semibold text-brand-900">Recruiting timeline</h2>
        <div className="rounded-lg border border-brand-100 bg-white p-5">
          <p className="text-sm font-semibold text-brand-900">{timeline.summary}</p>

          {/* The timing prose that used to sit here is gone. The chart above
              says the same thing in the form the student actually reads, and
              the paragraph repeated it at length under every sector. */}
          <RecruitingTimeline tracks={CATEGORY_TIMELINE_TRACKS[category]} now={now} />
        </div>
      </div>

      <div className="mt-8">
        <h2 className="mb-2 text-base font-semibold text-brand-900">
          Firms in {CATEGORY_LABELS[category]}
        </h2>
        {firmPage.total === 0 ? (
          <p className="text-sm text-warmgray-600">No firms listed for this type yet.</p>
        ) : (
          <FirmBrowser
            initialRows={firmPage.rows}
            initialTotal={firmPage.total}
            states={states}
              citiesByState={citiesByState}
            lockedCategory={category}
            pageSize={FIRM_PAGE_SIZE}
            initialFilters={filters}
          />
        )}
      </div>
    </div>
  );
}
