"use client";

import { useRef, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import type { StorySummary } from "@/lib/news/summary";
import { externalHref } from "@/lib/safe-url";

// What a story card opens: the button to the article first, then the story in
// a few bullets - its key points and the takeaway - so a student can decide
// whether to read it, or walk into an interview knowing the gist.
//
// The card itself is the trigger, so everything a card shows stays exactly as
// it was. A native <dialog>: it keeps focus inside while open, closes on
// Escape, and hands focus back to the card when it closes.

export type StoryPanelStory = {
  title: string;
  link: string;
  source: string;
  /** Source, age and outlet count, formatted on the server so both renders agree. */
  meta: string;
  locked: boolean;
  question: string | null;
  summary: StorySummary | null;
};

export default function StoryPanel({
  story,
  className,
  ariaLabel,
  children,
}: {
  story: StoryPanelStory;
  className: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  const { summary } = story;
  // Read-boundary guard - the article link comes from the news feed, which is
  // outside content (see lib/safe-url). "Read the article" is a full-width
  // button, and a button with no href is a dead control, so a refused link
  // becomes a line of text in its place and the summary below still reads.
  const article = externalHref(story.link);

  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-label={ariaLabel} onClick={() => dialog.current?.showModal()} className={className}>
        {children}
      </button>
      <dialog
        ref={dialog}
        aria-label={story.title}
        // A click on the backdrop lands on the <dialog> itself; one inside lands on its content.
        onClick={(e) => e.target === dialog.current && close()}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-brand-100 bg-white p-0 text-left shadow-card backdrop:bg-[#0b1526]/55"
      >
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs text-warmgray-500">{story.meta}</p>
            <button type="button" onClick={close} aria-label="Close" className="-mr-1.5 -mt-1.5 rounded-md p-1.5 text-warmgray-500 hover:bg-brand-50 hover:text-brand-900 focus-visible:outline-2 focus-visible:outline-accent-500">
              <X size={16} aria-hidden />
            </button>
          </div>
          <h2 className="mt-1 text-lg font-semibold leading-snug text-brand-900">{story.title}</h2>

          {article ? (
            <a
              href={article}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              Read the article on {story.source}
              <ExternalLink size={14} aria-hidden />
            </a>
          ) : (
            <p className="mt-4 rounded-md border border-brand-100 bg-brand-50 px-4 py-2.5 text-center text-sm text-warmgray-600">
              {story.source} didn&apos;t give a link we can open.
            </p>
          )}
          {story.locked &&<p className="mt-1.5 text-center text-xs text-warmgray-500">Needs a subscription you haven&apos;t added under Your news sources.</p>}

          {summary ? (
            <div className="mt-5 space-y-4">
              <section aria-label="Key points">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-600">Key points</h3>
                <ul className="space-y-2">
                  {summary.points.map((p) => (
                    <li key={p} className="flex gap-2 text-sm leading-snug text-brand-900">
                      <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {summary.takeaway && (
                <section aria-label="Takeaway">
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-accent-600">Takeaway</h3>
                  <p className="border-l-2 border-accent-400 pl-3 text-sm leading-snug text-brand-900">{summary.takeaway}</p>
                </section>
              )}
            </div>
          ) : (
            <p className="mt-5 text-sm text-warmgray-500">No summary for this one. The article has the full story.</p>
          )}

          {story.question && (
            <section aria-label="Ask about it" className="mt-4">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-accent-600">Ask about it</h3>
              <p className="text-sm leading-snug text-brand-900">{story.question}</p>
            </section>
          )}

          {summary && (
            <p className="mt-5 text-[11px] text-warmgray-500">
              {summary.basis === "article"
                ? "Summary written by AI from the article. Check the article before you quote it."
                : "Summary written by AI from the headline and the outlets' own summaries. The article has more."}
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}
