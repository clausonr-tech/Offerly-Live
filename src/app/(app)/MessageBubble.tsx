"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageCircle, X } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import type { ThreadSummary } from "@/lib/people";

export default function MessageBubble({ unreadThreads }: { unreadThreads: ThreadSummary[] }) {
  const [open, setOpen] = useState(false);
  // Seeded from the server-rendered prop, but tracked locally so opening a
  // thread can clear it instantly. A client-side <Link> navigation reuses
  // this layout's cached render rather than re-fetching it, so the prop
  // itself wouldn't reflect the read until the next full navigation. Reset
  // during render (not an effect) per React's "adjusting state when a prop
  // changes" pattern, so a fresh server render always wins over stale local edits.
  const [prevUnreadThreads, setPrevUnreadThreads] = useState(unreadThreads);
  const [threads, setThreads] = useState(unreadThreads);
  if (unreadThreads !== prevUnreadThreads) {
    setPrevUnreadThreads(unreadThreads);
    setThreads(unreadThreads);
  }
  const count = threads.length;

  if (open) {
    return (
      <div className="animate-slide-up-in fixed bottom-5 right-5 z-40 flex max-h-[70vh] w-[340px] flex-col overflow-hidden rounded-xl border border-brand-100 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-brand-100 px-5 py-4">
          <span className="text-sm font-semibold text-brand-900">Messages</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-1 text-warmgray-500 transition hover:bg-brand-50 hover:text-brand-900"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {count === 0 ? (
            <p className="px-5 py-6 text-sm text-warmgray-500">No new messages.</p>
          ) : (
            <ul>
              {threads.map((t) => (
                <li key={t.otherId}>
                  <Link
                    href={`/messages/${t.otherId}`}
                    onClick={() => {
                      setOpen(false);
                      setThreads((prev) => prev.filter((p) => p.otherId !== t.otherId));
                    }}
                    className="flex items-start justify-between gap-3 border-b border-brand-100 px-5 py-3 transition hover:bg-brand-50/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-brand-900">{t.otherName}</p>
                      <p className="mt-0.5 truncate text-sm text-warmgray-600">{t.lastBody}</p>
                    </div>
                    <time
                      dateTime={t.lastAt.toISOString()}
                      className="shrink-0 pt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warmgray-500"
                    >
                      {formatDistanceToNowStrict(t.lastAt, { addSuffix: true })}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Link
          href="/networking?view=people"
          onClick={() => setOpen(false)}
          className="border-t border-brand-100 px-5 py-3 text-center text-xs font-medium uppercase tracking-[0.14em] text-accent-600 transition hover:bg-brand-50/60"
        >
          View all messages
        </Link>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent-500 text-white shadow-lg transition hover:bg-accent-400"
      aria-label={count > 0 ? `${count} new message${count === 1 ? "" : "s"}` : "Messages"}
    >
      <MessageCircle size={20} />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-error-500 px-1 text-[11px] font-semibold text-white">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}
