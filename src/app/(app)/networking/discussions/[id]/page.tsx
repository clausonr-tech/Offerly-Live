import Link from "next/link";
import { notFound } from "next/navigation";

import { getCurrentUserId } from "@/lib/current-user";
import { getDiscussion } from "@/lib/discussions";
import FirmLogo from "../../../discovery/FirmLogo";

import { Byline, TopicTag } from "../DiscussionBits";
import { DeleteButton, ReplyForm } from "../DiscussionForms";

export const metadata = { title: "Discussion" };

export default async function DiscussionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewerId = await getCurrentUserId();
  const found = await getDiscussion(viewerId, id);
  if (!found) notFound();
  const { thread, replies } = found;

  return (
    <div className="max-w-3xl">
      <Link href="/networking/discussions" className="text-xs text-warmgray-500 hover:text-brand-900">
        ← Discussions
      </Link>

      <article className="mt-3 rounded-lg border border-brand-100 bg-white p-5">
        <div className="flex items-start gap-3">
          {thread.firmName && <FirmLogo domain={thread.firmWebsite ?? ""} name={thread.firmName} size={40} />}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-brand-900">{thread.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TopicTag topic={thread.topic} />
              {thread.firmName && <span className="text-xs text-warmgray-500">{thread.firmName}</span>}
            </div>
          </div>
        </div>
        <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-brand-900">{thread.body}</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Byline author={thread.author} anonymous={thread.anonymous} at={thread.createdAt} />
          {thread.mine && <DeleteButton kind="discussion" id={thread.id} />}
        </div>
      </article>

      <h2 className="mb-3 mt-6 text-sm font-semibold text-brand-900">
        {replies.length} {replies.length === 1 ? "reply" : "replies"}
      </h2>
      {replies.length > 0 && (
        <ul className="mb-4 grid gap-2">
          {replies.map((r) => (
            <li key={r.id} className="rounded-lg border border-brand-100 bg-white p-4">
              <p className="whitespace-pre-line text-sm leading-relaxed text-brand-900">{r.body}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Byline author={r.author} anonymous={r.anonymous} at={r.createdAt} />
                {r.mine && <DeleteButton kind="reply" id={r.id} />}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ReplyForm discussionId={thread.id} />
    </div>
  );
}
