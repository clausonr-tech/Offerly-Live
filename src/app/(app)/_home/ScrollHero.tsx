"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import OfferEmailArt from "./OfferEmailArt";
import OfferlyLogo from "@/components/brand/OfferlyLogo";

// The photo itself moves as the page scrolls - zooms in slightly and drifts
// upward - so the hero reads as a single continuous shot rather than a
// static banner, before the section list appears beneath it. Transform is
// driven off scrollY directly (not the image's own position) since this is
// always the first thing in the page, pinned at the top.
const WORDMARK = "Offerly";
const TAGLINE = "Beat the cycle";
// Flat interval per character - the wordmark types at a steady pace. The logo
// is artwork rather than text now, so "typing" it is a left-to-right wipe that
// advances one letter's worth per step on this same clock.
const WORDMARK_MS = 123;
const GAP_MS = 180;
// The email reveals at roughly twice the wordmark's pace: 20 lines staggered
// 40ms apart, each wiping in over 70ms. Keep these in step with .t-line in
// globals.css - the CSS owns the per-line animation, this owns when the
// wordmark is allowed to start.
// Base zoom of the hero art. The scroll handler zooms from here, but this must
// ALSO be the transform on first paint: the handler only runs in an effect, so
// rendering with no transform meant the email painted at scale 1 and then
// visibly jumped to 1.12 once the effect fired.
const BASE_SCALE = 1.08;
const SCROLL_ZOOM = 0.1;

// Framing switches on the hero's measured SHAPE, not a breakpoint: the hero is
// viewport-height-driven, so a tablet in portrait is as short-and-narrow as a
// phone despite being well past sm:. Wide enough to show the whole canvas ->
// frame all of it. Narrower -> centre on the text column instead, because the
// one in-focus sentence (artwork x 166-655) is the only thing that must stay
// readable and a canvas-centred crop cuts it in half on a phone.
// The y-origin of 23 is kept from our framing: it re-centres the crop on the
// letter (y 140-906, midpoint 523) rather than on the viewBox's own centre.
const WIDE_FRAME = { viewBox: "0 23 1600 1000", preserveAspectRatio: "xMinYMid slice" };
const NARROW_FRAME = { viewBox: "0 23 820 1000", preserveAspectRatio: "xMidYMid slice" };
const CANVAS_ASPECT = 1600 / 1000;

const EMAIL_LINES = 20;
const EMAIL_STAGGER_MS = 60;
const EMAIL_WIPE_MS = 100;
const EMAIL_MS = EMAIL_LINES * EMAIL_STAGGER_MS + EMAIL_WIPE_MS;
const AFTER_EMAIL_PAUSE_MS = 250;

// Types the two hero lines out in sequence on every mount - which means every
// reload and every fresh login, since this route remounts each time.
//
// Two things it deliberately does NOT do:
//  - it never removes the lines from the DOM, so nothing reflows while typing;
//    slicing a string only changes the glyph run, and the caret keeps the line
//    box alive when the string is still empty
//  - it doesn't animate at all under prefers-reduced-motion, where a cursor
//    jittering across the page is exactly the kind of motion people turn off
function useTypedHero() {
  const [wordmark, setWordmark] = useState("");
  const [tagline, setTagline] = useState("");
  // "email" is the leading phase: the artwork is still writing itself out and
  // neither hero caret should be visible yet.
  const [phase, setPhase] = useState<"email" | "wordmark" | "tagline" | "done">("email");

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setWordmark(WORDMARK);
      setTagline(TAGLINE);
      setPhase("done");
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    // Everything after the email is scheduled from `startDelay`.
    function scheduleFrom(startDelay: number) {
      if (cancelled) return;
      let t = startDelay;
      // Caret appears exactly when the wordmark's turn begins, not before.
      timers.push(setTimeout(() => setPhase("wordmark"), t));
      for (let i = 1; i <= WORDMARK.length; i++) {
        t += WORDMARK_MS;
        timers.push(setTimeout(() => setWordmark(WORDMARK.slice(0, i)), t));
      }
      // The tagline arrives whole rather than typing. Going straight to "done"
      // hands the caret its three-flash sign-off at the same moment, so the
      // line lands and the cursor signs off together instead of the caret
      // idling next to already-finished text.
      t += GAP_MS;
      timers.push(
        setTimeout(() => {
          setTagline(TAGLINE);
          setPhase("done");
        }, t),
      );
    }

    // Start the email reveal HERE rather than letting it begin at paint. Both
    // halves of the intro now share this one clock, so the pause between them
    // is exactly AFTER_EMAIL_PAUSE_MS regardless of how long paint or hydration
    // took. Reading the animation's own timing to predict the offset was tried
    // first and drifted badly - by ~1s on this page, more on a cold load.
    document.documentElement.dataset.intro = "run";
    // Scheduled immediately, NOT from a rAF callback. Aligning the timers to
    // the first painted frame was tried and is actively harmful: rAF is starved
    // whenever the tab is backgrounded, which turned the pause into 7-13s. The
    // reveal still begins one painted frame after this line, so in a real
    // foregrounded browser the timers lead it by ~16ms and the pause lands
    // within a frame of its nominal value.
    scheduleFrom(EMAIL_MS + AFTER_EMAIL_PAUSE_MS);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      delete document.documentElement.dataset.intro;
    };
  }, []);

  return { wordmark, tagline, phase };
}

