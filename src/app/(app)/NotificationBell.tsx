"use client";

import Link from "next/link";
import { ArrowRight, Bell, Check } from "lucide-react";
import { useOptimistic, useRef, useState, useTransition } from "react";

import { LABEL_TONES, type LabelTone } from "@/lib/label-colors";
import { bellRow } from "@/lib/notification-row";

import FirmLogo from "./discovery/FirmLogo";

import { completeNotification, readNotifications } from "./notification-actions";
import { useFitPanelInViewport, useCloseOnOutsideOrEscape } from "@/lib/use-anchored-panel";

/** One row as the panel shows it. No Date crosses the boundary. */
export type BellItem = {
  id: string;
  title: string;
  body: string;
  href: string;
  /** Relative, formatted on the server so the two never disagree. */
  when: string;
  read: boolean;
  /** The firm, if the server knows it as a field. Unset today - see
   *  lib/notification-row, which reads it from a follow-up's detail instead. */
  firm?: string | null;
  /** The firm whose own post this is, for its logo (lib/notifications). */
  logo?: { name: string; domain: string } | null;
  /** Its kind's colour, the same as its chip on the to-do list. */
  tone?: LabelTone;
  /** A muted line under the title - the people a firm's reminder names. */
  subline?: string | null;
};

/**
 * Everything the app has asked this student to do, and whether they did it.
 *
 * The number is the count of OUTSTANDING jobs, not of unread messages: this is
 * a to-do list that happens to arrive as notifications, and a badge that
 * cleared itself the moment someone glanced at the panel would be counting the
 * wrong thing. The unread ones get a dot instead.
 */
