"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Lock, Menu, X } from "lucide-react";
import { NAV_SECTIONS, sectionFor, subsectionFor, type NavSection } from "@/lib/nav-sections";
import { FIRM_NAV_SECTIONS } from "@/lib/firm-nav";
import { railCookieString, type RailState } from "@/lib/sidebar-rail";

/**
 * Clicking the view you are ALREADY on. Link has nowhere to navigate, so the
 * click would do nothing at all - and halfway down a long feed, nothing is
 * indistinguishable from a dead button. "Go to Networking" while standing in
 * Networking means the top of it, so take them there.
 */
function scrollToTop(e: React.MouseEvent) {
  e.preventDefault();
  window.scrollTo({
    top: 0,
    // A long page under a reduced-motion preference should jump rather than
    // travel. matchMedia, not a CSS media query, because this scroll is
    // scripted and no stylesheet can reach it.
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

/**
 * The app's navigation, as a rail down the left rather than a strip across
 * the top.
 *
 * Why the change: the tab strip had eight items and no room for a ninth, so
 * every new section either overflowed into a horizontal scroll a reader had
 * to discover, or forced two sections to be merged to make space. Merging for
 * layout reasons is how Connect ended up inside Community. A vertical rail
 * has as many rows as it needs, and it gives second-level views somewhere to
 * live that is not a second floating bar.
 *
 * Below `lg` it is off-canvas behind a menu button, because a fixed 15rem
 * column on a 375px screen leaves nothing for the page.
 */
export default function Sidebar({
  brand,
  actions,
  initialRail,
  nav = "student",
  lockPaidSections = false,
}: {
  /** True for a free account: sections marked `paid` in lib/nav-sections get
   *  a small lock beside the label. They stay visible and clickable - the
   *  paid sections ARE the upgrade pitch - and the click lands on /upgrade
   *  via each section's own layout gate (lib/plan-access). */
  lockPaidSections?: boolean;
  /** Which rail: the student app's (lib/nav-sections) or the firm portal's
   *  (lib/firm-nav), or none while a firm account waits for approval. A name
   *  rather than the list itself, because the list carries icon components,
   *  which a server layout cannot hand to a client component. */
  nav?: "student" | "firm" | "none";
  /** The retracted/expanded state as the server read it from the cookie, so
   *  the first paint is already the right width. See lib/sidebar-rail. */
  initialRail: RailState;
  /** The wordmark. Rendered twice - once at the top of the rail, once in the
   *  mobile bar - because the rail is off-canvas below `lg` and a signed-in
   *  page with no mark anywhere reads as a different site. */
  brand: React.ReactNode;
  /** Theme toggle and account menu: the header's right-hand side. They live
   *  here rather than in the layout so the opener and they share one row
   *  instead of stacking into two. */
  actions: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<RailState>(initialRail);
  const sections: NavSection[] = nav === "firm" ? FIRM_NAV_SECTIONS : nav === "none" ? [] : NAV_SECTIONS;
  const current = sectionFor(pathname, sections);
  const currentChild = current ? subsectionFor(current, pathname) : null;
  const collapsed = rail === "collapsed";

  // Retracting is a desktop idea: below `lg` the rail is already an off-canvas
  // drawer with its own opener, so the width toggle is hidden there and every
  // collapsed style is scoped inside the same media query in globals.css. The
  // attribute is still rendered at every size - the CSS decides where it
  // means anything, which keeps that decision in one place.
  const toggleRail = () => {
    const next: RailState = collapsed ? "open" : "collapsed";
    setRail(next);
    // Written here rather than through a server action: it is a display
    // preference with nothing on the server depending on it mid-session, and a
    // round trip would make the rail lag the click it is animating.
    try {
      document.cookie = railCookieString(next);
    } catch {
      // Cookies blocked. The rail still toggles for this session; it just
      // will not be remembered, which is not worth failing the click over.
    }
  };

  // Escape closes it, the same as any other overlay. Only bound while open,
  // so there is no stray global listener on the majority of renders.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Scrim. `hidden` rather than a conditional render, so it never sits
          invisibly over the page while closed. */}
      <div
        hidden={!open}
        onClick={() => setOpen(false)}
        // z above the message bubble (z-40), below the rail itself (z-50) -
        // a scrim the chat button floats on top of is not a scrim.
        // The colour is a class rather than bg-black/40 because this theme
        // redefines palette tokens (see .list-panel's note on --color-white),
        // and a dimmer is the last thing that should follow a theme.
        className="app-sidebar-scrim fixed inset-0 z-[45] lg:hidden"
        aria-hidden="true"
      />

      <nav
        aria-label="Sections"
        data-open={open ? "true" : "false"}
        data-collapsed={collapsed ? "true" : "false"}
        className="app-sidebar"
      >
        {/* The brand block lives inside the rail rather than above it, so the
            logo and the navigation share one column instead of the logo
            floating over a page that starts further left. */}
        <div className="app-sidebar-head">
          {brand}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="app-sidebar-close inline-flex h-9 w-9 items-center justify-center lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <ul className="app-sidebar-list">
          {sections.map((section) => {
            const active = current?.href === section.href;
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  // Navigating is the end of the drawer's job, and the click
                  // that navigates is where to say so - an effect watching
                  // `pathname` would set state during render-after-navigation
                  // instead, which is both a lint error and a wasted pass.
                  onClick={(e) => {
                    setOpen(false);
                    // Exact match only: from /networking/peers the Link does
                    // navigate, and Next scrolls to the top itself.
                    if (pathname === section.href) scrollToTop(e);
                  }}
                  // "page" only on the hub itself. Deeper in, the nested row
                  // carries "page" and this one says the reader is inside it.
                  aria-current={pathname === section.href ? "page" : active ? "location" : undefined}
                  // The label is the tooltip too. Retracted, the mark is all
                  // there is to go on, and a native title is the one hint that
                  // needs no hover styling and no portal.
                  title={section.label}
                  className={`app-sidebar-item ${active ? "is-active" : ""}`}
                >
                  {/* Hidden by CLIPPING when retracted, never display:none -
                      the link would otherwise have no accessible name at all,
                      leaving a screen reader with seven identical "link"s. */}
                  <span className="app-sidebar-label">{section.label}</span>
                  {/* aria-hidden: the label is right beside it, so announcing
                      the mark as well would read every section twice.
                      strokeWidth below lucide's default 2 - at 16px a 2px
                      stroke is heavier than 13px type next to it. */}
                  {lockPaidSections && section.paid ? (
                    // Replaces the section mark rather than adding a second
                    // glyph: the retracted rail has room for exactly one, and
                    // "locked" is the one thing a free account needs to read.
                    <Lock size={16} strokeWidth={1.75} aria-label="Offerly Pro" className="app-sidebar-icon" />
                  ) : (
                    section.Icon && (
                      <section.Icon
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="app-sidebar-icon"
                      />
                    )
                  )}
                </Link>

                {/* Sub-views appear only under the section being read. An
                    always-expanded tree would put eleven rows on screen to
                    navigate eight places. */}
                {active && section.children && section.childrenIn !== "topbar" && (
                  <ul className="app-sidebar-sublist">
                    {section.children.map((child) => (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          onClick={(e) => {
                            setOpen(false);
                            if (pathname === child.href) scrollToTop(e);
                          }}
                          // "page" on the view itself; "location" one level
                          // deeper (a thread under Messages), where the row is
                          // where you are but not the page you are on.
                          aria-current={
                            currentChild?.href === child.href
                              ? pathname === child.href
                                ? "page"
                                : "location"
                              : undefined
                          }
                          className={`app-sidebar-subitem ${
                            currentChild?.href === child.href ? "is-active" : ""
                          }`}
                        >
                          {child.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* The retract control: a disc centred on the rail's right edge, exactly
          halfway down it.

          A SIBLING of the rail rather than a child, which it has to be -
          .app-sidebar sets overflow-y:auto, and anything inside it that pokes
          past the right border gets clipped by that scroll box. Fixed
          positioning at `left: var(--rail-w)` with a -50% translate puts its
          centre on the border line, and it follows the border automatically
          when the width changes because both read the same variable.

          Hidden below lg in CSS: there the rail is a drawer, and retracting a
          drawer that is already off-canvas means nothing. */}
      <button
        type="button"
        onClick={toggleRail}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        className="app-rail-toggle"
      >
        {collapsed ? (
          <ChevronRight size={14} aria-hidden="true" />
        ) : (
          <ChevronLeft size={14} aria-hidden="true" />
        )}
      </button>

      {/* What is left of the header. Below `lg` it carries the opener and the
          wordmark; from `lg` up both are in the rail and only the account
          controls remain, hard right. */}
      <header className="bg-transparent">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 pt-3">
          <div className="flex items-center gap-2 lg:hidden">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
              aria-expanded={open}
              className="app-sidebar-opener inline-flex h-10 w-10 items-center justify-center"
            >
              <Menu size={20} />
            </button>
            {brand}
          </div>
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        </div>
        <div className="border-b border-brand-100" />
      </header>
    </>
  );
}
