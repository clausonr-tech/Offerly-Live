"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Feed posts are template sentences and mostly one line, but a long firm or
// school name can run an offer or join post to several lines in this rail's
// fixed width. Clamped to 3 lines with an inline "more" rather than letting
// a single long post push every post below it down the rail. Whether a post
// even needs the control is measured, not assumed: scrollHeight only exceeds
// clientHeight while clamped if the text actually overflows 3 lines, so a
// short post never grows a dead "more" link with nothing behind it.
export default function FeedPostText({ children }: { children: ReactNode }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    // Measured only while collapsed: expanded removes the clamp, so
    // clientHeight would just equal scrollHeight and always read as "fits".
    if (!el || expanded) return;

    // The column's width can change (viewport resize, sidebar breakpoint),
    // which changes how much text 3 lines hold. A ResizeObserver on the
    // paragraph rather than a window resize listener: the feed holds hundreds
    // of these, and a listener each meant hundreds of synchronous layout
    // reads per resize. It also fires once on observe, replacing the initial
    // measure, and batches with the browser's own layout pass.
    const ro = new ResizeObserver(() => setCanExpand(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  return (
    <div className="mt-1.5">
      <div className="relative">
        {/* Literal #45484a, not text-warmgray-600 - the card this sits on is
            fixed white in both themes now (see ActivityFeed.tsx), and
            warmgray-600 inverts to a near-white value in Dealroom, which
            would read as invisible text on a white card. #45484a is that
            token's own light-mode value, kept literal so the look is
            unchanged in light mode and simply stops flipping in dark mode. */}
        <p
          ref={textRef}
          className={`text-sm leading-relaxed text-[#45484a] ${expanded ? "" : "line-clamp-3"}`}
        >
          {children}
        </p>

        {!expanded && canExpand && (
          <>
            <span
              aria-hidden="true"
              className="feed-fade pointer-events-none absolute bottom-0 right-0 h-[1.5em] w-24"
            />
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
              className="absolute bottom-0 right-0 text-sm font-semibold text-[#45484a] underline-offset-2 hover:text-black hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              &hellip; more
            </button>
          </>
        )}
      </div>

      {expanded && canExpand && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded={true}
          className="mt-1 text-xs font-semibold text-[#45484a] underline-offset-2 hover:text-black hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          less
        </button>
      )}
    </div>
  );
}
