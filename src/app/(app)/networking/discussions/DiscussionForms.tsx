"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  postReply,
  removeDiscussion,
  removeReply,
  startDiscussion,
  type DiscussionFormState,
} from "./actions";

const field =
  "w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none";

/** The per-post choice. Worded so it is clear what the others will see. */
function AnonymousToggle({ id }: { id: string }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 text-xs text-warmgray-600">
      <input id={id} type="checkbox" name="anonymous" className="h-3.5 w-3.5" />
      Post anonymously (others see &ldquo;Anonymous&rdquo;, not your name or school)
    </label>
  );
}

export function NewDiscussionForm({ topics }: { topics: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<DiscussionFormState, FormData>(startDiscussion, undefined);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent-600 px-4 text-sm font-semibold text-[#ffffff] shadow-card hover:bg-accent-500"
      >
        <Plus size={15} aria-hidden />
        Start a discussion
      </button>
    );
  }

  return (
    <form action={action} className="w-full rounded-lg border border-brand-100 bg-white p-4 sm:p-5">
      <p className="mb-3 text-sm font-semibold text-brand-900">Start a discussion</p>
      <div className="grid gap-3">
        <input name="title" required maxLength={140} placeholder="Title, e.g. Evercore superday - what to expect?" aria-label="Title" className={field} />
        <div className="grid gap-3 sm:grid-cols-2">
          <select name="topic" required defaultValue="" aria-label="Topic" className={field}>
            <option value="" disabled>
              Topic
            </option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input name="firm" maxLength={100} placeholder="Firm (optional)" aria-label="Firm" className={field} />
        </div>
        <textarea name="body" required rows={5} maxLength={4000} placeholder="What do you want to ask or share?" aria-label="Body" className={field} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <AnonymousToggle id="new-discussion-anon" />
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-xs text-warmgray-500 hover:text-brand-900">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-accent-600 px-4 py-2 text-xs font-semibold text-[#ffffff] shadow-card hover:bg-accent-500 disabled:opacity-60"
          >
            {pending ? "Posting..." : "Post"}
          </button>
        </div>
      </div>
      {state?.error && <p className="mt-2 text-xs text-error-600">{state.error}</p>}
    </form>
  );
}

export function ReplyForm({ discussionId }: { discussionId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<DiscussionFormState, FormData>(async (prev, fd) => {
    const next = await postReply(prev, fd);
    if (next?.ok) formRef.current?.reset();
    return next;
  }, undefined);

  return (
    <form ref={formRef} action={action} className="rounded-lg border border-brand-100 bg-white p-4">
      <input type="hidden" name="discussionId" value={discussionId} />
      <textarea name="body" required rows={3} maxLength={2000} placeholder="Add a reply" aria-label="Your reply" className={field} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <AnonymousToggle id="reply-anon" />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent-600 px-4 py-2 text-xs font-semibold text-[#ffffff] shadow-card hover:bg-accent-500 disabled:opacity-60"
        >
          {pending ? "Posting..." : "Reply"}
        </button>
      </div>
      {state?.error && <p className="mt-2 text-xs text-error-600">{state.error}</p>}
    </form>
  );
}

/** Only rendered on the viewer's own posts - the server checks again. */
export function DeleteButton({ kind, id }: { kind: "discussion" | "reply"; id: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(kind === "discussion" ? "Delete this discussion and its replies?" : "Delete your reply?")) return;
        start(() => (kind === "discussion" ? removeDiscussion(id) : removeReply(id)));
      }}
      className="inline-flex items-center gap-1 text-xs text-warmgray-500 hover:text-error-600 disabled:opacity-60"
    >
      <Trash2 size={12} aria-hidden />
      Delete
    </button>
  );
}
