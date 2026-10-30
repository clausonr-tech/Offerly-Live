/**
 * A suspension bridge, drawn here because lucide has no bridge icon.
 *
 * FOUR STROKES, and the count is the whole design. A previous version had ten
 * - suspender cables, footings, the lot - and looked correct at 110px while
 * rendering as a grey smudge at the size it actually ships. The reason is
 * arithmetic, not taste: a 24-unit viewBox drawn at 22px puts roughly one
 * device pixel on each unit, and a 2px stroke antialiases across two or three
 * of them. Any two strokes closer than about four units merge. The suspenders
 * sat four units from the towers, so they did.
 *
 * What survives is the silhouette, and it is enough:
 *
 *  - POINTED APEXES. The cable arrives and leaves each tower vertically, so
 *    the curves meet in a spire rather than flattening over the top. This is
 *    the single detail that separates a suspension bridge from a bench.
 *  - PIERS THROUGH THE DECK. The towers continue below the roadway. Costs no
 *    extra strokes - the tower lines simply run further - and without it the
 *    shape reads as a goalpost.
 *  - A DEEP SAG well clear of the deck, and side spans falling away to the
 *    anchorages.
 *
 * Deliberately absent: suspenders and footings. They are accurate and they are
 * invisible at 22px. If they go back in, the icon needs to be 32px or larger.
 *
 * CHECK IT AT ITS REAL SIZE, NOT AT 110. Render the SVG to a 24x24 canvas and
 * magnify THAT with image-rendering:pixelated - scaling the vector up just
 * shows a bigger vector and hides exactly the failures this file keeps having.
 *
 * Size must be a whole multiple of the viewBox (24, 48). Every endpoint here
 * is an integer so that at 1:1 they land on pixel boundaries and a 2px stroke
 * covers exactly two pixels. At 22px the scale is 0.9167, every straight line
 * falls between pixels, and the whole icon renders with a grey fringe.
 */
export default function BridgeIcon({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* roadway */}
      <path d="M2 16h20" />
      {/* towers, apex to pier, crossing the deck on the way */}
      <path d="M7 20V3" />
      <path d="M17 20V3" />
      {/* main cable: anchorage, vertical into the apex, sag, mirrored.
          Endpoints on integers; the control points need not be, since they
          are never drawn. */}
      <path d="M2 13C4.5 13 7 8 7 3C7 8 9 10 12 10C15 10 17 8 17 3C17 8 19.5 13 22 13" />
    </svg>
  );
}
