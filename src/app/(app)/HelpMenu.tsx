"use client";

import Link from "next/link";
import { CircleHelp, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { RECRUITING_PATH, searchHelp } from "@/lib/help-guide";
import { useFitPanelInViewport, useHelpMenuShortcuts } from "@/lib/use-anchored-panel";

/**
 * The way around the app, from anywhere in it.
 *
 * Two answers to two different questions:
 *
 *   - "Where do I go for X?" - a search over every task in the guide, by what
 *     the student is trying to do rather than by what we named the page.
 *   - "What comes next?" - the recruiting path, in order, each step a link to
 *     where it happens.
 *
 * It no longer opens on help for the page behind it: the student is already
 * looking at that page, so the panel spent its top half repeating it.
 *
 * Same panel as the bell beside it, so the two read as one pair of controls.
 * The query is typed words, but it is matched in this component against a
 * fixed list and goes nowhere - it is never saved, sent or shown to anyone -
 * which is why it carries no language check (see CLAUDE.md).
 */
export default function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFitPanelInViewport(dialogRef, open);

  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  useHelpMenuShortcuts(panelRef, close, () => setOpen(true));

  // Straight into the search box on open: someone who opened help usually
  // knows what they are after and wants to say it.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Closing clears the search, so it opens fresh next time rather than on
  // whatever was typed last.
  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Help"
        title="Help (?)"
        className="flex h-9 w-9 items-center justify-center rounded-full text-brand-900 transition-colors hover:bg-brand-50"
      >
        <CircleHelp size={18} strokeWidth={1.75} />
      </button>

      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Help"
          // Every row in here is a link. Following one closes the panel, or it
          // would sit open over the page it just took you to.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) close();
          }}
          // Same panel as the bell's: light in both themes (.list-panel), so
          // anything that must keep a colour inside it uses literal hex.
          className="list-panel absolute right-0 z-50 mt-2 flex max-h-[min(34rem,calc(100vh-5rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-brand-100 shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)]"
        >
          <div className="border-b border-brand-100 px-3 py-2.5">
            <label className="flex items-center gap-2 rounded-lg bg-[#0b1526]/[0.05] px-2.5 py-1.5">
              <Search size={14} strokeWidth={1.75} className="shrink-0 text-[#4a5a72]" aria-hidden />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What are you trying to do?"
                aria-label="Search help"
                className="w-full bg-transparent text-sm text-[#0b1526] outline-none placeholder:text-[#0b1526]/45"
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto">
            {searching ? (
              results.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-warmgray-500">
                  Nothing matches that. Try a word like &ldquo;email&rdquo;, &ldquo;interview&rdquo; or
                  &ldquo;internships&rdquo;, or{" "}
                  <Link href="/help" className="underline underline-offset-2">
                    browse the full guide
                  </Link>
                  .
                </p>
              ) : (
                <ul>
                  {results.map(({ task, section }) => (
                    <li key={`${section.href}:${task.label}`} className="border-b border-brand-100 last:border-b-0">
                      <Link href={task.href} className="block px-4 py-2.5 hover:bg-[#0b1526]/[0.04]">
                        <span className="block text-sm font-medium text-brand-900">{task.label}</span>
                        <span className="block text-[11px] text-warmgray-500">in {section.label}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <section className="px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6b5a2a]">
                  The recruiting path
                </p>
                <ol className="mt-2 space-y-0.5">
                  {RECRUITING_PATH.map((step, i) => (
                    <li key={step.title}>
                      <Link
                        href={step.href}
                        className="-mx-2 flex gap-3 rounded-lg px-2 py-1.5 hover:bg-[#0b1526]/[0.04]"
                      >
                        <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0b1526] text-[10px] font-semibold text-[#ffffff]">
                          {i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-brand-900">{step.title}</span>
                          <span className="block text-[11px] leading-snug text-warmgray-500">{step.body}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>

          <div className="flex border-t border-brand-100">
            <Link
              href="/help#assistant-heading"
              className="flex-1 px-4 py-2.5 text-center text-xs font-medium text-brand-900 hover:bg-brand-50"
            >
              Ask the assistant
            </Link>
            <Link
              href="/help"
              className="flex-1 border-l border-brand-100 px-4 py-2.5 text-center text-xs font-medium text-brand-900 hover:bg-brand-50"
            >
              Open the full guide
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
