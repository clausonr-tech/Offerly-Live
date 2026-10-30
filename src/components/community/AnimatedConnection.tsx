import type { CommunityGroup } from "./data";

export type Point = { x: number; y: number };

// Adapted from the idea behind Magic UI's Animated Beam (MIT) - measure both
// endpoints relative to a shared container and draw a curve between them -
// but written against this project's SVG/CSS rather than pulling in a motion
// library the repo does not already have.
function curvePath(from: Point, to: Point, curvature: number) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  // Perpendicular to the chord, so the bow is consistent whichever way the
  // cluster sits once the container has been resized.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / length) * curvature;
  const cy = my + (dx / length) * curvature;

  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
}

export default function AnimatedConnection({
  group,
  from,
  to,
  active,
  reducedMotion,
}: {
  group: CommunityGroup;
  from: Point;
  to: Point;
  active: boolean;
  reducedMotion: boolean;
}) {
  const d = curvePath(from, to, group.curvature);
  const pathId = `beam-${group.id}`;

  return (
    <g>
      {/* Resting beam. */}
      <path
        id={pathId}
        d={d}
        fill="none"
        stroke={group.accent}
        strokeWidth={active ? 1.8 : 1.2}
        strokeOpacity={active ? 0.8 : 0.36}
        strokeLinecap="round"
        style={{ transition: "stroke-opacity 300ms ease-out, stroke-width 300ms ease-out" }}
      />

      {/* Flow. A dashed overlay whose offset animates, which reads as movement
          along the beam without animating any layout property. */}
      {!reducedMotion && (
        <path
          className="beam-flow"
          d={d}
          fill="none"
          stroke={group.accent}
          strokeWidth={active ? 2 : 1.4}
          strokeOpacity={active ? 0.9 : 0.4}
          strokeLinecap="round"
          strokeDasharray="3 132"
        />
      )}

      {/* Message packets. Two per beam, one outbound and one returning, so the
          section reads as a conversation rather than a broadcast. */}
      {!reducedMotion && (
        <>
          <circle r={active ? 3.2 : 2.4} fill={group.accent} opacity={active ? 0.95 : 0.6}>
            <animateMotion dur="4.4s" repeatCount="indefinite" begin={`${group.curvature === 0 ? 0.8 : 0}s`}>
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          <circle r={active ? 2.6 : 1.9} fill={group.accent} opacity={active ? 0.7 : 0.35}>
            <animateMotion
              dur="5.6s"
              repeatCount="indefinite"
              begin="2.1s"
              keyPoints="1;0"
              keyTimes="0;1"
              calcMode="linear"
            >
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
        </>
      )}
    </g>
  );
}
