"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import OpenTag from "./OpenTag";

const SRC = "/videos/discovery-orbit.mp4";

// The fifth panel, and the odd one out on purpose. Opportunities, Contacts,
// Applications and Schedule are each a literal render of the student's own
// data - there is nothing personal to show for Discovery, so this is
// decoration instead: a looping clip rather than the hand-drawn skyline and
// solar system that sat here before it.
//
// The source is a portrait 2160x3840 clip - taller than it is wide, the
// opposite of this panel, which is wide and short. `object-cover` is the
// whole trick: it scales the clip UNIFORMLY (never distorting it) until both
// dimensions at least fill the panel, then crops whatever overflows. Because
// this panel is always far wider relative to its height than the clip is
// wide relative to ITS height, that scale is always driven by matching the
// panel's WIDTH - which is exactly "widen it to fill the horizontal space"
// - and the surplus height (which is substantial, given how tall the source
// is) is what gets cropped, which is exactly "crop it vertically". One
// utility class does both, and guarantees no stretching either way.
export default function DiscoveryPanel() {
  const reduced = usePrefersReducedMotion();
  const [playable, setPlayable] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // onCanPlay alone is not enough. The clip is served from the same origin and
  // preloaded, so `canplay` routinely fires BEFORE React attaches its handler
  // - in which case the event never reaches us, `playable` stays false, and
  // the video sits fully decoded but never shown. Reading readyState on mount
  // covers the race; the handler covers the slow path. Same fix as
  // the page's old full-length backdrop clip, which hit the exact same race.
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.readyState >= 3) setPlayable(true);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playable) return;
    // A reduced-motion preference should never have to be overridden by hand
    // - under it the clip stays on its first frame instead of looping.
    if (reduced) {
      v.pause();
      return;
    }
    void v.play().catch(() => {});
  }, [playable, reduced]);

  return (
    <section id="opportunities" className="relative scroll-mt-6">
      <Link
        href="/dashboard"
        aria-label="Open Opportunities"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <div className="relative overflow-hidden bg-white/70">
          {/* Fades the video's own hard left/right edges into the page
              background, the same treatment every other panel's surface
              gets where it meets the page - here it's the clip's own
              content doing the fading rather than a flat color. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-background to-transparent" />

          {/* No top border: this is the first panel in the stack, sitting
              right under the sticky topbar with nothing above it to divide
              from - a hairline there just drew a stray line under the nav. */}
          {/* Full-bleed, not padded like the paper/card panels either side of
              it. Taller than its siblings now (500 vs their ~270-373) rather
              than height-matched - the clip is the one cinematic panel in the
              set, and the short box was cropping the source's tall portrait
              frame down to a thin band, so the bright orbiting content read
              as a brief flash before the bottom scrim's fade to
              --background cut it off, with the next panel's flat surface-1
              landing right after. More height means more of the source
              actually shows before that fade starts, so the run-up to it
              reads as a wind-down instead of an abrupt stop. */}
          <div style={{ height: 500 }} className="relative overflow-hidden bg-brand-950/5">
            <video
              ref={videoRef}
              src={SRC}
              muted
              loop
              playsInline
              preload="auto"
              aria-hidden="true"
              // autoPlay is deliberately absent - playback is owned by the
              // effect above, so the reduced-motion preference is honoured on
              // first paint rather than corrected after a frame has moved.
              onCanPlay={() => setPlayable(true)}
              onError={() => setPlayable(false)}
              className={`absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-700 motion-reduce:transition-none ${
                playable ? "opacity-100" : "opacity-0"
              }`}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-[var(--background)] via-[var(--background)]/85 to-transparent" />

          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Opportunities
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}
