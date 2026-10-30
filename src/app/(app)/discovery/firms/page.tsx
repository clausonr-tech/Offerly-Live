import { getFirmCitiesByState, getFirmCountsByCategory, getFirmStates, searchFirms } from "@/lib/firms";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { getCurrentUser } from "@/lib/current-user";
import FirmBrowser from "../FirmBrowser";
import { FIRM_DIRECTORY_FIRST_PAGE, FIRM_DIRECTORY_MORE, FIRM_PAGE_SIZE } from "../firmBrowserConfig";
import {
  ALL_FIRM_TYPES,
  parseFirmFilters,
  resolveFirmType,
  toSearchFilters,
} from "../firmFilterParams";

export const metadata = { title: "Firms" };

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

export default async function FirmsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The filters live in the URL so the back button restores them. Rendering
  // them here rather than letting the client re-fetch on mount is what stops a
  // student who pressed Back from watching an unfiltered page one flash past
  // before their own list returns.
  const [params, user] = await Promise.all([searchParams, getCurrentUser()]);
  // One firm type at a time, opening on the one this student recruits for.
  // See resolveFirmType for how ?sectors= overrides it.
  const firmType = resolveFirmType(params.sectors, user.preferredCategories);
  const filters = { ...parseFirmFilters(params), categories: [firmType] };
  const restoreLimit = Math.max(FIRM_DIRECTORY_FIRST_PAGE, Math.min(filters.shown, 20 * FIRM_PAGE_SIZE));
  // (20 pages is the same ceiling searchFirmsAction puts on a restore.)

  const [firmCountByCategory, states, citiesByState, allFirmsPage, everyFirm] = await Promise.all([
    getFirmCountsByCategory(),
    getFirmStates(),
    getFirmCitiesByState(),
    searchFirms(
      { categories: firmType === ALL_FIRM_TYPES ? [] : [firmType], ...toSearchFilters(filters) },
      restoreLimit,
      0,
    ),
    // The real number of firms, for the hero and "All firm types". Summing the
    // per-type counts said 24,690 against a list of 22,576: a firm with two
    // desks is counted under both types, but it is one firm.
    searchFirms({ categories: [] }, 1, 0),
  ]);

  const firmCount = everyFirm.total;

  return (
    <div>
      {/* Same navy card as Discovery and Opportunities, so the sub-page reads
          as part of the section. Literal hex for the same reason as there. */}
      <div className="mb-8 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)]">
        <div className="min-w-0">
          <h1 className="app-hero-title text-2xl font-normal text-[#ffffff]">Firms</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#c3cfe2]">
            {firmCount > 0 ? `${firmCount.toLocaleString()} firms` : "Every firm"} by industry -
            what the work actually is, when firms recruit, and the bigger names to know.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <FirmBrowser
          initialRows={allFirmsPage.rows}
          initialTotal={allFirmsPage.total}
          states={states}
          citiesByState={citiesByState}
          firstPageSize={FIRM_DIRECTORY_FIRST_PAGE}
          pageSize={FIRM_DIRECTORY_MORE}
          firmTypes={CATEGORIES.map((category) => ({
            value: category,
            label: CATEGORY_LABELS[category],
            count: firmCountByCategory[category] ?? 0,
          }))}
          allFirmsCount={firmCount}
          initialFilters={filters}
        />
      </div>
    </div>
  );
}
