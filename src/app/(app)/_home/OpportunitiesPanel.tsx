"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import FirmLogo from "../discovery/FirmLogo";
import OpenTag from "./OpenTag";

export type RolodexFirm = {
  slug: string;
  name: string;
  website: string;
  sector: string;
};

// The home page's showcase for Opportunities: a right-to-left marquee of every
// firm we know, with the section title overlaid across the panel's left edge -
// the same device the hero uses, where the Offerly wordmark crosses the edge of
// the email. Meant as the first of a set; the other sections get the same
// treatment, so the layout here is deliberately generic (panel + moving deck +
// overlapping title) rather than anything specific to firms.
//
// The deck pauses on hover and does not animate at all under
// prefers-reduced-motion - an endlessly moving strip is exactly the kind of
// motion that setting exists to stop.
export default function OpportunitiesPanel({
  firms,
}: {
  firms: RolodexFirm[];
}) {
  // The deck is ~390 cards and ~390 logo requests. Rendering it up-front more
  // than DOUBLED first contentful paint on this page (3.3s -> 6.2s measured),
  // and since the hero intro cannot start until the page paints, that delay
  // landed inside the pause between the email and the wordmark. The panel sits
  // below the fold, so it costs nothing to build it only once it is nearly in
  // view. The track keeps its height either way, so nothing shifts.
  const [deckMounted, setDeckMounted] = useState(false);

  useEffect(() => {
    // Intersection is NOT the right trigger here: the hero is 88vh, so this
    // panel is already at the fold on load and an observer fires immediately -
    // which defers nothing. Mount on idle instead, so building ~390 cards and
    // firing ~390 logo requests can never compete with first paint or with the
    // hero intro. The timeout is the upper bound if the main thread stays busy.
    type IdleWindow = Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const w = window as IdleWindow;

    if (typeof w.requestIdleCallback !== "function") {
      const id = window.setTimeout(() => setDeckMounted(true), 2000);
      return () => window.clearTimeout(id);
    }
    const handle = w.requestIdleCallback(() => setDeckMounted(true), { timeout: 2500 });
    return () => w.cancelIdleCallback?.(handle);
  }, []);

  return (
    <section id="discovery" className="relative scroll-mt-6">
      <Link
        href="/discovery"
        aria-label="Open Discovery"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        {/* The deck: overlapping cards travelling right-to-left, pausing when
            the panel is hovered so a firm can actually be read. */}
        {/* No margin under this section - News sits flush against it below.
            The top border marks the seam with Schedule above; the card
            shadow stays off so it doesn't draw a second, competing line
            right next to the hairline. */}
        <div className="feed-divider marquee-pause relative overflow-hidden border-t bg-surface-1">
          {/* Fades the panel's own lighter surface into the darker page
              background at its right edge only - the left stays unfaded on
              purpose. z-60, well above the marquee cards' own z-index (they
              run up to firms.length), so a card sliding past does not paint
              over the fade. */}
          <div className="pointer-events-none absolute inset-y-0 right-0 z-[60] w-10 bg-gradient-to-l from-background to-transparent" />

          {/* The list is rendered twice and the track travels -50%, so it lands
              on the start of the second copy and loops with no visible seam.
              Both halves must be IDENTICAL for that to hold - which is why the
              card rotation is keyed off the firm's index within the original
              list (i % count) and not the duplicated index, and why every card
              carries the same negative margin with no first-child exception. */}
          <div
            className={`marquee-track pb-28 pt-10 ${deckMounted ? "" : "h-[210px] w-full"}`}
            style={{
              animationDuration: `${Math.max(60, firms.length * 1.4)}s`,
            }}
            aria-hidden="true"
          >
            {(deckMounted ? [...firms, ...firms] : []).map((firm, i) => {
              const n = i % firms.length;
              return (
                <div
                  key={`${firm.slug}-${i}`}
                  className="relative -ml-12 shrink-0"
                  style={{
                    zIndex: n,
                    transform: `rotate(${(n % 2 === 0 ? -1 : 1) * (1.5 + (n % 3) * 0.6)}deg)`,
                  }}
                >
                  <div className="flex h-[210px] w-[164px] flex-col justify-between rounded-lg border border-brand-100 bg-white p-4 shadow-card">
                    <FirmLogo
                      domain={firm.website}
                      name={firm.name}
                      size={34}
                    />
                    <div>
                      <p className="display-serif line-clamp-2 break-words text-[13px] font-bold leading-snug text-brand-900">
                        {firm.name}
                      </p>
                      <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-warmgray-500">
                        {firm.sector}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scrim under the title band - the deck scrolls, so the title can end
            up over a card face or over empty panel depending on position. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-40 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />

          {/* Overlaid title. Pulled left of the panel and sitting across its
            border, mirroring the hero. The em-based negative margin cancels the
            italic Bodoni "O"'s own side bearing so the glyph - not its box -
            lines up with the page's left edge. */}
          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Discovery
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}
