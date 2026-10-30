"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import MultiSelect from "../MultiSelect";
import InternshipPostings, { DEADLINE_STYLES, deadlineLabel, type Posting } from "./InternshipPostings";
import FirmLogo from "./FirmLogo";
import ExpandableGrid from "../ExpandableGrid";
import EmptyState from "@/components/EmptyState";

// The filterable internship list: search, industry, deadline, location and
// sort over a set of postings, mirroring the firm browser's control bar so the
// two Discovery tabs don't teach two different filter interfaces.
//
// Used in two places — under the industry cards on the Discovery tab, where it
// browses everything, and on an industry's own page, where the server has
// already narrowed the rows and `lockedIndustry` drops the industry filter.

export type IndustryOption = { value: string; label: string };

type SortKey = "match" | "deadline" | "firm" | "role";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "match", label: "Best match" },
  { value: "deadline", label: "Deadline soonest" },
  { value: "firm", label: "Firm A–Z" },
  { value: "role", label: "Role A–Z" },
];

const DEADLINE_OPTIONS = [
  { value: "confirmed", label: "Confirmed date" },
  { value: "rolling", label: "Rolling" },
  { value: "tbd", label: "Deadline TBD" },
  { value: "closed", label: "Closed" },
];

// Confirmed first, then rolling, then unknown, then closed — the order a
// student can act on, which is not alphabetical.
const DEADLINE_RANK: Record<string, number> = {
  confirmed: 0,
  rolling: 1,
  tbd: 2,
  closed: 3,
};

