"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { House, Users, MessageSquare, SquarePen, Plus } from "lucide-react";
import BridgeIcon from "./BridgeIcon";

/**
 * How far the bar sits off the bottom of the viewport, and off the footer
 * once it reaches it.
 */
const GAP = 16;

/**
 * The bar is rendered into document.body, not where it sits in the tree.
 *
 * Not a stylistic choice - `position: fixed` does not work here otherwise.
 * app/(app)/template.tsx wraps every page in `.app-reveal`, whose entrance
 * animation is declared with `both`, so its final `transform: translateY(0)`
 * stays applied for the life of the page. A transform of any value, identity
 * included, makes that element the containing block for every fixed
 * descendant - so the bar was being pinned to the bottom of the PAGE rather
 * than the viewport, and scrolled away with the content.
 *
 * Portalling escapes the transformed ancestor without touching an animation
 * every app page depends on. Worth knowing the same trap is waiting for any
 * other fixed element added inside an app route.
 */
const subscribeNoop = () => () => {};

function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Keeps the floating bar clear of the footer.
 *
 * Returns the distance the bar should sit above the bottom of the viewport:
 * GAP normally, and GAP plus however much of the footer is on screen once the
 * reader gets there - so the bar rides up the page rather than sitting on top
 * of the footer's links.
 *
 * Riding up rather than hiding, deliberately. Hiding at the footer is the more
 * obvious reading of "floating until the footer", and it breaks the short
 * pages: Clubs with no clubs is under a screen tall, so its footer is visible
 * without scrolling and the bar would never appear at all - a nav that is
 * absent exactly when there is nothing else on the page to navigate from.
 *
 * Measured on scroll rather than with IntersectionObserver because this needs
 * a continuous distance, not a threshold crossing. Reads are batched into a
 * rAF and the listeners are passive, so this never blocks a scroll.
 */
function useFooterClearance(): number {
  const [offset, setOffset] = useState(GAP);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const footer = document.querySelector("footer");
    if (!footer) return;

    const measure = () => {
      frame.current = null;
      const top = footer.getBoundingClientRect().top;
      // How much of the footer is inside the viewport, floored at zero.
      const shown = Math.max(0, window.innerHeight - top);
      setOffset(GAP + shown);
    };
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(measure);
    };

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Clearing the ref is the load-bearing half of this line.
      //
      // `schedule` no-ops while a frame is already pending, and it reads that
      // from this ref - so a cleanup that cancels the frame without clearing
      // it leaves the guard permanently closed: every later scroll sees a
      // non-null id for a frame that will never run, and the bar stops
      // tracking the footer for the life of the page.
      //
      // StrictMode's double-invoke surfaced it on the very first mount in
      // development, but any remount would do the same in production.
      frame.current = null;
    };
  }, []);

  return offset;
}

/**
 * Community's own nav, one level below the app-wide bar.
 *
 * Icons only. Which means every item still needs an accessible NAME - an icon
 * has no text for a screen reader to announce, and "link" is what it would
 * otherwise read out four times. `aria-label` supplies it, and `title` gives
 * the same word to a sighted user on hover, so the two never disagree about
 * what the icon means.
 *
 * Styled as a segmented strip rather than the underlined tabs the top bar
 * uses, on purpose - two identical-looking bars stacked would read as one
 * confused row, and the difference in shape is what tells you which one is
 * scoped to this page.
 */
type NavItem = {
  href: string;
  label: string;
  /** Anything that renders a 24px glyph - lucide's icons and our own
   *  BridgeIcon both satisfy this. */
  Icon: (props: { size?: number; className?: string }) => React.ReactNode;
};

const ITEMS: NavItem[] = [
  { href: "/networking", label: "Home", Icon: House },
  { href: "/networking/connect", label: "Connect", Icon: BridgeIcon },
  { href: "/networking/clubs", label: "Clubs", Icon: Users },
  { href: "/networking/messages", label: "Messages", Icon: MessageSquare },
];

export default function CommunityNav({ mayPost }: { mayPost: boolean }) {
  const pathname = usePathname() ?? "";
  const offset = useFooterClearance();
  const mounted = useMounted();
  const items: NavItem[] = mayPost
    ? [...ITEMS, { href: "/networking/compose", label: "Club post", Icon: SquarePen }]
    : ITEMS;

  // The composer sits in the MIDDLE of the strip, not at either end.
  // Everything else here navigates between views; this one creates something,
  // and the centre is the one position that cannot be mistaken for another
  // tab in the sequence. Splitting the list rather than appending is what puts
  // it there, and it stays centred as tabs are added either side.
  const half = Math.ceil(items.length / 2);

  if (!mounted) return null;

  return createPortal(
    // The wrapper spans the viewport and passes clicks through; only the bar
    // itself is interactive. A full-width fixed element that ate pointer
    // events would sit invisibly across the bottom of every Community page.
    <div
      className="pointer-events-none fixed inset-x-0 z-40 px-4"
      style={{ bottom: offset }}
    >
      <nav
        aria-label="Community"
        // Full content width, matching max-w-7xl px-4 on <main> - the same
        // span the bar had when it sat in the flow at the top of the page.
        // The items inside are flex-1 basis-0, so they spread across it
        // rather than bunching in the middle.
        className="community-subnav pointer-events-auto mx-auto flex w-full max-w-7xl items-center gap-1 overflow-x-auto p-1"
      >
      {renderItems(items.slice(0, half))}

      <Link
        href="/networking/post"
        aria-label="New post"
        title="New post"
        aria-current={pathname.startsWith("/networking/post") ? "page" : undefined}
        className="community-subnav-new mx-1 inline-flex h-9 w-9 shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <Plus size={24} className="shrink-0" />
      </Link>

      {renderItems(items.slice(half))}
      </nav>
    </div>,
    document.body,
  );

  function renderItems(list: NavItem[]) {
    return list.map(({ href, label, Icon }) => {
        // "/networking" would otherwise match every child route and light up on all
        // of them; every other entry owns its subtree.
        const active =
          href === "/networking" ? pathname === "/networking" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={label}
            // h-10 keeps the target a comfortable height now that the text is
            // gone - an icon alone would otherwise collapse the row to 18px
            // and leave a control smaller than a fingertip.
            className={`community-subnav-item inline-flex h-10 min-w-max flex-1 basis-0 items-center justify-center whitespace-nowrap px-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 ${
              active ? "is-active" : ""
            }`}
          >
            {/* 24, and it must stay a whole multiple of the 24-unit viewBox.
                Anything else scales by a fraction and every straight stroke
                lands between device pixels: at 22 the scale is 0.9167, so the
                roadway at y=16 is drawn at 14.67 and a 2px stroke smears
                across three pixels instead of covering two. That is what
                "the icons look pixelated" was - not resolution, alignment.
                24 or 48. Never 22, 20 or 18. */}
            <Icon size={24} className="shrink-0" />
          </Link>
        );
    });
  }
}
