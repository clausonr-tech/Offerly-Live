"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Filter, Search, X } from "lucide-react";

export type FilterGroup = {
  /** Also the URL search-param key. */
  key: "schools" | "gradYears" | "firms" | "topFirms";
  label: string;
  options: string[];
};

// Below this many options, a typeahead is friction for no reason - picking
// one of six grad years is faster as plain chips than typing to find one.
// Above it (school: 44, the two firm lists: ~55 each), a wall of buttons is
// the friction, and a type-to-narrow box is what makes the list usable.
const TYPEAHEAD_THRESHOLD = 8;

export default function PeopleFilters({
  groups,
  basePath,
}: {
  groups: FilterGroup[];
  /** The page this panel's own filter chips navigate against - originally
   *  always "/messages", now also rendered from Community's People view at
   *  "/networking", so the destination has to be a prop rather than baked in. A
   *  bare path with no query string: toggle()/clearAll() below build the
   *  query themselves from the CURRENT params (which already carries
   *  ?view=people when rendered there), so a basePath that itself included
   *  "?view=people" would double up into "?view=people?view=people...". */
  basePath: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  // Picking a filter calls router.push, which re-runs the server component
  // this panel is rendered under - and that re-suspends the Suspense boundary
  // wrapping it (required for useSearchParams), remounting this component and
  // otherwise silently closing the panel after every single pick.
  //
  // sessionStorage survives that remount, which is what this is really for -
  // but it also survives a genuine hard reload/direct navigation to basePath
  // (bookmarked, typed, or just this page's own nav link), and THAT is a real
  // server round-trip: reading sessionStorage in the initial useState (rather
  // than after mount) made the client's first render disagree with the
  // server's every time this had ever been opened before, which is exactly
  // what React's hydration mismatch warning was catching. Starting closed
  // (matching the server) and syncing from sessionStorage in an effect right
  // after mount costs one open/close swap of the storage read.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Not deriving state from a changing prop (which the lint rule this
    // silences is really guarding against) - this reads a browser API with
    // no render-time equivalent, exactly once, to sync from a value the
    // server could never have known about. That is what effects are for.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (sessionStorage.getItem("people-filters-open") === "1") setOpen(true);
    } catch {
      // Persistence is a nicety, not a requirement - a locked-down storage
      // context just means the panel forgets it was open, same as before.
    }
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);

  function setOpenPersist(next: boolean) {
    setOpen(next);
    try {
      sessionStorage.setItem("people-filters-open", next ? "1" : "0");
    } catch {
      // Persistence is a nicety, not a requirement - a locked-down storage
      // context just means the panel forgets it was open, same as before.
    }
  }

  const activeCount = groups.reduce(
    (n, g) => n + (params.get(g.key) ?? "").split(",").filter(Boolean).length,
    0,
  );

  // Click-outside and Escape both close the panel - the two ways any dropdown
  // in this app is expected to dismiss.
  useEffect(() => {
    if (!open) return;
    // `click`, not `mousedown` - a dropdown option's own onMouseDown fires
    // first (with its own preventDefault, to beat the search input's blur),
    // and a `mousedown` listener here would race it: whichever handler's
    // effects land first would win, and closing the whole panel before the
    // pick's router.push had even started was exactly that race resolving
    // the wrong way. `click` always fires after both a target's own mousedown
    // handling AND its preventDefault have already resolved.
    function onOutsideClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenPersist(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenPersist(false);
    }
    document.addEventListener("click", onOutsideClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle(key: string, value: string) {
    const selected = new Set((params.get(key) ?? "").split(",").filter(Boolean));
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);

    const next = new URLSearchParams(params.toString());
    if (selected.size > 0) next.set(key, [...selected].join(","));
    else next.delete(key);
    router.push(`${basePath}?${next.toString()}`);
  }

  function clearAll() {
    // Drop only the filter keys, not every param - on /feed this panel sits
    // behind ?view=people, and a bare basePath push would silently kick the
    // reader back to the main Feed sub-tab along with clearing the filters.
    const next = new URLSearchParams(params.toString());
    for (const g of groups) next.delete(g.key);
    const query = next.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpenPersist(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`inline-flex h-10 items-center gap-2 rounded-md border px-3.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
          activeCount > 0
            ? "border-accent-500 bg-accent-50 text-brand-900"
            : "border-brand-200 bg-white text-brand-900 hover:bg-brand-50"
        }`}
      >
        <Filter size={15} aria-hidden="true" />
        Filters
        {activeCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-500 px-1 text-[11px] font-semibold text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter people"
          // Anchored to the button's RIGHT edge: the button sits at the right
          // of Connect's toolbar, and a left-anchored 560px panel ran off the
          // screen. Width is capped to the viewport less its gutters.
          className="absolute right-0 top-full z-30 bg-white mt-2 w-[min(calc(100vw-2rem),560px)] rounded-lg border border-brand-100 p-4 shadow-card"
        >
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-warmgray-500">
              Filter people
            </p>
            {activeCount > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 text-xs font-medium text-warmgray-500 hover:text-brand-900"
              >
                <X size={12} aria-hidden="true" />
                Clear all
              </button>
            )}
          </div>

          <div className="mt-3 flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {groups.map((group) => {
              const selected = (params.get(group.key) ?? "").split(",").filter(Boolean);
              return group.options.length > TYPEAHEAD_THRESHOLD ? (
                <TypeaheadGroup
                  key={group.key}
                  group={group}
                  selected={selected}
                  onToggle={(value) => toggle(group.key, value)}
                />
              ) : (
                <ChipGroup
                  key={group.key}
                  group={group}
                  selected={selected}
                  onToggle={(value) => toggle(group.key, value)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The plain case: few enough options that seeing all of them at once beats
 *  typing to find one. */
function ChipGroup({
  group,
  selected,
  onToggle,
}: {
  group: FilterGroup;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const selectedSet = new Set(selected);
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-warmgray-500">
        {group.label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {group.options.map((option) => {
          const active = selectedSet.has(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                active
                  ? "border-accent-500 bg-accent-500 text-white"
                  : "border-brand-200 text-brand-900 hover:bg-brand-50"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Type to narrow, pick from a scrollable dropdown of matches - the search
 *  box only shows suggestions once there is something to search for, and
 *  already-selected values show as their own removable tags above it rather
 *  than staying lit up in a 50-option list you'd have to scroll past. */
function TypeaheadGroup({
  group,
  selected,
  onToggle,
}: {
  group: FilterGroup;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return group.options.filter((o) => o.toLowerCase().includes(q)).slice(0, 50);
  }, [group.options, query]);

  // Same grace-period pattern PersonMenu uses: without it, a click on a
  // dropdown option fires its blur first and the list is gone before the
  // click ever registers.
  function scheduleBlurClose() {
    blurTimer.current = setTimeout(() => setFocused(false), 120);
  }
  function cancelBlurClose() {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }
  useEffect(() => () => cancelBlurClose(), []);

  function pick(value: string) {
    onToggle(value);
    setQuery("");
    inputRef.current?.focus();
  }

  const showDropdown = focused && query.trim().length > 0;

  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-warmgray-500">
        {group.label}
      </p>

      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onToggle(value)}
              className="flex items-center gap-1 rounded-full border border-accent-500 bg-accent-500 px-3 py-1 text-xs font-medium text-white"
            >
              {value}
              <X size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-[9px] text-warmgray-500"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            cancelBlurClose();
            setFocused(true);
          }}
          onBlur={scheduleBlurClose}
          placeholder={`Search ${group.label.toLowerCase()}...`}
          className="w-full rounded-md border border-brand-200 py-1.5 pl-8 pr-3 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />

        {/* In the flow, not absolute: the panel body scrolls, and an
            absolute list inside it was clipped at the panel's bottom edge. */}
        {showDropdown && (
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-brand-100 bg-white py-1 shadow-card">
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-xs text-warmgray-500">No matches.</li>
            ) : (
              matches.map((option) => {
                const active = selectedSet.has(option);
                return (
                  <li key={option}>
                    <button
                      type="button"
                      // mousedown, not click - it fires before the input's own
                      // onBlur, so the pick registers before the dropdown
                      // would otherwise have already closed.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(option);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition hover:bg-brand-50 ${
                        active ? "text-accent-600" : "text-brand-900"
                      }`}
                    >
                      {option}
                      {active && <span className="text-xs">Selected</span>}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