export default function InternshipBrowser({
  postings,
  industries,
  programYear,
  lockedIndustry = false,
  heading = "Browse every internship",
  trackedKeys,
  maxColumns = 3,
}: {
  postings: Posting[];
  industries: IndustryOption[];
  programYear: number;
  heading?: string;
  /** Passed straight through to the cards; see InternshipPostings. */
  trackedKeys?: Set<string>;
  /** True on an industry's own page, where the rows are already one industry:
   *  the industry filter would then only ever narrow to nothing, so it is
   *  dropped rather than left there as a control that can't help. */
  lockedIndustry?: boolean;
  /** Passed straight through to InternshipPostings/ExpandableGrid. */
  maxColumns?: 1 | 2 | 3;
}) {
  const industryLabels = useMemo(
    () => Object.fromEntries(industries.map((i) => [i.value, i.label])),
    [industries],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deadlines, setDeadlines] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>("match");
  // One firm open at a time, as on the Opportunities board.
  const [openFirm, setOpenFirm] = useState<string | null>(null);

  // Locations are drawn from the postings themselves rather than a fixed list:
  // the set is small, and a hard-coded one would drift from what was crawled.
  //
  // Grouped state -> city, the same shape the firm directory uses, so the two
  // location filters behave identically. Postings are written "New York, NY",
  // so the state is the trailing two-letter part; anything without one (remote,
  // London, a bare city) stays a top-level row rather than being dropped.
  const locationOptions = useMemo(() => {
    const byState = new Map<string, Set<string>>();
    const loose = new Set<string>();

    for (const p of postings) {
      const raw = p.location?.trim();
      if (!raw) continue;
      const m = /^(.*),\s*([A-Z]{2})$/.exec(raw);
      if (m) {
        const [, city, state] = m;
        if (!byState.has(state)) byState.set(state, new Set());
        byState.get(state)!.add(city.trim());
      } else {
        loose.add(raw);
      }
    }

    const states = [...byState.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([state, cities]) => ({
        value: state,
        label: state,
        children: [...cities]
          .sort((a, b) => a.localeCompare(b))
          .map((c) => ({ value: `${c}, ${state}`, label: c })),
      }));

    const others = [...loose]
      .sort((a, b) => a.localeCompare(b))
      .map((l) => ({ value: l, label: l }));

    return [...states, ...others];
  }, [postings]);

  /** Cities are stored as the posting's full location string, so a city pick
   *  matches exactly; a state pick matches every posting ending in that state. */
  const [cityPicks, setCityPicks] = useState<string[]>([]);

  // Everything except the industry filter. The industry cards' counts are
  // computed from this, so narrowing the search or deadline updates the counts
  // while picking an industry doesn't zero out every other card.
  const withoutIndustry = useMemo(() => {
    const q = query.trim().toLowerCase();
    return postings.filter((p) => {
      if (q) {
        const hay = `${p.firmName} ${p.roleTitle} ${p.location ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (deadlines.length && !deadlines.includes(p.deadlineStatus)) return false;
      if (locations.length || cityPicks.length) {
        const loc = p.location ?? "";
        const stateMatch = locations.some(
          (l) => loc === l || new RegExp(`,\\s*${l}$`).test(loc),
        );
        const cityMatch = cityPicks.includes(loc);
        if (!stateMatch && !cityMatch) return false;
      }
      return true;
    });
  }, [postings, query, deadlines, locations, cityPicks]);

  const visible = useMemo(() => {
    const rows = selected.length
      ? // Overlap, not equality: a cross-listed posting shows under any of the
        // industries it belongs to.
        withoutIndustry.filter((p) => p.categories.some((c) => selected.includes(c)))
      : withoutIndustry;

    const sorted = [...rows];
    sorted.sort((a, b) => {
      if (sort === "firm") return a.firmName.localeCompare(b.firmName);
      if (sort === "role") return a.roleTitle.localeCompare(b.roleTitle);
      if (sort === "deadline") {
        const rank = DEADLINE_RANK[a.deadlineStatus] - DEADLINE_RANK[b.deadlineStatus];
        if (rank !== 0) return rank;
        // Within confirmed, the nearer date first; a posting with no date sorts
        // after one that has it rather than jumping the queue.
        const at = a.deadlineDate ? new Date(a.deadlineDate).getTime() : Infinity;
        const bt = b.deadlineDate ? new Date(b.deadlineDate).getTime() : Infinity;
        if (at !== bt) return at - bt;
        return a.firmName.localeCompare(b.firmName);
      }
      return (
        b.matchScore - a.matchScore ||
        DEADLINE_RANK[a.deadlineStatus] - DEADLINE_RANK[b.deadlineStatus] ||
        a.firmName.localeCompare(b.firmName)
      );
    });
    return sorted;
  }, [withoutIndustry, selected, sort]);

  // One card per firm, its postings folded inside. Laid out flat, a firm that
  // posts twenty programs was twenty near-identical cards ("Evercore, 2028
  // Strategic Advisory...") and everyone else was pushed below them. Firms keep
  // the order of their first posting in the current sort, so "Best match" and
  // "Deadline soonest" still decide which firm comes first.
  const firms = useMemo(() => {
    const byFirm = new Map<string, Posting[]>();
    for (const p of visible) {
      const list = byFirm.get(p.firmName) ?? [];
      list.push(p);
      byFirm.set(p.firmName, list);
    }
    return [...byFirm.entries()].map(([name, rows]) => {
      // The deadline worth showing on the firm's face: the soonest one a
      // student could act on, ranked the same way the deadline sort ranks.
      const soonest = [...rows].sort((a, b) => {
        const rank = DEADLINE_RANK[a.deadlineStatus] - DEADLINE_RANK[b.deadlineStatus];
        if (rank !== 0) return rank;
        const at = a.deadlineDate ? new Date(a.deadlineDate).getTime() : Infinity;
        const bt = b.deadlineDate ? new Date(b.deadlineDate).getTime() : Infinity;
        return at - bt;
      })[0];
      return { name, website: rows[0].firmWebsite, postings: rows, soonest };
    });
  }, [visible]);

  const filtersActive =
    query.trim() !== "" ||
    selected.length > 0 ||
    deadlines.length > 0 ||
    locations.length > 0 ||
    cityPicks.length > 0;

  const clearAll = () => {
    setQuery("");
    setSelected([]);
    setDeadlines([]);
    setLocations([]);
    setCityPicks([]);
  };

  return (
    <div>
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-brand-900">{heading}</h2>
          <p className="text-xs text-warmgray-500">
            {visible.length.toLocaleString()} of {postings.length.toLocaleString()} shown
            {visible.length > 0 &&
              ` · ${firms.length.toLocaleString()} firm${firms.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {/* The master sorting bar. Same idiom as the firm browser above it, so
            the two tabs don't teach two different filter interfaces. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-warmgray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by firm, role or location"
              aria-label="Search internships"
              className="w-full rounded-md border border-brand-300 bg-transparent py-2 pl-9 pr-3 text-sm text-brand-900 placeholder:text-warmgray-500 focus:border-accent-400 focus:outline-none"
            />
          </div>

          {!lockedIndustry && (
            <MultiSelect
              label="All industries"
              options={industries}
              value={selected}
              onChange={setSelected}
            />
          )}
          <MultiSelect
            label="Any deadline"
            options={DEADLINE_OPTIONS}
            value={deadlines}
            onChange={setDeadlines}
          />
          <MultiSelect
            label="All locations"
            options={locationOptions}
            childValues={cityPicks}
            onToggleChild={(city) =>
              setCityPicks(
                cityPicks.includes(city)
                  ? cityPicks.filter((c) => c !== city)
                  : [...cityPicks, city],
              )
            }
            value={locations}
            onChange={setLocations}
            searchable
            searchPlaceholder="Search locations…"
          />

          <label className="flex items-center gap-2 text-xs text-warmgray-500">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort internships"
              className="rounded-md border border-brand-300 bg-transparent px-2 py-2 text-sm text-brand-900 transition-colors hover:border-brand-500 focus:border-accent-400 focus:outline-none"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          {filtersActive && (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 rounded-md px-2 py-2 text-xs text-warmgray-500 hover:text-brand-900"
            >
              <X size={12} aria-hidden />
              Clear filters
            </button>
          )}
        </div>

        {/* The empty state distinguishes "nothing crawled yet" from "your
            filters excluded everything" — they need different next actions. */}
        {postings.length > 0 && visible.length === 0 ? (
          <EmptyState>
            <p>
              No internships match these filters.{" "}
              <button
                type="button"
                onClick={clearAll}
                className="text-accent-500 underline hover:text-accent-400"
              >
                Clear them
              </button>{" "}
              to see all {postings.length.toLocaleString()}.
            </p>
          </EmptyState>
        ) : (
          <ExpandableGrid
            items={firms}
            getKey={(f) => f.name}
            isOpen={(f) => openFirm === f.name}
            gap="gap-3"
            maxColumns={maxColumns}
            renderCard={(f) => {
              const expanded = openFirm === f.name;
              return (
                <button
                  type="button"
                  onClick={() => setOpenFirm(expanded ? null : f.name)}
                  aria-expanded={expanded}
                  className={`flex h-full w-full items-center gap-3 rounded-lg border bg-white p-3 text-left transition-colors ${
                    expanded ? "border-accent-400" : "border-brand-100 hover:border-accent-400"
                  }`}
                >
                  <FirmLogo domain={f.website} name={f.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-brand-900">{f.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-warmgray-500">
                      {f.postings.length} internship{f.postings.length === 1 ? "" : "s"}
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${DEADLINE_STYLES[f.soonest.deadlineStatus]}`}
                      >
                        {deadlineLabel(f.soonest)}
                      </span>
                    </p>
                  </div>
                  <ChevronDown
                    size={14}
                    aria-hidden
                    className={`shrink-0 text-warmgray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                  />
                </button>
              );
            }}
            renderPanel={(f) => (
              <div className="rounded-lg border border-accent-400 bg-brand-50/40 p-3">
                <InternshipPostings
                  trackedKeys={trackedKeys}
                  postings={f.postings}
                  programYear={programYear}
                  industryLabels={industryLabels}
                  // Locked to one industry means the page heading already says
                  // which, so the per-card chip would repeat it on every row.
                  showIndustryTags={!lockedIndustry}
                  showFirm={false}
                  maxColumns={maxColumns}
                />
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
