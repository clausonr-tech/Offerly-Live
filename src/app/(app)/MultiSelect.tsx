"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

/**
 * A compact multi-select filter: a button that opens a checkbox list.
 *
 * Presentational on purpose - it owns no filter state, just `value` and
 * `onChange`. Discovery drives it from React state and Applications drives it
 * from the URL, and neither needs its own copy of the popover behaviour.
 *
 * A row of chips was the other option, but these lists run to fourteen sectors
 * and a chip per sector pushed the results below the fold on a laptop.
 *
 * `searchable` and `footer` exist so the filters that need more than a checkbox
 * list - locations, which run to fifty-odd states, and AUM, which takes a typed
 * range - can still reuse this popover instead of growing a second one. When a
 * footer contributes to the filter, the caller also owns the button's `summary`,
 * `active` and `onClear`, since this component can no longer tell from `value`
 * alone whether anything is set.
 */
export default function MultiSelect({
  label,
  options,
  value,
  onChange,
  className = "",
  searchable = false,
  searchPlaceholder = "Search…",
  footer,
  summary: summaryOverride,
  active: activeOverride,
  onClear,
  childValues = [],
  onToggleChild,
}: {
  label: string;
  options: {
    value: string;
    label: string;
    /**
     * Places nested under this option - cities under a state.
     *
     * They are a separate selection from the parent: ticking NY filters to the
     * state, expanding it and ticking New York filters to the city. The caller
     * owns what a child selection means, which is why toggling one goes through
     * `onToggleChild` rather than into `value`.
     */
    children?: { value: string; label: string }[];
  }[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  footer?: ReactNode;
  summary?: string;
  active?: boolean;
  /** Which child values are currently selected, for the tick marks. */
  childValues?: string[];
  onToggleChild?: (value: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dropping the query on the way out, rather than in an effect that watches
  // `open`: reopening with the last search still in the box hides most of the
  // list for no reason the user can see, and every close routes through here.
  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
  }, []);

  // Close on outside click and on Escape - a panel that can only be dismissed
  // by hitting the button again feels stuck.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  // The button has to say what is selected without the panel open. One
  // selection shows its name; more than one would overflow, so it counts.
  const summary =
    summaryOverride ??
    (value.length === 0
      ? label
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? label)
        : `${label} · ${value.length}`);

  // Which parents are expanded. Collapsed by default: fifty states with their
  // cities expanded is a thousand-row list, which is the thing this control
  // exists to avoid.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const active = activeOverride ?? value.length > 0;
  const clear = onClear ?? (() => onChange([]));

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm transition-colors ${
          active
            ? "border-accent-500 bg-brand-50 text-brand-900"
            : "border-brand-200 text-brand-900 hover:border-brand-300"
        }`}
      >
        <span className="max-w-[12rem] truncate">{summary}</span>
        {active && (
          // A span, not a nested button - a button inside a button is invalid
          // HTML and the inner one stops receiving clicks in some browsers.
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                clear();
              }
            }}
            className="rounded-sm text-warmgray-500 hover:text-brand-900"
          >
            <X size={13} />
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-warmgray-500" />
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 flex w-64 flex-col rounded-md border border-brand-200 bg-white shadow-lg">
          {searchable && (
            <div className="relative border-b border-brand-100 p-1.5">
              <Search
                size={13}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-warmgray-500"
              />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-sm bg-transparent py-1 pl-7 pr-2 text-sm text-brand-900 placeholder:text-warmgray-500 focus:outline-none"
              />
            </div>
          )}

          <div role="listbox" aria-multiselectable className="max-h-56 overflow-y-auto py-1">
            {shown.length === 0 ? (
              <p className="px-3 py-2 text-xs text-warmgray-500">No matches.</p>
            ) : (
              shown.map((o) => {
                const checked = value.includes(o.value);
                const kids = o.children ?? [];
                const isOpen = expanded.has(o.value);
                return (
                  <div key={o.value}>
                    <div className="flex w-full items-center hover:bg-brand-50">
                      {/* Two controls on one row, deliberately separate.
                          Selecting a state and picking a city inside it are
                          alternatives, not a narrowing - the query ORs them -
                          so a click that did both would open the cities and
                          then make every one of them a no-op. The tick box
                          filters to the whole state; the name opens it. */}
                      <button
                        type="button"
                        role="option"
                        aria-selected={checked}
                        aria-label={`Filter to ${o.label}`}
                        onClick={() => toggle(o.value)}
                        className="shrink-0 py-1.5 pl-3 pr-1"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                            checked ? "border-accent-500 bg-accent-500 text-white" : "border-brand-200"
                          }`}
                        >
                          {checked && <Check size={11} strokeWidth={3} />}
                        </span>
                      </button>

                      <button
                        type="button"
                        aria-expanded={kids.length > 0 ? isOpen : undefined}
                        onClick={() => {
                          if (kids.length === 0) {
                            toggle(o.value);
                            return;
                          }
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(o.value)) next.add(o.value);
                            return next;
                          });
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 pr-3 text-left text-sm text-brand-900"
                      >
                        <span className="truncate">{o.label}</span>
                      </button>

                      {kids.length > 0 && (
                        // Separate control from the checkbox: expanding a state
                        // to see its cities is not the same as filtering to it.
                        <button
                          type="button"
                          aria-label={`${isOpen ? "Hide" : "Show"} cities in ${o.label}`}
                          aria-expanded={isOpen}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (!next.delete(o.value)) next.add(o.value);
                              return next;
                            })
                          }
                          className="shrink-0 px-2 py-1.5 text-warmgray-500 hover:text-brand-900"
                        >
                          <ChevronDown
                            size={13}
                            className={isOpen ? "rotate-180" : ""}
                          />
                        </button>
                      )}
                    </div>

                    {isOpen &&
                      kids.map((k) => {
                        const kChecked = childValues.includes(k.value);
                        return (
                          <button
                            key={k.value}
                            type="button"
                            role="option"
                            aria-selected={kChecked}
                            onClick={() => onToggleChild?.(k.value)}
                            className="flex w-full items-center gap-2 py-1.5 pl-9 pr-3 text-left text-sm text-warmgray-600 hover:bg-brand-50"
                          >
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                                kChecked
                                  ? "border-accent-500 bg-accent-500 text-white"
                                  : "border-brand-200"
                              }`}
                            >
                              {kChecked && <Check size={11} strokeWidth={3} />}
                            </span>
                            <span className="truncate">{k.label}</span>
                          </button>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>

          {footer && <div className="border-t border-brand-100 p-2.5">{footer}</div>}
        </div>
      )}
    </div>
  );
}
