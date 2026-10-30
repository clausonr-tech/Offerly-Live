"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

type WorkflowStep = {
  id: number;
  title: string;
  side: "left" | "right";
};

// ---------------------------------------------------------------------------
// Edit the scene here. Order is the order the viewer meets them - index 0
// arrives first. Add or remove entries freely: the depth slots, the scroll
// length and the spacing all derive from the array's length. `side` picks which
// way a step branches off the spine; alternating keeps the columns balanced.
// ---------------------------------------------------------------------------
const WORKFLOW_STEPS: WorkflowStep[] = [
  { id: 1, title: "Build your profile", side: "left" },
  { id: 2, title: "Firm shortlist", side: "right" },
  { id: 3, title: "Live openings", side: "left" },
  { id: 4, title: "Alumni contacts", side: "right" },
  { id: 5, title: "Outreach drafts", side: "left" },
  { id: 6, title: "Interview prep", side: "right" },
];

const MAX_DEPTH = WORKFLOW_STEPS.length;

// Depth units between consecutive steps. At 1 the pipeline holds every step at
// once, spread from the horizon to the viewer.
const DEPTH_SPACING = 1;
// The depth a step occupies when it is the one being read: the foreground, just
// before it starts to dissolve.
const FOREGROUND_DEPTH = MAX_DEPTH - 1;
// Starting the run part-way means the scene is already populated when the pin
// engages, instead of opening on an empty stage. At exactly FOREGROUND_DEPTH
// the lead-in is one step long, which spaces all six evenly across the scroll.
const TRAVEL_START = FOREGROUND_DEPTH - DEPTH_SPACING;
// The run ends with the last step held in the foreground rather than dissolved,
// so the pin releases on a readable step instead of an empty scene.
const TRAVEL_END_DEPTH = FOREGROUND_DEPTH + (MAX_DEPTH - 1) * DEPTH_SPACING;

// How tall the scroll track is, in viewport heights. The scene is pinned for
// PIN_SCREENS - 1 of actual scrolling, so this is the single number to turn if
// the hold feels too long or too brief.
const PIN_SCREENS = 4.5;

// Fraction of the track spent moving the timeline. The remainder is a short
// hold on the last step so the pin does not release the instant it lands.
const TRAVEL_END = 0.92;

// Where the frozen scene sits when the pin is disabled for reduced motion:
// mid-run, with every step on screen.
const STATIC_TRAVEL_U = 0.5;

type Layout = {
  width: number; // viewBox width; the height is derived from the measured box
  branchFar: number; // branch length at the horizon
  branchNear: number; // additional branch length at the near edge
  bubbleR: number;
  glowRx: number;
  glowRy: number;
  spineTopHalf: number;
  spineBottomHalf: number;
};

// Phones do not get the wide scene scaled down - at 375px a 1000-unit viewBox
// renders a 17px label at 6px, which is unreadable. They get a narrower scene
// whose units land close to 1:1 with CSS pixels, so the type stays legible.
const WIDE: Layout = {
  width: 1000,
  branchFar: 90,
  branchNear: 285,
  bubbleR: 96,
  glowRx: 150,
  glowRy: 62,
  spineTopHalf: 0.7,
  spineBottomHalf: 4,
};

const COMPACT: Layout = {
  width: 390,
  branchFar: 40,
  branchNear: 66,
  bubbleR: 70,
  glowRx: 74,
  glowRy: 46,
  spineTopHalf: 0.5,
  spineBottomHalf: 3,
};

// Vertical geometry as fractions of the derived viewBox height, so the scene
// fills whatever box the pin gives it instead of letterboxing inside a fixed
// aspect. The aspect is clamped: past roughly 2.4:1 there is not enough height
// left for six bubbles to sit apart.
const HORIZON_F = 0.045;
const NEAR_F = 0.99;
const FIRST_F = 0.1;
const TRAVEL_F = 0.8;
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.4;

const MIN_SCALE = 0.26;
const SCALE_RANGE = 0.92;

// Kept in sync with the max-width media query at the bottom of this file.
const COMPACT_QUERY = "(max-width: 700px)";

