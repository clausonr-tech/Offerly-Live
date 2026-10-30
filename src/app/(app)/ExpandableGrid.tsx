"use client";

import { useEffect, useState } from "react";

// A grid of cards where opening one reveals a full-width panel *below the row
// it sits in*, rather than immediately after the card itself.
//
// The obvious implementation - a `col-span-full` panel rendered straight after
// the open card - is what this replaces. It reflows the grid: the cards that
// shared a row with the open one get pushed past the panel onto the next row,
// so opening the first of three firms leaves two thirds of that row empty and
// shuffles every card after it. The row a student clicked in visibly comes
// apart under the click.
//
// Keeping rows intact means knowing how many columns are actually rendered,
// which is a media query, not something CSS grid will tell you. Hence the hook
// below and the chunking here: each row is its own grid, and the panel is a
// sibling between two of them.

/** Tailwind's sm/lg breakpoints, matching the grid classes below. */
function useGridColumns() {
  // 3 is what the server renders. The first client render has to agree with it
  // or hydration fails; the effect corrects it immediately afterwards. Nothing
  // is expanded on a first paint, so the temporary disagreement about row
  // grouping is invisible.
  const [columns, setColumns] = useState(3);

  useEffect(() => {
    const lg = window.matchMedia("(min-width: 1024px)");
    const sm = window.matchMedia("(min-width: 640px)");
    const update = () => setColumns(lg.matches ? 3 : sm.matches ? 2 : 1);
    update();
    lg.addEventListener("change", update);
    sm.addEventListener("change", update);
    return () => {
      lg.removeEventListener("change", update);
      sm.removeEventListener("change", update);
    };
  }, []);

  return columns;
}

export default function ExpandableGrid<T>({
  items,
  getKey,
  isOpen,
  renderCard,
  renderPanel,
  gap = "gap-2",
  maxColumns = 3,
}: {
  items: T[];
  getKey: (item: T) => string;
  isOpen: (item: T) => boolean;
  renderCard: (item: T) => React.ReactNode;
  /** Rendered full width, below the row containing the open card. */
  renderPanel: (item: T) => React.ReactNode;
  /** Tailwind gap class, so callers keep their own density. */
  gap?: string;
  /**
   * Caps how many cards share a row, regardless of viewport. The breakpoints
   * below key off viewport width, not this grid's own container - so a caller
   * placed in a half-width column (Discovery's merged matches/internships
   * split) still measured the full viewport and packed 3 cramped cards into
   * half the space. Capping at 2 there keeps the same breakpoints but stops
   * one short of the column they don't fit.
   */
  maxColumns?: 1 | 2 | 3;
}) {
  const columns = Math.min(useGridColumns(), maxColumns);
  const colsClass =
    maxColumns >= 3 ? "sm:grid-cols-2 lg:grid-cols-3" : maxColumns === 2 ? "sm:grid-cols-2" : "";

  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }

  return (
    <div className={`grid ${gap}`}>
      {rows.map((row) => {
        const open = row.find(isOpen);
        return (
          // Keyed on the row's first card rather than its index: at a different
          // breakpoint the rows regroup, and an index key would have React
          // reuse the wrong row's DOM.
          <div key={getKey(row[0])} className={`grid ${gap}`}>
            <div className={`grid grid-cols-1 ${gap} ${colsClass}`}>
              {/* h-full, because a grid cell already stretches to the tallest
                  in its row but the CARD inside it did not - so three cards
                  with different amounts of text came out three different
                  heights and the row read as ragged. The card roots carry
                  their own h-full to fill the cell this gives them. */}
              {row.map((item) => (
                <div key={getKey(item)} className="h-full">
                  {renderCard(item)}
                </div>
              ))}
            </div>
            {open && renderPanel(open)}
          </div>
        );
      })}
    </div>
  );
}
