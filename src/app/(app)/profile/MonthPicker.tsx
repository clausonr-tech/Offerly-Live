"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A month-and-year picker with our own pop-up.
 *
 * Replaces <input type="month">, whose calendar is the browser's and cannot be
 * styled. The pop-up is .month-pop in globals.css: navy with white type on the
 * light theme, white with navy type on the dark one. Value is "YYYY-MM", or ""
 * for none.
 */
export default function MonthPicker({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedYear = value ? Number(value.slice(0, 4)) : null;
  const selectedMonth = value ? Number(value.slice(5, 7)) : null;
  const [year, setYear] = useState(selectedYear ?? new Date().getFullYear());
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside click or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = selectedYear && selectedMonth ? `${MONTHS[selectedMonth - 1]} ${selectedYear}` : "";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (selectedYear) setYear(selectedYear);
          setOpen((o) => !o);
        }}
        className="flex w-36 items-center justify-between gap-2 rounded-md border border-brand-200 px-2 py-1.5 text-left text-sm text-brand-900 focus:border-accent-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-brand-50 disabled:text-warmgray-400"
      >
        <span className={shown ? "" : "text-warmgray-400"}>{shown || "Month, year"}</span>
        <CalendarDays size={14} aria-hidden className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="month-pop absolute left-0 z-30 mt-1 w-60 rounded-lg border p-3 shadow-card"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setYear((y) => y - 1)}
              aria-label="Previous year"
              className="month-pop-cell rounded p-1"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold">{year}</span>
            <button
              type="button"
              onClick={() => setYear((y) => y + 1)}
              aria-label="Next year"
              className="month-pop-cell rounded p-1"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((m, i) => {
              const picked = selectedYear === year && selectedMonth === i + 1;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => {
                    onChange(`${year}-${String(i + 1).padStart(2, "0")}`);
                    setOpen(false);
                  }}
                  className="month-pop-cell rounded px-2 py-1.5 text-sm"
                >
                  {m}
                </button>
              );
            })}
          </div>
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="month-pop-cell mt-2 w-full rounded px-2 py-1 text-xs opacity-80"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