function subscribeCompact(onChange: () => void) {
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getCompact = () => window.matchMedia(COMPACT_QUERY).matches;
// The server cannot measure the viewport, so it renders the wide scene and the
// client corrects on hydration - the same assumption usePrefersReducedMotion
// makes, and for the same reason: no setState in an effect body.
const getCompactOnServer = () => false;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function projectStep(
  step: WorkflowStep,
  index: number,
  travel: number,
  layout: Layout,
  viewBoxHeight: number,
) {
  const centerX = layout.width / 2;
  const depth = travel - index * DEPTH_SPACING;
  const normalizedDepth = depth / MAX_DEPTH;

  // Exponential projection compresses distant steps near the horizon
  // and spreads steps apart as they approach the viewer.
  const perspectiveProgress = Math.pow(clamp01(normalizedDepth), 2.35);

  const y = viewBoxHeight * (FIRST_F + perspectiveProgress * TRAVEL_F);
  const scale = MIN_SCALE + perspectiveProgress * SCALE_RANGE;

  // Steps resolve out of the horizon and dissolve as they pass the camera, so
  // neither end of the run has anything appear or vanish on a single frame.
  // Outside [0, MAX_DEPTH] a step has not entered yet, or has already left.
  // The dissolve is deliberately steep. A white chip held at a middling opacity
  // over the navy canvas does not read as fading, it reads as a grey chip, so a
  // step stays fully white almost to the end of its run and then goes quickly.
  const emerge = clamp01(normalizedDepth / 0.22);
  const dissolve = clamp01((1 - normalizedDepth) / 0.07);
  const opacity = normalizedDepth <= 0 || normalizedDepth >= 1 ? 0 : emerge * dissolve;

  const branchLength = layout.branchFar + perspectiveProgress * layout.branchNear;
  const direction = step.side === "left" ? -1 : 1;
  const x = centerX + direction * branchLength;

  return { ...step, x, y, scale, opacity };
}

export default function PerspectiveWorkflow() {
  const reducedMotion = usePrefersReducedMotion();
  const compact = useSyncExternalStore(subscribeCompact, getCompact, getCompactOnServer);

  const trackRef = useRef<HTMLElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);

  const [scrollU, setScrollU] = useState(0);
  const [sceneAspect, setSceneAspect] = useState(1.6);

  // Scroll position drives the scene. The pin itself is a sticky child inside a
  // tall track - native scrolling throughout, so the wheel, the scrollbar,
  // Page Down and find-in-page all keep working. Nothing calls preventDefault.
  useEffect(() => {
    if (reducedMotion) return;

    let frame = 0;

    const read = () => {
      frame = 0;
      const el = trackRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const scrollable = rect.height - window.innerHeight;
      setScrollU(scrollable > 0 ? clamp01(-rect.top / scrollable) : 0);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Deferred through rAF rather than read inline: a synchronous setState in
    // an effect body is a lint error here, and the box is not laid out yet.
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [reducedMotion]);

  // The viewBox height follows the box the pin actually hands the scene, so the
  // scene fills it at any window shape instead of sitting in dead bands.
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width <= 0 || box.height <= 0) return;
      setSceneAspect(Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, box.width / box.height)));
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = compact ? COMPACT : WIDE;
  const centerX = layout.width / 2;
  const viewBoxHeight = Math.round(layout.width / sceneAspect);

  // Under reduced motion the track is not pinned and nothing is scroll-driven:
  // the scene renders once, frozen mid-run.
  const travelU = reducedMotion ? STATIC_TRAVEL_U : clamp01(scrollU / TRAVEL_END);
  const travel = TRAVEL_START + travelU * (TRAVEL_END_DEPTH - TRAVEL_START);
  const cueOpacity = reducedMotion ? 0 : clamp01(1 - scrollU / 0.05);

  const projectedSteps = WORKFLOW_STEPS.map((step, index) =>
    projectStep(step, index, travel, layout, viewBoxHeight),
  ).sort((a, b) => a.y - b.y);

  // A stroked line of constant width reads as a pole, not as a road running to
  // a vanishing point. Tapering it from a sliver at the horizon to a full-width
  // band at the near edge is what sells the recession.
  const spine = [
    `M ${centerX - layout.spineTopHalf} ${viewBoxHeight * HORIZON_F}`,
    `L ${centerX + layout.spineTopHalf} ${viewBoxHeight * HORIZON_F}`,
    `L ${centerX + layout.spineBottomHalf} ${viewBoxHeight * NEAR_F}`,
    `L ${centerX - layout.spineBottomHalf} ${viewBoxHeight * NEAR_F}`,
    "Z",
  ].join(" ");

  return (
    <section
      id="how-it-works"
      className="workflow-track"
      ref={trackRef}
      data-static={reducedMotion ? "" : undefined}
      style={reducedMotion ? undefined : { height: `${PIN_SCREENS * 100}dvh` }}
    >
      <div className="workflow-pin">
        <div className="timeline-layer">
          <header className="workflow-heading">
            <span className="eyebrow">How it works</span>
            <h2>Six steps, one pipeline.</h2>
            <p className="scroll-cue" style={{ opacity: cueOpacity }}>
              Scroll to move through it
            </p>
          </header>

          <div className="workflow-viewport" ref={sceneRef}>
            <svg
              className="workflow-scene"
              viewBox={`0 0 ${layout.width} ${viewBoxHeight}`}
              role="img"
              aria-label="Perspective timeline of the six stages of the Offerly recruiting pipeline"
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                {/* stop-color is set from CSS rather than as an attribute: SVG
                    attributes do not resolve var(), CSS properties do. */}
                <linearGradient id="workflow-spine" x1="0" y1="0" x2="0" y2="1">
                  <stop className="spine-stop-far" offset="0%" />
                  <stop className="spine-stop-mid" offset="45%" />
                  <stop className="spine-stop-near" offset="100%" />
                </linearGradient>

                <linearGradient id="workflow-bubble" x1="0" y1="0" x2="1" y2="1">
                  <stop className="bubble-stop-top" offset="0%" />
                  <stop className="bubble-stop-bottom" offset="100%" />
                </linearGradient>

                <radialGradient id="workflow-horizon">
                  <stop className="horizon-stop-in" offset="0%" />
                  <stop className="horizon-stop-out" offset="100%" />
                </radialGradient>
              </defs>

              {/* Drawn in scene coordinates rather than as a positioned CSS
                  blur: the vanishing point moves with the viewBox. */}
              <ellipse
                className="horizon-glow"
                cx={centerX}
                cy={viewBoxHeight * HORIZON_F}
                rx={layout.glowRx}
                ry={layout.glowRy}
              />

              <path className="center-spine" d={spine} />

              {projectedSteps.map((step) => {
                // Only the bubble and its label scale about the bubble centre.
                // The branch and its junction are drawn at true coordinates:
                // scaling those about the bubble would move the junction off
                // the spine by branchLength * (1 - scale), detaching every
                // branch from the centre line.
                const bubbleTransform = [
                  `translate(${step.x} ${step.y})`,
                  `scale(${step.scale})`,
                  `translate(${-step.x} ${-step.y})`,
                ].join(" ");

                return (
                  <g key={step.id} opacity={step.opacity}>
                    <line
                      className="branch-line"
                      x1={centerX}
                      y1={step.y}
                      x2={step.x}
                      y2={step.y}
                      strokeWidth={1 + 2 * step.scale}
                    />

                    <circle
                      className="center-junction"
                      cx={centerX}
                      cy={step.y}
                      r={3 + 4 * step.scale}
                      strokeWidth={1.4 * step.scale}
                    />

                    <g transform={bubbleTransform}>
                      <circle className="step-bubble" cx={step.x} cy={step.y} r={layout.bubbleR} />
                      <circle
                        className="step-bubble-wash"
                        cx={step.x}
                        cy={step.y}
                        r={layout.bubbleR}
                      />

                      <text
                        className="step-number"
                        x={step.x}
                        y={step.y - layout.bubbleR * 0.115}
                        textAnchor="middle"
                      >
                        STEP {step.id}
                      </text>

                      <text
                        className="step-title"
                        x={step.x}
                        y={step.y + layout.bubbleR * 0.156}
                        textAnchor="middle"
                      >
                        {step.title}
                      </text>
                    </g>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

      </div>

      <style jsx>{`
        .workflow-track {
          position: relative;
          --scene-bg: var(--mkt-band);
          color: var(--mkt-text);
          background-color: var(--scene-bg);
        }

        /* The hold. A sticky child inside a tall track keeps the scene on
           screen while the page scrolls past it - no wheel interception, so
           scrollbars, keyboard paging and find-in-page all behave normally. */
        .workflow-pin {
          position: sticky;
          top: 0;
          display: flex;
          height: 100dvh;
          flex-direction: column;
          overflow: hidden;
        }

        .timeline-layer {
          display: flex;
          height: 100%;
          flex-direction: column;
          /* The marketing header is fixed at top-6, so clear it the way the
             other marketing pages do rather than sliding under it. */
          padding: 128px 24px 24px;
        }

        .workflow-heading {
          position: relative;
          z-index: 2;
          max-width: 760px;
          margin: 0 auto;
          text-align: center;
        }

        .eyebrow {
          color: var(--mkt-accent);
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .workflow-heading h2 {
          margin: 14px 0 12px;
          font-family: var(--font-mkt-display), Georgia, serif;
          font-size: clamp(2rem, 4.4vw, 3.6rem);
          font-weight: 400;
          line-height: 1.02;
          letter-spacing: -0.03em;
        }

        .scroll-cue {
          margin: 0;
          color: var(--mkt-faint);
          font-size: 0.85rem;
          letter-spacing: 0.02em;
          transition: opacity 240ms ease-out;
        }

        .workflow-viewport {
          position: relative;
          width: min(1100px, 100%);
          min-height: 0;
          flex: 1;
          margin: 8px auto 0;
        }

        .workflow-scene {
          display: block;
          width: 100%;
          height: 100%;
        }

        /* prefers-reduced-motion: the pin and the tall track come off. The
           scene renders once, mid-run, and the page continues below it. */
        .workflow-track[data-static] .workflow-pin {
          position: static;
          height: auto;
        }

        .workflow-track[data-static] .workflow-viewport {
          flex: none;
          aspect-ratio: 1000 / 620;
        }

        .spine-stop-far {
          stop-color: var(--mkt-accent);
          stop-opacity: 0.08;
        }
        .spine-stop-mid {
          stop-color: var(--mkt-accent);
          stop-opacity: 0.45;
        }
        .spine-stop-near {
          stop-color: var(--mkt-accent);
          stop-opacity: 0.85;
        }

        /* Both stops carry the same colour and vary only in stop-opacity.
           Fading to the keyword transparent instead interpolates towards a
           transparent BLACK, greying the chip across its own width - invisible
           on a dark bubble, obvious once the bubble is white. */
        .bubble-stop-top {
          stop-color: rgb(41, 90, 127);
          stop-opacity: 0.1;
        }
        .bubble-stop-bottom {
          stop-color: rgb(41, 90, 127);
          stop-opacity: 0;
        }

        .horizon-stop-in {
          stop-color: var(--mkt-accent);
          stop-opacity: 0.16;
        }
        .horizon-stop-out {
          stop-color: var(--mkt-accent);
          stop-opacity: 0;
        }

        .horizon-glow {
          fill: url(#workflow-horizon);
        }

        .center-spine {
          fill: url(#workflow-spine);
          stroke: none;
        }

        .branch-line {
          stroke: var(--mkt-border-strong);
          stroke-linecap: round;
        }

        .center-junction {
          fill: var(--mkt-accent);
          stroke: var(--scene-bg);
        }

        .step-bubble {
          fill: #ffffff;
          stroke: rgba(41, 90, 127, 0.28);
          stroke-width: 1.5;
        }

        .step-bubble-wash {
          fill: url(#workflow-bubble);
          stroke: none;
        }

        .step-number {
          /* 7.3:1 on the white chip; the dark theme's --mkt-accent would be
             2.2:1 there. */
          fill: #295a7f;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 2.2px;
        }

        .step-title {
          fill: #0a0a0a;
          font-size: 21px;
          font-weight: 600;
        }

        /* Must stay in step with COMPACT_QUERY above: past this width the scene
           switches to the COMPACT layout, whose units are near 1:1 with pixels,
           so these sizes are read at roughly their nominal value. */
        @media (max-width: 700px) {
          .timeline-layer {
            padding: 104px 16px 16px;
          }

          .workflow-heading h2 {
            font-size: clamp(1.6rem, 7.4vw, 2.2rem);
          }

          .step-number {
            font-size: 11px;
            letter-spacing: 1.6px;
          }

          /* 17px leaves the longest title only ~7 units clear of the chip's
             chord; 16px puts that back to ~15. */
          .step-title {
            font-size: 16px;
          }
        }
      `}</style>
    </section>
  );
}
