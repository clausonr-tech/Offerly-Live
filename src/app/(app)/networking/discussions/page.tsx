import Link from "next/link";
import { MessageSquare, Search } from "lucide-react";

import EmptyState from "@/components/EmptyState";
import { getCurrentUserId } from "@/lib/current-user";
import { DISCUSSION_TOPICS, isTopic, listDiscussions } from "@/lib/discussions";
import FirmLogo from "../../discovery/FirmLogo";

import { Byline, TopicTag } from "./DiscussionBits";
import { NewDiscussionForm } from "./DiscussionForms";

export const metadata = { title: "Discussions" };

/**
 * Discussions: threads students start about interviews, timelines, offers.
 * Any post or reply can be anonymous - see lib/discussions for how that is
 * kept on the server.
 */
export default async function DiscussionsPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const topic = isTopic(sp.topic) ? sp.topic : null;
  const query = typeof sp.q === "string" ? sp.q : "";
  const viewerId = await getCurrentUserId();
  const threads = await listDiscussions(viewerId, { topic, query });

  const topicHref = (t: string | null) => {
    const p = new URLSearchParams();
    if (t) p.set("topic", t);
    if (query) p.set("q", query);
    const s = p.toString();
    return s ? `/networking/discussions?${s}` : "/networking/discussions";
  };

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">Discussions</h1>
          <p className="mt-1 max-w-2xl text-sm text-warmgray-500">
            Ask about interviews, timelines and offers, and answer what you know. Post under your name or
            anonymously.
          </p>
        </div>
        <NewDiscussionForm topics={DISCUSSION_TOPICS} />
      </header>

      <form action="/networking/discussions" className="relative mb-3">
        <Search
          size={15}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-warmgray-500"
        />
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search discussions, e.g. Evercore or superday"
          aria-label="Search discussions"
          className="h-10 w-full rounded-md border border-brand-200 bg-white pl-9 pr-3 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        />
        {topic && <input type="hidden" name="topic" value={topic} />}
      </form>

      {/* on the row, not each chip: it sets a text colour that
          would beat the active chip's own white. */}
      <nav aria-label="Topics" className="mb-5 flex flex-wrap gap-1.5">
        {[null, ...DISCUSSION_TOPICS].map((t) => {
          const active = t === topic;
          return (
            <Link
              key={t ?? "all"}
              href={topicHref(t)}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                active ? "border-accent-600 bg-accent-600 text-[#ffffff]" : "border-brand-200 bg-white text-brand-900"
              }`}
            >
              {t ?? "All"}
            </Link>
          );
        })}
      </nav>

      {threads.length === 0 ? (
        <EmptyState>
          {query || topic ? "No discussions match that yet." : "No discussions yet. Start the first one."}
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {threads.map((t) => (
            <li key={t.id} className="rounded-lg border border-brand-100 bg-white p-4 transition hover:border-brand-200">
              <div className="flex items-start gap-3">
                {t.firmName && <FirmLogo domain={t.firmWebsite ?? ""} name={t.firmName} size={32} />}
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/networking/discussions/${t.id}`}
                    prefetch={false}
                    className="block text-sm font-semibold text-brand-900 hover:underline"
                  >
                    {t.title}
                  </Link>
                  <p className="mt-1 line-clamp-2 text-xs text-warmgray-600">{t.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <TopicTag topic={t.topic} />
                    {t.firmName && <span className="text-[11px] text-warmgray-500">{t.firmName}</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <Byline author={t.author} anonymous={t.anonymous} at={t.createdAt} />
                    <span className="inline-flex items-center gap-1 text-xs text-warmgray-500">
                      <MessageSquare size={12} aria-hidden />
                      {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                    </span>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
