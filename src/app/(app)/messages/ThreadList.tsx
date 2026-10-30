"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import LogoAvatar from "@/components/feed/LogoAvatar";
import SampleTag from "@/components/SampleTag";

export type ThreadRow = {
  otherId: string;
  otherName: string;
  otherSchool: string | null;
  otherSchoolDomain: string | null;
  otherPhoto: string | null;
  otherIsSample: boolean;
  lastBody: string;
  lastFromMe: boolean;
  /** Formatted on the server, so server and browser agree. */
  when: string;
  unreadCount: number;
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The inbox's left pane: every conversation, newest first, searchable. */
export default function ThreadList({ threads, selectedId }: { threads: ThreadRow[]; selectedId: string | null }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? threads.filter((t) => [t.otherName, t.otherSchool ?? "", t.lastBody].some((v) => v.toLowerCase().includes(q)))
    : threads;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-3 pb-3">
        <Search size={14} aria-hidden className="pointer-events-none absolute left-6 top-1/2 -translate-y-[calc(50%+6px)] text-warmgray-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages"
          aria-label="Search messages"
          className="h-9 w-full rounded-md border border-brand-200 bg-white pl-9 pr-3 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-warmgray-500">
            {threads.length === 0 ? "No conversations yet." : "No conversations match."}
          </li>
        )}
        {shown.map((t) => {
          const active = t.otherId === selectedId;
          const unread = t.unreadCount > 0 && !active;
          return (
            <li key={t.otherId}>
              <Link
                href={`/messages/${t.otherId}`}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={`flex items-start gap-3 border-l-2 px-4 py-3 transition ${
                  active ? "border-accent-600 bg-brand-50" : "border-transparent hover:bg-brand-50/60"
                }`}
              >
                <LogoAvatar
                  domain={t.otherSchoolDomain}
                  label={t.otherSchool}
                  alt=""
                  initials={initials(t.otherName)}
                  photoUrl={t.otherPhoto}
                  size={40}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className={`min-w-0 flex-1 truncate text-sm text-brand-900 ${unread ? "font-semibold" : "font-medium"}`}>
                      {t.otherName}
                    </p>
                    <span className={`shrink-0 text-[11px] ${unread ? "font-semibold text-accent-600" : "text-warmgray-500"}`}>
                      {t.when}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className={`min-w-0 flex-1 truncate text-xs ${unread ? "text-brand-900" : "text-warmgray-500"}`}>
                      {t.lastFromMe ? "You: " : ""}
                      {t.lastBody}
                    </p>
                    {unread && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent-600 px-1.5 text-[10px] font-semibold text-[#ffffff]">
                        {t.unreadCount}
                      </span>
                    )}
                  </div>
                  {t.otherIsSample && (
                    <span className="mt-1 inline-block">
                      <SampleTag />
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
