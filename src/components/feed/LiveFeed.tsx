"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { deleteFeedItem, loadFeedPage } from "@/app/(app)/networking/feed-actions";
import type { FeedItem } from "@/lib/activity";
import { EmptyFeed, FeedCard } from "./ActivityFeed";

/** How long a card has to stay on screen to count as seen, and how much of it. */
const SEEN_AFTER_MS = 1000;
const SEEN_RATIO = 0.6;
/** Seen ids go to the server in batches, not one request per card. */
const FLUSH_EVERY_MS = 3000;

/**
 * The live feed on /networking: the first page arrives server-rendered, the
 * rest load as the reader nears the bottom, and "You're all caught up" appears
 * only when the server says there is genuinely nothing further - not merely
 * that a page came back short.
 *
 * Order comes from the server (lib/activity getFeedPage): posts this student
 * has not seen, newest first, then the ones they have. A divider marks where
 * one ends and the other begins.
 *
 * Seen tracking: a card counts once at least 60% of it has been on screen for
 * a second, which is reading, not scrolling past. Recorded now, but it only
 * reorders the NEXT visit - the split for this one is frozen at `snapshot`,
 * so nothing jumps while the student is reading.
 */
export default function LiveFeed({
  initialItems,
  initialCursor,
  snapshot,
}: {
  initialItems: FeedItem[];
  initialCursor: string | null;
  /** When this visit's feed was opened, as ISO. Sent back with every page. */
  snapshot: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const loadingRef = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  // The current list, for callbacks that must not depend on it - see onDelete.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // A new server render (after posting, say) brings a new first page.
  const [renderedFor, setRenderedFor] = useState(snapshot);
  if (renderedFor !== snapshot) {
    setRenderedFor(snapshot);
    setItems(initialItems);
    setCursor(initialCursor);
  }

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !cursor) return;
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const next = await loadFeedPage({ cursor, snapshot });
      setItems((prev) => {
        const have = new Set(prev.map((i) => i.id));
        return [...prev, ...next.items.filter((i) => !have.has(i.id))];
      });
      setCursor(next.nextCursor);
    } catch {
      setError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, snapshot]);

  // Loads the next page a little before the bottom, so scrolling rarely has
  // to wait on it.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), {
      rootMargin: "600px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, cursor]);

  /**
   * Takes one of the reader's own rows down.
   *
   * deleteFeedItem existed as a server action with nothing calling it, which
   * made the retraction half of the offer-privacy work unreachable: the row an
   * "offer" status published could not be removed from any screen a student
   * can open. The server is still the authority - it refuses a row that is not
   * theirs exactly as it refuses one that is gone - so this asks first, then
   * drops the card on success.
   *
   * Removed from state rather than refetched: a page re-read would re-order
   * the whole visit's unseen/seen split around the gap (see `snapshot`).
   *
   * Stable across renders, so FeedCard's memo still holds - without that, an
   * appended page re-renders every card already on screen.
   */
  const onDelete = useCallback((id: string) => {
    void (async () => {
      // Read through a ref rather than closing over `items`, or this callback
      // changes identity on every append and defeats the memo it is handed to.
      const kind = itemsRef.current.find((i) => i.id === id)?.kind;
      const what = kind === "offer" ? "Remove this offer from the feed?" : "Delete this post?";
      if (!window.confirm(`${what} This cannot be undone.`)) return;
      setDeleteFailed(false);
      const res = await deleteFeedItem(id);
      if (res.ok) setItems((prev) => prev.filter((i) => i.id !== id));
      else setDeleteFailed(true);
    })();
  }, []);

  // ---- seen tracking ----
  const pending = useRef(new Set<string>());
  const recorded = useRef(new Set(initialItems.filter((i) => i.seen).map((i) => i.id)));
  const timers = useRef(new Map<string, number>());
  const observer = useRef<IntersectionObserver | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const flush = useCallback(() => {
    if (pending.current.size === 0) return;
    const ids = [...pending.current];
    pending.current.clear();
    // A plain request, not a server action - see app/api/feed/seen.
    void fetch("/api/feed/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
      keepalive: true,
    })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
      })
      .catch(() => ids.forEach((id) => pending.current.add(id)));
  }, []);

  useEffect(() => {
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.feedId;
          if (!id || recorded.current.has(id)) continue;
          if (e.isIntersecting && e.intersectionRatio >= SEEN_RATIO) {
            if (!timers.current.has(id)) {
              timers.current.set(
                id,
                window.setTimeout(() => {
                  timers.current.delete(id);
                  recorded.current.add(id);
                  pending.current.add(id);
                }, SEEN_AFTER_MS),
              );
            }
          } else {
            window.clearTimeout(timers.current.get(id));
            timers.current.delete(id);
          }
        }
      },
      { threshold: [0, SEEN_RATIO] },
    );
    // Cards rendered before this effect ran (the whole first page) reported
    // their refs while there was no observer yet - pick them up now. Cards
    // added later register through `watch`.
    listRef.current?.querySelectorAll<HTMLElement>("[data-feed-id]").forEach((el) => observer.current?.observe(el));
    const every = window.setInterval(flush, FLUSH_EVERY_MS);
    // Leaving the page sends whatever is still waiting.
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    const pendingTimers = timers.current;
    return () => {
      observer.current?.disconnect();
      window.clearInterval(every);
      document.removeEventListener("visibilitychange", onHide);
      pendingTimers.forEach((t) => window.clearTimeout(t));
      flush();
    };
  }, [flush]);

  const watch = useCallback((el: HTMLLIElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  if (items.length === 0 && !cursor) return <EmptyFeed />;

  const firstSeen = items.findIndex((i) => i.seen);
  const hasNew = firstSeen !== 0;

  return (
    <div>
      <ul ref={listRef} className="flex flex-col items-stretch gap-3">
        {items.map((item, i) => (
          <Fragment key={item.id}>
            {/* Where new posts end. Only when there were new ones above it -
                a feed that opens straight onto seen posts says so instead. */}
            {i === firstSeen && (
              <li aria-hidden={!hasNew} className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-[#d5dae3]" />
                <span className="text-[11px] font-medium uppercase tracking-wide text-[#6b7280]">
                  {hasNew ? "Earlier posts you've seen" : "No new posts since your last visit"}
                </span>
                <span className="h-px flex-1 bg-[#d5dae3]" />
              </li>
            )}
            <FeedCard item={item} cardRef={watch} onDelete={onDelete} />
          </Fragment>
        ))}
      </ul>

      {deleteFailed && (
        <p className="py-3 text-center text-xs text-[#6b7280]" role="status">
          Couldn&apos;t remove that post. Reload the page and try again.
        </p>
      )}

      <div ref={sentinel} aria-hidden className="h-px" />

      {loading && (
        <p className="py-6 text-center text-xs text-[#6b7280]" role="status">
          Loading more posts...
        </p>
      )}
      {error && !loading && (
        <div className="py-6 text-center text-xs text-[#6b7280]">
          Couldn&apos;t load more posts.{" "}
          <button type="button" onClick={() => void loadMore()} className="font-medium text-black underline">
            Try again
          </button>
        </div>
      )}
      {!cursor && !loading && items.length > 0 && (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center" role="status">
          <CheckCircle2 size={22} strokeWidth={1.75} className="text-[#7c6ae6]" aria-hidden />
          <p className="text-sm font-semibold text-black">You&apos;re all caught up</p>
          <p className="text-xs text-[#6b7280]">That&apos;s every post in the feed. Check back later for more.</p>
        </div>
      )}
    </div>
  );
}
