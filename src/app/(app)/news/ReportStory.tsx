"use client";

import { Flag } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { REPORT_REASONS, type ReportReason } from "@/lib/news/report-reasons";
import { reportNewsStory } from "./actions";

/**
 * The Report link on a story card. Four fixed reasons, no typing. It sits
 * outside the card's link, since a button inside a link is invalid and a click
 * on it would open the story.
 */
export default function ReportStory({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function report(reason: ReportReason) {
    startTransition(async () => {
      const result = await reportNewsStory(itemId, reason);
      if (result.ok) setDone(true);
      setOpen(false);
    });
  }

  if (done) return <span className="text-[11px] text-warmgray-500">Thanks, we&apos;ll review it</span>;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Report this story"
        title="Report this story"
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-warmgray-500 hover:bg-brand-50 hover:text-brand-900"
      >
        <Flag size={11} aria-hidden /> Report
      </button>
      {open && (
        <div
          role="menu"
          className="list-panel absolute bottom-full right-0 z-40 mb-1 w-52 overflow-hidden rounded-xl border border-brand-100 shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)]"
        >
          {(Object.keys(REPORT_REASONS) as ReportReason[]).map((reason, i) => (
            <button
              key={reason}
              type="button"
              role="menuitem"
              onClick={() => report(reason)}
              className={`block w-full px-3 py-2 text-left text-xs text-brand-900 hover:bg-[#0b1526]/[0.04] ${i ? "border-t border-brand-100" : ""}`}
            >
              {REPORT_REASONS[reason]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
