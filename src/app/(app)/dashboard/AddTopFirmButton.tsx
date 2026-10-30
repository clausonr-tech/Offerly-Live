"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { searchFirmsForPicker } from "./actions";
import type { TopFirmsState } from "./actions";

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 200;

export default function AddTopFirmButton({
  firms,
  action,
  /**
   * Custom trigger, so the same picker can be opened from something other than
   * a text button - the deck opens it from a blank card at the end of the
   * hand. A render prop rather than a second copy of this component: the
   * search, the click-outside handling and the pending state are the hard
   * parts and should exist once.
   */
  renderTrigger,
  /** Which edge the dropdown hangs from. The card trigger sits at the
   *  right-hand end of a full-width deck, where a right-aligned panel would
   *  run off the screen. */
  align = "right",
  wrapperClassName,
}: {
  /**
   * The rows to show before anything is typed - a small, sector-scoped slice,
   * not the directory. Typing asks the server for matches instead of filtering
   * this array, because the array is deliberately too short to filter: at
   * 22,569 firms, shipping the whole list so the browser could find thirty of
   * them cost seconds of server time and megabytes of payload on every
   * dashboard load, whether or not the picker was ever opened.
   */
  firms: { id: string; name: string }[];
  action: (state: TopFirmsState, formData: FormData) => Promise<TopFirmsState>;
  renderTrigger?: (props: { onClick: () => void; isPending: boolean }) => React.ReactNode;
  align?: "left" | "right";
  /** Classes for the positioning wrapper. A custom trigger that wants to
   *  fill its parent (the deck's add card) needs this to carry the size -
   *  `h-full` on the button alone resolves against a wrapper that has none. */
  wrapperClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Results carry the query they answer, which is what lets everything below
  // be derived rather than synchronised. "Are we searching" is then simply
  // "the answer we hold is not for the question being asked", so there is no
  // separate flag to get out of step, and clearing the box needs no effect at
  // all - `firms` is already the right answer for an empty query.
  const [result, setResult] = useState<{ query: string; rows: { id: string; name: string }[] } | null>(null);
  const trimmed = query.trim();
  const matches = trimmed ? (result?.query === trimmed ? result.rows : []) : firms;
  const searching = trimmed !== "" && result?.query !== trimmed;

  // A request per keystroke would be a request per character, with no
  // guarantee they come back in the order they were sent. Debounced, and each
  // run checks it is still the current one before writing - so a slow early
  // response cannot overwrite a newer, faster one.
  useEffect(() => {
    if (!trimmed) return;
    let current = true;
    const timer = setTimeout(async () => {
      const rows = await searchFirmsForPicker(trimmed);
      if (current) setResult({ query: trimmed, rows });
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  function handleAdd(firmId: string) {
    const formData = new FormData();
    formData.set("firmId", firmId);
    startTransition(() => {
      action(undefined, formData);
    });
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} className={wrapperClassName ?? "relative"}>
      {renderTrigger ? (
        renderTrigger({ onClick: () => setOpen((o) => !o), isPending })
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-xs font-medium text-brand-900 hover:underline"
        >
          <Plus size={13} />
          Add firm
        </button>
      )}

      {open && (
        <div
          className={`absolute top-full z-50 mt-2 w-64 border border-brand-100 bg-white shadow-card ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search firms..."
            className="w-full border-b border-brand-100 px-3 py-2 text-sm text-brand-900 focus:outline-none"
          />
          <div className="max-h-64 overflow-y-auto">
            {matches.length === 0 ? (
              <p className="px-3 py-3 text-xs text-warmgray-500">
                {/* "Searching" and "nothing found" are different answers, and
                    showing the second while the first is true tells the reader
                    their firm does not exist when it simply has not arrived. */}
                {searching ? "Searching..." : "No firms match."}
              </p>
            ) : (
              matches.map((firm) => (
                <button
                  key={firm.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => handleAdd(firm.id)}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-brand-900 hover:bg-brand-50 disabled:opacity-60"
                >
                  {firm.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
