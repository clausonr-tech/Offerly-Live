"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { MessageCircle, SmilePlus, Trash2 } from "lucide-react";

import { addComment, deleteComment, listComments, toggleReaction } from "@/app/(app)/networking/feed-actions";
import {
  COMMENT_MAX,
  REACTION_EMOJIS,
  sortReactions,
  type FeedComment,
  type ReactionEmoji,
  type ReactionSummary,
} from "@/lib/feed-engagement";

/**
 * The foot of a feed card: emoji reactions, the comment count, and the
 * Comment button - all bottom left, where a reader's eye lands after the post.
 *
 * Reactions update optimistically (a tap that waited on a round trip would
 * feel broken) and then settle on the tallies the server returns. Comments
 * load the first time the thread is opened, not with the feed: most rows are
 * scrolled past, and fetching every thread for every row would make the feed
 * pay for conversations nobody opened.
 */
export default function FeedEngagement({
  eventId,
  initialReactions,
  initialCommentCount,
}: {
  eventId: string;
  initialReactions: ReactionSummary[];
  initialCommentCount: number;
}) {
  const [reactions, setReactions] = useState(initialReactions);
  const [commentCount, setCommentCount] = useState(initialCommentCount);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Outside click and Escape close the picker, like any other popover.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const react = (emoji: ReactionEmoji) => {
    setPickerOpen(false);
    setReactions((prev) => {
      const hit = prev.find((r) => r.emoji === emoji);
      if (!hit) return sortReactions([...prev, { emoji, count: 1, mine: true }]);
      const count = hit.count + (hit.mine ? -1 : 1);
      return count <= 0
        ? prev.filter((r) => r.emoji !== emoji)
        : prev.map((r) => (r.emoji === emoji ? { ...r, count, mine: !r.mine } : r));
    });
    void toggleReaction(eventId, emoji).then(setReactions).catch(() => setReactions(initialReactions));
  };

  return (
    <div className="mt-3 border-t border-[#e6e9ef] pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => react(r.emoji)}
            aria-pressed={r.mine}
            aria-label={`${r.emoji} ${r.count}${r.mine ? ", including you" : ""}. ${r.mine ? "Remove" : "Add"} your reaction`}
            className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
              r.mine
                ? "border-[#7c6ae6] bg-[#efecfd] text-[#3b2f99]"
                : "border-[#dfe3ea] bg-[#ffffff] text-[#45484a] hover:border-[#b8bfcc]"
            }`}
          >
            <span aria-hidden className="text-sm leading-none">{r.emoji}</span>
            <span className="font-medium tabular-nums">{r.count}</span>
          </button>
        ))}

        <div ref={pickerRef} className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-expanded={pickerOpen}
            aria-label="Add a reaction"
            title="Add a reaction"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#dfe3ea] bg-[#ffffff] text-[#45484a] transition-colors hover:border-[#b8bfcc] hover:text-black"
          >
            <SmilePlus size={14} aria-hidden />
          </button>
          {pickerOpen && (
            // Opens upward: the card clips its overflow, and there is always
            // post content above this row, never always room below it.
            <div
              role="menu"
              aria-label="Reactions"
              className="absolute bottom-full left-0 z-10 mb-1.5 flex gap-0.5 rounded-full border border-[#dfe3ea] bg-[#ffffff] p-1 shadow-md"
            >
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  onClick={() => react(emoji)}
                  aria-label={`React ${emoji}`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125 hover:bg-[#f3f5f9] motion-reduce:hover:scale-100"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="mx-1 h-4 w-px bg-[#e6e9ef]" aria-hidden />

        <button
          type="button"
          onClick={() => setThreadOpen((o) => !o)}
          className="inline-flex h-7 items-center gap-1 px-1 text-xs text-[#45484a] hover:text-black hover:underline"
        >
          <MessageCircle size={13} aria-hidden />
          {commentCount} comment{commentCount === 1 ? "" : "s"}
        </button>

        {/* The highlighted one: commenting is the thing worth prompting. */}
        <button
          type="button"
          onClick={() => setThreadOpen(true)}
          aria-expanded={threadOpen}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-[#1b2f4d] px-3 text-xs font-semibold text-[#ffffff] shadow-sm transition-colors hover:bg-[#33517a]"
        >
          <MessageCircle size={13} aria-hidden />
          Comment
        </button>
      </div>

      {threadOpen && (
        <CommentThread eventId={eventId} onCount={setCommentCount} onClose={() => setThreadOpen(false)} />
      )}
    </div>
  );
}

function CommentThread({
  eventId,
  onCount,
  onClose,
}: {
  eventId: string;
  onCount: (n: number) => void;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    listComments(eventId)
      .then((list) => live && setComments(list))
      .catch(() => live && setComments([]));
    inputRef.current?.focus();
    return () => {
      live = false;
    };
  }, [eventId]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    startTransition(async () => {
      const r = await addComment(eventId, text);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setComments((prev) => [...(prev ?? []), r.comment]);
      onCount(r.count);
      setDraft("");
    });
  };

  const remove = (id: string) =>
    startTransition(async () => {
      const count = await deleteComment(id);
      if (count === null) return;
      setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
      onCount(count);
    });

  return (
    <div className="mt-3 space-y-3">
      {comments === null ? (
        <p className="text-xs text-[#45484a]">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-[#45484a]">No comments yet. Start the conversation.</p>
      ) : (
        <ul className="space-y-2.5">
          {comments.map((c) => (
            <li key={c.id} className="group/comment flex gap-2">
              <Avatar name={c.name} photoUrl={c.photoUrl} />
              <div className="min-w-0 flex-1 rounded-lg bg-[#f3f5f9] px-3 py-2">
                <p className="flex items-baseline gap-1.5 text-xs">
                  <Link href={`/u/${c.userId}`} className="font-semibold text-black hover:underline">
                    {c.isYou ? "You" : c.name}
                  </Link>
                  <time
                    dateTime={new Date(c.createdAt).toISOString()}
                    suppressHydrationWarning
                    className="text-[11px] text-[#6b7280]"
                  >
                    {formatDistanceToNowStrict(new Date(c.createdAt), { addSuffix: true })}
                  </time>
                  {c.isYou && (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      aria-label="Delete your comment"
                      title="Delete"
                      className="ml-auto text-[#9aa1ad] opacity-0 transition-opacity hover:text-[#b42318] focus:opacity-100 group-hover/comment:opacity-100"
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                  )}
                </p>
                <p className="mt-0.5 whitespace-pre-line break-words text-sm text-black">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter posts; Shift+Enter is a new line, as in every chat box.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={COMMENT_MAX}
          placeholder="Write a comment..."
          aria-label="Write a comment"
          className="min-h-9 flex-1 resize-none rounded-lg border border-[#dfe3ea] bg-[#ffffff] px-3 py-2 text-sm text-black placeholder:text-[#9aa1ad] focus:border-[#7c6ae6] focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="h-9 rounded-lg bg-[#1b2f4d] px-3 text-xs font-semibold text-[#ffffff] transition-colors hover:bg-[#33517a] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Posting..." : "Post"}
        </button>
        <button type="button" onClick={onClose} className="h-9 px-1 text-xs text-[#45484a] hover:text-black">
          Close
        </button>
      </form>
      {error && <p className="text-xs text-[#b42318]">{error}</p>}
    </div>
  );
}

function Avatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />;
  }
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#e6e9ef] text-[10px] font-semibold text-[#45484a]"
    >
      {initials}
    </span>
  );
}
