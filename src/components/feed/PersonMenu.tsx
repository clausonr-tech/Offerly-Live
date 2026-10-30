"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { MessageSquare, User } from "lucide-react";
import LogoAvatar from "./LogoAvatar";

const MENU_W = 192;
const MENU_H = 92;
const GAP = 6;

/**
 * The avatar, and the small menu behind it.
 *
 * Hover opens it, but hover is never the only way in: the avatar is a real
 * link, so focus opens it too and Enter works exactly like a click. A
 * hover-only affordance is unreachable by keyboard and invisible on touch,
 * where there is no hover state at all - there the tap simply opens it.
 *
 * The panel is PORTALLED, which it has to be for two separate reasons. The
 * feed card clips its own overflow for its rounded corners, so an in-place
 * panel showed only its top edge; and .home-panel carries a backdrop-filter,
 * which creates a stacking context - so even unclipped, no z-index inside a
 * card could lift the menu above the cards below it.
 *
 * The target is the [data-app-theme] element, NOT <body>. The app's colour
 * tokens are redefined on that element, so a panel portalled to <body> sits
 * outside the theme entirely and renders in light colours on the black
 * Dealroom page. It is still an ancestor of every card, so the portal escapes
 * both the clipping and the stacking context exactly as well.
 */
export default function PersonMenu({
  userId,
  name,
  initials,
  schoolDomain,
  photoUrl = null,
  schoolName,
}: {
  userId: string;
  name: string;
  initials: string;
  schoolDomain: string | null;
  /** Their uploaded photo, which stands in front of the school crest. */
  photoUrl?: string | null;
  schoolName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Flip up when there is no room below, and keep it inside the viewport
    // horizontally - a menu half off the screen is not a menu.
    const below = window.innerHeight - r.bottom;
    const top = below < MENU_H + GAP ? r.top - MENU_H - GAP : r.bottom + GAP;
    const left = Math.min(Math.max(GAP, r.left), window.innerWidth - MENU_W - GAP);
    setPos({ top, left });
  }, []);

  // Measured before paint, so the panel never appears at the wrong spot first.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // A small grace period on leaving: without it the menu closes in the gap
  // between the avatar and the panel and becomes impossible to click into.
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => () => cancelClose(), []);

  const item =
    "flex items-center gap-2.5 px-3 py-2.5 text-sm text-warmgray-600 transition hover:bg-brand-50 hover:text-brand-900 focus-visible:bg-brand-50 focus-visible:text-brand-900 focus-visible:outline-none";

  // Looked up at the point of use rather than held in state. The panel only
  // ever renders after a hover, focus or tap, so this can only run on the
  // client - which makes a state round-trip (and the cascading render the
  // hooks lint rightly complains about) pointless.
  const host = open ? (document.querySelector<HTMLElement>("[data-app-theme]") ?? document.body) : null;

  return (
    <div
      className="shrink-0"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      onFocusCapture={() => {
        cancelClose();
        setOpen(true);
      }}
      onBlurCapture={scheduleClose}
    >
      <Link
        ref={triggerRef}
        href={`/u/${userId}`}
        prefetch={false}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // 44px of target, with the visible circle sitting inside it.
        className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <LogoAvatar
          photoUrl={photoUrl}
          domain={schoolDomain}
          label={schoolName}
          alt={schoolName ? `${schoolName} crest` : ""}
          initials={initials}
          size={40}
        />
        {/* The crest names the school, not the person, so the accessible name
            for this link still has to be the person. */}
        <span className="sr-only">{name}</span>
      </Link>

      {open &&
        pos &&
        host &&
        createPortal(
          <div
            ref={panelRef}
            id={menuId}
            style={{ top: pos.top, left: pos.left, width: MENU_W }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            className="fixed z-[60] overflow-hidden rounded-xl border border-brand-100 bg-white py-1 shadow-lg"
          >
            <Link href={`/u/${userId}`} className={item}>
              <User size={14} aria-hidden="true" className="shrink-0" />
              View profile
            </Link>
            <Link href={`/messages/${userId}`} className={item}>
              <MessageSquare size={14} aria-hidden="true" className="shrink-0" />
              Send message
            </Link>
          </div>,
          host,
        )}
    </div>
  );
}
