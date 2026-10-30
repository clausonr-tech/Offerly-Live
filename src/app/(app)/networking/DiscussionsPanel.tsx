import Link from "next/link";
import { MessageSquare } from "lucide-react";

import EmptyState from "@/components/EmptyState";
import type { DiscussionView } from "@/lib/discussions";


/** How many threads the rail shows before "All discussions". */
export const DISCUSSION_RAIL_SIZE = 5;

/**
 * The Networking hub's left rail: the most active discussions.
 *
 * The hub is the social side of the app - the feed is what students are
 * doing, Meet Peers is who to know - and this is what they are talking about.
 * It replaced a Messages rail (which duplicated the Messages tab and the chat
 * bubble) and, before that, Industry Contacts (which has its own page).
 */
export default function DiscussionsPanel({ threads }: { threads: DiscussionView[] }) {
  return (
    // Heading outside the panel, h-8 tall - the row the feed and Meet Peers
    // headings share, so all three land on one line.
    <>
      <div className="mb-4 flex h-8 items-center">
        <h2 id="discussions-rail" className="text-lg font-semibold text-brand-900">
          Discussions
        </h2>
      </div>

      <section aria-labelledby="discussions-rail" className="list-panel p-4 sm:p-5">
        <p className="mb-3 text-sm text-warmgray-500">What students are asking right now.</p>
        {threads.length === 0 ? (
          <EmptyState size="sm">
            Nothing yet.{" "}
            <Link href="/networking/discussions" className="underline">
              Start a discussion
            </Link>
            .
          </EmptyState>
        ) : (
          <ul className="divide-y divide-brand-100 border-y border-brand-100 shadow-none">
            {threads.slice(0, DISCUSSION_RAIL_SIZE).map((t) => (
              <li key={t.id}>
                <Link
                  href={`/networking/discussions/${t.id}`}
                  prefetch={false}
                  className="block py-2.5 transition hover:bg-brand-50"
                >
                  <p className="line-clamp-2 text-sm font-medium text-brand-900">{t.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-warmgray-500">
                    <span>{t.topic}</span>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-0.5">
                      <MessageSquare size={11} aria-hidden />
                      {t.replyCount}
                    </span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-warmgray-500">
          <Link href="/networking/discussions" className="underline">
            All discussions
          </Link>
        </p>
      </section>
    </>
  );
}
