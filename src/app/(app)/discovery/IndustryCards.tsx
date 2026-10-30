import Link from "next/link";

// The industry picker both Discovery tabs are split by. One component rather
// than two near-copies: the tabs show different things (internships, firms) but
// the taxonomy and the way you move through it are the same, and when they
// drifted apart the two tabs taught two different navigation idioms on one
// screen.
//
// Pills are links, not filters. Clicking an industry opens that industry's own
// page — the filter-in-place version left the student on a page whose heading
// still said "every internship" while showing one sector's worth.
//
// Pills rather than the grid of cards this used to be. Fourteen equal boxes,
// most of them dimmed at "0 internships", read as a wall of choices, half of
// them broken, and pushed the browser below a full screen down. As pills the
// whole set fits in two or three lines: the industries with something in them
// first, the empty ones after. Still every industry, since
// an empty one is a real answer about coverage and its page still explains
// the sector and its timeline.

export type IndustryCard = {
  value: string;
  label: string;
  count: number;
  href: string;
  /** A few-word tagline (CATEGORY_TAGLINES). Shown on hover. */
  description?: string;
};

export default function IndustryCards({
  items,
  unit,
}: {
  items: IndustryCard[];
  /** Singular noun for the count — "internship" or "firm". */
  unit: string;
}) {
  // Stable within each group, so the taxonomy's own order survives: busiest
  // first would reshuffle the row every time a posting lands.
  const open = items.filter((i) => i.count > 0);
  const empty = items.filter((i) => i.count === 0);

  const pill = (item: IndustryCard) => {
    const noun = item.count === 1 ? unit : `${unit}s`;
    return (
      <li key={item.value}>
        <Link
          href={item.href}
          title={item.description}
          aria-label={`${item.label}: ${item.count.toLocaleString()} ${noun}`}
          // One grey for every pill. Solid navy on the ones with postings,
          // beside outlined empty ones, read as a multiple-choice question
          // with some answers already picked - and these are links, not
          // choices. The bold count is what says which have something in them.
          className="inline-flex items-center gap-2 rounded-full border border-warmgray-200 bg-warmgray-100 px-3.5 py-1.5 text-sm text-warmgray-600 transition-colors hover:border-accent-400 hover:text-brand-900"
        >
          {item.label}
          <span className="text-xs font-semibold tabular-nums text-brand-900">{item.count.toLocaleString()}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="space-y-2">
      {open.length > 0 && <ul className="flex flex-wrap gap-2">{open.map(pill)}</ul>}
      {empty.length > 0 && <ul className="flex flex-wrap gap-2">{empty.map(pill)}</ul>}
    </div>
  );
}