export default function NotificationBell({
  items,
  unreadCount,
}: {
  items: BellItem[];
  /** The count is derived from `items` so it can answer a tick-off instantly;
   *  this is only the "new since you last looked" signal, which cannot be. */
  unreadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();

  useFitPanelInViewport(menuRef, open);

  // Ticking one off has to answer instantly - the round trip is a revalidate of
  // the whole layout, and watching a row sit there in the meantime reads as a
  // click that did not land. Finished work leaves the list rather than moving
  // to a "done" section: this is a to-do list, and a done row is not a to-do.
  const [shownOpen, removeOptimistically] = useOptimistic(
    items,
    (state: BellItem[], id: string) => state.filter((i) => i.id !== id),
  );
  const count = shownOpen.length;

  // Ticking a row off plays out in two steps before it leaves the list: the
  // check and strike-through ("checked"), then the slide up and fade
  // ("leaving"). Only then is it removed and saved, so the rows below rise
  // into its space rather than jumping. Reduced motion skips the wait.
  const [finishing, setFinishing] = useState<Record<string, "checked" | "leaving">>({});
  const finish = (id: string) => {
    if (finishing[id]) return;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setFinishing((f) => ({ ...f, [id]: "checked" }));
    window.setTimeout(() => setFinishing((f) => ({ ...f, [id]: "leaving" })), reduce ? 0 : 450);
    window.setTimeout(
      () =>
        startTransition(async () => {
          removeOptimistically(id);
          await completeNotification(id);
        }),
      reduce ? 0 : 450 + 320,
    );
  };

  useCloseOnOutsideOrEscape(panelRef, () => setOpen(false));

  // Opening the panel is reading it. Deliberately not awaited and deliberately
  // not revalidating: the dot going away on the next render is enough, and
  // re-rendering the layout under an open panel would close it. Called here,
  // not inside a setOpen updater: updaters run during render (twice in Strict
  // Mode), which fired the action twice and updated the Router mid-render.
  function toggle() {
    if (!open && unreadCount > 0) void readNotifications().catch(() => {});
    setOpen(!open);
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          count === 0
            ? "Notifications"
            : `Notifications, ${count} still to do${unreadCount > 0 ? `, ${unreadCount} new` : ""}`
        }
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-brand-900 transition-colors hover:bg-brand-50"
      >
        <Bell size={18} strokeWidth={1.75} />
        {count > 0 && (
          <span
            // Literal hex: the dark theme redefines --color-white to near-black,
            // which would render this as a dark blob on a dark badge.
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b3261e] px-1 text-[10px] font-semibold leading-none text-[#ffffff]"
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
        {unreadCount > 0 && (
          // The "new since you last looked" signal, separate from the count.
          <span className="absolute bottom-0.5 right-1 h-1.5 w-1.5 rounded-full bg-accent-500" />
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Notifications"
          // Width inline, not as a class: it hangs from a 36px bell, so without
          // an explicit width it shrinks to its narrowest content. When the
          // class was missing from a stale stylesheet, that squeezed every
          // title to one letter per line. The floor keeps it wide on a phone.
          style={{ width: "min(34rem, calc(100vw - 2rem))", minWidth: "min(18rem, calc(100vw - 2rem))" }}
          className="list-panel absolute right-0 z-50 mt-2 overflow-hidden rounded-xl border border-brand-100 shadow-[0_20px_44px_-16px_rgba(11,21,38,0.55)]"
        >
          <div className="flex items-baseline justify-between border-b border-[#c5cfe0] px-4 py-2.5">
            <span className="text-sm font-semibold text-brand-900">Notifications</span>
            <span className="text-[11px] text-warmgray-500">
              {count === 0 ? "Nothing to do" : `${count} to do`}
            </span>
          </div>

          <div className="max-h-[22rem] overflow-y-auto">
            {shownOpen.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-warmgray-500">
                Prompts from the app land here, and stay until they are done.
              </p>
            )}

            {/* One line per job, so the panel holds twice as many: what to do,
                the firm muted on the right, then the tick-off. The detail
                sentence and the age move into the tooltip rather than going
                anywhere - and the full page still shows both.

                The row's own px-3/py-1 is the room the focus ring needs: the
                app-wide ring sits 4px outside the element, and this list
                scrolls, so a link flush to its edges would have the ring
                clipped off.

                Colours inside the panel are literals because the panel is white
                in BOTH themes (.list-panel): bg-accent-500 turns white in the
                dark theme, which made the unread dot vanish, and
                border-brand-100 carries the app-wide card shadow, which in the
                dark theme is 85% black and smudged under every row. */}
            {shownOpen.map((item) => {
              const row = bellRow(item);
              const phase = finishing[item.id];
              const leaving = phase === "leaving";
              return (
              // Collapses to nothing when ticked off: grid rows from 1fr to
              // 0fr, so the rows below rise smoothly into the space.
              <div
                key={item.id}
                className={`group/row grid transition-[grid-template-rows,opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
                  leaving ? "-translate-y-1 grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                }`}
              >
              <div className="min-h-0 overflow-hidden">
              <div
                // A left edge in the job's colour (lib/label-colors), so a
                // thank-you and a deadline tell apart at a glance.
                className="flex items-center gap-2 border-b border-l-[3px] border-[#c5cfe0] py-1 pl-2 pr-1 group-last/row:border-b-0"
                style={{ borderLeftColor: LABEL_TONES[item.tone ?? "outreach"].fg }}
              >
                {/* Ticking off: an open circle. Clicked, it fills blue with a
                    black check, the line is struck through, and the row slides
                    up and away (5 October 2026, replacing "Mark as done"). */}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(phase)}
                  aria-label={`Mark as done: ${row.title}`}
                  disabled={Boolean(phase)}
                  onClick={() => finish(item.id)}
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-150 pointer-coarse:h-6 pointer-coarse:w-6 ${
                    phase
                      ? "border-[#5b9cf5] bg-[#5b9cf5]"
                      : "border-[rgba(11,21,38,0.35)] hover:border-[#5b9cf5] hover:bg-[#5b9cf5]/10"
                  }`}
                >
                  {phase && <Check size={12} strokeWidth={3} className="text-[#0b1526]" aria-hidden />}
                </button>
                {/* To the job on the full list, where the student sees it in
                    context. `focus` marks the row that was clicked and scrolls
                    to it - see NotificationTask. A query param rather than a
                    #hash: client-side navigation moves the URL with pushState,
                    which never updates :target. */}
                <Link
                  href={`/notifications?focus=${item.id}`}
                  onClick={() => setOpen(false)}
                  title={row.tooltip}
                  className="flex min-h-7 min-w-0 flex-1 items-center gap-2 pointer-coarse:min-h-[44px]"
                  role="menuitem"
                >
                  {!item.read && !phase && (
                    <span
                      aria-label="New"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#24447a]"
                    />
                  )}
                  {item.logo && (
                    // The title already names the firm, so the logo is decoration.
                    <span aria-hidden className="flex shrink-0">
                      <FirmLogo domain={item.logo.domain} name={item.logo.name} size={20} />
                    </span>
                  )}
                  {/* Wraps rather than truncating: a cut-off title hides
                      what the job is. */}
                  <span
                    className={`min-w-0 flex-1 py-1 text-sm font-medium leading-snug break-words transition-colors duration-150 ${
                      phase ? "text-warmgray-500 line-through decoration-[1.5px]" : "text-brand-900"
                    }`}
                  >
                    {row.title}
                    {item.subline && (
                      <span className="block text-xs font-normal text-warmgray-500">{item.subline}</span>
                    )}
                  </span>
                  {row.firm && (
                    <span className="max-w-[33%] shrink-0 truncate text-[11px] text-warmgray-500">
                      <span className="sr-only">, </span>
                      {row.firm}
                    </span>
                  )}
                </Link>
                {/* Straight to the work, on the far right (it was a "Go do it"
                    button). The row itself still opens the job in context. */}
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  role="menuitem"
                  aria-label={`Go do it: ${row.title}`}
                  title="Go do it"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#24447a] hover:bg-[#24447a]/10 pointer-coarse:h-11 pointer-coarse:w-11"
                >
                  <ArrowRight size={16} strokeWidth={2} aria-hidden />
                </Link>
              </div>
              </div>
              </div>
              );
            })}

          </div>

          {/* The way out to the full page. Always there, even when the list is
              empty, because the page is also where someone goes to see what
              the app has been asking them to do. */}
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-[#c5cfe0] px-4 py-2.5 text-center text-xs font-medium text-brand-900 hover:bg-brand-50"
          >
            Open the full list
          </Link>
        </div>
      )}
    </div>
  );
}