"use client";

import { useActionState, useEffect, useRef } from "react";
import { ExternalLink, Library, Newspaper, X } from "lucide-react";
import { PAID_PUBLISHERS } from "@/lib/news/access";
import FirmLogo from "../discovery/FirmLogo";
import { saveNewsAccess } from "./actions";

/**
 * "Your news sources": which paid newsrooms the student can read. A quiet
 * button at the top of every News view; the box it opens lists the paid
 * sources as checkboxes. Saving re-ranks the sector pages and rebuilds the
 * digest around what they can open (src/lib/news/access.ts).
 *
 * The note at the top of the box sends them to their library first: most
 * universities include the WSJ, the FT, the NYT and often Bloomberg in what a
 * student already gets, and few students know it.
 */
export default function NewsSourcesPicker({ access, school }: { access: string[] | null; school: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(saveNewsAccess, undefined);
  const chosen = new Set(access ?? []);
  const count = chosen.size;

  useEffect(() => {
    if (state?.ok) dialog.current?.close();
  }, [state]);

  const librarySearch = school
    ? `https://www.google.com/search?q=${encodeURIComponent(`${school} library Wall Street Journal Financial Times New York Times access`)}`
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-brand-100 bg-white px-3 text-sm text-brand-900 hover:border-accent-400"
      >
        <Newspaper size={15} aria-hidden className="text-warmgray-500" />
        Your news sources
        <span className="text-xs text-warmgray-500">{access === null ? "· set up" : count ? `· ${count}` : "· free only"}</span>
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="news-sources-title"
        className="m-auto w-[min(92vw,34rem)] rounded-xl border border-brand-100 bg-white p-0 text-brand-900 shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)] backdrop:bg-[#0b1526]/40"
      >
        <form action={formAction}>
          <div className="flex items-start justify-between gap-3 border-b border-brand-100 px-5 py-4">
            <div>
              <h2 id="news-sources-title" className="text-base font-semibold">
                Your news sources
              </h2>
              <p className="mt-0.5 text-xs text-warmgray-500">
                Tick the paid sources you can read. Your digest and industry pages will favor stories you can open. Free sources are always included.
              </p>
            </div>
            <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded p-1 text-warmgray-500 hover:bg-brand-50">
              <X size={16} aria-hidden />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
            <div className="mb-4 flex gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-xs text-brand-800">
              <Library size={14} aria-hidden className="mt-0.5 shrink-0 text-accent-600" />
              <p>
                Many schools give students free access to the Wall Street Journal, the FT, the New York Times and sometimes Bloomberg. Check your
                library&apos;s databases or student resources page before you pay.{" "}
                {librarySearch && (
                  <a href={librarySearch} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline">
                    Look up {school}&apos;s access <ExternalLink size={11} aria-hidden />
                  </a>
                )}
              </p>
            </div>

            {(["major", "trade"] as const).map((group) => (
              <fieldset key={group} className="mb-4 last:mb-0">
                <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
                  {group === "major" ? "Newspapers" : "Industry publications"}
                </legend>
                <div className="space-y-1">
                  {PAID_PUBLISHERS.filter((p) => p.group === group).map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-brand-50">
                      <input type="checkbox" name="access" value={p.id} defaultChecked={chosen.has(p.id)} className="h-4 w-4 accent-[#3a5da0]" />
                      <FirmLogo domain={p.logoDomain} name={p.name} size={20} />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-brand-100 px-5 py-3">
            <button type="button" onClick={() => dialog.current?.close()} className="h-9 rounded-md px-3 text-sm text-warmgray-600 hover:bg-brand-50">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="h-9 rounded-md bg-brand-900 px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60">
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