// Sized in em so it tracks whichever line it sits in. aria-hidden because it
// is pure decoration - the full text is always announced from the sr-only copy.
function Caret({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`ml-[0.06em] inline-block w-[0.055em] translate-y-[0.06em] self-stretch bg-current align-baseline ${className}`}
      style={{ height: "0.72em" }}
    />
  );
}

// Scrolls the first section below the hero - the Opportunities panel - fully
// into view. When the whole block fits on screen it is centred rather than
// top-aligned, so the deck and its title are framed together instead of the
// block clinging to the top edge with dead space below. Falls back to a plain
// jump under prefers-reduced-motion.
function scrollToFirstSection() {
  const el = document.getElementById("opportunities") ?? document.getElementById("workspace");
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const fits = rect.height <= vh - 32;
  const offset = fits ? Math.max(16, (vh - rect.height) / 2) : 16;
  window.scrollTo({
    top: Math.max(0, window.scrollY + rect.top - offset),
    behavior: reduced ? "auto" : "smooth",
  });
}

export default function ScrollHero({ onScrollCue }: { onScrollCue?: () => void } = {}) {
  const imgRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(WIDE_FRAME);
  const { wordmark, tagline } = useTypedHero();
  // The scroll cue is only meaningful while the page is actually at the top.
  // Driven off scroll position rather than a "was clicked" flag so it also
  // behaves correctly when the user scrolls by hand, and so it comes back
  // exactly when they return to the top - by any means.
  const [atTop, setAtTop] = useState(true);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    function measure(width: number, height: number) {
      if (!height) return;
      setFrame(width / height >= CANVAS_ASPECT ? WIDE_FRAME : NARROW_FRAME);
    }

    // Measured once up front rather than waiting on the observer's first
    // callback: ResizeObserver only runs on a rendering frame, so a hero that
    // mounts in a background tab would sit on the wide default until something
    // painted. The observer then only has to catch actual resizes.
    const rect = el.getBoundingClientRect();
    measure(rect.width, rect.height);

    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      measure(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let ticking = false;
    const range = 500; // px of scroll over which the effect fully plays out

    function apply() {
      ticking = false;
      const el = imgRef.current;
      if (!el) return;
      const progress = Math.min(1, Math.max(0, window.scrollY / range));
      const scale = BASE_SCALE + progress * SCROLL_ZOOM;
      const translate = progress * 40;
      el.style.transform = `scale(${scale}) translate3d(0, ${translate}px, 0)`;
    }

    function onScroll() {
      // Deliberately NOT inside the rAF below. The parallax transform can
      // afford to wait for a frame, but rAF is throttled whenever the tab is
      // backgrounded - and gating the scroll cue's visibility on it left the
      // button showing at scroll positions where it should have been hidden.
      // React bails out when the value is unchanged, so this only re-renders
      // on the two crossings of the threshold.
      setAtTop(window.scrollY <= 8);
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(apply);
      }
    }

    apply();
    setAtTop(window.scrollY <= 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Full-bleed: <main> is max-w-7xl with px-4, so the hero breaks out of it to
  // span the viewport. Previously it stopped at the container edge, which left
  // the page background showing as bands either side of the email card - the
  // "grey outline". Edge-to-edge means there is no boundary to see; the wash
  // fades the art into the page colour at the far left/right instead.
  return (
    <div ref={rootRef} className="relative left-1/2 -mt-8 mb-10 h-[88vh] max-h-[840px] min-h-[460px] w-screen -translate-x-1/2 overflow-hidden sm:mt-0">
      <div
        ref={imgRef}
        className="absolute inset-0 will-change-transform"
        style={{ transform: `scale(${BASE_SCALE}) translate3d(0, 0, 0)` }}
      >
        {/* Inlined rather than <img> so the email's own typing reveal shares a
            clock with the wordmark below it, and so it can be inspected. See
            OfferEmailArt for how the artwork is built.
            Cropping is handled by preserveAspectRatio inside the SVG
            (object-fit/object-position do nothing to an inline <svg>). */}
        <OfferEmailArt
          viewBox={frame.viewBox}
          preserveAspectRatio={frame.preserveAspectRatio}
          className="absolute inset-0 h-full w-full"
          style={
            {
              "--type-stagger": `${EMAIL_STAGGER_MS}ms`,
              "--type-wipe": `${EMAIL_WIPE_MS}ms`,
            } as React.CSSProperties
          }
        />
      </div>

      {/* Wash is a themed token (--hero-wash in globals.css) rather than a
          literal gradient: in light mode this has to fade the image into cream
          so the navy wordmark reads, and into black in Dealroom so the white
          one does. Kept lighter through the middle band in both, because the
          one in-focus sentence in the email has to stay readable. */}
      <div className="absolute inset-0" style={{ background: "var(--hero-wash)" }} />

      <div className="relative flex h-full flex-col items-start justify-end px-1 pb-14 sm:px-2">
        {/* Screen readers get the finished lines immediately; the animated
            copy below is aria-hidden so it isn't announced letter by letter. */}
        <span className="sr-only">
          Offerly. Beat the cycle.
        </span>

        {/* The logo, wiped in left to right as the old wordmark used to type.
            Always laid out at full size and only clipped, so nothing reflows
            while it writes itself. Letters follow text-brand-900 - navy in
            light mode, white in Dealroom - and the arrow keeps its blue. */}
        <h1 aria-hidden="true" className="text-brand-900">
          <OfferlyLogo
            className="block h-[13vw] w-auto sm:h-[5.25rem] lg:h-[7rem]"
            style={{
              clipPath: `inset(-10% ${100 - (wordmark.length / WORDMARK.length) * 100}% -10% 0)`,
              transition: `clip-path ${WORDMARK_MS}ms linear`,
            }}
          />
        </h1>
        <p
          aria-hidden="true"
          className={`mt-4 -ml-[0.09em] max-w-md text-base font-medium text-warmgray-500 sm:text-lg ${
            tagline ? "tagline-pop" : ""
          }`}
        >
          {tagline}
          {/* Permanently invisible, and mounted purely to hold the line box.
              The tagline is empty until it pops in, and an empty <p> has no
              line box at all - because the hero is bottom-aligned (justify-end)
              that collapse jumped the wordmark up ~31px. No caret is ever shown
              here: the tagline arrives whole, so there is nothing to type. */}
          <Caret className="opacity-0" />
        </p>
      </div>

      <button
        type="button"
        // HomeShell takes this over when it is mounted: the cue no longer just
        // moves the viewport, it retires the hero for the rest of the visit.
        onClick={onScrollCue ?? scrollToFirstSection}
        aria-label="Scroll to opportunities"
        tabIndex={atTop ? 0 : -1}
        aria-hidden={!atTop}
        className={`absolute bottom-5 left-1/2 hidden -translate-x-1/2 cursor-pointer flex-col items-center gap-1 rounded px-3 py-1 text-warmgray-500 transition-[opacity,color] duration-300 hover:text-brand-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 sm:flex ${
          atTop ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.2em]">Scroll</span>
        <ChevronDown size={14} className="animate-bounce" />
      </button>
    </div>
  );
}
