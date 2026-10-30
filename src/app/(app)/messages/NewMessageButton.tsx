"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PenSquare } from "lucide-react";

/** Pick anyone to start a conversation with. */
export default function NewMessageButton({
  people,
}: {
  people: { id: string; name: string | null; school: string | null; gradYear: number | null }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = (q ? people.filter((p) => (p.name ?? "").toLowerCase().includes(q)) : people).slice(0, 30);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="New message"
        title="New message"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-brand-200 text-brand-900 transition hover:bg-brand-50"
      >
        <PenSquare size={16} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="New message" className="absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border border-brand-100 bg-white p-2 shadow-card">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="To: search students"
            aria-label="Search students"
            className="mb-1.5 w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
          <ul className="max-h-72 overflow-y-auto">
            {shown.length === 0 && <li className="px-2 py-2 text-xs text-warmgray-500">No students match.</li>}
            {shown.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/messages/${p.id}`}
                  prefetch={false}
                  onClick={() => setOpen(false)}
                  className="block rounded px-2 py-1.5 hover:bg-brand-50"
                >
                  <span className="block truncate text-sm text-brand-900">{p.name ?? "A student"}</span>
                  <span className="block truncate text-xs text-warmgray-500">
                    {p.school ?? "School not set"}
                    {p.gradYear ? ` · Class of ${p.gradYear}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
