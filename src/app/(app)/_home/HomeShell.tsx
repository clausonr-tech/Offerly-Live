"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import type { NavSection } from "@/lib/nav-sections";
import ScrollHero from "./ScrollHero";

/**
 * The home page's two states.
 *
 * Before: the offer-letter hero, with a scroll cue under it. After: the hero is
 * GONE - not scrolled past, removed - and a sticky bar of section links takes
 * the top of the page. The transition is one-way for the rest of the visit,
 * because the email is an opening rather than a place you navigate back to.
 *
 * Removing an 88vh element mid-scroll would normally throw the reader down the
 * page by exactly its height. `retire` compensates in the same frame, so the
 * content that was under the viewport's top edge stays under it.
 */
// ScrollHero is rendered HERE rather than passed in as a prop. It needs an
// onScrollCue callback, and a server component cannot hand a function to an
// element it creates - so the element has to be created on the client side of
// the boundary, which is this file.
export default function HomeShell({
  sections,
  children,
}: {
  sections: NavSection[];
  children: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [retired, setRetired] = useState(false);
  const [barIn, setBarIn] = useState(false);
  const heroRef = useRef<HTMLDivElement>(null);
  // The hero's height, kept in a ref instead of re-read from the DOM wherever
  // it is needed. It only ever changes on a real resize (the hero is
  // viewport-height-driven), never on scroll - so measuring it via
  // getBoundingClientRect() inside the scroll handler below, once per scroll
  // EVENT, was a forced synchronous layout read on every tick for a number
  // that was not changing. Combined with ScrollHero's own scroll handler
  // writing a transform in the same event, that is a textbook layout-thrash
  // (write, forced read, write, forced read...) - cheap enough to miss on a
  // mouse wheel's handful of events per gesture, but macOS trackpad scrolling
  // fires far more scroll events per second, which is where this showed up
  // as visible stutter.
  const heroHeight = useRef(0);
  // Set while the cue's own smooth scroll is running, so the "user scrolled
  // past it themselves" rule below does not fire in the middle of it and cut
  // the animation short.
  const animating = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const measure = () => {
      heroHeight.current = el.getBoundingClientRect().height;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const retire = useCallback(() => {
    if (done.current) return;
    done.current = true;
    const h = heroHeight.current;
    const y = window.scrollY;
    // flushSync, not a plain setRetired - unmounting the hero shifts every
    // later pixel up by its full height, and the scrollTo below has to land
    // before the browser paints that shift or the jump is visible as a flash.
    // A plain setState only schedules the DOM update; the requestAnimationFrame
    // this used to wrap the scrollTo in doesn't run until the FOLLOWING frame,
    // so there was a real painted frame in between showing the page already
    // jumped with no compensation yet - worse the harder someone scrolled, since
    // a fast fling can cover many scroll events before onScroll's threshold
    // check ever fires. flushSync forces the commit through synchronously, so
    // the scrollTo runs before anything is painted.
    flushSync(() => setRetired(true));
    window.scrollTo({ top: Math.max(0, y - h), behavior: "auto" });
    // One frame before the bar animates, so its fade isn't competing with the
    // scroll jump that just happened.
    requestAnimationFrame(() => setBarIn(true));
  }, []);

  // The cue: travel the height of the hero, then retire it once the scroll has
  // actually stopped. Waiting for the stop (rather than a fixed timeout) is
  // what keeps the removal from landing mid-animation.
  const handleCue = useCallback(() => {
    const h = heroHeight.current;
    if (reduced) {
      retire();
      return;
    }
    animating.current = true;
    window.scrollTo({ top: h, behavior: "smooth" });

    let settled = 0;
    let last = window.scrollY;
    const tick = window.setInterval(() => {
      // `scrollend` is not in every browser this has to run in, so settle is
      // detected by the position holding still for two consecutive frames.
      if (Math.abs(window.scrollY - last) < 1) settled += 1;
      else settled = 0;
      last = window.scrollY;
      if (settled >= 2) {
        window.clearInterval(tick);
        animating.current = false;
        retire();
      }
    }, 90);
    // Hard stop, in case a browser never settles (a user grabbing the
    // scrollbar mid-animation will do it).
    window.setTimeout(() => {
      window.clearInterval(tick);
      animating.current = false;
      retire();
    }, 1600);
  }, [reduced, retire]);

  // Scrolling past the hero by hand retires it too - otherwise the email would
  // still be sitting up there for anyone who ignored the cue.
  useEffect(() => {
    if (retired) return;
    const onScroll = () => {
      if (animating.current || done.current) return;
      const h = heroHeight.current;
      if (h > 0 && window.scrollY >= h - 8) retire();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [retired, retire]);

  return (
    <div>
      {!retired && (
        <div ref={heroRef}>
          <ScrollHero onScrollCue={handleCue} />
        </div>
      )}

      {retired && (
        // Full-bleed via margins rather than `left-1/2 + translate`: on a
        // sticky element `left` is a stickiness THRESHOLD, not a position, so
        // the usual breakout trick would stop it sticking at all.
        <nav
          aria-label="Sections"
          style={{ marginLeft: "calc(50% - 50vw)", marginRight: "calc(50% - 50vw)" }}
          className={`sticky top-0 z-40 -mt-8 border-b border-brand-100 bg-white/85 backdrop-blur transition-opacity duration-500 motion-reduce:transition-none ${
            barIn ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* Each link takes an equal share of the bar, so the sections span
              it left to right instead of bunching at one end. `basis-0`
              with `flex-1` is what makes the shares equal rather than
              proportional to label length, and `min-w-max` stops a link
              shrinking below its own text - which is what turns the row into a
              horizontal scroll on a narrow screen instead of letting it wrap to
              two rows and shift the page under the reader. */}
          <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2">
            {sections.map((section) => (
              <Link
                key={section.href}
                href={section.href}
                className="min-w-max flex-1 basis-0 whitespace-nowrap border-b-2 border-transparent px-2.5 py-1.5 text-center text-[13px] tracking-tight text-warmgray-500 transition-colors hover:border-brand-200 hover:text-brand-900 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
              >
                {section.label}
              </Link>
            ))}
          </div>
        </nav>
      )}

      {children}
    </div>
  );
}
