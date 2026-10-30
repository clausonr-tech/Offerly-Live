"use client";

import { useState } from "react";

/**
 * Shows the first `pageSize` of a list and reveals another `pageSize` per click.
 *
 * Takes ALREADY-RENDERED rows rather than data, which is what lets a server
 * component page its own output: lib/upcoming-applications.ts is server-only,
 * so the component that builds these rows cannot become a client component to
 * hold the "how many are showing" state. Rendering the rows on the server and
 * slicing the resulting array here keeps that boundary intact.
 *
 * Every row is rendered up front and merely hidden, so expanding costs nothing
 * - no request, no spinner, no layout jump beyond the rows themselves. That is
 * the right trade at these sizes (tens of rows); it would not be for hundreds.
 */
export default function ShowMoreList({
  rows,
  pageSize,
  /** Word for the things being counted, for the button's label. */
  noun = "more",
}: {
  rows: React.ReactNode[];
  pageSize: number;
  noun?: string;
}) {
  const [shown, setShown] = useState(pageSize);
  const remaining = rows.length - shown;
  const expanded = remaining <= 0;

  return (
    <>
      {rows.slice(0, shown)}

      {rows.length > pageSize && (
        <div className="border-t border-brand-100 px-4 py-2">
          <button
            type="button"
            onClick={() => setShown(expanded ? pageSize : shown + pageSize)}
            className="ui-round-md px-2 py-1 text-xs text-brand-900 transition-colors hover:bg-brand-50"
          >
            {expanded
              ? "Show fewer"
              : // Never promises more than there are: the last click on a list
                // of twelve reads "Show 2 more", not "Show 5 more".
                `Show ${Math.min(pageSize, remaining)} ${noun}`}
            {!expanded && (
              <span className="ml-1.5 text-warmgray-500">{remaining} left</span>
            )}
          </button>
        </div>
      )}
    </>
  );
}
