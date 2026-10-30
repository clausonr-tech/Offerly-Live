"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";
import { MAP_VIEW_HEIGHT, MAP_WIDTH, US_OUTLINE_PATH, locateCity, locateSchool, project } from "@/lib/us-map";

/**
 * The student's industry contacts on a map of the US, and the student
 * themselves - at their school - as the one bigger, gold dot.
 *
 * Drawn from the contacts table on every render. Generating contacts
 * revalidates /dashboard (lib/contact-sourcing-run), so a search that saves
 * people in a new city puts a dot there as soon as it returns.
 *
 * One dot per city, a little larger where there are more people, rather than
 * one per person: ninety contacts in New York drawn separately are one dot
 * anyway, just a heavier one.
 *
 * Each dot opens a card naming the firms the student knows people at there,
 * with their logos (5 October 2026: "if they click the dot for Teleo Capital
 * in Boise, it pops up the firm logo"). A button for the keyboard too.
 */

// The purple of the illustration this replaced (violet on the navy card).
const LAND = "rgba(124, 106, 230, 0.38)";
const COAST = "#b1a3f5";
const CONTACT = "#ffffff";
const YOU = "#f2c14e";

export type MapContact = {
  city: string | null;
  firm: string | null;
  /** The firm's website, for its logo, when the directory knows it. */
  domain: string | null;
};

type Dot = { key: string; x: number; y: number; count: number; label: string; firms: { name: string; domain: string | null; count: number }[] };

export default function ContactMap({
  contacts,
  school,
  className = "",
}: {
  /** One entry per contact. */
  contacts: MapContact[];
  /** The student's school, from which their own dot is placed. */
  school: string | null;
  className?: string;
}) {
  const byPlace = new Map<string, Dot>();
  let placed = 0;
  for (const c of contacts) {
    const at = locateCity(c.city);
    if (!at) continue;
    placed++;
    const key = at.join(",");
    const dot = byPlace.get(key) ?? { key, ...project(at), count: 0, label: c.city!.split(",")[0].trim(), firms: [] };
    dot.count++;
    const firmName = c.firm?.trim();
    if (firmName) {
      const firm = dot.firms.find((f) => f.name.toLowerCase() === firmName.toLowerCase());
      if (firm) firm.count++;
      else dot.firms.push({ name: firmName, domain: c.domain, count: 1 });
    }
    byPlace.set(key, dot);
  }
  const dots = [...byPlace.values()].sort((a, b) => b.count - a.count);
  for (const d of dots) d.firms.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const home = locateSchool(school);
  const you = home ? project(home.at) : null;

  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = dots.find((d) => d.key === openKey) ?? null;
  const wrap = useRef<HTMLDivElement>(null);

  // Closes on a click outside the map or on Escape.
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenKey(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKey]);

  const summary =
    `Map of the US: ${placed} of your contacts across ${dots.length} ` +
    `${dots.length === 1 ? "city" : "cities"}` +
    (home ? `, and you at ${school}.` : ".");

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <svg role="group" aria-label={summary} viewBox={`0 0 ${MAP_WIDTH} ${MAP_VIEW_HEIGHT}`} className="contact-map block w-full">
        <title>{summary}</title>
        <path d={US_OUTLINE_PATH} fill={LAND} stroke={COAST} strokeWidth="1" strokeLinejoin="round" />

        {/* Biggest first, so a small city beside New York is drawn on top of it
            rather than hidden under it. */}
        {dots.map((d) => {
          const r = Math.min(5, 1.8 + Math.sqrt(d.count - 1) * 0.45);
          const isOpen = d.key === openKey;
          const firmsLine = d.firms.slice(0, 3).map((f) => f.name).join(", ");
          return (
            <g
              key={d.key}
              role="button"
              tabIndex={0}
              aria-label={`${d.label}: ${d.count} contact${d.count === 1 ? "" : "s"}${firmsLine ? ` at ${firmsLine}` : ""}. Show firms.`}
              aria-expanded={isOpen}
              onClick={() => setOpenKey(isOpen ? null : d.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenKey(isOpen ? null : d.key);
                }
              }}
              className="cursor-pointer outline-none [&:focus-visible>circle:last-child]:stroke-[#f2c14e]"
            >
              {/* A larger, invisible target: the dots are 2-5px on the map. */}
              <circle cx={d.x} cy={d.y} r={Math.max(r + 5, 8)} fill="transparent" />
              <circle
                cx={d.x}
                cy={d.y}
                // 1.8 for one person, growing gently: New York's ninety should
                // read as the hub it is without swallowing the Northeast.
                r={isOpen ? r + 1.2 : r}
                fill={isOpen ? YOU : CONTACT}
                fillOpacity="0.92"
                stroke="transparent"
                strokeWidth="1.5"
              />
            </g>
          );
        })}

        {you && (
          <g>
            <circle className="contact-map-pulse" cx={you.x} cy={you.y} r="4.5" fill="none" stroke={YOU} strokeWidth="1.2" />
            <circle cx={you.x} cy={you.y} r="4.5" fill={YOU} stroke="#0b1526" strokeWidth="1">
              <title>{`You: ${school}`}</title>
            </circle>
          </g>
        )}
      </svg>

      {open && (
        <div
          role="dialog"
          aria-label={`Firms in ${open.label}`}
          className="absolute z-20 w-56 -translate-x-1/2 rounded-lg border border-white/15 bg-[#0b1526] p-3 text-left shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7)]"
          style={{
            left: `${Math.min(80, Math.max(20, (open.x / MAP_WIDTH) * 100))}%`,
            top: `calc(${(open.y / MAP_VIEW_HEIGHT) * 100}% + 10px)`,
          }}
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-xs font-semibold text-[#ffffff]">
              {open.label}
              <span className="ml-1 font-normal text-[#9eb3c9]">
                · {open.count} {open.count === 1 ? "person" : "people"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setOpenKey(null)}
              aria-label="Close"
              className="-mr-1 -mt-1 rounded p-0.5 text-[#9eb3c9] hover:text-[#ffffff]"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
          {open.firms.length === 0 ? (
            <p className="text-[11px] text-[#9eb3c9]">No firm saved for these contacts.</p>
          ) : (
            <ul className="space-y-1.5">
              {open.firms.slice(0, 5).map((f) => (
                <li key={f.name} className="flex items-center gap-2">
                  <span className="flex shrink-0 rounded bg-[#ffffff] p-0.5">
                    <FirmLogo domain={f.domain ?? ""} name={f.name} size={22} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-[#ffffff]" title={f.name}>
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#9eb3c9]">{f.count}</span>
                </li>
              ))}
              {open.firms.length > 5 && (
                <li className="text-[10px] text-[#9eb3c9]">+{open.firms.length - 5} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
