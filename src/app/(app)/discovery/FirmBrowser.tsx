"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, Check, X, ChevronDown } from "lucide-react";
import FirmLogo from "./FirmLogo";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import MultiSelect from "../MultiSelect";
import type { FirmSearchRow } from "@/lib/firms";
import { searchFirmsAction } from "./firmSearchAction";
import {
  ALL_FIRM_TYPES,
  applyFirmFilters,
  EMPTY_FIRM_FILTERS,
  parseAum,
  type FirmFilterState,
} from "./firmFilterParams";
import EmptyState from "@/components/EmptyState";

// Filterable, paged view of the firm directory.
//
// It is used two ways: on a sector page with `lockedCategory` set, where the
// sector filter disappears and every query is confined to that sector, and on
// the Firms directory with `firmTypes`, where one firm type at a time is
// picked from a single dropdown bubble at the top (starting on the type the
// student recruits for). Both go through the same server action, so paging and
// filtering behave the same in either place.
//
// The other filters are multi-select and OR-ed within themselves: sizes and
// locations answer "any of these", because the single-value versions forced
// a student comparing PE and RE, or New York and Chicago, into separate passes
// through the directory. Size and location also take free input - a typed range
// and typed place names - since the preset bands and the state list only cover
// the shapes the SEC data happens to have.

const AUM_OPTIONS = [
  { value: "mega", label: "$100B+" },
  { value: "large", label: "$10B - $100B" },
  { value: "mid", label: "$1B - $10B" },
  { value: "small", label: "Under $1B" },
  { value: "unreported", label: "Not reported" },
] as const;

// The custom-range slider is logarithmic between $1M and $1T. AUM spans six
// orders of magnitude, so a linear track would spend nine tenths of its length
// above $100B, where almost no firms are.
const AUM_MIN_EXP = 6;
const AUM_MAX_EXP = 12;
const SLIDER_STEPS = 1000;

function sliderToAum(pos: number): number {
  const t = pos / SLIDER_STEPS;
  return Math.round(10 ** (AUM_MIN_EXP + t * (AUM_MAX_EXP - AUM_MIN_EXP)));
}

function aumToSlider(v: number): number {
  const exp = Math.log10(Math.max(v, 10 ** AUM_MIN_EXP));
  const t = (exp - AUM_MIN_EXP) / (AUM_MAX_EXP - AUM_MIN_EXP);
  return Math.round(Math.min(Math.max(t, 0), 1) * SLIDER_STEPS);
}

function formatAum(aum: number | null): string | null {
  if (!aum) return null;
  if (aum >= 1e12) return `$${(aum / 1e12).toFixed(1)}T`;
  if (aum >= 1e9) return `$${Math.round(aum / 1e9)}B`;
  if (aum >= 1e6) return `$${Math.round(aum / 1e6)}M`;
  return `$${aum}`;
}

/** What the slider writes back into the text box - the same units a person
 *  would have typed, so dragging then editing doesn't hand them "2500000000". */
function toAumInput(v: number): string {
  if (v >= 1e12) return `${+(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${Math.round(v / 1e6)}M`;
  return String(v);
}

function rangeLabel(min: number | null, max: number | null): string | null {
  if (min && max) return `${formatAum(min)} - ${formatAum(max)}`;
  if (min) return `${formatAum(min)}+`;
  if (max) return `Under ${formatAum(max)}`;
  return null;
}

