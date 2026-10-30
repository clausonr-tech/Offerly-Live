"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";
import { searchFirmsForPicker } from "../dashboard/actions";
import { internshipDates } from "@/lib/internships";
import MonthPicker from "./MonthPicker";

export type Internship = {
  firm: string;
  firmId: string | null;
  website: string | null;
  role: string;
  /** "YYYY-MM" */
  start: string | null;
  /** "YYYY-MM"; null while ongoing. */
  end: string | null;
  current: boolean;
};

type Option = { id: string; name: string; website: string };

const inputClass =
  "w-full rounded-md border border-brand-200 px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";

/**
 * Past and current internships, inside the About you form.
 *
 * Typing a firm searches our directory and offers matches with their logos;
 * picking one keeps its logo on the entry. A firm we do not have is still
 * accepted as typed, and shows its first letter instead of a logo. The list
 * travels to the server as one JSON field (`internships`), where every entry
 * is checked again and a picked firm's logo is taken from our own record.
 */
export default function InternshipsField({ initial }: { initial: Internship[] }) {
  const [items, setItems] = useState<Internship[]>(initial);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Option | null>(null);
  const [role, setRole] = useState("");
  const [current, setCurrent] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  // Search as they type, after a pause; a slower earlier answer never
  // overwrites a newer one.
  useEffect(() => {
    const term = query.trim();
    if (picked || term.length < 2) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const rows = await searchFirmsForPicker(term).catch(() => []);
      if (mine === seq.current) setOptions(rows.slice(0, 8));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, picked]);

  // Typing a firm's exact name counts as picking it - pressing Add without
  // clicking the suggestion used to lose the logo.
  const typedMatch = picked
    ? null
    : (options.find((o) => o.name.trim().toLowerCase() === query.trim().toLowerCase()) ?? null);
  const chosen = picked ?? typedMatch;
  const firmName = (chosen?.name ?? query).trim();

  function add() {
    if (!firmName) return;
    if (!start) {
      setProblem("Pick a start month.");
      return;
    }
    if (!current && !end) {
      setProblem("Pick an end month, or tick \u201cI\u2019m still here\u201d.");
      return;
    }
    if (!current && end < start) {
      setProblem("The end month is before the start.");
      return;
    }
    setProblem(null);
    setItems((list) => [
      ...list,
      {
        firm: firmName,
        firmId: chosen?.id ?? null,
        website: chosen?.website ?? null,
        role: role.trim(),
        start: start || null,
        end: current ? null : end || null,
        current,
      },
    ]);
    setQuery("");
    setPicked(null);
    setRole("");
    setCurrent(false);
    setStart("");
    setEnd("");
    setOptions([]);
    setOpen(false);
  }

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-warmgray-600">Internships</span>
      <input type="hidden" name="internships" value={JSON.stringify(items)} />

      {items.length > 0 && (
        <ul className="mb-3 divide-y divide-brand-100 rounded-md border border-brand-100">
          {items.map((it, i) => (
            <li key={`${it.firm}-${i}`} className="flex items-center gap-3 px-3 py-2">
              <FirmLogo domain={it.website ?? ""} name={it.firm} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-brand-900">{it.firm}</p>
                <p className="truncate text-xs text-warmgray-500">
                  {[it.role, internshipDates(it)].filter(Boolean).join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                aria-label={`Remove ${it.firm}`}
                className="text-warmgray-400 hover:text-brand-900"
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="relative">
          <div className="flex items-center gap-2">
            {picked && <FirmLogo domain={picked.website} name={picked.name} size={24} />}
            <input
              value={picked ? picked.name : query}
              onChange={(e) => {
                setPicked(null);
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              placeholder="Firm"
              aria-label="Internship firm"
              className={inputClass}
            />
          </div>
          {open && !picked && query.trim().length >= 2 && options.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-brand-100 bg-white shadow-card">
              {options.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setPicked(o);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-brand-900 hover:bg-brand-50"
                  >
                    <FirmLogo domain={o.website} name={o.name} size={22} />
                    <span className="truncate">{o.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Role (e.g. Summer Analyst)"
          aria-label="Internship role"
          className={inputClass}
        />
        <button
          type="button"
          onClick={add}
          disabled={!firmName || !start || (!current && !end)}
          title={firmName && !start ? "Add the dates first" : undefined}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-brand-200 px-3 py-2 text-xs font-semibold text-brand-900 hover:bg-brand-50 disabled:opacity-50"
        >
          <Plus size={13} />
          Add
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-xs text-warmgray-600">Start</span>
          <MonthPicker value={start} onChange={setStart} label="Internship start month" />
        </div>
        <div>
          <span className="mb-1 block text-xs text-warmgray-600">End</span>
          <MonthPicker value={current ? "" : end} onChange={setEnd} label="Internship end month" disabled={current} />
        </div>
        <label className="inline-flex items-center gap-2 pb-2 text-xs text-warmgray-600">
          <input type="checkbox" checked={current} onChange={(e) => setCurrent(e.target.checked)} />
          I&apos;m still here (shows &ldquo;May 2026 &ndash; Now&rdquo;)
        </label>
      </div>
      {problem && <p className="mt-1 text-xs text-error-600">{problem}</p>}
      <p className="mt-1 text-xs text-warmgray-500">
        A start month is required, and an end month unless it&apos;s ongoing. Added internships save with the
        rest of About you.
      </p>
    </div>
  );
}
