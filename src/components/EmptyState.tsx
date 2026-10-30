/**
 * The one empty-state box.
 *
 * Every "nothing here yet" panel in the app used to be hand-rolled at its call
 * site, and they had drifted apart: five radii (none, md, lg, 2xl, list-panel's
 * 12px), paddings from p-4 to py-14, text-xs next to text-sm, warmgray-500 next
 * to warmgray-600, and some centred while others were a left-aligned <p>. Two
 * of them sitting side by side in a grid is where that became visible - the
 * boxes were different heights and their text sat at different offsets, so a
 * row that should have read as one line of panels read as a mistake.
 *
 * Built on `.list-panel` rather than `bg-white` deliberately: the terminal
 * theme redefines --color-white to near-black, so a `bg-white` empty box was a
 * near-black card on a near-black page. `.list-panel` also carries the 12px
 * radius the filled panels use, so an empty section and a full one are the
 * same shape - which is the whole point of having one component.
 *
 * `min-h` is what actually does the aligning. Without it a one-line message
 * and a two-line message produce boxes of different heights, and in a grid the
 * shorter column's box visibly floats.
 */

export type EmptyStateSize = "sm" | "md" | "lg";

const SIZES: Record<EmptyStateSize, string> = {
  // Nested inside a section that already has its own heading and box - tighter,
  // so it reads as part of that section rather than competing with it.
  sm: "min-h-[56px] px-4 py-4 text-xs",
  // The default: a panel's own empty state, directly under its h2.
  md: "min-h-[76px] px-4 py-6 text-sm",
  // A whole page or feed with nothing in it, where the box IS the screen and
  // usually carries a heading and a call to action rather than one sentence.
  lg: "min-h-[160px] px-6 py-12 text-sm",
};

export default function EmptyState({
  children,
  size = "md",
  className = "",
}: {
  children: React.ReactNode;
  size?: EmptyStateSize;
  className?: string;
}) {
  return (
    <div
      className={`list-panel flex items-center justify-center border border-dashed border-brand-200 text-center text-warmgray-500 ${SIZES[size]} ${className}`}
    >
      {/* A div, not a <p>: several of these boxes hold a button or a stacked
          block alongside the sentence, and an element like that inside a <p>
          is invalid HTML that React resolves by splitting the paragraph. */}
      <div className="max-w-prose">{children}</div>
    </div>
  );
}