export default function FirmBrowser({
  initialRows,
  initialTotal,
  states,
  citiesByState = {},
  lockedCategory = null,
  pageSize,
  firstPageSize = pageSize,
  firmTypes,
  allFirmsCount,
  initialFilters = EMPTY_FIRM_FILTERS,
}: {
  initialRows: FirmSearchRow[];
  initialTotal: number;
  states: string[];
  /** Cities that actually have firms, keyed by state. */
  citiesByState?: Record<string, string[]>;
  lockedCategory?: FirmProgramCategory | null;
  /** Rows each "show more" adds. */
  pageSize: number;
  /** Rows in the first page, and after any filter change. Defaults to pageSize. */
  firstPageSize?: number;
  /** When set (and nothing is locked), the sector filter is ONE firm type,
   *  chosen from a dropdown bubble above the controls, with the count each
   *  type holds. `initialFilters.categories` is then `[type]` or `["all"]`. */
  firmTypes?: { value: FirmProgramCategory; label: string; count: number }[];
  /** The count beside "All firm types" in that dropdown. */
  allFirmsCount?: number;
  /** Seeded from the URL by the page, so the first server render already shows
   *  the filtered list a student is coming back to. */
  initialFilters?: FirmFilterState;
}) {
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState(initialFilters.query);
  const [aumBands, setAumBands] = useState<string[]>(initialFilters.aumBands);
  // Kept as the raw strings so a half-typed "1." survives a re-render; the
  // numbers below are derived, and derived is what reaches the query.
  const [aumMinText, setAumMinText] = useState(initialFilters.aumMinText);
  const [aumMaxText, setAumMaxText] = useState(initialFilters.aumMaxText);
  const [pickedStates, setPickedStates] = useState<string[]>(initialFilters.states);
  const [locationTerms, setLocationTerms] = useState<string[]>(initialFilters.locationTerms);
  const [locationDraft, setLocationDraft] = useState("");
  // A list, not a single value: a student comparing IB, PE and RE wants all
  // three at once rather than three separate passes through the directory.
  const [categories, setCategories] = useState<string[]>(
    lockedCategory ? [lockedCategory] : initialFilters.categories,
  );
  const [verifiedOnly, setVerifiedOnly] = useState(initialFilters.verifiedOnly);
  const [pending, startTransition] = useTransition();
  const [loadingMore, setLoadingMore] = useState(false);

  const aumMin = parseAum(aumMinText);
  const aumMax = parseAum(aumMaxText);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const restoredScroll = useRef(false);

  // Serialised so the effect compares by content: these are fresh arrays on
  // every render, and a raw array in the dependency list re-fires the search on
  // every keystroke in the search box.
  const bandsKey = aumBands.join(",");
  const statesKey = pickedStates.join(",");
  const termsKey = locationTerms.join("|");
  const categoriesKey = categories.join(",");

  // The filters the rows on screen were fetched for. Starts as the server's
  // own, so mounting does not re-request the page it already rendered.
  //
  // By value rather than a "has mounted" flag: React runs effects twice in
  // development, the second run got past the flag, and its search - one first
  // page - replaced a restored list. Coming back to a view paged to 150 rows
  // showed 100 (60 before that), and the scroll position went with it.
  const searchKey = JSON.stringify([
    query,
    bandsKey,
    aumMin,
    aumMax,
    statesKey,
    termsKey,
    categoriesKey,
    verifiedOnly,
    lockedCategory,
  ]);
  const searchedKey = useRef(searchKey);

  const typePicker = !lockedCategory && !!firmTypes;

  function filterArgs(offset: number) {
    return {
      categories: lockedCategory
        ? [lockedCategory]
        : categories.filter((c) => c !== ALL_FIRM_TYPES),
      query,
      aumBands,
      aumMin,
      aumMax,
      states: pickedStates,
      locationTerms,
      verifiedOnly,
      offset,
    };
  }

  // One debounce covers every control, not just the text box: changing a filter
  // while still typing should collapse into a single request rather than race.
  useEffect(() => {
    if (searchKey === searchedKey.current) return;
    searchedKey.current = searchKey;
    const t = setTimeout(() => {
      startTransition(async () => {
        const res = await searchFirmsAction({ ...filterArgs(0), limit: firstPageSize });
        setRows(res.rows);
        setTotal(res.total);
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  // Everything in the URL, including params this component does not own, so the
  // open tab survives a filter change.
  const fullQuery = applyFirmFilters(
    new URLSearchParams(searchParams.toString()),
    {
      query,
      categories: lockedCategory ? [] : categories,
      aumBands,
      aumMinText,
      aumMaxText,
      states: pickedStates,
      locationTerms,
      verifiedOnly,
      shown: rows.length,
    },
    firstPageSize,
  ).toString();

  /** Where a firm link should send the student back to. */
  const returnTo = fullQuery ? `${pathname}?${fullQuery}` : pathname;

  // Mirror the filters into the URL. `replace`, not `push`: typing in the
  // search box should not bury the back button under one history entry per
  // keystroke. The entry still carries the filters when a student clicks
  // through to a firm, which is what makes Back restore this view.
  useEffect(() => {
    const t = setTimeout(() => {
      router.replace(returnTo, { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [returnTo, router]);

  // Restore the paged-through list in ONE request rather than replaying every
  // "show more" the student pressed.
  useEffect(() => {
    if (initialFilters.shown <= initialRows.length) return;
    let cancelled = false;
    (async () => {
      const res = await searchFirmsAction({ ...filterArgs(0), limit: initialFilters.shown });
      if (cancelled) return;
      setRows(res.rows);
      setTotal(res.total);
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately mount-only: this restores the view the student left, and
    // re-running it on a filter change would fight the search effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll position, saved per URL and restored once the rows are back.
  //
  // Only for URLs that carry filter state: arriving at a bare /discovery from
  // the nav should start at the top, which is the case where resetting is the
  // helpful behaviour. Coming back from a firm always carries params, because
  // paging writes `shown` and filtering writes the rest.
  const scrollKey = `firmbrowser:${pathname}?${fullQuery}`;
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        try {
          sessionStorage.setItem(scrollKey, String(window.scrollY));
        } catch {
          // Private browsing and blocked site data both throw here; losing the
          // scroll position is not worth breaking the page over.
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollKey]);

  useEffect(() => {
    if (restoredScroll.current || !fullQuery) return;
    // Wait until the restored rows are actually on screen, or the page is still
    // one screen tall and scrolling to a saved offset does nothing.
    if (rows.length < Math.min(initialFilters.shown || initialRows.length, total)) return;
    restoredScroll.current = true;
    try {
      const saved = Number(sessionStorage.getItem(`firmbrowser:${pathname}?${fullQuery}`));
      if (Number.isFinite(saved) && saved > 0) {
        requestAnimationFrame(() => window.scrollTo(0, saved));
      }
    } catch {
      // See above - a blocked sessionStorage just means no restore.
    }
  }, [rows.length, total, fullQuery, pathname, initialFilters.shown, initialRows.length]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await searchFirmsAction({ ...filterArgs(rows.length), limit: pageSize });
      setRows((prev) => [...prev, ...res.rows]);
      setTotal(res.total);
    } finally {
      setLoadingMore(false);
    }
  }

  function addLocationTerm() {
    const t = locationDraft.trim();
    if (!t) return;
    // Case-insensitive dedupe: the match is ILIKE, so "chicago" and "Chicago"
    // are the same filter and two chips for it would just look broken.
    if (!locationTerms.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setLocationTerms([...locationTerms, t]);
    }
    setLocationDraft("");
  }

  const aumActive = aumBands.length > 0 || aumMin !== null || aumMax !== null;
  const locationCount = pickedStates.length + locationTerms.length;

  const aumSummaryParts: string[] = [];
  if (aumBands.length === 1) {
    aumSummaryParts.push(AUM_OPTIONS.find((o) => o.value === aumBands[0])?.label ?? "1 size");
  } else if (aumBands.length > 1) {
    aumSummaryParts.push(`${aumBands.length} sizes`);
  }
  const customRange = rangeLabel(aumMin, aumMax);
  if (customRange) aumSummaryParts.push(customRange);

  const filtersActive =
    !!query.trim() ||
    aumActive ||
    locationCount > 0 ||
    verifiedOnly ||
    // The firm type is the view, not a filter to clear - Clear leaves it be.
    (!lockedCategory && !typePicker && categories.length > 0);

  function clearAum() {
    setAumBands([]);
    setAumMinText("");
    setAumMaxText("");
  }

  function clearLocations() {
    setPickedStates([]);
    setLocationTerms([]);
    setLocationDraft("");
  }

  function reset() {
    setQuery("");
    clearAum();
    clearLocations();
    setVerifiedOnly(false);
    if (!lockedCategory && !typePicker) setCategories([]);
  }

  const numberBoxClass =
    "w-full rounded-sm border border-brand-300 bg-transparent px-2 py-1 text-sm text-brand-900 placeholder:text-warmgray-600 focus:border-accent-500 focus:outline-none";

  const pickedType = categories[0] ?? ALL_FIRM_TYPES;

  return (
    <div>
      {typePicker && (
        // One white bubble in place of the fourteen navy industry pills that
        // used to sit here. Those were links out to each industry's page, and
        // as a wall of equal-weight choices they buried the one a student
        // actually recruits for. This opens on that type and changes the list
        // below in place.
        //
        // A native <select> under the pill styling: it is the control a phone
        // already knows how to present, and it needs no popover of its own.
        // Literal white and navy, not bg-white/text-brand-900, which the dark
        // theme inverts - "white bubble" should stay white in both.
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="firm-type-heading" className="text-base font-semibold text-brand-900">
            Browse firms in
          </h2>
          <div className="relative inline-flex">
            <select
              aria-labelledby="firm-type-heading"
              value={pickedType}
              onChange={(e) => setCategories([e.target.value])}
              className="cursor-pointer appearance-none rounded-full border border-[#0b1526]/15 bg-[#ffffff] py-2 pl-4 pr-10 text-sm font-medium text-[#0b1526] shadow-card transition-colors hover:border-[#0b1526]/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              {firmTypes!.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} ({t.count.toLocaleString()})
                </option>
              ))}
              <option value={ALL_FIRM_TYPES}>
                All firm types
                {allFirmsCount ? ` (${allFirmsCount.toLocaleString()})` : ""}
              </option>
            </select>
            <ChevronDown
              size={16}
              aria-hidden="true"
              className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[#0b1526]/70"
            />
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-warmgray-600"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by firm name or location"
            className="w-full rounded-md border border-brand-200 py-2 pl-9 pr-3 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
        </div>

        {!lockedCategory && !typePicker && (
          <MultiSelect
            label="All sectors"
            value={categories}
            onChange={setCategories}
            options={(Object.keys(CATEGORY_LABELS) as FirmProgramCategory[]).map((c) => ({
              value: c,
              label: CATEGORY_LABELS[c],
            }))}
          />
        )}

        <MultiSelect
          label="All sizes"
          value={aumBands}
          onChange={setAumBands}
          options={AUM_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          active={aumActive}
          summary={aumSummaryParts.join(" · ") || "All sizes"}
          onClear={clearAum}
          footer={
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-600">
                Custom range
              </p>

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  inputMode="decimal"
                  value={aumMinText}
                  onChange={(e) => setAumMinText(e.target.value)}
                  placeholder="Min"
                  aria-label="Minimum assets under management"
                  className={numberBoxClass}
                />
                <span className="text-xs text-warmgray-600">to</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={aumMaxText}
                  onChange={(e) => setAumMaxText(e.target.value)}
                  placeholder="Max"
                  aria-label="Maximum assets under management"
                  className={numberBoxClass}
                />
              </div>

              <p className="text-[11px] text-warmgray-600">
                Type a number, or use $ shorthand - 750M, 2.5B, 1T.
              </p>

              <label className="block">
                <span className="flex items-center justify-between text-[11px] text-warmgray-600">
                  <span>Min</span>
                  <span>{aumMin ? formatAum(aumMin) : "Any"}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={SLIDER_STEPS}
                  value={aumMin ? aumToSlider(aumMin) : 0}
                  onChange={(e) => {
                    const pos = Number(e.target.value);
                    // Position zero is the "no minimum" end of the track, not
                    // a literal $1M floor.
                    setAumMinText(pos === 0 ? "" : toAumInput(sliderToAum(pos)));
                  }}
                  className="w-full accent-accent-500"
                />
              </label>

              <label className="block">
                <span className="flex items-center justify-between text-[11px] text-warmgray-600">
                  <span>Max</span>
                  <span>{aumMax ? formatAum(aumMax) : "Any"}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={SLIDER_STEPS}
                  value={aumMax ? aumToSlider(aumMax) : SLIDER_STEPS}
                  onChange={(e) => {
                    const pos = Number(e.target.value);
                    setAumMaxText(pos === SLIDER_STEPS ? "" : toAumInput(sliderToAum(pos)));
                  }}
                  className="w-full accent-accent-500"
                />
              </label>
            </div>
          }
        />

        <MultiSelect
          label="All locations"
          value={pickedStates}
          onChange={setPickedStates}
          // Cities hang off their state. Picking one adds it to the same
          // free-text place list the "Add a place" box writes to, so it filters
          // through the existing headquarters match with no new query path.
          options={states.map((s) => ({
            value: s,
            label: s,
            children: (citiesByState[s] ?? []).map((c) => ({ value: c, label: c })),
          }))}
          childValues={locationTerms}
          onToggleChild={(city) =>
            setLocationTerms(
              locationTerms.includes(city)
                ? locationTerms.filter((t) => t !== city)
                : [...locationTerms, city],
            )
          }
          searchable
          searchPlaceholder="Find a state"
          active={locationCount > 0}
          summary={
            locationCount === 0
              ? "All locations"
              : locationCount === 1
                ? (pickedStates[0] ?? locationTerms[0])
                : `Locations · ${locationCount}`
          }
          onClear={clearLocations}
          footer={
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-600">
                Add a place
              </p>

              {locationTerms.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {locationTerms.map((t) => (
                    <span
                      key={t}
                      className="flex items-center gap-1 rounded-sm bg-brand-50 px-1.5 py-0.5 text-xs text-brand-900"
                    >
                      {t}
                      <button
                        type="button"
                        aria-label={`Remove ${t}`}
                        onClick={() => setLocationTerms(locationTerms.filter((x) => x !== t))}
                        className="text-warmgray-600 hover:text-brand-900"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={locationDraft}
                  onChange={(e) => setLocationDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      // The popover sits inside no form today, but Enter here
                      // means "add this chip" either way.
                      e.preventDefault();
                      addLocationTerm();
                    }
                  }}
                  placeholder="e.g. Chicago, London"
                  aria-label="Add a city or region"
                  className={numberBoxClass}
                />
                <button
                  type="button"
                  onClick={addLocationTerm}
                  disabled={!locationDraft.trim()}
                  className="shrink-0 rounded-sm border border-brand-200 px-2 py-1 text-xs text-brand-900 hover:border-brand-300 disabled:opacity-50"
                >
                  Add
                </button>
              </div>

              <p className="text-[11px] text-warmgray-600">
                Matches the headquarters text, so cities and countries both work.
              </p>
            </div>
          }
        />

        <button
          type="button"
          onClick={() => setVerifiedOnly((v) => !v)}
          aria-pressed={verifiedOnly}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm ${
            verifiedOnly
              ? "border-accent-500 bg-accent-50 text-accent-700"
              : "border-brand-200 text-warmgray-600 hover:border-brand-300"
          }`}
        >
          {verifiedOnly && <Check size={13} />}
          Known student program
        </button>

        {filtersActive && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-warmgray-600 underline hover:text-brand-900"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mb-2 flex items-center justify-between text-xs text-warmgray-600">
        <span>
          {pending ? "Searching…" : `${total.toLocaleString()} firm${total === 1 ? "" : "s"}`}
          {total > rows.length && !pending && ` · showing ${rows.length.toLocaleString()}`}
        </span>
      </div>

      {rows.length === 0 && !pending ? (
        <EmptyState>
          <p>No firms match these filters.</p>
          {/* This pair always returns nothing, and silently: the firms with a
              known student program are the hand-curated ones, whose HQ is
              recorded as "United States" with no city or state, while the
              location filter only has data for the SEC-imported rows. Saying so
              beats letting it look like a broken search. */}
          {pickedStates.length > 0 && verifiedOnly && (
            <p className="mx-auto mt-2 max-w-md text-xs">
              Firms with a known student program don&apos;t have a state on record yet, so that
              filter and the location filter can&apos;t be combined.
            </p>
          )}
        </EmptyState>
      ) : (
        <>
          {/* auto-rows-fr + h-full on the card: without them a firm whose name
              wraps to two lines made its card taller than the two beside it,
              and the row read as ragged. Same treatment the posting cards
              carry. */}
          <div className="grid auto-rows-fr gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((firm) => {
              const aum = formatAum(firm.aum);
              return (
                <Link
                  key={firm.slug}
                  // The exact view to restore on the way back. Carried
                  // explicitly rather than inferred from history, so it also
                  // works after a refresh or a shared link.
                  href={`/discovery/firm/${firm.slug}?from=${encodeURIComponent(returnTo)}`}
                  className="flex h-full items-start gap-2.5 rounded-lg border border-brand-100 bg-white p-3 hover:border-brand-300"
                >
                  <FirmLogo domain={firm.website} name={firm.name} />
                  {/* Same bottom-pinning as the posting cards. */}
                  <span className="flex min-w-0 flex-1 flex-col self-stretch">
                    <span className="block truncate text-sm font-medium text-brand-900">
                      {firm.name}
                    </span>
                    <span className="block truncate text-xs text-warmgray-600">
                      {firm.headquarters}
                    </span>
                    {(aum || firm.hasVerifiedProgram) && (
                      <span className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                        {aum && (
                          <span className="rounded-sm bg-brand-50 px-1 py-px text-[10px] font-medium text-brand-700">
                            {aum} AUM
                          </span>
                        )}
                        {firm.hasVerifiedProgram && (
                          <span className="rounded-sm bg-success-50 px-1 py-px text-[10px] font-medium text-success-700">
                            Student program
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>

          {rows.length < total && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-md border border-brand-200 px-4 py-2 text-sm font-medium text-brand-900 hover:border-brand-300 disabled:opacity-60"
              >
                {loadingMore
                  ? "Loading…"
                  : `Show ${Math.min(pageSize, total - rows.length).toLocaleString()} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
